# Shadow Index — ファイル鮮度シグナルによる盲点検知

> 2026-03-19 構想・設計。同日 Phase 1-3, 5 実装完了。Phase 4, 6 未着手。
>
> **課題**: エージェントは grep/glob で古いファイルを先に発見すると、
> 新しい同種ファイルの存在に気づかずそのまま作業を進める。
> 矛盾する情報が両方見えていれば解決できるが、**視野に入らないものは存在しないのと同じ**。
>
> **方針**: エージェント自身を賢くするのではなく、
> エージェントが見ていないものを**外部レイヤーが気配として伝える**。

---

## 背景: なぜこの問題が起きるか

### AIの構造的弱点

1. **grep/glob は完全一致の呪い** — 検索クエリの発想が古い知識に基づく。ファイル名や命名規則が変わっていればヒットしない
2. **「見つかった＝正しい」バイアス** — エージェントは最初にヒットしたファイルを疑わない
3. **メタデータの無視** — `lastModified` はファイルシステム上に存在するが、エージェントは中身しか見ない
4. **メタ認知の欠如** — 人間は「最近なんか変えたな」という違和感を持てる。AIにはこれがない

### engram のベクトル検索は多少マシ

ベクトル近傍検索は意味的な近さで引くため、ファイル名が変わっても概念レベルで両方ヒットする可能性がある。
しかしファイルシステム上の操作（日常的なコード編集）は依然として grep/glob ベースが主流。

---

## 設計思想

### 原則

1. **ベクトルDB・LLM推論を使わない** — ファイルメタデータとパス文字列だけで動く軽量な仕組み
2. **警告ではなく気配** — うるさくない。本当に危ない時だけ静かにシグナルを送る
3. **PathHeatmap を多次元化** — 別コンポーネントを立てるのではなく、既存のパスツリーにインデックス軸を追加する
4. **receptor hooks に載せる** — engram と並走できるが、単体でも機能する

### update を持たない思想との整合

engram は意図的に update 機能を持たない（再投入が更新の作法）。
Shadow Index も同様に、ファイルの「正しさ」を判定しない。
**「他に新しいものがある」という事実だけ**を伝える。判断はエージェントに委ねる。

---

## 核心: Multi-Index PathHeatmap

### PathHeatmap の多次元構造

同じパスツリーに複数のインデックス軸を重ねる。
1つのノードに多次元データが紐づく。

```
/services/nodejs/src/config/db.js
  ├── accessCount: 12        [軸1: アクセス頻度]  ← 既存
  ├── totalOpened: 3          [軸2: 累計オープン回数]
  ├── totalModified: 7        [軸3: 累計編集回数]
  ├── lastModified: 1710...   [軸4: ファイルシステム由来の鮮度]
  ├── lastAccess: 1710...     [軸5: 最終アクセス時刻（時間減衰の基準）]
  ├── lastTouchedState: "exploring"  [軸6: 最終アクセス時のエージェント状態]
  └── ...                     [将来の軸もここに追加するだけ]
```

### 多次元 HeatNode

```typescript
interface HeatNode {
  // --- 軸1: アクセス頻度（既存） ---
  count: number;

  // --- 軸2: 累計オープン回数 ---
  totalOpened: number;        // セッション内で何回開いたか

  // --- 軸3: 累計編集回数 ---
  totalModified: number;      // file_write/file_edit 時にインクリメント

  // --- 軸4: ファイルシステム鮮度 ---
  lastModified: number;       // fs.stat 由来。file_read 時に取得

  // --- 軸5: 時間減衰基準 ---
  lastAccess: number;         // 最終アクセス時刻

  // --- 軸6: 認知鮮度 ---
  lastTouchedState: AgentState; // 最後にこのファイルに触れた時の meta neuron 状態

  // --- 構造 ---
  children: Map<string, HeatNode>;
}

type AgentState = "idle" | "exploring" | "delegating" | "stuck" | "deep_work";

```

### なぜ別コンポーネントにしないか

ShadowIndex を PathHeatmap と別に立てると:
- 同じパスツリーを2つ管理する冗長性
- 2つのツリー間の同期問題
- 「このパスの情報はどちらに聞くか」の判断が必要

PathHeatmap 自体を多次元化すれば:
- ツリーは1つ。record() の時点で全軸が更新される
- 兄弟ファイルの比較は `node.children` を走査するだけ
- 将来の軸追加もフィールド追加のみ

---

## アーキテクチャ

### 配置の判断: pre-neuron monitor 層

PathHeatmap + StalenessDetector は **neuron の発火以前に動くべき機能**である。

