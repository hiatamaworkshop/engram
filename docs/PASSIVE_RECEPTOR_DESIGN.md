# Passive Receptor — 解釈層設計メモ

> 2026-03-15 概念設計議論に基づく。実装前の設計合意。

---

## 概要

Neuron (A/B/C) が発火した FireSignal を受け取り、
**何を実行するか** を確率的に選定する解釈層。

Neuron は純粋なセンサー。Passive Receptor は行動選択器。
mycelium の `assess()` と同構造: 入力 → 重み付け → 確率的選出 → 実行。

```
FireSignal[] (B neuron 出力)
       |
       v
  [1] A gate ラベル確認 (排他的)
       flow_active → 全メソッド抑制、即 return
       |
       v
  [2] C ラベル (agentState: stuck / deep_work / exploring / idle / delegating)
       → メソッド群への重み選択
       |
       v
  [3] Metrics 群
       signal.kind, signal.intensity, emotion snapshot, pattern
       → 各メソッドのスコア算出
       |
       v
  [4] learnedDelta
       × (1 - falsePositiveRate) でスコア補正
       |
       v
  [5] 配信モード判定 + メソッド確率分布
       → probabilisticSelect or threshold cut
       |
       v
  実行メソッド群
```

### mycelium との構造対応

```
mycelium:  metrics → computeFeelings → personality × feelings → softmax → action
receptor:  FireSignal → A gate → C label × metrics → learnedDelta → softmax → method
```

---

## 1. メソッド定義 — receptor-rules.json

開発者がメソッド群とトリガ条件を宣言的に定義する外部設定ファイル。

### 設定例

```jsonc
{
  "methods": [
    {
      "id": "engram_probe",
      "type": "knowledge_search",
      "mode": "background",
      "trigger": {
        "signals": ["hunger_spike", "compound_frustration_hunger"],
        "states": ["stuck", "exploring"],
        "sensitivity": 0.7,
        "frequency": "low"
      },
      "action": { "tool": "engram_pull", "args": { "projectId": "auto" } }
    },
    {
      "id": "mycelium_walk",
      "type": "knowledge_search",
      "mode": "ask",
      "trigger": {
        "signals": ["uncertainty_sustained"],
        "states": ["exploring"],
        "sensitivity": 0.5,
        "frequency": "medium"
      },
      "action": { "tool": "mycelium_walk", "args": {} }
    },
    {
      "id": "frustration_alert",
      "type": "status_notify",
      "mode": "notify",
      "trigger": {
        "signals": ["frustration_spike", "compound_frustration_hunger"],
        "states": ["stuck"],
        "sensitivity": 0.8,
        "frequency": "low"
      },
      "action": { "message": "frustration 持続中 — アプローチの変更を検討" }
    }
  ]
}
```

### 宣言フィールド

| フィールド | 型 | 意味 |
|-----------|-----|------|
| `id` | string | メソッド一意識別子 |
| `type` | string | メソッドのカテゴリ。learnedDelta の粒度 (同 type で学習共有) |
| `mode` | enum | 配信モード (下記参照) |
| `trigger.signals` | string[] | 反応する FireSignalKind のリスト |
| `trigger.states` | string[] | 反応する AgentState のリスト |
| `trigger.sensitivity` | number (0-1) | トリガ感度。開発者が手動で調整する係数 |
| `trigger.frequency` | "low" \| "medium" \| "high" | 発火頻度の許容度 |
| `action` | object | 実行内容 (tool 呼び出し or メッセージ) |

### 宣言からスコアへの内部変換

```
sensitivity 0.7  → minIntensity threshold を逆算
frequency "low"  → recencyDecay の減衰定数を厳しく (連発防止)
signals 一致     → スコア +1.0 / 不一致 → +0.0
states 一致      → スコア ×1.0 / 不一致 → ×0.3 (抑制だが完全排除はしない)
```

開発者は「何を」「いつ」「どれくらい敏感に」「どの頻度で」を宣言するだけ。
スコアリングの数理は passive receptor の内部に閉じる。

