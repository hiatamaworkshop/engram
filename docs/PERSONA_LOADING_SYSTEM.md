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
  string,       // stateFlow: macro state trajectory (contrastive pair)
];
// 例: ["H", 3420000, 0.3, 0.05, 0.30, 0.15, 0.02, 0.10, "idle→exploring→stuck→deep_work→exploring"]
// → 57分セッション、やや positive、seeking 優位で開始、行き詰まりを経て探索に戻った軌跡
```

`dominant persona axis` (string) と `dominant agent state` (string) を廃止。
初期 emotion vector の 5 値がそれを数値的に表現する — seeking=0.30 が最大なら dominant axis は seeking と自明。

**stateFlow**: セッション全体の agentState 遷移を連続的な重複を除去して連結したもの。Header に含めることで、Arc の詳細を読む前にセッションの全体像（対比ペア）が伝わる。Header の初期 emotion + stateFlow で「どこから始まり、どう動いたか」が1行で語られる。

**initial emotion state の取得:** 前セッション終了時の emotion state（最後の persona-snapshot の emotion vector）。セッション「開始時の感情」は存在しない — 存在するのは「前セッション終了時の感情」であり、それが次のセッションの出発点。Arc の最初の点が absolute で記録されるため、Header の値と一致する。

#### Arc（経過 — 起伏線本体）

全点を渡す。間引きはしない（Phase 1 では生データが最重要）。

```typescript
type PriorArcPoint = [
  "A",          // type marker
  number,       // t: cumulative work time (ms)
  number,       // gapMs: time since previous point (ms)
  string,       // agentState: stuck/exploring/deep_work/idle
  number,       // intensity: 0.0-1.0
  // per-axis delta (first point: absolute values, subsequent: delta from previous)
  number,       // dFrustration
  number,       // dSeeking
  number,       // dConfidence
  number,       // dFatigue
  number,       // dFlow
  string | null, // engram nodeId (nullable)
];
// 例: ["A", 180000, 45000, "exploring", 0.6, -0.12, 0.35, 0.08, 0.01, 0.02, null]
// → 3分地点、exploring 中、seeking +0.35 急騰 + frustration -0.12 下降 = 行き詰まりからの脱出
```

**フィールド改定 (2026-03-22):**

| 廃止 | 理由 |
|---|---|
| `label` (string) | 発火ラベルは delta から導出可能。delta の最大軸 = 支配的な変化 |
| `valence` (+1/0/-1) | 3 値の粗い分類。delta の符号パターンが連続的な valence を表現 |
| `freq` | intensity と情報が被る。delta で十分 |

| 追加 | 理由 |
|---|---|
| `agentState` | 行動文脈。delta からは導出不能。delta と組み合わせて意味が増幅 |
| `delta×5` | 感情がどう動いたかの実体。label より精密 |
| `engram nodeId` | 「何に対して」感情が動いたかの文脈。Footer の weight 分布と紐づく |

| 保留 | 理由 |
|---|---|
| `pattern` (trial_error 等) | agentState と情報が被る。蓄積データで有意差があれば後で追加 |

**delta vs absolute emotion vector:**
- delta だけで良い。absolute は delta の累積で復元可能（最初の点が absolute）
- delta のほうが変化を直接表現する — 「seeking +0.35」は absolute 0.65 より体験の質を語る
- トークン数が半分（5 値 vs 10 値）

**agentState + delta の組み合わせが体験を語る:**

```
"stuck"      + [+0.30, -0.10, -0.15, +0.08, -0.20] → 行き詰まりが深まった
"exploring"  + [-0.12, +0.35, +0.08, +0.01, +0.02] → 行き詰まりから脱出して探索
"deep_work"  + [-0.05, +0.02, +0.20, +0.03, +0.40] → 集中状態に入った
```

agentState は「何をしていたか」、delta は「どう感じたか」、engram nodeId は「何について」。

gap が「時間の厚み」。gap 長 = 静穏、gap 短 = 連続反応。配列の並び順が時系列そのもの。

点の密度が体験の重みを自然にエンコードする。密集区間 = 多くのトークンを消費 = attention が集中。追加の重み付けは不要。

#### Footer（結果 — 俯瞰統計 + weight 分布）

```typescript
type PriorFooter = [
  "F",                          // type marker
  number[],                     // finalEmotion[5]: session end emotion state
  number[],                     // stats[events, activeMs, arcPts, maxI, meanI]
  Array<[string, number]>,      // stateRatio: ranked desc, zero-ratio omitted (negative anchor)
  Array<[string, number]>,      // engramTop: [summary, weight] pairs (weight desc)
];
// 例: ["F", [0.08,0.15,0.45,0.12,0.35], [18,245000,18,0.9,0.52],
//      [["deep_work",0.5],["exploring",0.3],["stuck",0.1],["idle",0.1]],
//      [["Data Cost dual-field",1.8],["receptor SessionPoint",1.2]]]
```

**Footer の4ブロック:**
1. **finalEmotion**: セッション終了時の emotion state。Header の初期値との差がセッション全体の変化量
2. **stats**: 統計概要。events=シグナル発火数、activeMs=実作業時間、maxI/meanI=intensity の範囲
3. **stateRatio**: agentState 分布を**ランク順ペア**で表現。ゼロのモードは省略される — 不在が否定マーカーとして機能する（例: `delegating` がない = 委譲行動なし）。ランク表現は LLM が解釈しやすい — `0.34` と `0.37` の差は無視されるが「1位 vs 2位」は明確
4. **engramTop**: 参照された知識の weight 分布。summary (string) は数値化できない human index — Data Cost Protocol の「summary 一行が最後の橋」に該当

### 完全な Prior Block の例

```
[prior-block: prior session experience. use as context for continuity.]
[schema: H=header(durationMs,valenceBalance,frust,seek,conf,fatigue,flow,stateFlow) A=arc(t,gapMs,agentState,intensity,dFrust,dSeek,dConf,dFatig,dFlow,engramId?) F=footer(finalEmotion[5],stats[events,activeMs,arcPts,maxI,meanI],stateRatio[...[state,ratio]desc],engramTop[...[summary,weight]]) ---=separator]
[["H",3420000,0.3,0.05,0.30,0.15,0.02,0.10,"idle→exploring→deep_work→stuck→exploring→deep_work→idle"],["---"],["A",0,0,"idle",0.2,0.05,0.30,0.15,0.02,0.10,null],["A",60000,60000,"exploring",0.4,-0.05,0.03,0.18,0.02,0.04,null],["A",180000,45000,"exploring",0.6,-0.12,0.35,0.08,0.01,0.02,null],["A",320000,20000,"deep_work",0.9,-0.08,0.05,0.10,0.03,0.40,"abc123"],["A",380000,30000,"deep_work",0.7,-0.02,0.01,0.15,0.04,0.05,null],["A",500000,60000,"stuck",0.5,0.30,-0.10,-0.15,0.08,-0.20,null],["A",580000,15000,"exploring",0.8,-0.20,0.40,0.05,0.02,0.10,"def456"],["A",700000,40000,"deep_work",0.6,-0.05,0.02,0.08,0.03,0.20,null],["A",800000,50000,"idle",0.3,-0.03,0.01,0.10,0.05,0.02,null],["---"],["F",[0.08,0.15,0.45,0.12,0.35],[9,800000,9,0.9,0.56],[["deep_work",0.44],["exploring",0.33],["stuck",0.11],["idle",0.11]],[["Data Cost dual-field design",1.8],["receptor SessionPoint schema",1.2]]]]
```

3行構成: **マニフェスト → スキーマ → データ**。10 点で約 **150-170 トークン**。自然言語の 1/3 以下。

読み方:
- マニフェスト: データの意図を宣言（context priming）
- Header: 57分セッション、seeking 優位で開始、`idle→exploring→deep_work→stuck→exploring→deep_work→idle` の軌跡
- t=0: 最初の点は absolute emotion（frustration=0.05, seeking=0.30, ...）
- t=500000: `"stuck"` + frustration +0.30, flow -0.20 → 行き詰まりが発生
- t=580000: `"exploring"` + seeking +0.40, frustration -0.20 + engram `"def456"` 参照 → 知識を引いて脱出
- Footer: 終了時 confidence=0.45, flow=0.35 が高い。deep_work が44%で1位。`delegating` が不在 = 委譲なし
- `"abc123"`, `"def456"` は Footer の engramTop と紐づく

**agentState が文脈、delta が変化、engram link が対象。三つで体験の質を語る。**

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

### マニフェスト行 — データの意図を宣言する (2026-03-22)

LLM はデータを渡されても、それをどう使うかの動機がなければ薄くしか解釈しない（attention は均等に薄く張られる）。データの冒頭に「これは何で、どう使うべきか」を1行で宣言する。

```
現在:
  [prior-block schema: H=header(...) ...]
  [["H", ...], ...]