- record() は file_read/file_write の**全イベント**で走る必要がある
- 落とし穴にハマっているエージェントは「正常に見える」ため、neuron は発火しない
- **検知すべき状態が、検知機構（neuron）を起動しない状態と一致している**

したがって receptor の passive trigger に依存させてはならない。
しかし全ロジックを native hotpath に載せるのも重すぎる。

**解決**: 2層に分離する。

| 層 | 配置 | 責務 |
|----|------|------|
| record() + 軽量チェック | **native 側（hotpath）** | HeatNode 更新 + 兄弟の lastModified 走査。閾値超えで signal emit |
| StalenessDetector 本体 | **外部モジュール** | 多次元交差分析、3段階視野拡大、Index Vector 管理 |

record() が「何かおかしい」と気づいた時点で StalenessDetector を呼び出す。
neuron の判断を待たず、receptor signal pipeline に直接注入する。

### pre-neuron monitor — 新しいカテゴリ

これは PathHeatmap 固有の問題ではなく、**neuron に材料を渡す層**という新しいアーキテクチャカテゴリ。
receptor の概念を「neuron が発火してから動く」とするなら、この層はその入力側に位置する。

将来的に同じ位置に座る機能が出てくる可能性がある。

```
[Claude Code hooks]
       |
       v
  ┌─────────────────────────────────────────────┐
  │  pre-neuron monitors [native寄り、常時稼働]  │
  │                                               │
  │  PathHeatmap.record(event)                    │
  │  ├── HeatNode 全軸更新（hotpath、軽量）       │
  │  ├── 兄弟 lastModified 走査（children のみ）  │
  │  └── 閾値超え?                                │
  │       ├── YES → StalenessDetector 呼出        │
  │       │          (外部モジュール、詳細分析)    │
  │       │          └── signal emit ──────────┐  │
  │       └── NO  → 無音                       │  │
  │                                             │  │
  │  (将来) 他の pre-neuron monitor              │  │
  │       └── signal emit ─────────────────┐   │  │
  └────────────────────────────────────────┼───┼──┘
                                           │   │
                                           v   v
                                  receptor signal pipeline
                                           │
                                           v
                                  neuron evaluation
                                  (monitors からのシグナルも
                                   含めて総合判断)
```

### 設計上の意味

- **native hotpath は薄く保つ**: record() + children 走査だけ。重い分析は外部
- **neuron を汚さない**: monitors からのシグナルは pipeline 経由で neuron に届く。neuron 側は「シグナルが来た」として処理するだけ
- **拡張可能**: 新しい pre-neuron monitor を足しても同じパターンで配置できる

---

## 各インデックス軸の詳細

### 軸1: accessCount（既存）

現行の `count`。パスセグメントごとに加算。
project root に近いノードほど自然とカウントが大きくなる（子の合計）。

**用途**: エージェントの行動範囲の把握。entropy 計算。

### 軸2: totalOpened

`file_read` イベント時のみインクリメント。リーフノードのみ。
accessCount はディレクトリ通過でもカウントされるが、totalOpened は**実際にファイルを開いた回数**。

**用途**:
- エージェントの関心の指標
- 既存の `isFirstAccess()` をこの軸で置き換え（より正確）
- **単体では解釈が曖昧** — 高 totalOpened は「意図的に参照」と「繰り返し落とし穴にハマっている」の両方がありうる。totalModified との突き合わせで意味が確定する

### 軸3: totalModified

`file_write` / `file_edit` イベント時にインクリメント。リーフノードのみ。
totalOpened が「エージェント側の関心」を表すのに対し、totalModified は**ファイル側の重要性**を表す。

**用途**:
- 重要度の指標。頻繁に編集されるファイル = 作業の中心
- エージェントが未アクセスのファイルでも、modifiedCount が高ければ「見落としている重要ファイル」として検出可能
- totalOpened との多次元交差で落とし穴パターンを検出（後述）

### totalOpened × totalModified の交差分析

| totalOpened | totalModified | 解釈 |
|:-----------:|:------------:|------|
| 高 | 高 | **安全**。活発に編集しているファイル |
| 高 | 低 | **落とし穴の兆候**。何度も開くが書き換えない＝古い情報を繰り返し参照している可能性 |
| 低 | 高 | **盲点**。頻繁に変更されている重要ファイルをエージェントが見ていない |
| 低 | 低 | 無関心。シグナル不要 |

さらに `lastModified`（軸4）と組み合わせることで:
- 「高opened × 低modified × 兄弟に新しいファイルがある」→ **古いファイルに繰り返しハマっている**
- 「低opened × 高modified × lastModified が最近」→ **活発なファイルが視野外**