---

## 2. 配信モード

メソッドごとに開発者が指定する。

| mode | 挙動 | エージェント体験 | 用途例 |
|------|------|-----------------|--------|
| `auto` | スコア超過で即実行、結果を直接返す | 次の engram_watch に結果が含まれる | engram_probe, mycelium_walk |
| `ask` | 推奨を提示、エージェントが承認/却下 | 「probe 実行しますか？理由: hunger 0.87」 | コスト高い操作、外部 API |
| `notify` | 通知枠に蓄積のみ、実行しない | 「frustration 持続中」を表示 | 状態通知、警告 |
| `background` | バックグラウンド実行、結果を MCP 状態に反映 | エージェントは気づかない、次の watch で見える | プリフェッチ、キャッシュ |

### 配信モードと learnedDelta の関係

| mode | 学習信号 | 信号の質 |
|------|---------|---------|
| `ask` | 承認/却下が直接 falsePositiveRate に反映 | 最高 (明示的判断) |
| `auto` | 結果がエージェントに使われたかの暗黙観測 | 中 (間接的) |
| `background` | 結果がエージェントに使われたかの暗黙観測 | 中 (間接的) |
| `notify` | 学習信号なし | なし |

---

## 3. スコアリング

```
score(method, signal) =
    signalMatch(method.trigger.signals, signal.kind)
  × stateMatch(method.trigger.states, signal.agentState)
  × signal.intensity
  × method.trigger.sensitivity        // 手動 (開発者)
  × (1 - falsePositiveRate(method))   // 自動 (learnedDelta)
  × recencyDecay(method, frequency)   // 連発防止
```

### 二層校正 — 手動と自動の分離

| 層 | 変更者 | 速度 | 永続先 |
|----|--------|------|--------|
| sensitivity | 開発者 (エージェント経由) | 即座 | receptor-rules.json |
| learnedDelta | 自動観測 (adopt/dismiss) | 漸進 | 別ファイル (receptor-learned.json) |

sphere の二層構造と同原理:
- `sensitivity` = `base_bias` (開発者の意図、不変の設計)
- `learnedDelta` = `learned_δ` (環境の適応、bounded ±0.3)

原則: **開発者の意図と環境の学習を混ぜない**。

---

## 4. learnedDelta — 解釈層の自己校正

### 居場所

learnedDelta は neuron 内部（入力ゲイン、閾値）には **触らない**。
解釈層のスコアリングに乗算として適用する。

### 廃案: 入力ゲイン調整

PREDICTIVE_INFERENCE.md の三層原則:
> C (Meta): B の閾値を調整。**直接ゲインを操作しない**

learnedDelta もこの原則を継承する。neuron は純粋なセンサーとして保つ。
「センサーが何を感じたか」は変えない。「感じたことにどう反応するか」を調整する。

### 学習信号

| 信号源 | 効果 | コスト |
|--------|------|--------|
| エージェントが出力を採用した | falsePositiveRate 維持/低下 | ゼロ (観測) |
| エージェントが dismiss/無視した | falsePositiveRate 上昇 | ゼロ (観測) |
| エージェントが直接スコア付与 | 即座に補正 | 手動 |

### 粒度

`type` フィールド単位で蓄積する。メソッド個別ではなく `knowledge_search` 型全体の
falsePositiveRate を共有すれば、同種メソッドが追加されても学習が引き継がれる。

### 前例

| プロジェクト | 構造 | 適用先 |
|-------------|------|--------|
| sphere | `effective = base × (1 + δ)`, δ ±0.3, Digestor が校正 | flagBias, returnWeights, qualityVector |
| mycelium | `personality × feelings → actionProbs` | personality 行列 (immutable, 将来の δ 候補) |
| receptor | `score × (1 - falsePositiveRate)`, エージェントが校正 | 解釈層トリガスコア |

---

## 5. A gate の排他制御

