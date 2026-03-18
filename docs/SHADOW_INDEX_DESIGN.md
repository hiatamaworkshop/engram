# Shadow Index — ファイル鮮度シグナルによる盲点検知

> 2026-03-19 構想。未実装。
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

### 現状の PathHeatmap

1つのパスツリーに `count`（アクセス頻度）だけが載っている。
これを**同じツリー構造に複数のインデックス軸を重ねる**形に拡張する。

概念的には同じパスツリーのコピーが並列に存在し、それぞれが異なるインデックスを表現している。
全て重ねれば1つのノードに多次元データが紐づく。

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
PathHeatmap の内部メソッドとして実装するか、薄いラッパーとして外に出すか。

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

### 参照時減衰（推奨）

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

## ライフサイクル管理 — 足切りとインデックスベクトル

### 設計思想

HeatNode を無限に保持するわけにはいかない。engram や sphere と同じ作法で、
足切りスコアを下回ったノードは管理から除外する。

このシステムは**AIエージェント専用**。人間の「週末を挟んで月曜に続き」のような
時間感覚は考慮しない。エージェントのセッションは数時間、セッション間隔に意味はない。
時間パラメータはエージェントの作業サイクルに最適化する。

### 2段階の足切り

```
Active HeatNode（監視ウィンドウ: 48時間）
    ↓ lastAccess から 48時間経過、足切り
Index Vector（生存期間: 2週間 or 上限500件、LRU追い出し）
    ↓ 足切り
削除
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

### Index Vector の用途

- **落とし穴の繰り返し検出**: ウィンドウを跨いで同じパターンが現れたら、
  新しい Active HeatNode と過去の Index Vector のコサイン距離で類似判定できる
- **「前回も同じファイルでハマった」が数値的に言える**
- Active に復帰した場合、Index Vector のカウントを引き継いで継続可能

### 監視ウィンドウ: 48時間

- エージェントのセッションは通常数時間
- 48時間あれば「今日の作業 → 明日の続き」をカバーできる
- 72時間以上経ったら同じファイルでも作業文脈が変わっている可能性が高い
- デフォルト48時間、設定可能

---

## receptor との統合

### シグナルの扱い

StalenessSignal は既存の receptor signal pipeline に流す。

```typescript
// receptor の generateSignals() に追加
{
  type: "staleness_warning",
  intensity: timeDelta に基づく 0.0-1.0,
  payload: {
    openedFile: string,
    newerSibling: string,
    timeDelta: number,
  }
}
```

### EmotionVector への影響

staleness_warning は **uncertainty 軸**に微量寄与する。
エージェントが古いファイルを掴んでいる可能性 = 方向性が誤っている可能性。

```
uncertainty += (staleness_warning.intensity × 0.15)
```

0.15 という係数は「気配」レベル。他の uncertainty 要因（wandering, heatmap shift）と同程度。

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

### engram ノードとの連携

engram ノードが参照するファイルパスが PathHeatmap 上で「lastModified が古い」と判定されている場合、
そのノードの recall スコアを下げる。

ただし、これは PathHeatmap 単体の範囲外。将来的な統合として検討。

### 「変化があった」シグナル

ノードの中身を全部読む必要はない。
**ある話題について最近何か変わったかどうか**だけを返す軽量なクエリ。

```
projectId × tag の組み合わせで「この領域に最近 recent ノードが入ったか」
→ エージェントに「ここは再確認すべき」というシグナルを送る
```

PathHeatmap の範囲外だが、同じ「視野に入らない問題」への別アプローチとして complementary。

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

Phase 1-3 が核心。Phase 4-6 は効果を見てから判断。

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
   - 初期実装は兄弟（同一親）の全子ノードを対象にする。拡張子フィルタは Phase 2 以降で検討
   - Stage 3 の編集距離閾値の調整が必要（あまり緩いと無関係なファイルがヒットする）
2. **走査の深さ** — ~~親ディレクトリだけか、祖父母まで見るか~~
   - → **解決**: 3段階の視野拡大で対応。Stage 1: 兄弟、Stage 2: 祖先（最大2階層、設定可能）、Stage 3: 逆引きファイル名マップ
3. **シグナルの伝達方法** — receptor 経由のみか、直接エージェントのコンテキストに注入するか
   - receptor 経由を推奨。既存のアーキテクチャに合致する
4. **セッション跨ぎ** — ~~インメモリで十分か、永続化が必要か~~
   - → **解決**: 2段階ライフサイクル（Active HeatNode → Index Vector → 削除）で対応。Active は48hウィンドウ、Index Vector は2週間/500件上限。Index Vector はコサイン距離で過去パターンとの類似検出に使う
5. **lastModified 取得の非同期性** — record() 内で fs.stat() を await するか、fire-and-forget で後から埋めるか
   - fire-and-forget を推奨。record() のクリティカルパスをブロックしない。lastModified が埋まる前の短い窓ではStalenessDetector が発火しないだけ（安全側に倒れる）
