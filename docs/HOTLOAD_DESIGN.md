# Hot Load — 局所アクティベーションによる予測的知識供給

> 2026-03-16 設計構想。未実装。

---

## 概要

receptor が「エージェントが何をしているか」を知り、
engram が「何を知っているか」を持っている。
この二つを接続し、**今のタスクに最適な知識を予測的にプリフェッチする**。

パッシブレセプタの「異常検知 → 発火 → 検索」とは逆方向のアプローチ。
**常に近傍を把握し、状態変化の瞬間に即座に供給する。**

---

## アーキテクチャ

```
行動履歴（tool_name + path + result + emotion）
        │
        ▼
  ウィンドウ方式でベクトライズ（5分窓、上書き）
  「このエージェントは今こういう作業をしている」の embedding
        │
        ▼
  mycelium インメモリ空間に展開
        │
        ├── 過去の行動パターン（蓄積）
        ├── engram ノード（ローカル知識）
        └── sphere ノード（グローバル知識）← 将来
        │
        ▼
  リアルタイム近傍探索（cosine similarity）
        │
        ▼
  感情ベクトルで重み付けフィルタリング
        │
        ▼
  activation gate（receptor state で開閉）
        │
        ▼
  hotmemo / subsystem FIFO
```

---

## Phase 1: heatmap ベースのホットロード

既存インフラだけで実現可能な最小構成。

### データフロー

```
heatmap.json (5min snapshot, 既存)
      │
      ▼
  topPaths → キーワード抽出（service-loader と同じ手法）
      │
      ▼
  engram_pull (background, 非同期)
      │
      ▼
  ホットロードバッファ（近傍ノード候補、スコア付き）
      │
      ▼
  receptor state change → activation gate
      │
      ├── stuck / exploring → gate open → hotmemo に注入
      ├── deep_work → gate closed（邪魔しない）
      └── idle → ロードしない
```

### 接続点（全て既存）

| コンポーネント | 役割 | 状態 |
|--------------|------|------|
| heatmap snapshot | 入力（作業領域） | 実装済み |
| engram_pull | 検索 | 実装済み |
| receptor state | ゲート制御 | 実装済み |
| subsystem FIFO | 出力 | 実装済み |
| receptor-rules.json | メソッド定義 | 拡張のみ |

新規コード: ホットロードバッファ + アクティベーションゲートのロジック。

---

## Phase 2: 行動ベクトル空間

エージェントの行動自体をベクトル空間に展開する。

### 行動ウィンドウのベクトライズ

```
5分窓の行動サマリ:
  "Read src/receptor/index.ts, Edit heatmap.ts, Bash npm test fail,
   Edit heatmap.ts, Bash npm test success, Grep emotion"
        │
        ▼
  embedding (all-MiniLM-L6-v2, 384d)
        │
        ▼
  mycelium インメモリ空間に投入（ウィンドウ方式、上書き）
```

行動履歴が蓄積されると、過去のセッションの行動パターンとの
cosine similarity で「以前同じような作業をした時の知識」を引ける。

### mycelium の役割

- Qdrant ではなくインメモリで高速演算（mycelium の既存強み）
- 開発作業は時間を伴うため、データが溜まったタイミングでバッチベクトライズ
- ウィンドウ方式で上書き — 無限蓄積しない（代謝の原則）

---

## Phase 3: 感情ベクトルによるフィルタリング

**核心設計: システム側が感情を持つ**

receptor の emotion vector（6軸）を検索結果の重み付けに使う。
cosine similarity だけでは「意味的に近いもの」しか出ない。
感情ベクトルを掛けることで「今の状態に役立つもの」が優先される。

### 感情 × 検索の重み付け

```
candidate_score = cosine_similarity(行動embedding, ノードembedding)
                × emotion_weight(receptor_state, candidate_tags)
```