提案:
  [prior-block: prior session experience. use as context for continuity.]
  [schema: H=header(...) A=arc(...) F=footer(...) ---=separator]
  [["H", ...], ...]
```

- **マニフェスト**: データの性質と使い方の焦点を設定（context priming）
- **スキーマ**: データの構造を記述
- **データ**: Prior Block 本体

マニフェストは Data Cost Protocol の「summary 一行が最後の橋」と同じ位置。スキーマがデータの構造を教え、マニフェストがデータの**意図**を教える。

文言は恣意的に見えるが、LLM にとっては「このデータをどの角度から見るか」の焦点設定。焦点がないとデータは均等に薄い。焦点があると特定の解釈が優先される。

**文言はテスト後に精度を詰める。** 候補:
- `prior session experience. use as context for continuity.`
- `you are continuing a previous session. this data is your prior experience.`
- より直接的 / より間接的なバリエーションを比較検証

### LLM の attention とマルチインデックスデータ (2026-03-22)

LLM の attention は入力全体に対して並列に計算される。人間のように「1つの角度から見て、次の角度に切り替える」逐次処理ではない。

```
人間:  観点を選ぶ → 精密に見る → 別の角度に切り替える（逐次的、切り替えコストあり）
LLM:   全角度が同時に薄く見えている → 質問が来ると特定角度が鮮明になる（並列的）
```

マルチインデックスデータは「どの角度からでもすぐに焦点を合わせられる」複数の入口を提供する。LLM には角度切り替えコストがないため、マルチインデックスは特に効果的。

Prior Block を渡しただけでは「前セッションの雰囲気がコンテキストにある」程度。作業中に前セッション関連の判断を求められた時、Prior Block の特定部分に焦点が合う。**これが Phase 1「搭載するだけで効く」の実態 — 必要な時に必要な角度から引ける状態にしておく。**

### 推論コストの制約 (2026-03-22)

MCP ツール呼び出しは同期的。内部で非同期処理があっても、LLM から見ると「呼んで→結果が返る」の1往復。Prior Block を1回の engram_watch 応答に全て含めれば推論コスト1回。

3段階に分けた提示（Header → Arc → Footer を別ターンで渡す）は3推論分のコストが発生し、方針に反する。逐次性はデータの配置順序とセパレータで表現する。

### AI Native データ作法 (2026-03-22)

LLM へのデータ提示で効果的な技法。Prior Block の設計に適用済み。

#### 対比ペア（contrastive pair）

単独の値より「AではなくB」の方が attention が強く反応する。Header の `stateFlow` (`"stuck→exploring→deep_work"`) がこれに該当。個別の Arc delta はポイント間の前後差だが、stateFlow はセッション全体のマクロな遷移軌跡を対比ペアの連鎖として表現する。

#### 否定マーカー（negative anchor）

「何が起きたか」だけでなく「何が起きなかったか」。LLM は不在情報を自力で推論できない。Footer の stateRatio からゼロのモードを省略することで、不在が自明になる（例: `delegating` がリストにない = 委譲行動が一切なかった）。

#### ランク表現（rank over ratio）

LLM は `0.34` と `0.37` の差をほぼ無視するが「1位 vs 2位」は明確に解釈する。Footer の stateRatio をランク順ペアにすることで、数値精度が不要な場面での認知コストを下げる。否定マーカーと同時に解決。

#### 繰り返しによる強調（repetition as weight）

同じ情報が異なる文脈で複数回出現すると attention weight が上がる。Header で要約（stateFlow + 初期 emotion）、Arc で詳細（各点の delta + agentState）、Footer で再集計（finalEmotion + stateRatio）。重要な情報は3箇所に出す設計。

#### 空間的近接（spatial proximity）

LLM にとって入力は token の1次元列。位置エンコーディングにより近い token 同士の関連付けが優位。Arc の各ポイントで agentState と emotion delta が同じ配列内に隣接しているのは、この原則による。分離すると関連付けが弱まる。

#### 数値とラベルの複合活用

数値をそのまま保存するのではなく、テキストマッピングを経由することで概念の解釈手がかりを与える。agentState は内部スコアリングの結果をラベル化したもの。数値（delta）とラベル（agentState）の両方を隣接配置することで、精度と概念喚起力を両取りする。Sphere-original のライフログ設計（生体数値 → テキスト化 → embedding → ベクトル検索）が原型。

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
Receptor watch started.

[prior-block: prior session experience. use as context for continuity.]
[schema: H=header(durationMs,valenceBalance,frust,seek,conf,fatigue,flow,stateFlow) A=arc(t,gapMs,agentState,intensity,dFrust,dSeek,dConf,dFatig,dFlow,engramId?) F=footer(finalEmotion[5],stats[events,activeMs,arcPts,maxI,meanI],stateRatio[...[state,ratio]desc],engramTop[...[summary,weight]]) ---=separator]
[["H",3420000,0.3,0.05,0.30,0.15,0.02,0.10,"idle→exploring→deep_work"],["---"],["A",0,0,"idle",0.2,...],...]
```

