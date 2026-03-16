# Semantic CDN — エージェントの意味的位置に基づく知識配信

> 2026-03-17 設計構想。HOTLOAD_DESIGN.md の議論から派生。

---

## 概要

従来の CDN は「ユーザーが東京にいるから東京のサーバーからコンテンツを配信する」。
Semantic CDN は「エージェントが認証系の実装をしているから、認証系の知識を手元に配信する」。

```
従来の CDN:    地理的位置 → 最寄りサーバー → コンテンツ配信
Semantic CDN:  意味的位置（行動 embedding） → 近傍知識プル → ローカルキャッシュ配信
```

エージェントに「位置」がある — これが全ての出発点。
ファイルアクセス・検索・編集の履歴が embedding として数値化され、
ベクトル空間上の現在地になる。現在地の周囲にある知識をプルしてローカルに置き、
作業中はローカルキャッシュだけで動く。大きく移動したら再プル。

---

## アーキテクチャ

```
┌─────────────────────────────────────────────┐
│  エージェント（ローカル）                       │
│                                               │
│  行動 → heatmap → embedding → 現在地          │
│                                  │             │
│              ┌───────────────────┤             │
│              │                   │             │
│       ローカルキャッシュ    バウンダリ判定       │
│       (近傍知識+感情)      drift > 0.7 ?       │
│              │                   │             │
│              ▼                   │ yes         │
│        未来予測・供給             │             │
│        (Δv + 感情重み付け)       │             │
└──────────────────────────────────┼─────────────┘
                                   │
                            プル / プリフェッチ
                                   │
                    ┌──────────────▼──────────────┐
                    │  知識ストア（リモート）        │
                    │                              │
                    │  engram (個人知識)             │
                    │  action_log (行動ログ)        │
                    │  Sphere (グローバル知識)       │
                    │  他エージェントの行動ログ       │
                    │  + 代謝エンジン（鮮度管理）     │
                    └──────────────────────────────┘
```

---

## 何を embedding するか

**行動ログのテキスト要約のみ。感情は embedding しない。**

```
embedding 対象:
  "Read src/receptor/index.ts, Edit heatmap.ts, Bash test fail, Grep emotion"
  → MiniLM → 384d vector

embedding しない（payload に数値のまま保存）:
  感情ベクトル [0.72, 0.41, 0.35, ...]
  state "stuck"
  entropy 2.3
```

理由: MiniLM はテキスト embedding モデル。数値の大小関係を意味的距離として捉えない。
`frustration=0.72` と `frustration=0.35` の差はテキスト embedding では潰れる。
行動の意味は embedding で、感情の数値は数値演算で — それぞれの得意分野で処理する。

---

## 検索の仕組み

エージェントが明示的にクエリを投げるのではない。
**現在地 embedding が自動的にクエリになる。**

```
現在地 embedding（行動ログから自動生成）
  → cosine similarity で近傍ヒット
  → payload の感情ベクトルでポストフィルタ / 重み付け

感情フィルタリング:
  同じ近傍でも:
    frustration 高 → gotcha, error-resolved を優先
    confidence 高  → 次タスク候補を優先
    hunger 高      → howto を優先
    deep_work      → 全て抑制
```

---

## 保存構造

行動ログは**要所のみ**記録。全イベントではない。

記録する要所:
- `stuck → resolved` の遷移点
- `exploring → deep_work` の収束点
- entropy が急変した瞬間

```json
{
  "vector": "[384d - 行動テキストの embedding]",
  "payload": {
    "text": "Edit heatmap.ts, Bash test fail x3, Grep emotion, Edit index.ts",
    "emotion": { "frustration": 0.72, "hunger": 0.41 },
    "state": "stuck",
    "entropy": 2.3,
    "outcome": "resolved",
    "resolution": "heatmap.ts の import パスが間違っていた",
    "ts": 1773667985217,
    "projectId": "engram"
  }
}
```

1 ポイント ≈ 2KB（384d float32 = 1.5KB + payload 0.5KB）。
1 日 50 要所 = 100KB。1 年 = 36MB。軽量。

---

## バウンダリ判定とプリフェッチ

プル時の最遠近傍の距離がキャッシュ半径になる。

```
プル時:
  center = v_now
  results = search(v_now, limit=50)
  boundary = max(results.map(r => r.distance))  // 例: 0.65

作業中:
  drift = cosine_distance(v_now, center)

  drift < boundary × 0.7  → キャッシュ内、何もしない
  drift > boundary × 0.7  → 境界に接近、プリフェッチ開始
  drift > boundary         → 境界を出た、再プル必須
```

0.7 の余裕で境界を出る前にプリフェッチ。
50 ポイント × 2KB = 100KB のプル。ネットワーク負荷はほぼゼロ。

---

## 未来予測 — 移動ベクトルに対する近傍探索

