# Multi-Agent Vision — Brain AI, Quantum Nodes, and Fractal Architecture

> 未来構想ドキュメント。実装済みの receptor/persona/prior-block を基盤に、異種 AI 協調とスケーラブルなオーケストレーションを構想する。

**関連ドキュメント:**
- [RECEPTOR_ARCHITECTURE.md](./RECEPTOR_ARCHITECTURE.md) — 三層ニューロンモデル（実装済み）
- [DATA_COST_PROTOCOL.md](./DATA_COST_PROTOCOL.md) — DCP 設計（実装済み）
- [PERSONA_LOADING_SYSTEM.md](./PERSONA_LOADING_SYSTEM.md) — Experience Package（計画中）

---

## 1. 本来のマルチエージェント

現在「マルチエージェント」と呼ばれているものは同質の LLM 群が役割分担しているだけ。本来のマルチエージェントは異なるドメイン AI の協調。

```
現在:  LLM-A(コード) ←自然言語→ LLM-B(レビュー) ←自然言語→ LLM-C(テスト)
       → 同種の知能が役割を分けているだけ

本来:  自動運転AI ←?→ ロボティクスAI ←?→ 言語AI ←?→ 視覚AI
       → 異種の知能体系の協調。共通言語がない
```

同じ Claude Code を複数ウィンドウで開いて receptor の signal を共有しても、同じドメイン・同じ行動語彙だからノイズが増えるだけ。メッセージパッシングが有意味になるのは **異種ドメイン AI が協調している場面** に限られる。

---

## 2. Emotion Delta が Lingua Franca になる

異種ドメイン AI には共通言語がない。自動運転の制御コマンドとロボティクスのモーターコマンドは相互翻訳できない。しかし **frustration, seeking, confidence, fatigue, flow の 5 軸はドメイン非依存**。

```
自動運転AI:    "frustration +0.3" → 何かに行き詰まった
ロボティクスAI: 何に行き詰まったかは知らない。
                行き詰まっていることは理解できる。
                → 支援行動を取る判断材料になる
```

自然言語ではなく数値。Data Cost Protocol が理想とする native 通信の実現形。

---

## 3. Brain AI — 三層フラクタルアーキテクチャ

### 個体の内部構造がスケールする

receptor の三層ニューロンモデル（A/B/C）がマルチエージェントの外部構造にフラクタル的に再現される。

```
個体内部 (receptor)          マルチエージェント (Brain AI)
─────────────────────        ─────────────────────────────
A層 (Flow Gate)              Brain AI
  観測だけ。介入しない         純粋な観測。判断しない。
  flow 中は全介入を抑制        「全体がどういう状態か」だけを見る

B層 (Emotion Engine)         Dispatcher
  閾値で信号を振り分ける       可能性の配分。Brain の観測を受けて
  動的 baseline で適応         各子 AI に候補指示を割り振る
                               まだ実行されない — 準備状態

C層 (Meta Neuron)            Child AIs
  フィールドを発する           Brain が決定トリガ
  B の閾値を間接調整           → Dispatcher が実行デスパッチ
                               → 各子 AI の状態確定
```

### スケールする理由

- Brain AI は**観測だけ**に専念。最高性能モデルのコストを判断や実行に浪費しない
- Dispatcher は**ルーティングだけ**。ルールベースで十分。LLM すら不要かもしれない
- 子 AI は**自律的に動く**。確定した状態の中で独自に receptor を回す

Brain AI のコストは「観測サイクルの頻度 × 観測1回のコスト」だけ。子 AI が N 体に増えても Brain のコストは線形に増えない — Dispatcher が吸収する。

### Brain AI の視界

```
Brain AI の視界:

  receptor A (コーディング): exploring, seeking+0.35
  receptor B (設計 AI):      deep_work, confidence+0.20
  receptor C (テスト AI):    stuck, frustration+0.40  ← 介入判断
```

Brain AI は各ドメインの receptor から Live Experience Fragment を受け取り:

