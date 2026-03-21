# Dialogue Receptor — 対話入力による receptor 拡張設計

> 2026-03-21 — UserPromptSubmit hook を通じた対話入力の receptor 統合。
> DATA_COST_PROTOCOL.md での議論から派生。

---

## 背景: receptor の知覚の欠落

現在の receptor は PostToolUse hook のみを入力とする。ツール操作がない時間は「無」として扱われる。

```
問題:
  思想的議論、設計議論、雑談 — ツール操作を伴わない対話
  → receptor から見ると stagnation / wandering
  → 実態と乖離した状態判定
```

典型例: 30分間の活発な設計議論が stagnation 扱いされる。

---

## 設計原則

### 1. 言語非依存

キーワードマッチ、疑問表現検出、感情語辞書 — 全て言語依存になるため排除。

```
排除したもの:
  - questionCount (「？」「か」「かな」「?」— 言語ごとにパターンが異なる)
  - キーワード辞書 (転換語、肯定語、否定語、興奮語 — 多言語対応が泥沼化)
  - langShift (多言語混在ユーザーでは日常であってシグナルにならない)
  - hasCodeBlock (人間の発話では稀、価値が薄い)
```

### 2. 定量的観測のみ

normalizer は計測器に徹する。意味の解釈はしない。

```
計測するもの: 文字数、時間
解釈するもの: なし — ニューロンが既存状態と混ぜて判断する
```

### 3. 断定しない

対話の特徴量から状態を断定しない。傾向として impulse に反映し、既存の emotion に影響が出る程度。

---

## normalizer 出力

```typescript
interface PromptFeatures {
  length:       number;   // 文字数
  turnInterval: number;   // 前回発話からの経過 ms
}
```

### 足切り

```
length < 10 → 無視 (ingest しない)
```

「ok」「yes」「続けて」等の低情報量発話を除外。

---

## impulse 設計

### ツール比で控えめ

対話 impulse はツール操作の 0.3〜0.5 倍。「行動」より「思考」は弱い信号。

### 既存状態との照合

normalizer は生値を渡し、impulse 生成は receptor が既に持つ文脈と照合して行う:

```
prompt 入力時点で receptor が持っているもの:
  - 直前の emotion vector
  - 直前の agentState (exploring, deep_work, etc.)
  - 直近のツール操作パターン
  - ニューロンの活性度

照合パターン (断定ではなく傾向):
  長文 + 直前 deep_work + ツール密度高い   → 作業中の議論
  長文 + 直前 exploring + ツール密度低い   → 思想的議論
  短文連打 + turnInterval 短い             → 活発なやりとり
  長い沈黙後の長文                         → 熟考後の投入
```

---

## セマンティックラベル: 不要

対話入力に新しいセマンティックラベルは追加しない。

```
ツール入力:  tool_name → semantic label → impulse → neuron
対話入力:    length + turnInterval → impulse → neuron (ラベルなし)
```

ラベルを付けず、既存ニューロンへの impulse として流す。ツール操作と対話が混ざった結果として emotion が動く。ラベル体系の膨張を防ぐ。

---

## 最大の価値: 既存状態判定の補正

対話入力の主な役割は新しい状態を検出することではなく、**既存の状態判定の誤りを補正する** こと。

### post-work chat フェーズの検出

```
stagnation（本物）:
  ツールなし + 対話なし or 対話まばら
  → 本当に止まっている

post-work chat（雑談フェーズ）:
  ツールなし + 対話が活発 (length 中〜長, turnInterval 短め)
  → 手は動いていないが頭は動いている
```

impulse 効果:

```
ツールなし + 対話活発
  → stagnation 方向の減衰を抑制
  → flow や confidence を急落させない
  → 「まだセッションは生きている」という信号
```

---

## パイプライン統合

```
UserPromptSubmit hook
  → prompt normalizer (文字数 + 時間間隔を計測)
  → 足切り判定 (length < 10 → 破棄)
  → impulse 生成 (既存 receptor 状態と照合、ツール比 0.3〜0.5 倍)
  → 既存ニューロンに注入
  → emotion 更新 (ツール入力と対話入力が混合)
  → signal 判定 / persona snapshot 等は既存のまま
```

既存の PostToolUse 経路は一切変更しない。横に対話経路を追加するだけ。

---

## Data Cost Protocol との接続

この設計自体が Data Cost Protocol の実践:

```
対話テキスト (自然言語) → 定量特徴量 (数値2つ) → receptor に注入
                         ^^^^^^^^^^^^^^^^^^^^^^^^
                         自然言語の内容には一切触れない
                         native な数値データとして処理
```

人間の発話という最も「人間語」な入力を、言語に触れずに処理する。

---

## 実装 (2026-03-21)

### 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `receptor/types.ts` | `NormalizedAction` に `"user_prompt"` 追加。`NormalizedEvent` に `promptLength`, `turnInterval` フィールド追加 |
| `receptor/normalizer.ts` | `RawHookEvent` に `prompt_content` 追加。UserPromptSubmit 正規化（足切り length < 10、turnInterval 計測） |
| `receptor/emotion-profile.json` | `user_prompt`: fatigue -0.02。`user_prompt.long` (>100文字): seeking +0.02, confidence +0.01 |
| `receptor/emotion.ts` | `user_prompt.long` 条件分岐（promptLength > 100） |
| `receptor/commander.ts` | counts レコードに `user_prompt: 0` 追加 |
| `receptor/index.ts` | 対話入力時 heatmap/staleness スキップ。表示ラベル `Dl` 追加 |
| `receptor/http.ts` | `/turn` エンドポイントで対話を `ingestEvent` に流す。`/receptor` の parseHookPayload で UserPromptSubmit ハンドル |

### impulse チューニング

```
user_prompt (基本):     fatigue: -0.02  (セッション生存信号)
user_prompt.long (>100): seeking: +0.02, confidence: +0.01 (思考的活動)
```

ツール impulse の約 0.3 倍。断定せず、既存 emotion の減衰を緩やかにする程度。

### 入力経路

```
経路1: UserPromptSubmit hook → /receptor → parseHookPayload → ingestEvent
経路2: UserPromptSubmit hook → /turn { type: "user", content: "..." } → ingestEvent
経路3: MCP event パラメータ → ingestEvent (tool_name: "UserPromptSubmit")
```

### 未実装・今後の検討

- 対話入力のみのセッションでのパターン分類改善（現状は `exploration` default にフォールバック）
- turnInterval を使った活発度の直接的な impulse 修飾（現状は生値保存のみ）
- 対話密度に基づく stagnation 判定の補正ロジック

---

## 参照

- [DATA_COST_PROTOCOL.md](DATA_COST_PROTOCOL.md) — 二層通信設計、入力側コスト管理
- [RECEPTOR_ARCHITECTURE.md](RECEPTOR_ARCHITECTURE.md) — receptor の実装設計
- [PERSONA_DESIGN.md](PERSONA_DESIGN.md) — ペルソナスナップショッティング