単軸では判断できないが、**多次元の交差点**でパターンが浮かび上がる。これが Multi-Index PathHeatmap の本来の力。

### 軸4: lastModified

`file_read` 時に `fs.stat()` で取得してノードに記録。
**ファイルシステムの真実**をツリーに射影する。

**用途**:
- 兄弟ファイル間の鮮度比較
- 古いファイルを掴んでいないかの検証
- totalOpened × totalModified の交差分析と組み合わせて、落とし穴パターンの確度を上げる

**取得コスト**: `fs.stat()` は軽量（inode 読み取りのみ）。file_read のタイミングで非同期取得すればブロックしない。

### 軸5: lastAccess

`record()` 時に `Date.now()` を記録。

**用途**: 時間減衰の計算基準。

```typescript
effectiveCount(node) = node.count × exp(-(now - node.lastAccess) / halfLife)
// halfLife 例: 2時間
```

topPaths() と entropy() は effectiveCount を使う。
古い作業領域のヒートが自然に冷える。

### 軸6: lastTouchedState — 認知鮮度

`record()` 時に meta neuron の現在の AgentState を記録。
ファイルの鮮度（軸4: lastModified）ではなく、**そのファイルに対するエージェントの認知の鮮度**を表す。

```typescript
type AgentState = "idle" | "exploring" | "delegating" | "stuck" | "deep_work";
```

**用途**:
- **落とし穴の感度調整**: `idle` や `exploring` 状態で触ったファイルは批判的検証なしに掴んだ可能性が高い
- **認知の陳腐化検出**: `lastTouchedState` が `deep_work` だが現在の state が `exploring` なら、
  文脈が切り替わった後にそのファイルの認知を更新していない
- **StalenessDetector の発火感度に直接寄与**:

| lastTouchedState | 発火感度 multiplier | 根拠 |
|:----------------:|:-------------------:|------|
| `idle` | ×1.0 | 文脈ゼロ。最も危険 |
| `exploring` | ×0.8 | 方向未定。突発指示の直後もここ |
| `delegating` | ×0.5 | サブエージェント経由の間接知識 |
| `stuck` | ×0.4 | 問題を自覚している可能性がある |
| `deep_work` | ×0.1 | 文脈豊富。意図的なアクセスの可能性が高い |

**状態遷移デルタ**: `lastTouchedState` と**現在の** AgentState の差分も情報を持つ。
特に `deep_work → exploring` の遷移直後（コンテキストスイッチ）は、
以前 `deep_work` で触ったファイルの認知が陳腐化している可能性がある。

**取得コスト**: meta neuron の `agentState` を参照するだけ。ゼロコスト。

**HeatNode に持たせる妥当性**: totalOpened, totalModified も「エージェントの行動記録」であり、
ファイル固有の性質は lastModified だけ。HeatNode は元々「パス × エージェント行動」の交差を
記録する構造であり、lastTouchedState も同じ責務の範囲内。

---

## StalenessDetector — 兄弟比較と発火

PathHeatmap の多次元ノードを使って鮮度判定を行う。
外部モジュール `pre-neuron/staleness-detector.ts` として実装。

### 兄弟の取得

```typescript
/** 同一親パス配下の子ノードを返す（ツリーを辿るだけ） */
siblings(path: string): Map<string, HeatNode>
```

パスツリーの構造上、兄弟は**親ノードの children**。追加のデータ構造不要。

### 発火条件（全て AND）

シグナルは以下の**全条件を満たした時だけ**発火する。普段はほぼ無音。

| 条件 | 根拠となる軸 | 理由 |
|------|-------------|------|
| 兄弟ファイル数 ≥ 3 | children.size | ファイルが2つだけなら混同リスクは低い |
| 開いたファイルの `lastModified` が兄弟中で最古クラス（下位 25%） | 軸4 | 古いからと言ってダメなわけではない。明らかに古い場合だけ |
| 最新の兄弟との時間差 ≥ 閾値（例: 24時間） | 軸4 | 数分〜数時間の差は通常の開発フロー |
| totalOpened × totalModified の交差が危険パターン | 軸2 × 軸3 | 「高opened × 低modified」（繰り返し参照だが未編集）または「低opened × 高modified の兄弟が存在」（重要ファイルが視野外） |

### シグナル出力