- **進捗監視** — 各 AI が何をしていて、どういう状態か
- **相関検出** — A の成果が C の行き詰まりを解決するか？B の設計変更が C の原因か？
- **介入判断** — いつ、どの AI に、何を渡すか
- **オーケストレーション** — ドメイン横断の意思決定

### Live Experience Fragment

receptor 発火時に送信するのは感情情報だけではない。Experience Package の部分情報 — 作業の進捗監視に必要なコンテキストを含む。

```
Live Experience Fragment (receptor → Brain AI):
  emotion:     [0.08, 0.35, 0.45, 0.12, 0.60]   // 5軸の現在値
  agentState:  "exploring"                         // 現在の行動状態
  hotPaths:    ["receptor/learn.ts", ...]          // 何を触っているか
  stateFlow:   "idle→exploring→deep_work"         // ここまでの軌跡
  recentArc:   [["A", ...], ["A", ...]]           // 直近の arc points
```

Experience Package の **ストリーミング版** — セッション終了を待たず、発火のたびに部分情報が流れる。Data Cost Protocol compact JSON でそのまま送信。

### 通信は登録メソッドの1つにすぎない

receptor の本質は変わらない — **発火 → 登録済みメソッド群を実行 → そのドメイン AI の作業を助ける**。Brain AI への通信は特別な通信層ではなく、method resolver + executor にそのまま載る汎用メソッドの1つ。

```
receptor-rules.json (コーディング AI):
  - path_suggest      → ファイル推薦（ドメイン固有）
  - future_probe      → 予測知識供給（ドメイン固有）
  - action_logger     → 行動記録（ドメイン固有）
  - signal_relay      → Brain AI に Live Fragment 送信（汎用通信）
```

`signal_relay` は `path_suggest` と同列。passive scorer がスコアリングし、閾値を超えたら発火し、executor が実行する。通信もまた「発火で駆動される機能」。

---

## 4. 量子ノード — DCP による多層履歴の重ね合わせ

### 古典的アプローチの問題

```
AI-A ログ → 集約 → 解析 → レポート
AI-B ログ → 集約 → 解析 → レポート
AI-C ログ → 集約 → 解析 → レポート
→ 3つのレポートを読み比べる。N × 解析コスト。重い。
```

### 量子ノード案

```
AI-A 履歴 (DCP compact) ──┐
AI-B 履歴 (DCP compact) ──┼→ シャローコピーで重ねる → 1つの量子ノード
AI-C 履歴 (DCP compact) ──┘
→ Brain AI がクエリ角度で射影 → 必要な解釈だけ浮かぶ
→ 解析コストはクエリ時のみ。事前集約不要。
```

DCP だからこそ成立する。スキーマが共通だから構造的に重ね合わせ可能:

```
同一時刻 t=1200 の3ドメインの状態:
  AI-A: ["A", 1200, 0.3,  "stuck",      0.42, ...]  ← コーディング
  AI-B: ["A", 1200, -0.1, "exploring",  0.28, ...]  ← 設計
  AI-C: ["A", 1200, 0.5,  "deep_work",  0.60, ...]  ← テスト
```

自然言語なら重ねられない — フォーマットがバラバラでノイズの山になる。positional array + 共通スキーマだから、同一座標系に並ぶ。

### 量子ノードの構造

```
quantum_node = {
  schema_table: { ... }           // 共有スキーマテーブル（実体は1つ）
  layers: [
    { source: "receptor-A", ref: → AI-A 履歴 },   // シャローコピー（参照のみ）
    { source: "receptor-B", ref: → AI-B 履歴 },
    { source: "receptor-C", ref: → AI-C 履歴 },
  ]
}
```

実体はコピーしない。スキーマテーブルと参照だけ持つ。Brain AI が処理した各レイヤーの解釈結果もスナップショットとして蓄積される。

### クエリによる射影

```
クエリ: 「テスト失敗の原因は？」

Brain AI が量子ノードを射影:
  → layer C (テスト): t=1200 で frustration spike、stuck 状態
  → layer A (コーディング): t=1180 で file_edit、receptor/learn.ts を変更
  → 相関発見: 「A が編集した 20ms 後に C が stuck になった」
  → layer B (設計): t=1200 は deep_work、confidence 高 → 設計側に問題なし

クエリ: 「設計の品質は？」

同じ量子ノードを別角度で射影:
  → layer B が主に浮かぶ
  → layer A, C は背景情報
```

