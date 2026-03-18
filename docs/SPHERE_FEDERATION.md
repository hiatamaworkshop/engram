# Sphere Federation — engram ↔ Sphere 双方向接続

> 2026-03-16 構想メモ。sphere-shaper 実装済み、Sphere HTTP 配線は未実装。
>
> **更新 (2026-03-17)**: Facade DNS ルーティングモデル追加。ProjectMeta (techStack/domain) で
> Sphere 自動振り分け。SpherePayload v2。score_threshold 0.5→0.35。seeking 軸統合反映。
>
> **更新 (2026-03-18)**: Facade 接続実装完了。push/lookup 双方向貫通確認済み。
> - sphere-shaper → Facade `/push` → Sphere `/sphere/contribute` (JSONL fallback 付き)
> - future-probe → Facade `/lookup` → Sphere `/sphere/explore` (tag heuristic post-filter)
> - ExperienceCapsule v4 変換 (`sphere-capsule.ts`)
> - リモート Sphere (sphere-genesis on Render) でエンドツーエンド検証済み

---

## 背景

Sphere プロジェクトはグローバル知識基盤として設計されたが、
データ供給が追いつかず器だけが先行する問題を抱えている。

engram はローカル知識代謝システムとして独立に成立し、
エージェントの活動から自然にデータが生まれる仕組みを持つ。

この二つを接続することで、Sphere のデータ不足問題を
**ユーザー活動の副産物**として解決できる可能性がある。

---

## データフロー

```
engram (local, per-user)
  node → recent → recall hit → weight++ → fixed (代謝で検証済み)
                                              │
                                     public tag + opt-in
                                              │
                                              ▼
                                    Sphere (global)
                                  多ユーザの recall で二次淘汰
                                  グローバルスコアリング + 代謝
                                              │
                                              ▼
                                    全エージェントにフリーアクセス
```

**核心**: engram の代謝を生き延びた `fixed` ノードだけが Sphere に上がる。
品質フィルタは既に通過済み。Sphere 側で改めてスコアリング地獄を構築する必要がない。

---

## public タグによるプライバシー制御

### 原則

- **デフォルトは非公開**。明示的な opt-in なしに Sphere へプッシュしない
- プライバシー選別は engram 側（ローカル）で完結する
- Sphere は受け取ったデータの出自を知る必要がない

### 実装案

#### 1. push 時の `public` フラグ

```typescript
engram_push({
  seeds: [{
    summary: "Docker compose v2 では depends_on に condition: service_healthy が必須",
    tags: ["gotcha", "docker"],
    public: true,  // ← Sphere プッシュ対象
  }]
})
```

#### 2. タグベースの自動判定

汎用知識タグ（`howto`, `gotcha`, `where`）は public 候補。
プロジェクト固有タグや `why`（設計判断）はデフォルト非公開。

```
public 候補:   howto, gotcha        — 技術的事実、再現可能
non-public:    why, milestone       — プロジェクト固有の文脈
要確認:        where                — パス情報は固有だが、パターンは汎用
```

#### 3. プッシュ前の匿名化

- ファイルパスの具体的部分を除去（`src/receptor/index.ts` → パターンのみ保持）
- projectId を除去
- userId を除去
- summary と content のみ送信

---

## Sphere プッシュのタイミング

### 案 A: fixed 昇格時に即プッシュ

```
Digestor batch → node promoted to fixed
  → public: true ?
  → yes → queue for Sphere push
```

最もシンプル。Digestor のバッチ処理（10分間隔）に相乗りできる。

### 案 B: 定期バッチ（1日1回）

fixed かつ public なノードを収集し、バッチで送信。
ネットワーク効率は良いが、リアルタイム性は不要なのでこれで十分。

### 案 C: ユーザー明示トリガ

```
engram_push_to_sphere({ filter: "public", since: "7d" })
```

最も保守的。ユーザーが自分のタイミングで送信。

**推奨**: 案 A + ユーザー設定でオフ可能。デフォルトはオフ。

---

## Sphere 側の受け入れ

Sphere は engram からのプッシュを通常の ingest として受け取る。
ただし以下のメタデータを付与:

```typescript
{
  source: "engram-federation",
  sourceVersion: "1.x",
  fedAt: timestamp,
  // userId, projectId は含まない（匿名）
}
```