```typescript
interface StalenessSignal {
  openedFile: string;
  newerSibling: string;
  timeDelta: number;          // lastModified の差 (ms)
  siblingCount: number;
  totalOpened: number;        // このファイルの累計オープン回数
  totalModified: number;      // このファイルの累計編集回数
  pattern: "repeated-trap" | "blind-spot";  // 検出パターン
}
```

### 発火しない例

- `utils/helpers.js` を開いた。兄弟は1ファイルのみ → **兄弟数不足、無音**
- `config/db.js` を開いた（5回目、3回編集済み）。高opened × 高modified → **安全パターン、無音**
- `src/index.js` を開いた。兄弟10ファイル。全て lastModified が同日 → **時間差不足、無音**

### 発火する例

- `config/db.old.js` を4回開いたが一度も編集していない。兄弟5ファイル。`config/db.new.js` が2日前に更新。`db.old.js` は30日前 → **高opened × 低modified + 鮮度差 → `repeated-trap` シグナル発火**
- `config/db.new.js`（totalModified=7）が存在するディレクトリで、エージェントは `config/db.old.js` しか見ていない → **重要ファイルが視野外 → `blind-spot` シグナル発火**

---

## 時間減衰

### 参照時減衰

```typescript
effectiveCount(node: HeatNode): number {
  const dt = Date.now() - node.lastAccess;
  return node.count * Math.exp(-dt / HALF_LIFE);
}
// HALF_LIFE = 2 * 60 * 60 * 1000  // 2時間
```

- バッチ処理不要。参照時に計算するだけ
- topPaths() の結果が自然と「今の作業」にフォーカスされる
- 過去の作業痕跡がヒートマップを汚さない

### 減衰と totalOpened / totalModified の関係

totalOpened と totalModified は**減衰させない**。これらは累計の行動記録であり、
時間が経っても「何回開いたか」「何回編集したか」の事実は変わらない。
accessCount（軸1）だけが減衰対象。

### fileScore — 合成スコア

各軸を係数で重み付けするのではなく、**時間減衰が唯一の重み調整メカニズム**として機能する。

- 各軸の生データは独立に記録される
- 外部に見せる「このパスの重み」は、減衰後に残った軸の交差で決まる
- 単純な count 加算では `src/`（全アクセスで通過）が常にトップになる — 情報量ゼロ
- fileScore は「よく通る道」ではなく「重要な道」を表現する

算出方針:
- 係数による重み付けは行わない（公平性）
- 兄弟の有無が過度に影響しない（兄弟比較は StalenessDetector の責務）
- 参照のないファイルは時間減衰により自然に沈む

---

## ライフサイクル管理 — 代謝と永続化

### 設計思想

HeatNode を無限に保持するわけにはいかない。engram の Digestor と同じ作法で、
足切りスコアを下回ったノードは管理から除外する。

**Digestor との作法統一**: engram の代謝は作業時間だけを計測する。
プロジェクトに触っていない時はスリープする（`idleThresholdMs` 超過で batch skip）。
Shadow Index も同じであるべき — 非作業時間に代謝が進んではならない。

### 現状と課題

PathHeatmap は現在インメモリのみ。セッション終了で全ノードが消失する。

1. **セッション間の断絶** — プロジェクト単位のファイル盲点検知が本来の目的。
   セッションごとにリセットされると、長期的な staleness パターンを捕捉できない。
2. **永続化時の膨張** — 永続化を導入すると HeatNode は追加のみで削除がない。
   長期プロジェクトでは数千〜数万ノードに膨れる。
3. **非作業時間の減衰** — 現在の effectiveCount() はウォールクロック基準。
   8時間の睡眠で heatmap が冷え切り、翌朝の staleness 判定に影響する。

### 作業時間ウィンドウ（Digestor 作法）

effectiveCount() の dt を「累積アクティブ時間」で計算する。
record() が呼ばれた時刻をトラッキングし、idle gap をスキップする。

```
Digestor:  touchProject() → lastActivityMs 更新 → idle超過 → batch skip
Heatmap:   record()       → lastActivityTs 更新 → idle超過 → 減衰停止
```

同一の精神。作業していない時間は存在しないものとして扱う。

### 3段階のライフサイクル

```
Active HeatNode（監視ウィンドウ: 48時間の累積作業時間）
    ↓ activeWindow 超過、足切り
Index Vector（6次元正規化ベクトル、軽量）
    ↓ engram / sink に退避
永続化（既存インフラに乗る）
```

### Active → Index Vector の圧縮

多次元の HeatNode をそのまま正規化ベクトルに変換する。