同じデータ、同じノード。クエリの角度で見え方が変わる。これが Sphere ノードの「触る人間によって反応を変える」概念の、Brain AI レベルでの実現。

### DCP がなければ成立しない理由

```
自然言語履歴:  重ねると混沌。スキーマがない。時刻の対応付けが曖昧。
JSON 履歴:     重ねられるが重い。キーが毎行付くから N 倍のコスト。
DCP 履歴:      スキーマ共通、positional array、軽量。重ねてもコスト増は参照分のみ。
```

量子ノードは DCP の軽量性なしには実用的でない。

### 「量子」メタファーの射程

量子力学では観測が状態を確定させる（波動関数の収縮）。量子ノードでは「クエリ角度で見え方が変わる」が、全レイヤーのデータは常に確定している。変わるのは注意の配分であって状態ではない。これは multi-view indexing であって superposition ではない。

ただし、メタファーを本物に近づける方法がある:

```
Brain AI の指示（視点）によって
  → 登録 AI が自身の状態を確定させる
  → 作業モード、receptor チューニング、Persona レンズが変わる
  → 指示前: 複数のチューニング候補を持つ（重ね合わせ）
  → 指示後: 1つに確定する（収縮）
  → 異なる指示なら異なる確定状態になる（観測依存）
```

動的チューニングレイヤー = Persona の `applyLens()` を外部から注入する口。Brain AI がレンズを選んで渡す — 「観測による状態確定」が実装レベルで成り立つ。

---

## 5. スキーマテーブル事前保持

Brain AI は複数ドメインの receptor から異なるスキーマのデータを同時に受信する。毎回 `"$S"` を parse するのではなく、起動時にスキーマテーブルを保持する:

```
Brain AI schema_table (メモリ常駐):
  "prior-arc":  ["type","t","valence","state","intensity","fru","seek","conf","fati","flow","link"]
  "live-frag":  ["emotion","state","hotPath","entropy","ts","projectId"]
  "control":    ["command","target"]

ストリーム受信:
  "$S" 行 → schema_table を更新（新スキーマ or バージョン変更時のみ）
  データ行 → 先頭要素で schema_id を引き、即 parse。コストほぼゼロ
  "$V" 行 → 検証プロセスに転送（メイン処理を止めない）
```

HTTP/2 の HPACK（ヘッダテーブル事前共有）と同じ作法。

---

## 6. メッセージングとデータプール

### 2層アーキテクチャ

DCP はデータのエンベロープに徹する。ルーティングと非同期はインフラ層に任せる。

```
高速層:  Queue（宛先明確、即時解決、使い捨て）
蓄積層:  Sphere/Engram（意味検索、代謝、長期参照）
```

DCP はどちらのペイロードにもなれる。載せるインフラが違うだけ。

### Sphere をメッセージプールにしない

Sphere はセマンティック近傍検索が必要な時に使う。宛先が明確で即時解決が必要なメッセージにベクトル検索も代謝も要らない。

高速メッセージングのインフラには Redis Streams や NATS のような軽量キューが適切。判断基準は「このデータに近傍検索の価値があるか」— あれば Sphere、なければ Queue。

### 蓄積パターン: バッファ → セントロイド → Sphere

個別メッセージは Queue で即時解決。Sphere に入るのは通信の痕跡:

```
高速層の N メッセージ
  → バッファ + フィルタリング
  → セントロイド化（期間内の要約ベクトル）
  → Sphere に「通信パターンノード」として投入
  → 「このエージェント群は最近こういう通信をしていた」
```

action_log が「個別ツール呼び出し」を記録し、Experience Package が「セッション全体の体験」を記録するのと同じ構造。

---

## 7. 統合 Receptor — 体験の相関検出