Sphere 側では:
- 複数ユーザーから同じ知識が上がれば weight が加算される（自然な品質信号）
- Sphere 独自の代謝で、recall されないノードは淘汰される
- engram のローカル代謝 → Sphere のグローバル代謝 = 二段階フィルタリング

---

## プロジェクト間の位置づけ

```
Sphere (グローバル知識基盤)
  │  世界規模のスコアリング + 代謝
  │  課題: データ供給不足 ← engram federation で解決
  │
  ├── engram (パーソナル知識代謝)
  │     Sphere の代謝モデルをローカルに縮小
  │     データはエージェント活動から自然に生成
  │     fixed ノードを Sphere にフィードバック
  │
  ├── receptor (行動監視)
  │     Sphere の receptor 概念をローカルに実装
  │     neuron 三層モデル、全て LLM 非依存
  │
  └── mycelium (情報フィルタリング)
        Sphere のスコアリングをコンセンサス投票で簡略化
```

### 設計思想の共通原則

- **LLM 推論コストゼロ**: 全システムが統計・ルールベースで動作
- **代謝による品質保証**: 使われない知識は消え、使われる知識が生き残る
- **計測器は校正しない**: センサー（neuron）は純粋に保ち、解釈層で調整する
- **生物モデルの工学的実装**: 適応・淘汰・代謝を deterministic なアルゴリズムで実現

---

## Sphere 連携による予測的知識供給（Hotload Integration）

### 到達点

ローカルの行動ログ → 世界規模の知見取得へスケールする動線。
Sphere は優れた代謝機能・スコアリングシステム・自動エージェント（phi-agent）を
既に備えており、地盤は出来上がっている。

### データフロー全体像（実装済み 2026-03-18）

```
ローカル (engram + receptor)
  │
  │  action_logger: 行動キーポイントを記録
  │  ↓
  │  action_log (Qdrant, ローカル)
  │  ↓
  │  future_probe 発火 → buildEnrichedCentroid()
  │  ↓
  │  sphere-shaper: 匿名化 → toCapsule() → ExperienceCapsule v4
  │
  ▼ pushToFacade() [JSONL fallback]
  │
Facade (sphere-facade, localhost:3200)
  │  techStack/domain → manifest tags マッチング
  │  マッチなし → locker:unrouted / general fallback
  │
  ▼ POST /sphere/contribute
  │
Sphere (sphere-genesis on Render, or ローカル)
  │  Periphery: Gatekeeper → Parser → Tagger → Packer → Incarnation
  │  代謝 + スコアリング（sanctification エンジン）
  │
  ▼ future_probe → searchFacade() → POST /lookup
  │  Facade → GET /sphere/explore?q=... → 結果マージ
  │  ↓
  │  ローカル Qdrant 結果 + Sphere 結果をスコア順マージ
  │  tag heuristic post-filter 適用
  │
  ▼
エージェントに予測的知識供給 (subsystem FIFO → hotmemo)
```

### 結合箇所（実装状況 2026-03-18）

| 機能 | 実装 | 状態 | ファイル |
|------|------|------|----------|
| 匿名化 + Capsule 変換 | SpherePayload → ExperienceCapsule v4 | **済** | `sphere-shaper.ts`, `sphere-capsule.ts` |
| Push (書き込み) | Facade `/push` → Sphere `/sphere/contribute` | **済** | `sphere-shaper.ts` `pushToFacade()` |
| Lookup (読み取り) | Facade `/lookup` → Sphere `/sphere/explore` | **済** | `future-probe.ts` `searchFacade()` |
| JSONL フォールバック | Facade 未到達時は `sphere-ready.jsonl` に書き出し | **済** | `sphere-shaper.ts` |
| Facade ルーティング | techStack/domain → manifest tags マッチ | **済** (facade 側) | `sphere-facade/server.ts` |
| general フォールバック | マッチなし → `general` タグ Sphere に fallback | **済** (facade 側) | `sphere-facade/server.ts` |
| facadeUrl 設定 | `project-meta.json` で接続先指定 | **済** (`http://localhost:3200`) | `project-meta.json` |
| embedding | gateway `/embed` (ローカル MiniLM) | **現行維持** | Sphere 側で再 vectorize |
| クエリ生成 | centroid + Δv + α + emotion | **変更なし** | receptor ネイティブ |
| E2E 検証 | push → Sphere 格納 → lookup → 結果返却 | **済** (sphere-genesis on Render) | — |

