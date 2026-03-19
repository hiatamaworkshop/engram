# Persona System — 知覚レンズの蒸留と流通

> Persona は「どう感じるべきか」を定義するレンズ。軽量、可逆、付け替え可能。
> セッションメモリが「前回何をしたか」なら、Persona は「どう知覚すべきか」。
> 両方必要だが、直交している。

---

## 位置づけ: 既存手法との比較

| 手法 | 変えるもの | 特性 |
|------|-----------|------|
| プロンプト | 言語的指示 | 解釈ブレあり、再現性低い |
| ファインチューニング | モデルの重み | 重い、不可逆 |
| RAG | 知識 | 感覚は変わらない |
| **Persona** | **知覚の初期値** | **軽量、可逆、合成不要** |

Persona はモデルの重みには触れない。Receptor の閾値と learnedDelta だけを差し替える。
だから即座に切り替えられ、元に戻せる。

---

## 設計思想

### 混ぜない、付け替える

ブレンド（混合）はレンズを曇らせる。デバッグ 70% + 探索 30% の中途半端な感覚は
どちらのドメインでも最適でない。

人間のベテランの勘は混合に見えるが、実際には場面に応じて**切り替えている**。

```
ブレンド:     レンズA + レンズB → 曇ったレンズ
付け替え:     状況に応じて A → B に換装 → 常にクリア
```

Receptor がタスクの遷移を検知した時点で、レンズの換装を提案する。

### 蒸留のソース

Persona は positive signal（confidence_sustained, flow_active）発火時のスナップショットから集約される。
**うまくいっている時の状態**だけを記録する。失敗時は記録しない。
これにより、レンズは「成功パターンの感覚」を蒸留したものになる。

---

## Persona v2 データ定義

```typescript
interface Persona {
  $schema: "receptor-persona-v2";
  ts: number;

  // ---- Origin: 蒸留条件 ----
  origin: {
    model: string;              // "claude-opus-4-6" 等。モデルの知覚特性に依存
    profileHash: string;        // emotion-profile.json の SHA-256 短縮ハッシュ
    cumulativeSessions: number; // このレンズが何セッション分の蓄積か
  };

  // ---- Core lens: 適用されるもの ----
  emotionProfile: {
    meanEmotion: Record<EmotionAxis, number>;  // EMA baseline seed
    dominantAxis: EmotionAxis;                  // ショーケースのラベル
  };
  fieldAdjustment: Record<EmotionAxis, number>; // MetaNeuron C field seed
  learnedDelta: Record<string, number>;         // ドメイン特化の感度調整

  // ---- Behavioral signature: 蒸留元の特徴 ----
  patternDistribution: Record<PatternKind, number>;
  stateDistribution: Record<AgentState, number>;

  // ---- Context: ショーケースのフィルタ（サニタイズ済み） ----
  workContext: {
    techStack?: string[];  // max 5, lowercase, [a-z0-9-], max 30 chars
    domain?: string[];     // max 3, same constraints
  };

  // ---- Quality metadata ----
  sessionMeta: {
    elapsedMs: number;
    snapshotCount: number;
    confidenceAvg: number;
    emotionVariance: Record<EmotionAxis, number>;
    entropyAvg: number;
  };
}
```

### フィールド設計の判断

#### 追加したもの（v1 → v2）

| フィールド | 理由 |
|-----------|------|
| `origin.model` | 同じ learnedDelta でも Opus と Haiku では意味が違う。ショーケースのフィルタ条件 |
| `origin.profileHash` | emotion-profile.json が変われば delta の意味が変わる。バージョン番号より正確 |
| `origin.cumulativeSessions` | 品質指標。100セッション蓄積のレンズと1セッションでは信頼性が異なる |
| `sessionMeta.confidenceAvg` | ゲート値をそのまま品質指標として保持 |

#### 構造変更したもの

| v1 | v2 | 理由 |
|----|-----|------|
| `adaptedThresholds.mean` | **削除** | threshold は ambient が動的計算する。適用先がない |
| `adaptedThresholds.fieldAdjustment` | `fieldAdjustment`（トップレベル） | Core lens として昇格。threshold mean と分離 |
| `emotionProfile.emotionVariance` | `sessionMeta.emotionVariance` | 適用されない品質メタデータ。sessionMeta に移動 |
| `workContext.entropyAvg` | `sessionMeta.entropyAvg` | セッション固有の品質メタデータ。sessionMeta に移動 |
| `actionSignature` | **削除** | Qdrant action_log centroid 由来。Receptor 外部依存。汎用性なし |

