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

## 設計原則

- **LLM 推論コストゼロ**: embedding は MiniLM (ローカル)、フィルタリングは数値演算のみ
- **既存インフラの再利用**: heatmap, receptor, engram, mycelium の接続
- **局所性**: 全ノードスキャンではなく、heatmap 上位パスの意味的近傍のみ
- **代謝の継承**: ウィンドウ方式で上書き、古いパターンは自然に消える
- **間接誘導**: 直接注入ではなく、gate の開閉で供給を制御（C neuron と同じ思想）

---

## 関連ドキュメント

- `RECEPTOR_ARCHITECTURE.md` — emotion vector, state classification, heatmap
- `SUBSYSTEM_INTEGRATION.md` — サブシステム FIFO, output routing
- `SPHERE_FEDERATION.md` — Sphere 連携、public tag 設計
- `PASSIVE_RECEPTOR_DESIGN.md` — パッシブレセプタのスコアリング

---

*パッシブレセプタが「異常を検知して反応する免疫系」なら、
ホットロードは「必要な栄養を予測して供給する循環系」。
二つ合わせて、エージェントの認知インフラが完成する。*