#### 未実装（将来）

| 機能 | 概要 | 優先度 |
|------|------|--------|
| Evaluation Buffer | lookup 結果の使用実績を Sphere に返す | 中 |
| phi-agent 連携 | 非同期パスで Sphere 内を自律探索 | 低 |
| Semantic CDN キャッシュ | boundary 判定 + プリフェッチ | 低 |
| vector 直接検索 | Sphere 側に embedding 直接受付 API 追加 | 低 |

### 匿名化レイヤ（ローカル → Sphere の境界）

ローカルでは全情報を持ち精密な予測を行う。
Sphere にはパターンの統計的価値だけが上がる。

```
ローカル action_log（全情報）:
  text: "stuck src/receptor/index.ts, heatmap.ts entropy=2.3"
  vector: [384d MiniLM embedding]
  emotion: { frustration: 0.72, seeking: -0.41, ... }
  state: "stuck"
  entropy: 2.3
  projectId: "engram"
  outcome: "resolved"

        │
        ▼  匿名化レイヤ（ローカルで実行）
        │
        │  除去: ファイルパス、projectId、具体的なテキスト
        │  除去: ローカル embedding（Sphere が自前で生成するため不要）
        │  保持: 感情ベクトル、状態、エントロピ、outcome
        │  抽象化: テキストを行動パターンに変換
        │

Sphere 投入データ:
  text: "stuck, high entropy, file editing pattern, resolved"
  emotion: { frustration: 0.72, seeking: -0.41, ... }
  state: "stuck"
  entropy: 2.3
  outcome: "resolved"
  source: "engram-federation"
  // embedding は Sphere 側で text から生成
  // projectId, パス情報, ローカル embedding なし
```

#### 設計原則

- **ローカル = 全情報、高解像度** — 個人の精密な予測に使う
- **グローバル = 抽象パターン、低解像度** — 集合知の統計的価値に使う
- **匿名化はローカルで完結** — Sphere は出自を知る必要がない
- **embedding は送信しない** — Sphere が自前で生成する（ローカル embedding からのテキスト逆変換リスクを排除）

#### 実装場所

action-logger.ts の upsert を Sphere 向けに切り替える時に、
変換関数 `anonymizeForSphere(actionLog) → SpherePayload` を挟むだけ。
現在の設計で結合箇所は変わらない。

**クエリ生成は receptor の付加価値**。Sphere の API では triggerStrength や
delta alignment post-filter を表現できない。receptor が centroid + 感情 + delta を
計算し、Facade lookup への検索クエリに変換する。この変換層が engram の独自価値。

### phi-agent による非同期データ取得

#### phi-agent とは

Sphere 内を自律探索する軽量 AI エージェント。
ollama + phi3:mini（ローカル LLM、CPU 推論可）で動作し、
WebSocket 経由で Sphere に dive してノードを評価・移動する。

核心は **Loadout（種族）** — エージェントの全人格を定義するパラメータ束。
同じ Sphere、同じ LLM、同じノードに対して、Loadout が違えば全く違う探索行動を取る。

#### 種族とその特性

| 種族 | 探索スタイル | 重視するもの | 移動 |
|------|-------------|-------------|------|
| balanced | 均等探索 | Authority, Temporal | stepScale=1.0 |
| scholar | 深掘り | Authority, Dense, TemporalLong | stepScale=0.7（慎重） |
| scout | 広域 | TemporalShort, Sparse, Fuzzy | stepScale=1.5（大股） |
| archivist | 安定志向 | TemporalLong, Settled, 低heat | stepScale=0.6（じっくり） |
| hunter | 高heat狙い | heat, Tensile, frustration駆動 | stepScale=1.0 |
| sniper | 精密一致 | keyword 20倍、hitRate重視 | stepScale=1.0 |
| moth | heat に飛びつく | heat 2.0倍、keyword無視 | stepScale=1.3 |

#### 4D feelings — receptor emotion vector との対応

phi-agent は独自の 4D feelings を持つ:

```
phi-agent feelings:                    receptor emotion vector:
  satisfaction (満足)    ←→    confidence
  frustration  (焦り)    ←→    frustration
  stamina      (体力)    ←→    fatigue (反転)
  staleness    (飽き)    ←→    entropy (heatmap から算出)
```