| receptor state | frustration 高 | hunger 高 | confidence 高 |
|---------------|---------------|-----------|--------------|
| stuck | 解決系を優先 (gotcha, error-resolved) | 概要系を優先 (howto) | 抑制 |
| exploring | 抑制 | 深掘り系を優先 (where, why) | 保存を推奨 |
| deep_work | 全て抑制 | 全て抑制 | 全て抑制 |

### Sphere の 3 軸評価との対応

| Sphere | Hot Load | 意味 |
|--------|----------|------|
| heat | cosine similarity | 意味的近さ（注意と関連性） |
| weight | emotion_weight | 状態適合度（信頼と深さ） |
| decay | TTL / staleness | 鮮度（古い知識の減衰） |

engram のローカル代謝が Sphere のグローバル代謝と同じ構造を
エージェントの内部で再現している。

---

## 感情ベクトルの検索空間への統合

### 案 A: ポストフィルタ（Phase 1-2 で十分）

cosine 検索 → 上位 N 件 → emotion weight で再ランキング。
検索空間自体は変更しない。実装が軽い。

### 案 B: ベクトル結合（Phase 3）

```
search_vector = concat(行動embedding[384d], emotion_vector[6d])
                → 390d のハイブリッド空間
```

ノード側にも「このノードはどの感情状態で有用か」の 6d ベクトルを付与。
検索が一発で意味 + 感情の最適解を返す。

ただし 6d の感情軸は 384d の意味軸と次元数が違いすぎるため、
重み調整 (alpha blending) が必要:

```
hybrid = alpha × normalize(行動embedding) + (1-alpha) × normalize(emotion_vector_padded)
```

alpha は receptor state で動的に変更:
- deep_work: alpha=1.0（感情無視、純粋な意味検索）
- stuck: alpha=0.7（感情を強く反映）

### 推奨

Phase 1-2 は案 A（ポストフィルタ）で十分。
Phase 3 で案 B を検討。ただし案 A で実用上問題なければ不要。
**過剰な最適化より、動く最小構成を先に。**

---

## 実装ロードマップ

### Phase 1: heatmap ホットロード（最小構成）

- [ ] receptor-rules.json に `hotload_probe` メソッド追加
- [ ] heatmap snapshot → キーワード → engram_pull (background)
- [ ] ホットロードバッファ（subsystem FIFO と別の小さなリングバッファ）
- [ ] activation gate: state 変化時にバッファから hotmemo へ注入
- [ ] 5分間隔（heatmap flush と同期）

### Phase 2: 行動ベクトライズ

- [ ] 行動ウィンドウのテキスト化（tool + path + result の要約文生成）
- [ ] embedding 生成（gateway の embedding エンドポイント利用）
- [ ] mycelium インメモリ空間への投入
- [ ] 行動 embedding での近傍探索
- [ ] 過去セッションの行動パターンとのマッチング

### Phase 3: 感情フィルタリング

- [ ] emotion vector → 検索重み付けマッピング定義
- [ ] candidate_score = cosine × emotion_weight 算出
- [ ] state 遷移時の動的 alpha 調整
- [ ] チューニング: calibration-scenarios.json にホットロードシナリオ追加

---

## 感情レイヤの疎結合設計

### 原則: 感情は知識に焼き込まない

engram は**事実**を保持する。感情は**参照文脈**であり事実ではない。
同じノードが stuck で参照される時と deep_work で参照される時がある。
ノードに感情を焼き込むと上書き合戦になる。

### 構造

```
hotload.ts 内部（インメモリ、セッション揮発）:

  emotionMap: Map<nodeId, EmotionContext>
    EmotionContext = {
      lastEmotion: EmotionVector,   // 最後の参照時の感情
      recallCount: number,
      lastState: AgentState,
      updatedAt: number,
    }

  発火ポイント: Array<FiringPoint>
    FiringPoint = {
      embedding: Float32Array,      // 行動パターン embedding
      emotion: EmotionVector,       // その時の感情
      outcome: 'stuck' | 'resolved' | 'flow',
    }
```