```
自動運転AI → receptor-a → SessionPoint stream ─┐
ロボティクスAI → receptor-b → SessionPoint stream ─┼→ 統合観測層
言語AI → receptor-c → SessionPoint stream ─┤
視覚AI → receptor-d → SessionPoint stream ─┘
                                                    │
                                              ┌─────┴─────┐
                                              │ 相関検出器  │
                                              └─────┬─────┘
                                                    │
                                          システム全体の Prior Block
```

pub/sub に似るが本質が違う。pub/sub はメッセージの配信。これは **体験の相関検出**。

| | pub/sub | 統合 receptor |
|---|---|---|
| 流れるもの | メッセージ（命令・データ） | SessionPoint（体験の点） |
| 目的 | 配信と処理 | 相関と文脈の発見 |
| 購読者が得るもの | 他者の出力 | 他者の体験構造 |
| 時間構造 | イベント単位 | 起伏線（delta 時系列） |

### 異種ドメイン間の共鳴検出

```
t=100: 自動運転AI — stuck (frustration +0.3)
t=102: 視覚AI — seeking 急騰 (+0.4)
t=105: 自動運転AI — exploring (frustration -0.2, confidence +0.15)

→ 相関: 自動運転の行き詰まりと視覚 AI の探索が連動
→ 知見: 視覚 AI の探索が自動運転の突破を支援した
→ メッセージログからは見えない。体験の時間構造を並べて初めて見える
```

### Prior Block の拡張

```
個体 Prior Block:  「前回の自分」を知っている → 個体の連続性
統合 Prior Block:  「前回のチーム」を知っている → システムの連続性
```

### ボトムアップ種族分類の拡張

```
個体レベル:    delta パターン → 個体の種族（探索型、集中型...）
システムレベル: ドメイン間相関パターン → チームの種族
               「視覚主導型チーム」「言語仲介型チーム」...
```

---

## 8. クロッキング問題

量子ノードの時刻対応付けは自明ではない。各エージェントの時間軸がずれる。

Brain AI の観測サイクルが全 Agent の同期点になる可能性:
- wall clock 方式: 全 Agent が物理時刻で同期
- フィールド時間: Brain AI の観測間隔がクロック（累積作業時間ベース）
- Brain AI サンプリング: 観測が同期点を作る — 時刻対応付けは「Brain AI のサンプリング頻度」に帰着

協調型 AI の課題として残る。

---

## 9. Receptor アダプタ層

### AI Runtime 行動ログ標準の不在

MCP は tool 接続、A2A は agent 間通信を標準化した。しかし **agent の内部行動ログの標準** は誰も定義していない。

```
MCP:  tool 呼び出しの標準 → 存在する
A2A:  agent 間通信の標準 → 存在する
???:  agent 内部行動ログの標準 → 存在しない
```

### アダプタ層を薄いシムとして割り切る

```
アダプタ層:   汚い。ドメイン固有。デベロッパー依存。壊れやすい。
              → しかし薄い。書き捨てられる。
receptor core: 純粋。ドメイン非依存。数理的。不変。
              → 蓄積、delta、SessionPoint、Prior Block
```

標準がないことを弱みではなく **多様性の源泉** と割り切る。

### ドメイン別アダプタ

```
Claude Code:     PostToolUse hook → emotion-profile.json → receptor core
Copilot:         VSCode Extension API (accept/reject) → copilot-profile.json → receptor core
自動運転:        action log adapter → driving-profile.json → receptor core
ロボティクス:    motor log adapter → robotics-profile.json → receptor core
マルチモーダル:  modality adapter → modal-profile.json → receptor core
```

receptor core への入力は最小構造: `{ action, result, timestamp }` 程度。各アダプタはその形に変換するだけ。

### 非 LLM ドメイン: 時間ウィンドウ積分

LLM は tool call という明確な離散イベントがある。他ジャンルの AI は連続的な行動ループで動いており、「1イベント」の境界が自明でない。

```
パターン A: イベント離散化（LLM 向き）
  1 tool call = 1 NormalizedEvent

パターン B: 時間ウィンドウ積分（非 LLM 向き）
  連続行動の t ms ウィンドウを切る
  → ウィンドウ内の信号分布を集計
  → セマンティックラベルを付与
  → 1 NormalizedEvent として emit
```