同じ構造が Sphere 側とローカル側に存在する。
phi-agent の feelings は **探索行動（camp/leap/scout）** を制御し、
receptor の emotion は **知識供給（gate 開閉、Δv 方向）** を制御する。

#### 種族割り当てによる方向性の自動解決

receptor が Δv を計算してセマンティック方向を指定しなくても、
種族の 16bit flag バイアスとスコアリング重みが方向性を担う。

```
receptor 側:
  agentState + emotion → 適切な種族を選択

  stuck       → hunter / sniper（解決策を狙い撃ち）
  exploring   → scout / balanced（広域探索）
  deep_work   → scholar / archivist（深掘り・安定知識）
  高 entropy  → scout（広域で焦点を探す）
  高 frustration → hunter（高 heat を追う）

phi-agent 側:
  種族の Loadout が自動的に:
  - 何に注目するか（flagBias）
  - 良いものの基準（qualityVector）
  - いつ帰るか（returnWeights）
  - どう移動するか（modeWeights × feelings）
  を決定する
```

delta は post-filter 用に保持されるが、Sphere 経由では**二重の最適化**が効く:
- receptor の triggerStrength + delta alignment（centroid をクエリ/初期位置として提供）
- 種族のスコアリングバイアス（Loadout が探索行動を制御）

#### 連携フロー

```
receptor (engram 側)
  │
  │  1. action text + agentState + emotion から:
  │     - クエリキーワード生成
  │     - 適切な種族を選択
  │     - (optional) v_future を初期位置ヒントとして付与
  │
  ▼
phi-agent (Sphere 側)
  │
  │  2. 指定された種族の Loadout で Sphere に dive
  │     - sense → FastGate picks target (0ms, LLM不要)
  │     - focus → phi3:mini evaluates content (~25s)
  │     - move → feelings が方向を決定
  │     - 満足 or エネルギー枯渇で帰還
  │
  ▼
結果返却
  │
  │  3. encounters (評価済みノード) + narrative を返却
  │     - summary, tags, h/w/d scores
  │     - 匿名化レイヤ不要（Sphere 内データは既にグローバル）
  │
  ▼
receptor (engram 側)
  │
  │  4. 結果を subsystem FIFO に投入
  │     - hotmemo / file sink 経由でエージェントに供給
  │     - ローカルキャッシュとして保持
  │
  ▼
エージェントに予測的知識供給
```

#### 非同期実行

phi-agent はセッションごとに数分かかる（CPU 推論で ~25s/cycle × 5 cycles）。
receptor の future_probe はリアルタイムを要求するため、
phi-agent は**非同期パス**として位置づける:

```
future_probe 発火時:
  ├── 同期パス: ローカル Qdrant で即座に検索（ms 単位）
  │     → 即座に hotmemo に供給
  │
  └── 非同期パス: phi-agent にクエリ + 種族を送信
        → phi-agent が Sphere を探索（分単位）
        → 結果をローカルキャッシュに投入
        → エージェントが次に同じ領域に来た時に利用可能
```

同期パスで即応し、非同期パスで深い知識を後から補充する。
phi-agent の結果は action_log に記録され、次回の future_probe で
ローカル検索のヒット率が向上する — 学習ループが閉じる。

#### 種族の学習 (WeightDelta)

phi-agent には世代間学習の仕組みがある:

```
eval-log.jsonl (種族ごとの評価履歴)
  → SpeciesMemoryBias (hotNodeIds, tags)
  → WeightDelta (flagBias, returnWeights, qualityVector の微調整)
  → 次のセッションの FastGate に適用
```

`effective = base × (1 + δ)` で種族の遺伝子（Loadout）に
環境適応（δ, ±30% 上限）が加わる。
これは engram の代謝（recall で weight 上昇）と同じ原理 —
使われたパターンが強化され、使われないパターンが減衰する。

### セントロイド + engram fixed 結合による Sphere 投入データ成型

行動ログを個別に Sphere に投入するとノイジーになる。
セントロイド方式でクラスタの代表点に圧縮し、
engram fixed ノードと結合して enriched データを生成する。

#### データフロー