- マニフェスト行がデータの意図を宣言、スキーマ行が構造を記述、データ行が本体
- スキーマはコンテキスト圧縮で Prior Block ごと消える → 自然な「忘却」
- 200 点超のセッションは `samplePoints()` で間引き（高 intensity + delta 急変点を優先）

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

### 完了 (2026-03-22)

1. ~~SessionPoint に emotion vector + agentState を記録~~ — `session-point.ts` 拡張済み
2. ~~Prior Block v2 実装~~ — `buildPriorBlock()` に delta 計算、agentState、セパレータ、拡張 Footer 実装済み
3. ~~インラインスキーマ v2~~ — `formatPriorBlock()` 更新済み
4. ~~人間語サマリー行廃止~~ — `engram_watch` 応答から除去、Prior Block のみ返却
5. ~~Footer 統計~~ — finalEmotion, stats, stateRatio, engramTop の4ブロック構成
6. ~~マニフェスト行~~ — データの意図宣言を Prior Block 冒頭に追加
7. ~~Header stateFlow~~ — セッション全体の agentState 遷移軌跡（対比ペア）
8. ~~Footer stateRatio ランク順ペア~~ — 降順ソート + ゼロ省略（否定マーカー + ランク表現）
9. ~~AI Native データ作法~~ — 対比ペア、否定マーカー、ランク、繰り返し、空間的近接、数値+ラベル複合