- engram_pull の結果を受け取り → emotionMap から感情コンテキストを付与
- 未登録 → 現在の emotion vector で新規登録
- 既存 → 差分更新（EMA で平滑化）
- engram のスキーマ変更は**一切不要**

### 汎用ミドルウェアとしての将来性

感情レイヤが独立していれば、engram 以外のあらゆるアプリにアタッチ可能:

```
receptor (sensor) → 感情レイヤ (middleware) → consumer (任意のアプリ)

engram + 感情レイヤ → 知識の感情的文脈化
Sphere + 感情レイヤ → グローバル知識の個別最適化
IDE    + 感情レイヤ → コード推薦の状態適応
CI/CD  + 感情レイヤ → ビルド失敗時の予測的支援
```

sensor と consumer は互いを知らない。

### 切り出し戦略

1. engram の `receptor/hotload.ts` として実装（実験しやすい）
2. 動くことを確認したら、独立パッケージに切り出し
3. receptor → 感情レイヤ → consumer の 3 層を明確に分離

Sphere が大きすぎて engram が生まれたのと同じ順序:
**動く小さいものを先に作り、うまくいったら切り出す。**

---

## 設計原則

- **LLM 推論コストゼロ**: embedding は MiniLM (ローカル)、フィルタリングは数値演算のみ
- **既存インフラの再利用**: heatmap, receptor, engram, mycelium の接続
- **局所性**: 全ノードスキャンではなく、heatmap 上位パスの意味的近傍のみ
- **代謝の継承**: ウィンドウ方式で上書き、古いパターンは自然に消える
- **間接誘導**: 直接注入ではなく、gate の開閉で供給を制御（C neuron と同じ思想）
- **感情は事実と混ぜない**: 知識ストアは純粋に保ち、感情レイヤはインメモリ middleware

---

## 設計議論ログ (2026-03-16)

### 感情レイヤの再認識

当初 hotload.ts 内に独自の emotionMap を設計していたが、
議論の結果 **receptor の emotion vector がそのまま感情レイヤである** ことに気づいた。
新しいレイヤを作る必要はない。receptor の listener として hotload を追加するだけ。

```typescript
_listeners.push(onFireSignals);     // パッシブレセプタ（異常検知）
_listeners.push(onHotloadCycle);    // ホットロード（未来予測）
```

パッシブレセプタとホットロードは同じ感情ベクトルの**別の消費者**に過ぎない。

### 未来予測の3層

| 層 | 手法 | 精度 | 実装難度 |
|----|------|------|----------|
| 慣性予測 | 過去の行動系列 → 次の行動推定 | 低 | 低 |
| 地形予測 | 現在地 × 移動方向 → 進路上の知識ノード検出 | 中 | 中 |
| 意図予測 | 行動の意味的収束度 → 目的地推定 → 最適知識供給 | 高 | 高 |

意図予測の鍵は**行動の意味的収束度**。
heatmap のアクセス対象が同じクラスタに集中しているか分散しているかで、
探索が実りそうかどうかを推定できる。

### ファイル検索エントロピ

heatmap から即座に算出可能な先行指標。

```
entropy = -Σ (p_i × log2(p_i))
  where p_i = count_i / totalHits

集中 (entropy 低 ≈ 0.9): 目的地が見えている → Edit に向かう
分散 (entropy 高 ≈ 2.3): 焦点が定まらない → stuck の予兆
```

エントロピの急激な再上昇は **frustration が閾値を超える前の先行指標** になる。
receptor の emotion が反応型なのに対し、エントロピは予測型。

#### エントロピの適用範囲

議論の結果、エントロピは **heatmap のネイティブ指標として局所的に留める** のが正しいと判断。

- ファイルパスは木構造を持つため、分散に意味がある
- 外部 API コールやランダムなクエリには構造がなく、エントロピは無意味
- 汎用化の価値は薄い

```
heatmap entropy  → ファイル行動に特化した先行指標（局所的、高精度）
emotion vector   → 行動パターン全般の状態指標（汎用、中精度）
```