時間ウィンドウ積分は「非 LLM 向けの将来機能」ではない。LLM receptor のコアに既に複数箇所で採用されている設計パターン（Commander, AmbientEstimator, SessionPoint freq, Future Probe, Heatmap decay, Persona finalize）。非 LLM 展開はウィンドウ幅とラベル体系の差し替えであり、新しいアーキテクチャではない。

### Experience Package のポータビリティ

```
Prior Block:  体験データ。consumer の目的関数に対して中立。どの AI でも自然に読める
Persona:      身体性データ。receptor + emotion-profile に密結合。同一アーキテクチャでないと適用できない
```

**Prior Block は portable、Persona は non-portable** — これが本質。異種 AI は Prior Block だけ取得し、自分の receptor で再解釈する。

---

## 10. Brain AI の通信経路設計

### 2系統の下位経路

Brain AI の直下に2つの系統が存在する:

```
Brain AI
  ├── Receptor 経路（観測・フィールド・レンズ）
  │     感情データの受信、場の調整、レンズ注入
  │     → 推論コスト低。数値処理中心。常時稼働
  │
  └── Method 経路（実務指示・タスク割当）
        具体的な作業指示、成果物の受け渡し
        → 推論コスト高。判断が必要。イベント駆動
```

### 上り経路（子 AI → Brain AI）

```
signal_relay:   receptor 発火連動。DCP compact で Live Fragment を送信
                → Receptor 経路に入る。Brain の観測入力
task_report:    作業完了報告。成果物への参照を含む
                → Method 経路に入る。次のタスク割当の判断材料
escalation:     自力解決不能。Brain に判断を要求
                → 両経路に入る。感情状態（stuck）+ 具体的な問題内容
```

### 下り経路（Brain AI → 子 AI）

```
field_adjust:    ambient baseline をシフト。全子 AI に効く。最軽量
                 → 個体の Meta neuron C がフィールドを発するのと同じ
lens_inject:     特定の子 AI にレンズを差し替え。applyLens() 経由
                 → 状況変化時。翻訳レイヤがレンズ候補からホットローディング
task_assign:     具体的な作業指示。対象の子 AI を指名
                 → Brain の推論が必要。最もコストが高い
resource_share:  他の子 AI の成果物を渡す。Brain が仲介
                 → A の成果を C に渡して行き詰まりを解消する等
```

### 緊急度によるコスト階層

```
日常:      field_adjust（場の維持）        → コスト最小。推論不要
状況変化:  lens_inject（レンズ差し替え）   → 中コスト。レンズ選択の判断
タスク完了: task_assign + resource_share    → 中〜高コスト。次の判断
緊急:      escalation → 直接介入            → 最大コスト。Brain が推論
```

### 翻訳レイヤの役割拡大

翻訳レイヤは入力翻訳（子 AI の独自スキーマ → Brain の統一スキーマ）だけでなく、出力側も担う:

```
入力側:  子 AI の DCP → スキーマ変換 → Brain の統一スキーマ
出力側:  Brain の観測結果 → レンズ候補プールから選択 → ホットローディング
キャッシュ: 過去のレンズ適用結果を保持 → 類似状況で再利用
```

Dispatcher（セクション3の B層対応）とほぼ同一の機能。フラクタル構造が通信設計にまで及ぶ。

### 未解決: 経路の統合 or 分離

Receptor 経路と Method 経路を物理的に分離するか、単一チャネルでメッセージタイプで分岐するか。これは実装時の判断。概念的には分離が明確だが、実装コストとの兼ね合い。

---

## 11. 設計の優先順位

```
今やること:        receptor core の堅牢化
待つこと:          アダプタの標準化（業界が動くまで）
必要な時にやること: 個別アダプタの実装（薄いシム）
```

同じパターンがスケールで繰り返される時、それは偶然ではなく構造的に正しい。個体の三層構造がマルチエージェントの三層構造にフラクタル的に再現される — これが設計の正しさの証拠。

---

*言語を appreciate し過ぎている。しかし一応人間なので、橋は残しておく。*