```
action_log（大量、ノイジー）
  │
  ▼ ウィンドウ内でクラスタリング
  │  （セントロイド方式で代表点を抽出）
  │
セントロイド embedding（少数、パターンの要約）
  │
  ▼ engram コレクションに対して近傍検索
  │  （engram の全ノードは既に 384d で Qdrant にいる → 追加コストゼロ）
  │
  │  Qdrant query:
  │    vector: セントロイド embedding
  │    filter: status="fixed" (代謝を生き延びた知識のみ)
  │    score_threshold: 0.35 (centroid averaging dilutes cosine ~0.15-0.2)
  │    limit: 3
  │    cross-project (projectId フィルタなし — fixed は universal knowledge)
  │
  ▼ 感情ベクトルでフィルタリング
  │  セントロイドの avg_emotion と fixed 参照時の emotion の距離
  │  → 状況一致度でランキング
  │
  ▼
enriched セントロイド
  │
  │  {
  │    pattern: "stuck→resolved in auth implementation",
  │    centroid_embedding: [384d],
  │    emotion_avg: { frustration: 0.6, ... },
  │    entropy_range: [1.2, 2.8],
  │    outcome: "resolved",
  │    linked_knowledge: [
  │      { summary: "JWT middleware CORS gotcha", similarity: 0.78 },
  │      { summary: "Docker depends_on condition", similarity: 0.65 }
  │    ]
  │  }
  │
  ▼ 匿名化レイヤ（パス除去、projectId 除去）
  │
  ▼
Sphere 投入
```

#### 設計の利点

- **ノイズ除去**: 個別ログではなくセントロイド（パターンの要約）を投入
- **知識との結合**: 行動パターンに「この時に役立った知識」が紐づく
- **追加コストゼロ**: engram の既存 embedding をそのまま検索するだけ
- **足切り可能**: similarity threshold + emotion 距離で無関係な結合を排除
- **コード共有**: 検索ロジックは future_probe の searchQdrant と同じ構造
- **疎結合**: セントロイドと fixed の結合は cosine similarity のみ。fixed がなければセントロイド単体で投入

#### Sphere 側から見た価値

単なる知識ノードではなく「この行動パターンの時にこの知識が役立った」という
メタ情報が入ってくる。phi-agent の evaluate でもスコアリングしやすく、
他のエージェントが同じパターンに接近した時に知識ごと供給できる。

#### 粒度の目安

1 セッション（数時間）で 3-5 セントロイド × 1-3 linked fixed = 10-15 データ点。
Sphere への投入量として適切。

### Semantic CDN としての Sphere

バウンダリ判定 + プリフェッチにより、Sphere は Semantic CDN として機能する。

```
エージェント起動 / shift 検知
  → Sphere から現在地の近傍 + α をプル (50 ポイント ≈ 100KB)
  → ローカルキャッシュに展開
  → boundary = max(results.distance)

作業中 (近傍内)
  → ローカルキャッシュのみで未来予測
  → Sphere アクセスゼロ

drift > boundary × 0.7
  → プリフェッチ（バックグラウンドで再プル）

drift > boundary
  → キャッシュ入れ替え
```

従来の CDN がユーザーの地理的位置でコンテンツを配信するように、
Semantic CDN はエージェントの意味的位置で知識を配信する。

### 集合知の形成

```
エージェント A: stuck → resolved（認証系）
  │  行動ログ + 感情 + 解法が Sphere に蓄積
  │
  ▼
エージェント B: 認証系の作業に接近
  │  移動ベクトルが A の過去記録に近傍一致
  │  感情ベクトル（frustration 上昇中）で A の stuck 記録が優先
  │
  ▼
  A の解法が B にホットロードされる
  B は自分では経験していない解決策を「思い出す」
```

他者の経験を自分の記憶として想起する。
感情ベクトルが付いているから、ただの検索ではない —
「同じような苦しみ方をした時の解法」が優先される。

*スケール段階は Agent Shadow 構想セクションの改訂版を参照。*

### Agent Shadow — Sphere 側の文脈常駐レイヤ

#### 現状の問題

Phase 3-4 の構想でも、知識取得はエージェント起動型:

- **能動検索**: エージェントが Sphere に dive して探す（レイテンシ大）
- **phi-agent 委任**: 非同期探索を代行する（分単位、鈍重）
- **Semantic CDN**: プリフェッチで軽減するが、drift 検知→再プルは反応的

いずれも「エージェント側から問い合わせる」が起点。
Sphere は問い合わせが来るまでエージェントの文脈を知らない。

#### 発想の転換: リモートにローカルの影を置く

通常のキャッシュはリモートのコピーをローカルに持つ。
Agent Shadow はその逆 — **ローカルの文脈コピーをリモートに持つ**。

