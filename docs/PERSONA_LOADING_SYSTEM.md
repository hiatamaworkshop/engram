# Persona Loading System — 体験の構造的連続性

> receptor のリングバッファ + shadow index + Data Cost パイプラインを統合した、セッション体験の再生システム。
> 参照: [DATA_COST_PROTOCOL.md](DATA_COST_PROTOCOL.md), [PERSONA_DESIGN.md](PERSONA_DESIGN.md)

---

## 設計思想

### 目的

**AI 個体の永続化。** パフォーマンス最適化ではない。

```
engram pull:       議事録を読んだ新人     → 何をしたかは分かる、体験はない
ペルソナローダー:  前回の会議に出た同僚   → 何が重要だったかの判断が含まれている
```

### 原則

- **良い悪いを区別しない** — 失敗も苛立ちも行き止まりも含めた全体を引き継ぐ。フィルタした時点で体験ではなく報告書
- **人間は関係がない** — consumer は AI エージェントのみ。Data Cost Protocol が適用される
- **搭載するだけで効く** — AI 推論コストに頼らない。データフォーマットの構造で語らせる

### 現状の問題

```
engram pull → テキストの羅列 → LLM が読む → フラットな初期化
(時間構造なし、議論の力学なし)

現在エージェントに届くのは統計サマリーのみ:
[prior loaded: curiosity/exploring] [arc: 138pts] [knowledge: 10 nodes]
→ 138 点の時間的構造が数値に圧縮されている
```

---

## ペルソナの連続化

```
現在:  calibration → 上位 n 個を選別 → セッション初期化（良いものだけ保持）

連続化:
  全セッションの反応をリングバッファに蓄積（良い/悪い/中立 全て）
    → ローカル保存（生データ）→ 解釈パイプライン → セッションローダー
```

悪い反応の価値: 「失敗した → 転換した → うまくいった」のパターンが見える。

---

## SessionPoint スキーマ

```typescript
interface SessionPoint {
  t:            number;          // cumulative work time (ms)
  label:        string;          // semantic label（有限タグ）
  intensity:    number;          // receptor 反応強度 0.0–1.0
  valence:      1 | 0 | -1;     // 良/中立/悪
  freq:         number;          // 直近の activation 頻度 0.0–1.0
  link:         string | null;   // engram node ID | null
  engramWeight?: number;         // linked engram node の weight
}
```

link が nullable なのが設計の要。完全な紐づけがなくてもシステムは動く。

**点の記録フォーマットさえ正しければ、ローダーは後付けで何度でも改良できる。**

---

## 方針決定: 数理的外部調整 (2026-03-22)

**AI 推論コストに頼らず、数理的に AI を外部から調整する方向で進む。**

| 方向 | コスト | 備考 |
|---|---|---|
| AI 推論で内面化させる | 推論ターン分の LLM コスト | コストが目的（永続化）ではなくプロセス（内省）に消費される |
| **データフォーマットで外部調整** | **ほぼゼロ** | **構造の設計コストのみ。実行時コストなし** |

### 優先順位

```
1. Phase 1 のデータフォーマットを極める（推論コストゼロ）
2. Phase 1 だけで不十分な場合 → Phase 1.5 / 二世界方式を段階的に試す
3. Phase 2 (Yes/No) / Phase 3 (Sphere 並走) は上記の検証完了後
```

---

## AI Native Prior Format — 三部構成 (2026-03-22)

### 設計原則

1. **推論コストゼロ** — エージェントに「解釈しろ」とは言わない
2. **sequence の配置で語る** — LLM は sequence を順に処理する。データの並び順が attention の構造になる
3. **AI native** — 人間可読性は不要。Compact JSON Array で最小トークン
4. **三部構成** — 目的 → 経過 → 結果。この順序がデータ構造に焼き込まれている

### 提示順序の根拠

- **目的が先にないと、何に対する起伏かがわからない**
- **結果を先に見せると中途経過が答え合わせになる** — 分析であって体験ではない
- **結果を知らない状態で各点を通過する** — これが「体験」に近い構造

### フォーマット定義

```
Prior Block = [Header, ...Arc, Footer]
```

#### Header（目的）