**正規化方法**: 各軸のスケールが大きく異なる（accessCount: 数十〜数百、lastModified: ミリ秒タイムスタンプ）ため、
圧縮時点での Active HeatNode 全体の**兄弟内順位（パーセンタイル）**で正規化する。
これにより各軸が 0.0-1.0 の範囲に収まり、コサイン距離で公平に比較できる。

```typescript
// Active HeatNode（フル状態）
[accessCount, totalOpened, totalModified, lastModified, lastAccess, lastTouchedState]
→ 兄弟内パーセンタイルで正規化 → 6次元 Index Vector

interface IndexVector {
  path: string;
  vector: number[];     // 正規化済み 6次元（各軸 0.0-1.0）
  lastSeen: number;     // 最後にアクティブだった時刻
}
```

Index Vector は軽量（パス文字列 + 数値6個 + タイムスタンプ）。
500件保持しても無視できるメモリ量。

### Index Vector の永続化: engram / sink への退避

独自の永続化層を持たず、既存インフラに逃がす:

- **engram push** — 繰り返し罠パターン（repeated-trap が複数回発火したもの）。
  検索可能な永続化。Digestor の代謝にそのまま乗り、自然淘汰される。
  tag: `gotcha`, `shadow-index`。セッション開始時に pull → heatmap に初期バイアス注入。
- **sink** — 通常の expire ノード。次セッション復元用の一時退避。
  検索不要、軽量保存。セッション開始時にロードし復元。

これにより永続化の独自実装が不要になり、engram の作法（代謝・淘汰）がそのまま適用される。

### Index Vector の用途

- **落とし穴の繰り返し検出**: ウィンドウを跨いで同じパターンが現れたら、
  新しい Active HeatNode と過去の Index Vector のコサイン距離で類似判定できる
- **「前回も同じファイルでハマった」が数値的に言える**
- Active に復帰した場合、Index Vector のカウントを引き継いで継続可能

### 監視ウィンドウ: 48時間（累積作業時間）

- エージェントのセッションは通常数時間
- 48時間の**累積作業時間**で「今日の作業 → 明日の続き」をカバー
- 非作業時間はカウントしない（Digestor の idle skip と同じ）
- 72時間以上の累積作業は文脈が変わっている可能性が高い
- デフォルト48時間、設定可能

### 実装ステータス: 保留

現状はインメモリ・セッション単位で実害なし。
永続化の導入時に作業時間ウィンドウと代謝を同時に実装する。
3つはセットで来る — 永続化なしに代謝は不要、代謝なしに永続化は膨張する。

---

## receptor との統合

実装では receptor signal pipeline を経由せず、**pre-neuron monitor Layer 7 → hot-memo** の独立経路で実現した。
StalenessDetector が発火すると `pushAlert()` で FIFO に入り、hot-memo が次回応答時にドレインしてエージェントに表示する。

EmotionVector への直接寄与（uncertainty 軸への加算）は Phase 7-2 構想として検討中。

---

## Config 化方針

チューニングが必要なパラメータは全て設定ファイルで外出しする。
ハードコードしない。

```typescript
interface ShadowIndexConfig {
  // --- 時間減衰 ---
  halfLife: number;               // デフォルト: 7200000 (2時間)

  // --- StalenessDetector ---
  minSiblingCount: number;        // 発火に必要な最小兄弟数。デフォルト: 3
  stalenessPercentile: number;    // 下位何%を「古い」とするか。デフォルト: 0.25
  minTimeDelta: number;           // 最新兄弟との最小時間差。デフォルト: 86400000 (24時間)

  // --- 視野拡大 ---
  ancestorDepth: number;          // Stage 2 の最大祖先走査階層。デフォルト: 2
  levenshteinThreshold: number;   // Stage 3 のファイル名編集距離閾値。デフォルト: 3

  // --- lastTouchedState 感度 ---
  stateMultipliers: Record<AgentState, number>;
  // デフォルト: { idle: 1.0, exploring: 0.8, delegating: 0.5, stuck: 0.4, deep_work: 0.1 }

  // --- ライフサイクル ---
  activeWindow: number;           // Active HeatNode の生存期間。デフォルト: 172800000 (48時間)
  indexVectorTTL: number;         // Index Vector の生存期間。デフォルト: 1209600000 (2週間)
  indexVectorMaxCount: number;    // Index Vector の上限件数。デフォルト: 500

  // --- receptor 統合 ---
  uncertaintyCoefficient: number; // staleness_warning の uncertainty 寄与係数。デフォルト: 0.15
}
```

---

## 将来の拡張可能性

### 新しい軸の追加

多次元 HeatNode に軸を足すだけで拡張できる。例:

| 軸 | 型 | 用途 |
|----|------|------|
| `errorAssociation` | number | このファイル操作後に bash failure が起きた回数。「問題のあるファイル」の検出 |
| `fileSize` | number | fs.stat 由来。巨大ファイルの認識 |

いずれも HeatNode にフィールドを足し、record() の分岐で更新するだけ。
ツリー構造は変わらない。

### engram 連携・セッション跨ぎの免疫記憶

→ 「ライフサイクル管理 — 代謝と永続化」セクション + Phase 7-1 を参照。

---

## 実装優先度

| フェーズ | 内容 | 依存 |
|---------|------|------|
| **Phase 1** | HeatNode 多次元化: totalOpened, totalModified, lastModified, lastAccess を追加 | 既存 PathHeatmap |
| **Phase 2** | StalenessDetector: siblings() + 多次元交差発火条件 | Phase 1 |
| **Phase 3** | fileScore 合成 + 時間減衰: effectiveCount() と topPaths() の対応 | Phase 1 |
| **Phase 4** | ライフサイクル管理: 48h ウィンドウ足切り + Index Vector 圧縮 | Phase 1 + Phase 3 |
| **Phase 5** | receptor signal pipeline 統合 | Phase 2 + receptor |
| **Phase 6** | engram ノード信頼度への反映 | Phase 2 + gateway |

### 実装ステータス (2026-03-19)

| フェーズ | ステータス | コミット |
|---------|-----------|---------|
| Phase 1 | **完了** | `2707bc4` |
| Phase 2 | **完了** | `2707bc4` |
| Phase 3 | **完了** | `2707bc4` |
| Phase 4 | 未着手 | — |
| Phase 5 | **完了**（pre-neuron Layer 7 経由） | `154505e` + `2707bc4` |
| Phase 6 | 未着手 | — |

---

## 同種ファイル検出 — 3段階の視野拡大

兄弟比較だけでは検出できない同種ファイルが別の場所にいる場合がある。
段階的に視野を広げ、**前段で検出できなかった時だけ次段に進む**。コストも段階的に上がる。

### Stage 1: 兄弟比較（同一親パス）

既存設計の通り。`node.parent.children` を走査。コスト最小。

### Stage 2: 祖先走査（親 → 祖父）

兄弟で差が出なかった場合、親ノードを1つ上がっていとこまで見る。
パスツリーの構造上、ノードを1つ上がるだけ。コストはほぼゼロ。

```
/services/api/config/db.js     ← 開いたファイル
/services/api/config/db.old.js ← Stage 1 で検出
/services/api/settings/db.js   ← Stage 2 で検出（config/ と settings/ は同じ祖父 api/ の下）
```

走査は最大2階層上まで（祖父）。それ以上はノイズが増える。設定可能（config化）。

### Stage 3: 逆引きファイル名マップ（ツリー全体）

ディレクトリ構造上は遠くても、**同じファイル名**のファイルを検出する。

```typescript
/** record() 時に自動更新される逆引きマップ */
filenameIndex: Map<string, Set<string>>

// 例:
// "db.js"        → ["/services/api/config/db.js", "/services/worker/config/db.js"]
// "settings.json" → ["/app/settings.json", "/lib/core/settings.json"]
```

- **basename 同士の完全一致**で引く（パス全体は見ない。パスの類似性は Stage 2 の責務）
- 完全一致がなければ **basename 同士の編集距離**（Levenshtein）で近いものをグルーピング
  - `.old`, `.bak`, `.backup`, `.v1` 等のサフィックスパターンも考慮
  - 閾値は config 化（`levenshteinThreshold`、デフォルト: 3）
- record() 時にマップを更新するだけ。検索時にツリー走査は不要

**ライフサイクル**: filenameIndex は Active HeatNode だけでなく **Index Vector のパスも保持する**。
Stage 3 の目的は「どこかに似たファイルがいる」という**存在の検知**であり、多次元スコアは不要。
Index Vector が生きている限り逆引きマップに残す。Index Vector が TTL/LRU で削除された時に初めてマップからも除外する。

```
Active HeatNode 削除 → Index Vector に圧縮 → filenameIndex はそのまま保持
Index Vector 削除（TTL/LRU）             → filenameIndex からも削除
```

**用途**: `/services/api/config/db.js` を開いた時に `/services/worker/config/db.js` の存在を検知。
兄弟でも祖先走査でも出会わない距離にいる同種ファイルを捕捉する。

### 3段階の判定フロー