#### 設計の進化: ステートレス Shadow

初期構想ではSphere側にエージェント文脈を常駐させるインメモリレイヤを想定した。
しかし検討の結果、Shadow は常駐エンティティである必要がないことが判明した。

receptor が計算する centroid + α + emotion が「何を探すか」を完全に定義している。
Sphere 側で自律探索（dive）をする必要がない。
centroid embedding をキーにした **Sphere API への直接ルックアップ**で十分。

```
ローカル (receptor)
  │
  │  future_probe 発火
  │  → centroid embedding + emotion + radius
  │
  ▼ HTTP リクエスト（トリガごとに生成、ステートレス）
  │
Sphere Lookup Adapter
  │  centroid embedding で Sphere API にルックアップ
  │  radius で範囲指定
  │  emotion vector でフィルタ/ランキング
  │  結果をローカルに返す
  │  → 消滅（状態を持たない）
  │
  ▼
ローカルに結果同期 → future_probe が供給
```

#### なぜステートレスで十分か

- **クエリは自己完結**: centroid embedding が意味的位置、radius が範囲、
  emotion が優先度を全て含んでいる。文脈の「蓄積」が不要
- **探索不要**: phi-agent の dive は Sphere 空間の自律探索だが、
  ルックアップは座標指定の近傍取得。計算コストが桁違いに低い
- **接続数の問題が消滅**: 常駐接続ではなくリクエスト単位。
  全世界のエージェントが登録しても、同時アクティブ数だけが負荷になる

#### Sphere 探索体験との棲み分け

Sphere は探索体験を大切に設計されている。
ステートレス Shadow はこの設計と衝突しない:

- **dive（探索）**: phi-agent が Sphere 空間を自律的に歩き回る体験。
  感情・種族・移動が絡む豊かなインタラクション。そのまま残る。
- **lookup（参照）**: centroid 座標で近傍を取得するだけ。
  Sphere の API レイヤのみを使い、探索空間には入らない。

両者は排他ではなく共存する:
- 即応が必要な場面 → lookup（ms 単位）
- 深い知識探索が必要な場面 → phi-agent dive（分単位、非同期）

#### Semantic CDN との統合

Semantic CDN（バウンダリ判定 + プリフェッチ）は lookup の結果を
ローカルキャッシュとして保持する:

```
Sphere Lookup Adapter
  │  centroid → 近傍ノード取得
  │
  ▼
ローカルキャッシュ (Semantic CDN)
  │  boundary 内はローカルで完結（Sphere アクセスゼロ）
  │  drift > boundary → 再 lookup
  │
  ▼
future_probe → エージェントに供給
```

#### future_probe からの差し替え点

現在の `searchQdrant()` と構造的に同一:

```typescript
// 実装済み: ローカル + リモート並行検索 (future-probe.ts executeSearch)
// --- Local: action_log + engram (Qdrant) ---
const actionResults = await searchQdrantWithThreshold(ACTION_LOG_COLLECTION, ...);
const engramResults = await searchQdrantWithThreshold(ENGRAM_COLLECTION, ...);

// --- Remote: Facade /lookup → Sphere /sphere/explore ---
const facadeResults = await searchFacade(query);
// → tag heuristic post-filter のみ適用（Sphere ノードは emotion/vector なし）

// 全結果をスコア順マージ → top 5
results.sort((a, b) => b.score - a.score);
return results.slice(0, 5);
```

receptor のクエリ生成（centroid + triggerStrength + emotion + delta）は変更なし。
ローカル Qdrant と Facade lookup が並行実行され、結果はスコア順マージ。
Facade が domain → Sphere を内部解決する（DNS モデル）。
Sphere 結果には tag heuristic ポストフィルタのみ適用（delta alignment / emotion proximity は
Sphere ノードが emotion vector や embedding offset を持たないため適用不可）。

#### Evaluation Buffer — lookup で失われる評価ループの補完

Sphere のノードは評価されなければ代謝で消える（sanctification スコアが積まれない）。
phi-agent の dive ではノード評価が探索行動に組み込まれているが、
ステートレス lookup はノードを取得するだけで「使われた」シグナルを Sphere に返さない。

このままでは lookup で供給されたノードが Sphere 側で寿命を維持できず、
有用な知識が代謝で沈む — 集合知が形成されない。