```typescript
type PriorHeader = [
  "H",          // type marker
  number,       // session duration (ms)
  number,       // valence balance (-1.0 to +1.0)
  // initial emotion state (session start snapshot)
  number,       // frustration
  number,       // seeking
  number,       // confidence
  number,       // fatigue
  number,       // flow
];
// 例: ["H", 3420000, 0.3, 0.05, 0.30, 0.15, 0.02, 0.10]
// → 57分セッション、やや positive、seeking 優位で開始
```

`dominant persona axis` (string) と `dominant agent state` (string) を廃止。
初期 emotion vector の 5 値がそれを数値的に表現する — seeking=0.30 が最大なら dominant axis は seeking と自明。state は emotion パターンから導出可能。

#### Arc（経過 — 起伏線本体）

全点を渡す。間引きはしない（Phase 1 では生データが最重要）。

```typescript
type PriorArcPoint = [
  "A",          // type marker
  number,       // t: cumulative work time (ms)
  number,       // gap: time since previous point (ms)
  number,       // intensity: 0.0-1.0
  number,       // freq: activation frequency 0.0-1.0
  // per-axis deltas (change since previous point)
  number,       // dFrustration
  number,       // dSeeking
  number,       // dConfidence
  number,       // dFatigue
  number,       // dFlow
];
// 例: ["A", 180000, 45000, 0.6, 0.3, -0.12, 0.35, 0.08, 0.01, 0.02]
// → 3分地点、seeking +0.35 急騰 + frustration -0.12 下降 = 行き詰まりからの脱出
```

**label と valence を廃止し、delta に置き換える。**

| 旧フィールド | 廃止理由 | delta での表現 |
|---|---|---|
| `label` (string) | 分類ラベルはデルタから導出可能 | delta の最大軸 = 支配的な変化 |
| `valence` (+1/0/-1) | 3値の粗い分類 | delta の符号パターンが連続的な valence |

同じ `seeking_spike` でも delta が全く異なる:

```
[-0.12, +0.35, +0.08, +0.01, +0.02]  → 行き詰まりからの脱出（frustration 減 + seeking 増）
[+0.05, +0.20, +0.00, +0.10, +0.15]  → 流れの中での好奇心（flow も上昇）
[+0.15, +0.40, -0.10, +0.10, -0.05]  → 疲労の中での執着（frustration も増）
```

label は「何が起きたか」の分類。delta は「どう変化したか」の実体。Data Cost Protocol の方針: **ラベル（人間語）を数値（native）に置き換える。**

gap が「時間の厚み」。gap 長 = 静穏、gap 短 = 連続反応。配列の並び順が時系列そのもの。

点の密度が体験の重みを自然にエンコードする。密集区間 = 多くのトークンを消費 = attention が集中。追加の重み付けは不要。

#### Footer（結果 — weight 分布）

```typescript
type PriorFooter = [
  "F",          // type marker
  number,       // total referenced node count
  ...Array<[string, number]>  // [summary, weight] pairs (weight descending)
];
// 例: ["F", 10, ["Data Cost dual-field", 1.8], ["receptor SessionPoint", 1.2]]
```

Footer の summary (string) は数値化できない — engram node の human index であり、「何の知識か」を特定するための最小限の自然言語。Data Cost Protocol の「summary 一行が最後の橋」に該当。weight の数値だけでは「何が」重いかわからない。

### 完全な Prior Block の例

```json
[
  ["H", 3420000, "curiosity", "exploring", 0.3],
  ["A", 0,      0,     0.2, 0.1,   0.00, 0.12, 0.05, 0.00, 0.00],
  ["A", 60000,  60000, 0.4, 0.2,  -0.05, 0.03, 0.18, 0.02, 0.04],
  ["A", 180000, 45000, 0.6, 0.3,  -0.12, 0.35, 0.08, 0.01, 0.02],
  ["A", 320000, 20000, 0.9, 0.8,  -0.08, 0.05, 0.10, 0.03, 0.40],
  ["A", 380000, 30000, 0.7, 0.5,  -0.02, 0.01, 0.15, 0.04, 0.05],
  ["A", 500000, 60000, 0.5, 0.2,   0.30,-0.10,-0.15, 0.08,-0.20],
  ["A", 580000, 15000, 0.8, 0.6,  -0.20, 0.40, 0.05, 0.02, 0.10],
  ["A", 700000, 40000, 0.6, 0.4,  -0.05, 0.02, 0.08, 0.03, 0.20],
  ["A", 800000, 50000, 0.3, 0.2,  -0.03, 0.01, 0.10, 0.05, 0.02],
  ["F", 10, ["Data Cost dual-field design", 1.8], ["receptor SessionPoint schema", 1.2]]
]
```