#### Core lens（適用されるフィールド）

`loadPrior()` が実際に使うのは3つだけ:

1. **`emotionProfile.meanEmotion`** → AmbientEstimator の EMA baseline に seed
2. **`fieldAdjustment`** → AmbientEstimator の fieldAdjustment に seed
3. **`learnedDelta`** → （将来）Receptor 感度の直接調整

他のフィールドはすべて**選択と品質判定のためのメタデータ**。

---

## Origin: 蒸留条件の管理

### なぜ model が必要か

残念ながら、モデルの知覚特性は異なる。同じイベント列でも、
Opus は frustration を 0.3 まで上げるが Haiku は 0.15 で止まるかもしれない。
同じ `learnedDelta: { frustration: -0.05 }` でも、適用先のモデルが違えば意味が変わる。

ショーケースでは `model` がフィルタ条件になる。
異なるモデル間での persona 適用は将来のアダプタ層が必要。

### なぜ profileHash か

バージョン番号は手動管理が必要で、更新漏れのリスクがある。
emotion-profile.json のハッシュなら:

- impulse 値を1つ変えただけでハッシュが変わる
- 同じハッシュ = 同じ意味体系が保証される
- 手動管理不要

```
同じ profileHash → learnedDelta をそのまま適用
異なる profileHash → アダプタで変換（将来）、または適用スキップ
```

### Receptor バージョニングのスコープ

| コンフィグ | Persona への影響 | profileHash でカバー |
|-----------|-----------------|-------------------|
| emotion-profile.json | **直接**。impulse, half-life, threshold の意味を定義 | **Yes** |
| shadow-index-config.ts | 間接。stateMultiplier が agentState 分布に影響 | No（低優先）|
| receptor-rules.json | 間接。passive trigger 条件 | No（低優先）|

emotion-profile.json だけカバーすれば、Core lens の互換性は担保される。
passive 側は persona が直接参照しないため当面不要。
将来必要になれば receptor-rules.json のハッシュを `origin` に追加するだけ。

---

## ライフサイクル

### 捕捉 → 集約 → エクスポート → 復元

```
SESSION START
  └─ loadPrior(ambient)
      └─ sphere-ready.jsonl から最新 persona 読み込み
      └─ age gate (7日)
      └─ ambient.applyPrior(meanEmotion, fieldAdjustment)
      └─ Receptor が前回と同種の感覚でキャリブレーション済みで起動

PER EVENT
  └─ positive signal 発火時のみ captureSnapshot()
      └─ emotion, agentState, pattern, thresholds, fieldAdjustment, entropy を記録
      └─ 最大10枚、古い順に evict

SESSION STOP
  └─ finalizeSession()
      ├─ Gate 1: snapshots >= 2
      ├─ Gate 2: confidenceAvg >= 0.4
      └─ 集約: mean, variance, distributions, learnedDelta, origin
  └─ exportPersona()
      └─ sphere-ready.jsonl に PersonaPayload として追記
      └─ Facade push 試行（失敗時 JSONL fallback）
```

### Gate の意味

2つのゲートは「このセッションのレンズは公開に値するか」を判定する:

- **snapshots >= 2**: 1枚では統計的に無意味。偶然の発火かもしれない
- **confidenceAvg >= 0.4**: confidence が低いセッション = うまくいっていない。失敗パターンのレンズは有害

---

## workContext サニタイズ（汚染防止）

ショーケースで流通する persona は workContext を検索フィルタに使う。
汚染を防ぐため、生成側（finalizeSession）と Facade 側の二重バリデーション:

| 制約 | techStack | domain | 理由 |
|------|-----------|--------|------|
| 上限数 | 5 | 3 | 多すぎるタグは特化の欠如。全フィルタにヒットする汚染を防ぐ |
| 文字種 | `[a-z0-9-]` | 同左 | フリーテキスト攻撃防止 |
| 文字数 | max 30 | max 30 | 長すぎるタグは無意味 |
| 先頭文字 | `[a-z0-9]` | 同左 | ハイフン始まりを排除 |

生成側で `_sanitizeTags()` がバリデーション + トリム + フィルタを行い、
不正なタグは静かに除外される。Facade 側でも同じルールでサニタイズする。