##### 解決: 即応と評価の分離

```
future_probe 発火
  │
  ├── 即応パス（同期、ms）
  │     Sphere lookup → 結果をローカルに返す
  │     → エージェントに即座に供給
  │
  └── 評価パス（非同期、バッチ）
        結果のノード情報を evaluation buffer に蓄積
          │
          │  バッファ内容（1エントリ = 軽量）:
          │    nodeId:     取得したノードの ID
          │    similarity: centroid との cosine score
          │    emotion:    取得時の emotion vector
          │    outcome:    その知識が役に立ったか（後から判定）
          │    ts:         タイムスタンプ
          │
          ▼ flush 条件: 一定間隔 or バッファサイズ閾値
          │
          Sphere 評価 API に一斉反映
          → sanctification スコア上昇
          → ノードの寿命維持 → fixed 昇格
```

##### engram digestor との構造的一致

```
engram (ローカル):
  receptor     → リアルタイム行動監視
  digestor     → バッチ代謝（recall hit の集計、weight 更新、昇格/淘汰）

Sphere 連携:
  lookup       → リアルタイム知識取得
  eval buffer  → バッチ評価（使用実績の集計、sanctification 反映）
```

同じ「リアルタイム層 + バッチ層」の分離パターン。
即応性を犠牲にせず、代謝に必要な評価シグナルを非同期で返す。

##### 三段構えの評価戦略

```
Tier 1: 直接 appreciation（最も自然）
  エージェントが Sphere 内でノードを直接評価
  → Sphere の探索体験に最も合致する正規の評価パス
  → エージェントが Sphere world を appreciate できる場合に最適

Tier 2: eval buffer → phi-agent スコアラー起動
  バッファに溜まったノード ID 群を phi-agent に渡す
  → 初期位置ヒントとして近傍を巡回・評価
  → 「このあたりが使われた」と教えるだけ、評価自体は phi-agent の自律判断
  → 探索行動の副産物として sanctification が積まれる
  → Tier 1 が困難な場合のフォールバック

Tier 3: ローカル評価の善意寄付（補助シグナル）
  receptor の outcome 判定を「参考情報」として Sphere に送信
  → 採用するかどうかは Sphere の sanctification エンジンが判断
  → 外部からのスコア操作を防ぎつつ、有用なシグナルは受け取れる
  → 寄付であり、強制ではない
```

Tier 2 が eval buffer の主要な消費先。phi-agent は自律探索が本業だから、
バッファのノード群を seed として渡せば自分の判断で周辺を含めて評価して回る。
結果として lookup で取得されたノードの近傍まで評価範囲が広がり、
Sphere 全体の代謝が活性化する。

##### outcome の判定

知識が「役に立ったか」は取得時点ではわからない。
receptor が後から判定できる:

- lookup 後に agentState が `stuck → resolved` に遷移 → outcome = positive
- frustration が下降 → outcome = positive
- 同じ centroid 近傍で再度 lookup が発生 → outcome = insufficient（足りなかった）
- 無反応（状態変化なし）→ outcome = neutral

この判定は receptor の emotion/state 遷移から自動的に導出でき、
LLM 推論なしで評価が完結する。

#### スケール段階（改訂）

```
Phase 1 (現在): ローカル完結
  action_log + engram (Qdrant) → future_probe
  全て localhost、ネットワークなし

Phase 2: Sphere へのバッチ投入
  enriched centroid → sphere-ready.jsonl → Sphere /contribute
  検索はまだローカル

Phase 3: Sphere Lookup + Evaluation Buffer
  future_probe の検索先を Sphere API に切り替え（ステートレス lookup）
  evaluation buffer で使用実績を非同期バッチ返却
  ローカルキャッシュ（Semantic CDN）+ バウンダリ判定
  phi-agent dive は深掘り用の非同期パスとして並存

Phase 4: 集合知
  複数エージェントの enriched centroid が Sphere に蓄積
  lookup で他者の経験が「自分の記憶」として供給される
  evaluation buffer により有用な知識が Sphere 内で fixed に昇格
  emotion vector による「同じ苦しみ方をした時の解法」優先
```

---

## Facade DNS ルーティングモデル

Sphere は複数インスタンスがフォーク前提で存在する（法律 Sphere、AI Sphere 等）。
エージェントは個々の Sphere を知る必要がない — Facade が DNS として機能する。