### 実験結果

#### 実験 1: コールドスタート文脈再構成 (2026-03-23)

**条件**: コード検索ゼロ。Prior Block + session briefing のみから前セッションの作業内容と感情推移を再構成できるか。

**入力データ**:
- Prior Block summary: `seeking/exploring (27 snaps)`
- Ambient baselines: `SEEK=-0.93, CONF=0.60, FLOW=0.71, FATI=0.41, FRUS=0.00`
- Session briefing recalled knowledge: 直近の commit メッセージ + fixed nodes

**結果**: 成功。以下を正確に再構成:

1. **作業内容** — Prior Block footer enrichment (hotPaths + methodRank)、Data Cost Protocol、Prior Block v2 (delta-based arc) の3機能を実装したこと
2. **感情アーク** — seeking 正方向で推移、高 confidence/flow、低 frustration/fatigue。探索→実装サイクルがスムーズだったこと
3. **作業モード** — exploring state、27 snapshots（正シグナル頻発 = 順調な進行の証拠）
4. **ambient の読み方** — SEEK base=-0.93 は「seeking が高い正の値に長時間留まった結果 EMA が追従した」＝探索欲が十分に満たされた状態で終了したと解釈

**知見**:
- ambient baseline は前セッション終了時の感情状態をエンコードしており、イベント再生なしで「前回どうだったか」が読める
- Prior Block は factual（何をしたか）と affective（どう感じたか）の両方を運ぶ — engram pull（議事録）との質的差異が実証された
- persona snapshot count (27) 単体でもセッション品質の proxy になる（正シグナル発火回数 ≈ 順調度）