この二層で十分。entropy は heatmap.ts に閉じ込め、emotion system への入力として使う。

### engram data と感情の分離

- engram は**事実**を保持する。感情は**参照文脈**であり事実ではない
- 同じノードが stuck と deep_work で参照されうる — 焼き込むと上書き合戦
- 感情コンテキストは hotload のインメモリで完結（セッション揮発で問題ない）
- engram のスキーマ変更は**一切不要**

### 未来予測の定義 — 移動ベクトルに対する近傍探索

ベクトル空間に「方向」がある。行動 embedding の差分が移動ベクトルを与える。

```
v_prev  →  v_now  →  v_future = v_now + α × Δv
                          ↑
                     ここで近傍探索
```

| 概念 | 手法 | 何を見ているか |
|------|------|--------------|
| 反応 | 閾値超過で発火 | 現在の状態 |
| 近傍探索 | v_now の周辺 | 現在地の知識 |
| 慣性予測 | v_now + Δv | 進行方向の知識 |
| 適応予測 | v_now + α(entropy, emotion) × Δv | 状態を加味した進行方向 |
| 迂回予測 | v_now ± rotate(Δv) | 行き詰まり時の代替路 |

#### α の調整

```
entropy 低（集中）   → α 大（方向に確信、遠くを探せ）
entropy 高（分散）   → α 小（方向不定、近場に留まれ）
frustration 上昇中   → Δv の逆方向・直交方向にも展開（迂回路探索）
```

stuck 時に Δv 方向だけ見ても解はない — だから stuck になっている。
逆方向・直交方向の探索がエージェントの視野外の知識を提示する。

#### 確率的性質

感情ベクトル 6 軸は確定状態ではなく**可能性の分布**を表現している。
frustration 0.7 は「stuck になる確率が高い」であって「stuck である」ではない。
予測が外れてもバッファに残るだけで害はない。当たれば stuck を未然に防ぐ。

**未来予測とは、現在地ではなく移動ベクトルに対して近傍探索をかけること。**

### embedding と数値の分離原則

MiniLM はテキスト embedding モデルであり、数値の大小関係を意味的距離として捉えない。
`frustration=0.72` と `frustration=0.35` の差はテキスト embedding では潰れる。

```
行動 embedding:  v_action = MiniLM("Read index.ts, Edit heatmap.ts")   [384d]
感情ベクトル:    v_emotion = [0.72, 0.41, 0.35, 0.15, 0.08, 0.50]     [6d]

検索は v_action で行い、結果を v_emotion で重み付けフィルタリング
```

Qdrant point 構造:
```json
{
  "vector": "[384d MiniLM embedding]",
  "payload": {
    "text": "Read index.ts, Edit heatmap.ts, Bash fail",
    "emotion": { "frustration": 0.72, "hunger": 0.41 },
    "state": "stuck",
    "entropy": 2.3,
    "ts": 1773667985217
  }
}
```

vector で cosine 検索、payload の emotion で重み付け。
engram コレクションとは別コレクションに保存（知識と行動ログは性質が違う）。

### 要所記録とクラスタ形成

全行動を記録するのではなく、要所だけを記録する:
- `stuck → resolved` の遷移点
- `exploring → deep_work` の収束点
- entropy が急変した瞬間

要所をベクトライズ + 感情 payload で保存すると、
似た状況は意味空間で自然にクラスタを形成する。

```
現在地から:
  同クラスタ内     → 関連知識をホットロード
  クラスタ間距離   → プロジェクト全体のエントロピ
  過去の遷移パターン → 次の遷移を予測
```

#### 感情による多重展開

同じクラスタに対して、感情状態が違えば引き出すものが変わる:

```
クラスタ「認証系の実装」:
  frustration 高 → gotcha, error-resolved を優先
  confidence 高  → 次のタスク候補を供給
  hunger 高      → 概要的な howto を供給
```