flow_active が発火している間、passive receptor は**一切のメソッドを実行しない**。
A neuron の不可侵性を解釈層でも尊重する。

```
if signals.any(s => s.kind === "flow_active"):
  return []   // 全抑制
```

deep_work (C label) は完全抑制ではなく、state 不一致による ×0.3 の抑制。
flow_active (A gate) だけが排他的な遮断。

---

## 6. 接続点

現在の receptor は `onSignal(listener)` で FireSignal[] を配信する仕組みが
既に存在する (`receptor/index.ts` L38-43)。

Passive Receptor はこの listener として登録し、毎イベント:
1. rules.json のメソッド群を走査
2. スコアリング
3. threshold / 確率選出
4. mode に応じた実行

---

## 7. アーキテクチャ原則 — 内部メソッドも登録制

### engram/mycelium に特権を与えない

engram_pull や mycelium_walk は同一プロセス内に存在するが、
passive receptor から見れば **他の外部メソッドと同じ rules.json 経由** で登録される。

```
passive receptor (スコアリング + 選出のみ)
       |
       v
  method resolver (action の type を見て振り分け)
       ├── tool: "engram_pull"   → 内部呼び出し (たまたま同一プロセス)
       ├── tool: "mycelium_walk" → MCP 呼び出し
       └── tool: "custom_hook"   → shell command / HTTP
```

passive receptor は呼び出し先が同一プロセスかどうかを知らない。
実行の振り分けは method resolver の責務。
これにより初期テスト (engram/mycelium) と将来の外部メソッド追加で作法が変わらない。

---

## 8. 将来構想 — 細胞モデル

### Passive Receptor を包括する「細胞」

passive receptor は単なるスコアリング機ではなく、
**自己更新する生物的システムの一部** として位置づける。

```
Cell (名前未定)
  ├── state: CellMetrics        ← 自身の状態 (活性度, 学習蓄積, 疲労...)
  ├── active receptor           ← neuron A/B/C (感覚器 — 入力)
  ├── passive receptor          ← 解釈層 (行動選択)
  ├── method resolver           ← 実行 (外部委譲)
  └── feedback loop             ← 結果 → state 更新 → 感度変化
```

mycelium ノードとの構造対応:

```
mycelium node:
  metrics → computeFeelings → personality × feelings → action → 結果 → metrics 更新

receptor cell:
  neuronSignal → passive receptor → method → 結果 → cellState 更新
```

細胞は行動結果で自身の状態を変える。
probe を実行してエージェントが採用すれば「有用だった」が蓄積し、次の判断に影響する。

### 独立 MCP サーバとしての分離可能性

method resolver が外部委譲に対応すれば、
neuron + passive receptor + method resolver は engram/mycelium に依存しない
**純粋な行動監視・自律応答 MCP サーバ** として機能し得る。

任意の MCP ツール、HTTP エンドポイント、shell command を
receptor-rules.json に登録するだけで接続できる汎用基盤。

現時点では engram 内に同居するが、アーキテクチャ上の分離は維持する。

---

## 9. 未決定事項

- スコアの threshold 値（auto 実行の最低スコアはいくつか）
- 確率選出か threshold cut か、あるいは両方か
- receptor-learned.json のフォーマットと永続化タイミング
- sensitivity の変更 API（engram_tune 相当の MCP ツール）
- 複数メソッドが同時にスコア超過した場合の排他制御
- `ask` モードの承認/却下をどう受け取るか（MCP ツール? watch の引数?）

---

## 関連ドキュメント

- `RECEPTOR_ARCHITECTURE.md` §10 — learnedDelta 設計決定
- `PREDICTIVE_INFERENCE.md` §learnedDelta, §配信モード — 原案
- sphere `reports/LEARNED_WEIGHT_DESIGN.md` — 二層構造の前例
- mycelium `docs/MYCELIUM_DESIGN_DRAFT_20260305.md` — assess() の構造
- mycelium `docs/NODE_AS_AGENT_DISCUSSION_20260305.md` — personality × feelings