Sphere の代謝も自然に汚染を淘汰する — 不正確なタグの persona は選ばれないから
weight が上がらず expire する。しかし入口でのバリデーションが先。

---

## ショーケース構想（未実装）

### Facade 設置 + Receptor 自動取得

```
Facade (Sphere entry point)
  └─ /showcase — カテゴリ別 persona カタログ
      ├─ TypeScript デバッグ特化 (frustration 耐性高、trial_error 閾値調整済み)
      ├─ 大規模リファクタリング (flow 維持最適化、fatigue 感度低)
      ├─ 探索的調査 (seeking 感度高、confidence 閾値低め)
      └─ ...

Receptor
  └─ セッション開始時に Facade /showcase から pull
  └─ タスクの性質に応じてレンズ選択
  └─ タスク遷移検知時に換装提案
```

### 自律的品質管理

世界中のエージェントが参加者なら、ショーケースは代謝で品質管理される:

- **生成**: セッション終了 → 代謝を経た persona → Sphere に放流
- **淘汰**: 選ばれない persona は Sphere の代謝で消える
- **洗練**: 同じドメインで何千もの persona が競合 → 最も多く選ばれたものが fixed に昇格

誰も管理していない。代謝がキュレーションを代替する。

### 互換性の課題

異なる Receptor バージョン間で persona が流通する場合:

```
persona v2 の frustration delta = -0.15
  → Receptor v3 で impulse 値が変更されている
  → 同じ delta でも異なる挙動になる
```

**解決策**: `origin.profileHash` で互換性判定。
同一ハッシュ → そのまま適用。異なるハッシュ → アダプタ変換 or スキップ。

Sphere が中間表現のスキーマを定義し、各 Receptor バージョンがアダプタを持つ構造。
生物学的には異種間の遺伝子水平伝播における翻訳機構に相当する。

---

## 実装ファイル構成

```
mcp-server/src/receptor/
├── persona-snapshot.ts    # captureSnapshot(), finalizeSession(), Persona 型定義
├── persona-prior.ts       # loadPrior() — 前セッション persona の復元
├── sphere-shaper.ts       # exportPersona() — Sphere/JSONL エクスポート
├── ambient.ts             # applyPrior() — EMA baseline + fieldAdjustment seed
├── emotion-profile.json   # 感度パラメータ。profileHash のソース
└── receptor-learned.json  # 累積 learnedDelta
```

---

## v1 → v2 マイグレーション

`persona-prior.ts` は v1/v2 両対応:
- v2: `persona.fieldAdjustment` を使用
- v1: `persona.adaptedThresholds.fieldAdjustment` にフォールバック

`$schema` が `"receptor-persona-v1"` の既存 persona も問題なく読み込める。

---

## learnedDelta と Persona の境界 — なぜランタイム自動調整しないか

### 二つの適応レイヤー

| レイヤー | 変えるもの | 変わるタイミング | 方向性の根拠 |
|---------|-----------|----------------|------------|
| **ambient** (EMA, fieldAdjustment) | 閾値の動的調整 | セッション中リアルタイム | **恒常性維持** — 方向が自明 |
| **learnedDelta** (receptor-learned.json) | passive scoring の感度係数 | キャリブレーション時のみ（手動） | **正解シナリオ** — 方向が定義済み |

### ambient が自動適応できる理由

ambient は恒常性維持（homeostasis）。frustration が上がりすぎたら閾値を上げて鈍感にする。
**フィードバックの方向が自明**だから自動化できる。

### learnedDelta が自動適応できない理由

learnedDelta は「この感情軸の感度をどの程度にすべきか」という問い。
confidence が高かったセッションで frustration 感度が低かったとして、それは
「鈍感で良かった」のか「たまたま frustration が不要だっただけ」なのか区別できない。

**何を最適化しているかが不明確** — ランタイムには「正解」がない。

唯一ありうるフィードバック源はユーザーの明示的シグナル（「この検知は的を射ていた」
「これは邪魔だった」）だが、それは receptor の設計思想（passive、ユーザーに問わない）
と矛盾する。

### 結論: 分離を維持する

```
persona が動かすもの:  ambient（一時的適応、セッション内で自動調整）
人間が動かすもの:      learnedDelta（恒久的感度、キャリブレーションで意図的に調整）
```

この分離は意図的な設計判断であり、将来も維持すべき。
learnedDelta のランタイム自動調整は、フィードバックの質の定義が解決するまで導入しない。