```
ファイル open
  │
  ├─ Stage 1: siblings(path) → 兄弟と比較
  │    └─ 検出あり → シグナル発火、終了
  │
  ├─ Stage 2: ancestors(path, depth=2) → いとこまで比較
  │    └─ 検出あり → シグナル発火、終了
  │
  └─ Stage 3: filenameIndex.get(basename) → ツリー全体から同名ファイル
       └─ 検出あり → シグナル発火、終了
       └─ 検出なし → 無音
```

---

## 設計上の未決事項

1. **「同種」判定の精度** — 同一親パス + 同一拡張子で十分か。`db.config.js` と `db.migration.js` は「同種」か？
   - 初期実装は兄弟（同一親）の全子ノードを対象にする。拡張子フィルタは今後検討
   - Stage 3 の編集距離閾値の調整が必要（あまり緩いと無関係なファイルがヒットする）

---

## 実装ファイル構成

```
mcp-server/src/
├── pre-neuron/
│   ├── index.ts                    # Pre-neuron alert FIFO (pushAlert / formatPreNeuronAlerts)
│   ├── staleness-detector.ts       # 3段階視野拡大 + 多次元交差分析
│   └── staleness-detector.test.ts  # ユニットテスト (19テスト)
├── receptor/
│   ├── heatmap.ts                  # PathHeatmap (多次元化済み)
│   ├── shadow-index-config.ts      # ShadowIndexConfig (全パラメータ外出し)
│   ├── types.ts                    # HeatNode (6軸)
│   └── index.ts                    # ingestEvent() から detectStaleness() 呼出
└── hot-memo.ts                     # Layer 7: pre-neuron monitor alerts
```

### データフロー（実装後）

```
Claude Code hook event
  → ingestEvent()
    → heatmap.agentState = metaNeuron.state
    → heatmap.record(event)
    │   ├── count++ (全セグメント)
    │   ├── totalOpened++ (file_read, リーフのみ)
    │   ├── totalModified++ (file_edit, リーフのみ)
    │   ├── lastAccess = event.ts
    │   ├── lastTouchedState = agentState
    │   ├── filenameIndex 更新 (basename → fullPath)
    │   └── statProvider(path) → lastModified (fire-and-forget)
    │
    → detectStaleness(path, heatmap)
        ├── Stage 1: siblings(path) → analyzeGroup()
        ├── Stage 2: ancestor(path, depth) → collectLeaves() → analyzeGroup()
        └── Stage 3: filenameIndex.get(basename) + Levenshtein → analyzeGroup()
              │
              └── analyzeGroup()
                    ├── lastModified パーセンタイル判定
                    ├── timeDelta 閾値チェック
                    ├── stateMultiplier による感度調整
                    ├── classifyPattern() → "repeated-trap" | "blind-spot"
                    └── pushAlert() → hot-memo Layer 7 → エージェントに表示
```

### ユニットテスト

```
実行: npx tsx --test src/pre-neuron/staleness-detector.test.ts
結果: 19/19 pass (0 fail)
```

| スイート | テスト数 | 内容 |
|---------|---------|------|
| PathHeatmap multi-index | 7 | totalOpened, totalModified, lastAccess, lastTouchedState, filenameIndex, siblings, effectiveCount |
| StalenessDetector Stage 1 | 6 | repeated-trap 発火、safe pattern 抑制、兄弟数不足抑制、時間差不足抑制、blind-spot 発火、deep_work 抑制 |
| StalenessDetector Stage 3 | 2 | cross-directory 検出、Levenshtein filenameIndex 確認 |
| Pre-neuron alert layer | 4 | push/format 往復、空時無音、消費済みマーク、severity 表示 |

### 実装時の発見・判断

1. **siblings() のキー形式**: `PathHeatmap.siblings()` は `Map<basename, HeatNode>` を返す。
   StalenessDetector の `analyzeGroup()` はフルパスで照合するため、Stage 1 で親パスを付与する変換を入れた。
2. **Stage の優先順位**: 3段階は排他的（前段で検出されれば後段は実行しない）。
   テストで Stage 3 を意図したケースが Stage 2 (ancestors) で先に検出されることが判明 — 設計通りの動作。
3. **lastModified の注入**: テストでは `setLastModified()` ヘルパーで直接ノードに書き込み。
   本番では `setStatProvider()` 経由の fire-and-forget。stat が埋まる前は発���しない（安全側）。
4. **pattern 分類の閾値**: `totalOpened >= 3 && totalModified === 0` で repeated-trap。
   `totalModified >= 3 && totalOpened === 0` で blind-spot。将来的に config 化の余地あり。

### ステータス参照 API

Shadow Index の内部状態は `engram_watch` の status 表示（`formatState()`）から参照可能。