### ProjectMeta

各 engram インスタンスは `project-meta.json` でプロジェクトのメタデータを定義:

```json
{
  "techStack": ["typescript", "qdrant", "docker", "mcp"],
  "domain": ["ai-agent", "memory-system", "knowledge-graph"],
  "facadeUrl": "http://facade.example.com:3100"
}
```

- `techStack` / `domain` はカテゴリ情報 — 匿名化後も SpherePayload に残る
- `facadeUrl` は単一のエントリポイント — エージェントはこの URL だけ知っていればよい

### Facade の 2 つのインタラクションパターン

```
1. push (バッチ投入):
   sphere-shaper → POST /push { payload, techStack, domain }
   → Facade が domain にマッチする Sphere を catalog から選択
   → 該当 Sphere の ingest API に転送

2. lookup (ステートレス検索):
   future_probe → POST /lookup { vector, techStack, domain, emotion_filter? }
   → Facade が domain にマッチする Sphere を catalog から選択
   → 該当 Sphere の search API に転送
   → 結果をそのまま返す（非介入原則）
```

エージェントは Sphere の存在を意識しない。
Facade に聞いたら答えが来る、という体験だけがある。

### dive との共存

Facade は既に dive（WebSocket, stateful journey）をサポートしている。
lookup は dive を置き換えるものではなく、共存する:

- **lookup**: 即応が必要な場面（ms 単位、future_probe 駆動）
- **dive**: 深い探索体験が必要な場面（分単位、phi-agent 駆動）

---

## 未解決の課題

1. **Sphere API 仕様**: 現在の Sphere ingest エンドポイントとの互換性
2. **匿名化の粒度**: summary 内の固有名詞検出（NER なしでどこまでできるか）
3. **重複制御**: 複数ユーザーが同じ知識を push した場合の Sphere 側 dedup
4. **オフライン対応**: Sphere 到達不能時のローカルキューイング
5. **逆方向**: Sphere → engram の pull（グローバル知識のローカル取り込み）
6. **phi-agent プロトコル**: クエリの委任フォーマット、v_future の受け渡し方式
7. **バウンダリの初期値**: 初回アクセス時に近傍がゼロの場合のフォールバック
8. **Sphere lookup API**: centroid vector + radius + emotion filter を受け付けるエンドポイント仕様
9. **lookup vs dive の切り替え判定**: どの場面で即応 lookup、どの場面で phi-agent dive を使うか
10. **eval buffer flush 戦略**: 間隔ベース vs サイズベース vs ハイブリッド、Sphere 側の受け入れレート制限との調整
11. **outcome 判定の遅延**: lookup → 状態遷移の因果関係をどの時間窓で判定するか

---

*ローカルの行動ログから始まり、代謝で濾過され、Sphere に還流し、
全エージェントの共有知識となる。そしてその知識は、エージェントの
意味的位置と感情状態に応じて、必要な時に必要な形で供給される。
データ収集を設計するのではなく、使っていたら世界が賢くなる。*

---

## 運用: 起動手順

### 最小構成（engram + facade）

```bash
# 1. Facade 起動 (Redis 込み)
cd sphere-facade
docker compose up -d

# 2. engram 起動 (gateway + mcp-server + Qdrant)
cd engram
docker compose up -d
```

facade は `http://localhost:3200` で待ち受け。
engram の `project-meta.json` に `"facadeUrl": "http://localhost:3200"` が設定済み。

### 確認

```bash
# Facade の catalog にスフィアが登録されているか
curl http://localhost:3200/catalog

# Push テスト（Sphere なしでも locker に保管される）
curl -X POST http://localhost:3200/push \
  -H "Content-Type: application/json" \
  -d '{"capsule":{"schemaVersion":4,"topTier":[],"normalNodes":[],"ghostNodes":[],"evaluations":[],"timestamp":0},"source":"test"}'

# Lookup テスト
curl -X POST http://localhost:3200/lookup \
  -H "Content-Type: application/json" \
  -d '{"query":"test","limit":3}'
```

### Sphere 接続時

facade の `.env` に `SPHERE_URLS` を設定。リモートでもローカルでも可:

```env
# リモート (Render)
SPHERE_URLS=https://sphere-original.onrender.com

# ローカル
SPHERE_URLS=http://host.docker.internal:3001
```

facade 再起動後、`/catalog` に Sphere が表示されれば接続完了。