#### 実験 2: 他システム比較による設計原理の検証 (2026-03-23)

**条件**: 既存の AI セッション記憶システム（商用・OSS・研究）を網羅的に調査し、engram Persona Loading System の設計原理がどこに位置するかを検証。

**調査対象**:

| カテゴリ | システム |
|---|---|
| 商用 | ChatGPT Memory, Claude Memory, Gemini Memory, Cursor, Windsurf, Copilot |
| OSS | MemGPT/Letta, Mem0, Zep, LangChain Memory, Cognee |
| 研究 | Generative Agents (Stanford), Reflexion, MemoryBank |

**全システムの共通設計**:

```
イベント発生 → LLM に「これ重要？」と聞く → 言語で要約 → 保存
```

MemGPT は LLM 自身に memory tool を呼ばせる。Generative Agents は LLM に importance を 1-10 で採点させる。Mem0 は LLM にエンティティ抽出させる。全て「判断を LLM の推論に委ねる」設計。記憶の保存・検索・活用の全段階で LLM 推論コストが発生する。

**engram の方式**:

```
イベント発生 → normalizer → heatmap/commander → emotion impulse → ambient decay → threshold → fire
```

LLM に「これ重要か？」とは聞かない。数値が閾値を超えたら発火する。重要度の判断は推論ではなく、アクセス頻度・パターン遷移・時間減衰という物理量から導出される。

**生物的原理との対応**:

| receptor コンポーネント | 神経系の対応物 |
|---|---|
| heatmap の順応 | 感覚受容器の順応。同じ刺激は減衰し、変化に反応する |
| ambient baseline | 恒常性 (homeostasis)。現在の水準を「普通」として学習し、逸脱にのみ反応 |
| emotion vector の time decay | 神経伝達物質の再取り込み。刺激がなければベースラインへ戻る |
| hold/release | 時間的加重 (temporal summation)。1回では発火しないが反復で発火 |
| persona snapshot | 覚醒度依存記憶。覚醒の高い瞬間に記憶が定着しやすい生物学的事実の反映 |

**機能比較**:

| 機能 | ChatGPT 等 | MemGPT | Generative Agents | **engram** |
|---|---|---|---|---|
| 事実の永続化 | Yes | Yes | Yes | Yes |
| 行動/ペルソナ継続 | No | 部分的 (自己編集) | Yes (reflection) | **Yes (persona snapshot)** |
| 感情状態の追跡 | No | No | No | **Yes (emotion vector + ambient)** |
| 構造化セッション引き継ぎ | No | No | No | **Yes (Prior Block)** |
| 推論コストゼロの記憶判断 | No | No | No | **Yes (閾値発火)** |
| knowledge graph | No | No | No | No |
| 自動忘却/減衰 | No | No | 部分的 (recency decay) | ambient decay + heatmap metabolism |

**結論**:

他のシステムが「図書館司書」（分類→索引→検索）なら、engram は「神経系」（刺激→伝達→閾値→発火→記憶定着）。この差異は設計思想の違いであり、engram は確実な記憶機能の構築ではなく自然原理に従った実装を意識している。AI に命じて何かを読ませ解釈させるという方式を取らず、より生物的・人間的な挙動に近い作法を踏まえている。