**追加ファイル・関数:**
- `PathHeatmap.shadowIndexStatus()` — ノード数、mtime 取得数、filenameIndex 衝突候補、most-opened リーフ
- `formatPreNeuronStatus()` — 発火済みアラート総数、pending 数、直近3件のアラート内容

**表示例:**
```
Shadow Index: 12 nodes, 8 with mtime, 6 unique basenames
  most opened:
    config/db.js  opened:5 modified:2 state:exploring
    src/main.ts   opened:3 modified:1 state:deep_work
  filename collisions: db.js(3) config.ts(2)

Pre-neuron: 2 alerts total, 1 pending
  ! staleness-detector: config/db.new.js (modified 48h newer) not in view (120s ago)
```

**設計判断:**
- `formatPreNeuronStatus()` はアラートを**消費しない**（drain しない）。表示専用。drain は hot-memo Layer 7 の `formatPreNeuronAlerts()` が担当。
- `shadowIndexStatus()` は `_collectLeavesWithNodes()` で全リーフを走査する。ステータス確認は低頻度のため、コスト許容。

---

## Phase 7: 免疫系拡張構想（未着手）

Shadow Index を「自然免疫」の第一段として位置づけ、免疫系のアナロジーから派生する機能群を構想する。

### 7-1. 抗体記憶 — engram 連携（Adaptive Immunity）

**概要:** Shadow Index で確定した罠パターンを engram に永続化し、セッションをまたぐ免疫記憶を実現する。

永続化の具体的方針（engram push / sink 退避）は「ライフサイクル管理 — 代謝と永続化」セクションに統合済み。

- **ライフサイクル:** engram 側の Digestor が自然淘汰を管理。独自の TTL 管理は持たない
- **課題:** 初期バイアスの強度設定。強すぎると誤検知、弱すぎると意味がない

### 7-2. 炎症反応 — neuron 感度調整（Inflammatory Response）

**概要:** Shadow Index のアラートを neuron の入力ゲイン増大やEmotionエンジンの閾値低下に変換する。

- **方向:** pre-neuron → neuron への逆方向フィードバック（現在は hot-memo への一方通行のみ）
- **メカニズム案:**
  - アラート発火時に frustration / seeking の入力信号を微量加算（サイトカイン的）
  - 特定ディレクトリに対する stateMultiplier を一時的に引き上げ（局所炎症）
  - 累積アラート数に応じて Emotion の閾値を局所的に下げる
- **���果:** 控えめなシグナルでも neuron が発火しやすくなる。エージェントが「なんとなく不快」を感じる
- **実装口:** Emotion engine の fieldAdjustment が既に存在。ここへの接続コストは低い
- **課題:** 炎症の収束条件。いつ「治癒」するか — エージェントが該当ファイルを実際に確認した時点で減衰？

### 7-3. 検知結果の提示方式（Signal Delivery）

**問題:** hot-memo Layer 7 で表示しても、エージェントが「読んだ」ことと「行動を変えた」ことは別。
免疫系で言えば、サイトカインを放出しても標的細胞にレセプターがなければ無意味。

**現状の課題:**
- hot-memo は他レイヤーと混在 → ��もれる
- コンテキストウィンドウ圧縮で消失する可能性
- 「気配」が弱すぎると無視、強すぎると邪魔

**提示方式の候補:**

| 方式 | 概要 | 強度 |
|------|------|------|
| 繰り返し提示 | 同一罠への再アクセス時に再アラート | 中 |
| 行動レベル介入 | 検索結果・ファイル一覧に直接注入（粘膜免疫的） | 高 |
| neuron 経由間接介入 | 7-2 の感度調整。提示ではなく「不快感」として伝達 | 低〜中 |
| エスカレーション | 無視された場合に severity を段階的に上げる | 可変 |

**設計方針:** 単一の方式に依存せず、複数経路の組み合わせで「認識されない」問題を乗り越える。
neuron 経由の間接介入で地なら���し、hot-memo で明示的に提示、無視されればエスカレーション — という多段構成が免疫系のカスケードに近い。

### 7-4. 自己・非自己の区別（Self vs Non-self）

**概要:** エージェント自身の編集と外部変更（人間、他プロセス、git pull）を区別する。

- heatmap は既に file_read / file_edit を区別している
- 外部変更の検知には git status / ファイルウォッチャーとの連携が必要
- 「エージェントが知らない変更が入ったファイルを古い認識で触り続ける」ケースの検知
- Shadow Index の既存メカニズム（lastModified パーセンタイル）と自然に組み合わさる