現在地だけでなく、**向かっている方向**の知識を引ける。

```
v_future = v_now + α × Δv

  Δv = v_now - v_prev（移動ベクトル）
  α は entropy と emotion で調整:
    entropy 低（集中）   → α 大（方向に確信、遠くを探せ）
    entropy 高（分散）   → α 小（方向不定、近場に留まれ）
    frustration 上昇中   → 逆方向・直交方向にも展開（迂回路探索）
```

未来予測とは、**現在地ではなく移動ベクトルに対して近傍探索をかけること**。

---

## 集合知 — 他エージェントの行動ログ

あるエージェントが stuck → resolved した記録が、
別のエージェントが同じ意味領域に到達した時にキャッシュに入る。

```
Agent A: stuck at "認証 middleware" → resolved (原因: session token の expire)
  ↓ action_log に保存（感情 payload 付き）

Agent B: "認証 middleware" 領域に接近
  ↓ 現在地 embedding が Agent A の記録に近傍ヒット
  ↓ 感情: frustration 上昇中 → 解決系を優先
  ↓ Agent A の resolution がホットロードされる
```

明示的な知識共有なしに、行動の副産物として集合知が形成される。

---

## 実装ステップ

### Step 1: ローカル閉じたループ（engram 内）

```
engram Qdrant:
  engram コレクション（既存）: 知識ノード
  action_log コレクション（新規）: 行動ログ + 感情 payload
```

- 行動ログの要所を自動記録
- 現在地 embedding で action_log を検索
- 感情フィルタリングで過去の解法を引く
- 代謝は engram の Digestor に相乗り

### Step 2: 外部 DB への経路

- action_log コレクションだけを外部 Qdrant / マネージド DB に向ける
- コレクションが分かれているので切り替えは容易
- バウンダリ判定 + プリフェッチで最小ネットワークアクセス

### Step 3: 複数エージェント間共有

- 外部 DB に複数エージェントの action_log が蓄積
- projectId でスコープ制御、匿名化オプション
- 代謝エンジンで古いログは自然消滅

---

## 5つの特性

| 特性 | CDN との対応 | 実現手段 |
|------|------------|----------|
| 位置ベースの配信 | 地理的位置 → 最寄りサーバー | 行動 embedding → 近傍知識プル |
| キャッシュとプリフェッチ | TTL + edge cache | バウンダリ判定 + drift 監視 |
| 鮮度管理 | TTL expiry | 代謝（使われた知識が生存） |
| コンテンツ最適化 | デバイス別配信 | 感情ベクトルで優先度変動 |
| 集合知 | CDN にはない | 他エージェントの行動ログ共有 |

---

## なぜ誰も作っていないか

技術的には全て既存のもの:
cosine similarity, ベクトル DB, EMA, エントロピ, プリフェッチ。

**エージェントに「位置」があるという認識がない**からだ。
embedding は検索の道具としか見られていない。
我々は embedding 空間を**地形**として見ている —
位置があり、方向があり、移動があり、バウンダリがある。

---

## 世界への貢献

**短期 — 個人のエージェント支援**
コンテキストウィンドウの限界を、推論力ではなく入力最適化で解決。
1M コンテキストを買えなくても、適切な 2K があれば同等の成果。

**中期 — チーム開発の暗黙知共有**
ドキュメント化されない暗黙知が、行動ログとして自然に共有。
「片方が解いた問題をもう片方がまた解く」無駄を構造的に排除。

**長期 — AI インフラとしての知識生態系**
LLM のコンテキスト拡大は計算コストの二乗増。
Semantic CDN は逆のアプローチ — 必要な知識をピンポイント配信。
AI の民主化を計算コストの側面から支える。

全て LLM 推論コストゼロ。AI の力に頼らず AI を支えるインフラ。

---

## 設計原則

- **LLM 推論コストゼロ**: embedding は MiniLM、フィルタは数値演算のみ
- **位置ベース**: クエリ設計不要、現在地が自動的にクエリになる
- **代謝**: キャッシュの肥大化が構造的に起きない
- **感情は事実と混ぜない**: embedding はテキストのみ、感情は payload で別管理
- **段階的拡張**: ローカル → 外部 DB → 複数エージェント共有

---

## 関連ドキュメント

- `HOTLOAD_DESIGN.md` — 未来予測型レセプタの詳細設計、エントロピ、感情レイヤ議論
- `RECEPTOR_ARCHITECTURE.md` — emotion vector, state classification, heatmap
- `SPHERE_FEDERATION.md` — Sphere 連携、public tag 設計
- `SUBSYSTEM_INTEGRATION.md` — サブシステム FIFO, output routing

---

*CDN がインターネットの地理的距離を解消したように、
Semantic CDN はエージェントと知識の意味的距離を解消する。*