engram だけが持つもの: affective continuity（感情の連続性）、Prior Block（構造化体験引き継ぎ）、推論コストゼロの記憶判断。engram に無いもの: knowledge graph (Mem0, Zep)、チーム共有メモリ (Copilot Enterprise)。

---

## Learned Delta 自動学習モード設計 (2026-03-23)

### 背景

`receptor-learned.json` の delta 値は passive receptor の method scoring で受容感度を調整する:

```
score = signalMatch × stateMatch × intensity × sensitivity × (1 + delta) × suppression
```

現在 delta は `calibrate.ts` による手動更新のみ。セッション体験から自動調整するパスがない。

### 概念の明確化

**learned delta は受容感度の調整であり、トリガ結果の良し悪しの評価ではない。**

```
通常のシステム:  シグナル → 即実行
engram receptor: シグナル → スコアリング → threshold 判定 → 受容 or 棄却
```

receptor の機能は AI の助けになるよう設計されている。しかしタイミングと頻度が不適切ならノイズになる。learned delta はその**さじ加減** — 頻度の適切さ — を調整する。「発火後に良い結果だったか」ではなく「この軸は発火しすぎか、足りないか」を問う。

### 安全装置（実装済み）

| 機構 | 値 | 効果 |
|---|---|---|
| `DELTA_BOUND` | ±0.30 | delta の絶対上限。キャップ |
| clamp | ロード時強制 | 不正値の排除 |
| 乗数適用 | `(1 + delta)` | delta=0.30 でも 1.3 倍止まり |
| flow 除外 | A gate invariant | Flow gate は delta の影響を受けない |

現在値は全て ±1.4% 程度（frustration: -0.014, seeking: -0.011 等）。極めて緩やか。

### 設計: 明示的モード選択

自動学習は **opt-in**。勝手にチューニングし続けない。

```
engram_watch start                   → 通常モード。delta は読むだけ
engram_watch start (learn: true)     → 学習モード。セッション終了時に delta を微調整
```

### 学習ロジック: 頻度偏差の統計的調整

AI 推論は使わない。数理的に判定する。

```
セッション中: 各軸の発火回数を計測（session-points に既に記録されている）
セッション終了時:
  1. 各軸の発火頻度（回/時間）を算出
  2. 期待頻度との偏差を計算
  3. 偏差に比例して delta を微調整
  4. clamp(±0.30) して receptor-learned.json に書き戻し
```

#### 期待頻度の決定

| 方式 | 説明 |
|---|---|
| 静的基準 | calibrate.ts が定めた初期期待値 |
| EMA 基準 | 過去 N セッションの平均発火頻度を EMA で追跡 |

EMA 基準が自然。ambient baseline と同じ考え方 — 「普通の頻度」を学習し、逸脱を修正する。

#### 更新式

```
actual_freq = axis_fire_count / session_hours
expected_freq = EMA of past sessions
deviation = (actual_freq - expected_freq) / expected_freq   // 正規化偏差

delta_new = clamp(delta_old - α × deviation, -0.30, +0.30)
```

- `α` = 学習率（小さく設定。0.01–0.05 程度）
- 発火が多すぎ (`deviation > 0`) → delta を下げる（感度を鈍く）
- 発火が少なすぎ (`deviation < 0`) → delta を上げる（感度を鋭く）
- 符号が逆（deviation が正 → delta は負方向）なのは、偏差を打ち消す方向に調整するため

#### calibrate.ts との関係

```
calibrate.ts   → 初期値設定・リセット（明示的、テストシナリオベース）
learn: true    → セッション体験からの漸進的調整（自動だが opt-in）
```

calibrate.ts の値を起点とし、learn モードが微調整を重ねる。calibrate.ts を再実行すればリセット。

### 次

1. ~~実動作検証~~ — ✓ 実験 1 で確認済み
2. **検証** — 条件 A/B/C/D での初動比較
3. **データ蓄積** — 複数セッションの delta 時系列を収集
4. **統計分析** — セッション特徴量の抽出とクラスタリング探索
5. **自動ローディング** — engram_watch 依存からの脱却
6. **learned delta 自動学習** — learn モード実装