#### mycelium によるクラスタ圧縮

広域のクラスタ管理には mycelium のフィルタリングを利用:

```
engram (大量、個別ノード、感情 payload 付き)
  │
  ▼
mycelium filter (コンセンサス投票で圧縮)
  │  生存ノードに感情 payload を継承
  │  複数ノード統合時は感情を平均化
  ▼
クラスタ代表ノード（少数、高品質、感情付き）
  │  「この領域は主に stuck 時に参照された」等の領域性格
  ▼
ホットロードの検索対象（インメモリ、高速）
```

mycelium 側の変更: 感情メタデータの保存は未実装。
フィルタリング結果に元の行動ログの感情 payload を引き継ぐ拡張が必要。

### 疎結合の帰結

感情レイヤ = receptor の emotion vector がそのまま middleware になる。
sensor (receptor) と consumer (パッシブ/ホットロード/将来の任意アプリ) は互いを知らない。

```
receptor (sensor) → emotion vector (middleware) → consumer
  consumer A: パッシブレセプタ（異常検知 → 発火 → 検索）
  consumer B: ホットロード（近傍探索 → 感情重み付け → 予測供給）
  consumer C: (将来) IDE プラグイン、CI/CD 連携、etc.
```

---

## 関連ドキュメント

- `RECEPTOR_ARCHITECTURE.md` — emotion vector, state classification, heatmap
- `SUBSYSTEM_INTEGRATION.md` — サブシステム FIFO, output routing
- `SPHERE_FEDERATION.md` — Sphere 連携、public tag 設計
- `PASSIVE_RECEPTOR_DESIGN.md` — パッシブレセプタのスコアリング
- `SEMANTIC_CDN.md` — Semantic CDN 構想、バウンダリ判定、集合知

---

## 実装メモ (次回着手)

### hotload.ts の位置づけ

passive.ts と並列する**もう一つの解釈レイヤ**。
発火後の配信（hotmemo, file sink 等）は既存配線に任せる。

```
FireSignal[] (B neuron 出力)
       │
       ├── passive.ts (異常検知 → method scoring → dispatch)
       └── hotload.ts (未来予測 → 近傍探索 → subsystem FIFO)
```

### 実装タスク

1. **heatmap.ts に `entropy()` メソッド追加**
   - topPaths の count 分布から Shannon entropy を算出
   - 1 メソッド、数行

2. **action_log コレクション**
   - engram の既存 Qdrant に新規コレクション作成
   - 行動テキスト embedding [384d] + 感情 payload
   - 要所（state 遷移点、entropy 急変）のみ記録

3. **hotload.ts 本体**
   - `_listeners.push(onHotloadCycle)` で receptor に接続
   - 現在地 embedding の追跡（v_prev, v_now 保持）
   - Δv 計算 + α 調整（entropy, emotion）
   - engram_pull を executor 経由で近傍探索
   - 結果を subsystem FIFO に置く

4. **gate 制御**
   - deep_work / flow → 抑制（A gate と同じ基準）
   - stuck 接近 / exploring 長期化 → 供給
   - 新しい判断基準は不要、receptor の既存ロジックを流用

### 依存関係

```
heatmap.ts (entropy 追加) → 依存なし、先にやる
action_log コレクション   → gateway の Qdrant 初期化に追加
hotload.ts               → heatmap, action_log, executor registry に依存
index.ts                 → _listeners に hotload を追加（1行）
```

### やらないこと（スコープ外）

- 外部 DB へのフェッチ（Step 2 以降）
- バウンダリ判定 / プリフェッチ（Semantic CDN 層、後回し）
- mycelium 連携（クラスタ圧縮、後回し）
- 発火後の配信経路変更（既存配線で十分）

---

*パッシブレセプタが「異常を検知して反応する免疫系」なら、
ホットロードは「必要な栄養を予測して供給する循環系」。
Semantic CDN はその配送インフラ。
三つ合わせて、エージェントの認知インフラが完成する。*