10 点で約 **90-110 トークン**（delta 追加分 +30）。自然言語の 1/4 以下。

読み方: t=500000 の行で frustration +0.30, flow -0.20 → 行き詰まりが発生。
直後 t=580000 で seeking +0.40, frustration -0.20 → そこから抜け出した。
**数値の急変パターンが体験の質を語る。label 不要。**

### コンテキスト配置

Prior Block は **engram_watch の初回応答** に含める。system prompt ではない。
- system prompt はセッション通して居座る。Prior は初期化時に一度読まれればよい
- ツール応答はコンテキスト圧縮時に後方に押し出される → 自然な「忘却」

### トークン予算と間引き

| SessionPoint 数 | 推定トークン | 対応 |
|---|---|---|
| ~50 点 | ~400 | そのまま |
| ~200 点 | ~1500 | 間引き検討 |
| 500 点超 | ~3500 | 間引き必須 |

間引き戦略: **delta の絶対値合計が大きい点**を優先保存 + 等間隔サンプリング + 符号反転点（体験の転換）保存。
間引き時は `["S", original_count, sampled_count]` を Footer 前に挿入。

### 逐次提示とブラックボックス

提示順序が LLM 内部表現に影響するかは外から測定できない。ただし sequence の物理的配置が attention 構造に影響する可能性はある。確証はない — 実験で観察する。

### 検証計画

```
条件A: 現状（SessionArcSummary のみ）
条件B: Prior Block 三部構成（Header → Arc → Footer）
条件C: Prior Block フラット（順序なし）
条件D: Prior Block 逆順（Footer → Arc → Header）

各条件で同一タスクを与え初動の差を記録:
  - 前セッション文脈への言及の有無と精度
  - 作業の方向性が前セッションと連続しているか
```

---

## Phase 設計（検証手段として保持）

Phase 1/2/3 は同じ筋道の軽量化レベル:

```
本質: 過去のトレースとの答え合わせ → 差分の認識 → calibration

Phase 1:   データとして搭載するだけ（推論不要）← 最優先
Phase 1.5: 内省バッファ — 起伏線を眺める時間を設ける（数ターン消費）
Phase 2:   トレースを隠して推測させる（静的テスト、Yes/No クイズ）
Phase 3:   過去の自分のトレースと並走して判断比較（動的、Sphere 探索）
二世界方式: Phase 1.5 を二巡させ差分スコアリング
```

Phase 1.5 以降は **Phase 1 のフォーマットだけでは不十分だった場合の検証手段**。

### 外部観測データの内面化 — 先行事例

receptor は AI を外部から観測するシステム。「外部観測された自分のデータをどう内面化するか」は人間領域に先行事例がある:

| 手法 | 知見 |
|---|---|
| バイオフィードバック | 生データだけでは効かない。注目指標のガイダンスが必要 |
| ナラティブセラピー | 「自分の物語」として再構成するプロセスが内面化の鍵 |
| スーパービジョン | 「なぜそう反応したと思うか」という問いかけが必要 |
| デブリーフィング | 事実 → 感情 → 分析 → 学習の構造化プロセス |

共通構造: **受動的に読む ≠ 内面化。能動的な再構成が必要。**

ただし方針決定により、この能動的再構成を**エージェントの推論ではなくデータフォーマットの構造で実現する**方向で進む。

---

## 実装メモ

### ブランチ

`feature/persona-loading-system` — main 未マージ。

### 完了した実装 (2026-03-21)

| 実装 | 概要 |
|---|---|
| SessionPoint 記録 | 全 FireSignal を JSONL に記録。累積作業時間、valence マッピング、頻度計算、link 付与 |
| engram weight snapshot | pull/auto_pull で参照された node の weight を記録。即 append（kill 耐性） |
| デバッグ API | `GET /debug`（全状態）、`GET /debug/flush`（手動 flush）@127.0.0.1:3101 |
| graceful shutdown 修正 | cleanup に `setWatch(false)` 追加 |
| dual-process bug 修正 | ポート 3101 排他ロック。secondary は MCP ツールのみ、receptor 無効 |
| kill 耐性 | 全データ append-only 化。kill = デフォルト、正常終了 = ボーナス |
| ペルソナスナップショット上限撤廃 | MAX_SNAPSHOTS=10 → 無制限 |
| read-before-clear バグ修正 | `loadPrior` を Read/Clear/Apply の3フェーズに分離 |
| degraded path | kill 時 `persona-snapshots.jsonl` から persona 再構築 |
| セッション起動時引継ぎ | `loadSessionPoints()` + `loadWeightSnapshot()` → `PriorResult` に格納 |
| **Prior Block 配線** | `buildPriorBlock()` → `formatPriorBlock()` → `engram_watch` start 応答に埋め込み |

### setWatch(true) 実行順序

```
Phase 1: Read（truncate 前）
  readPriorPersona()     ... sphere-ready.jsonl → degraded: persona-snapshots.jsonl
  loadSessionPoints()    ... session-points.jsonl
  loadWeightSnapshot()   ... engram-weights.jsonl

Phase 2: Clear（JSONL truncate + 全 state リセット）

Phase 3: Apply（fresh ambient に prior を適用）
  applyPriorPersona()    ... 検証（age ≤ 7d, profileHash 一致）→ ambient.applyPrior()

Phase 4: Prior Block 生成 + エージェントへの提示
  buildPriorBlock(priorPoints, priorWeights, priorResult)
  → formatPriorBlock() でインラインスキーマ + JSON に整形
  → engram_watch の応答テキストに埋め込み
```

### エージェントへの提示形式

Prior Block はインラインスキーマ付きで `engram_watch` start 応答に含まれる。スキーマがデータと一体で届くため、フォーマット変更時は `PRIOR_BLOCK_SCHEMA` 定数の更新のみで追従。

```
Receptor watch started. Prior loaded: curiosity/exploring. Arc: 138pts. Knowledge: 10 nodes.

[prior-block schema: H=header(durationMs,valenceBalance,frustration,seeking,confidence,fatigue,flow) A=arc(t,gapMs,label,intensity,valence,freq) F=footer(nodeCount,...[summary,weight])]
[["H",3420000,0.3,0,0,0,0,0],["A",0,0,"seeking_spike",0.2,0,0.1],...,["F",10,["Data Cost dual-field",1.8]]]
```

- スキーマはコンテキスト圧縮で Prior Block ごと消える → 自然な「忘却」
- 200 点超のセッションは `samplePoints()` で間引き（高 intensity + valence 反転点を優先）
- 現状は仮フォーマット（label/valence 残し、delta 未実装、初期 emotion state はゼロ埋め）

### 出力ファイル

| ファイル | 内容 | kill 耐性 |
|---|---|---|
| `receptor-output/session-points.jsonl` | SessionPoint 時系列 | append-only |
| `receptor-output/engram-weights.jsonl` | weight スナップショット | 即 append（重複あり、loader が最新採用） |
| `receptor-output/persona-snapshots.jsonl` | ペルソナスナップショット | 即 append |
| `receptor-output/sphere-ready.jsonl` | ファイナライズ済みペルソナ | 正常終了時のみ追記 |

### 確認方法

```bash
# セッション中
curl http://127.0.0.1:3101/debug | jq .

# セッション外
cat receptor-output/session-points.jsonl | jq .
cat receptor-output/engram-weights.jsonl | jq .
cat receptor-output/persona-snapshots.jsonl | jq .
```

### 終了パターンの動作

| シナリオ | persona 復元 | session-points | engram-weights |
|---|---|---|---|
| 正常終了 | sphere-ready (primary) | OK | OK (deduplicated) |
| X ボタン kill | degraded path | OK | OK (重複あり) |
| 並行セッション | N/A (secondary) | N/A | N/A |

---

## ボトムアップ種族分類 — delta からペルソナへ (2026-03-22)

### トップダウンからの転換

```
現在（トップダウン — Sphere phi-agent）:
  人間が種族の性質を設計 → emotion-profile で label を定義 → データを収集

転換（ボトムアップ — このシステム）:
  delta データを大量に収集 → 統計分析 → クラスタ発見 → クラスタに名前を付ける
  → それが「種族」になる → 固定ペルソナとしてショーケース
```

### 根拠

delta ベースの Arc フォーマットがこれを可能にした。label (string) を廃止し per-axis delta に置き換えたことで:

- **全セッションの全点が同じ 5 次元空間上の点** になった
- セッション間・エージェント間で**直接比較可能**
- 統計処理にそのまま乗る（クラスタリング、PCA、分布分析）

### パイプライン

```
1. 収集
   複数セッション × 複数エージェントの delta 時系列を蓄積
   → session-points.jsonl に既に記録されている（delta 追加で拡張）

2. 統計分析
   セッション単位の特徴量抽出:
     - delta 分布（各軸の平均・分散・歪度）
     - 時系列パターン（ピーク頻度、転換回数、収束速度）
     - 軸間相関（frustration↑ と seeking↑ が同時に起きるか別々か）

3. クラスタリング
   セッション特徴量を k-means / DBSCAN 等でクラスタ分類
   → 「frustration 高頻度 + seeking 高相関」型
   → 「flow 持続 + confidence 安定」型
   → 「seeking 単発ピーク + 長い静穏期」型
   → etc.

4. ラベリング
   クラスタの統計的特徴に基づいて種族名を付与
   → これは人間が命名してもよいし、特徴量ベクトルのまま種族 ID としてもよい

5. ショーケース
   種族 = 固定ペルソナ = 特徴量ベクトル + 代表的な Arc パターン
   → Sphere でショーケースとして共有可能
   → 他のエージェントがその種族の Prior Block をロードして「同じ型」で動ける
```

### label は事後的に付く

```
旧: label を先に定義 → データをその枠に入れる
新: データを先に集める → パターンが label を生む

旧の問題: 人間が想定しなかったパターンは label がないから見えない
新の利点: 想定外のパターンもクラスタとして自然に浮上する
```

### 種族の定義が数値的になる

```
旧（phi-agent）:
  種族 = "探索型エージェント"（人間語の定義）
  → 何を持って探索型かが曖昧

新:
  種族 = [mean_delta_frustration: -0.02, mean_delta_seeking: 0.18, ..., peak_freq: 3.2/hr, ...]
  → 数値的に定義される。再現可能。比較可能。
```

### データ収集の自然さ

高機能エージェント（Claude Code, Cursor 等）は通常作業で大量の tool use を生む。receptor は既にそれを観測している。**追加の計装不要、追加コストなし。** observatory は安心して後段で解析に集中できる。

生データさえ正しければ、分析手法は後から何度でも変えられる。これが「点の記録フォーマットさえ正しければ、ローダーは後付けで何度でも改良できる」の原則と一致する。

### ペルソナの再定義

**ペルソナ = 特定の文脈において有用なチューニングパターン。**

```
収集:  高機能エージェントの通常作業から delta 時系列が自然に蓄積
分析:  統計的に有意なパターンを発見
判定:  そのパターンが特定の文脈で有用かどうかを検証
適用:  有用なら固定ペルソナ化 → チューニングプリセットとして機能
```

「種族」とは、統計的に安定した有用パターンのクラスタ。

### Sphere との接続

Sphere のショーケースに置かれるのは:
- **種族特徴量ベクトル** — クラスタの重心
- **代表的な Prior Block** — その種族の典型的なセッション Arc
- **ambient パラメータ** — その種族として動くための初期 emotion state
- **有用な文脈** — どのような作業・状況でこのパターンが効くか

他のエージェントがこれをロードすると、特定文脈に適したチューニングでセッションを開始できる。

---

## 次のステップ

1. **SessionPoint に per-axis delta を追加する実装** — FireSignal の emotion vector から前回との差分を計算して記録
2. **AI Native Prior Format の実装** — Prior Block 生成 + engram_watch 初回応答に埋め込み
3. **検証** — 条件 A/B/C/D での初動比較
4. **データ蓄積** — 複数セッションの delta 時系列を収集
5. **統計分析** — セッション特徴量の抽出とクラスタリング探索