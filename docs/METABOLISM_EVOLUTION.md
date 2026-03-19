# 代謝機構の進化 — Sphere Digestor → Engram Digestor

> 2026-03-19 設計検討 + Phase 1-3 実装完了。
> engram の代謝パラメータを状況適応型に進化させる。
> 実装: `gateway/src/digestor.ts`, config: `gateway/gateway.config.json`

---

## 系譜: 三世代の代謝

```
Sphere Digestor（本家）
  └─ "小Sphere" として設計。hunger, time_decay, 確率的生存, 環境ブレンド
      │
      └─ Engram Digestor（子）
          └─ 簡略版。固定 TTL, 固定 decay, 確定削除
```

Sphere Digestor は生態系シミュレーション。Engram Digestor はそこから
代謝の骨格だけを抽出した。しかし簡略化しすぎた部分がある。

---

## 現状の問題

### 1. パラメータの硬直性

すべて固定値:

| パラメータ | 現状値 | 問題 |
|-----------|--------|------|
| TTL | 6h | 短期セッションには長すぎ、長期プロジェクトには短すぎ |
| decay | 0.1/batch | データ量に関係なく一律 |
| promotion | weight≥3 AND hits≥5 | 状況を反映しない |

### 2. fixed の剥がしにくさ

- **心理的ハードル**: fixed を「間違い」と明示的に宣言するのは重い
- **発見の難しさ**: outdated な fixed に気づくのは recall 時だけ
- **グラデーションの欠如**: 「やや古い」を表現できない

### 3. 長期プロジェクトのデータ圧迫

- 固定容量では長期プロジェクトが窮屈
- マルチプロジェクト環境ではグローバル容量圧迫が加わる
- 価値のあるノードが淘汰される可能性

---

## Sphere Digestor との比較

### Sphere が持ち Engram が持たないもの

| 機構 | Sphere | Engram | 影響 |
|------|--------|--------|------|
| **hunger（動的淘汰圧）** | eval数で 0.2〜1.0 | なし（固定 decay） | 状況適応できない |
| **指数減衰（time_decay）** | half-life ベース | 線形 TTL カウントダウン | 粗い近似 |
| **確率的生存** | 閾値以下でも min 5% | 閾値以下は即死 | 多様性を殺す |
| **環境ブレンド** | 0.7×自己 + 0.3×全体 | なし | プロジェクト間の影響なし |
| **Weight delta 学習** | consistency ゲート | なし | bump が固定値 |

### Sphere から学ぶべき核心

**hunger（動的淘汰圧）**: データ量が淘汰圧を決める。
少ない時は保護、多い時は刈る。これが「短期か長期か」を自然に解決する。

---

## 設計: 密度ベースの動的代謝

### プロジェクト活性度の算出 — 追加ファイル不要

専用の管理ファイルは作らない。既存の Qdrant ノードの `ingestedAt` から算出する。

digestor は batch 毎にプロジェクトの recent ノードを scroll 済み。
そのついでに min/max の `ingestedAt` を取るだけで十分:

```
oldest = min(ingestedAt) across project nodes
newest = max(ingestedAt) across project nodes
span = newest - oldest          // プロジェクトの時間的広がり
density = nodeCount / span      // 時間あたりのノード生産速度
```

engram のスコープは短期〜中期。永続的な作業時間追跡は
別のシステム領域（receptor, Sphere）の仕事。
ノードの timestamp 分布だけでプロジェクトの性格は十分に推定できる。

> **Note**: receptor の `project-meta.json` は Sphere Facade routing 用
> （techStack, domain）。代謝パラメータとは無関係。共有不要。

### 密度ベースの淘汰圧（hunger 相当）

成熟度（workTime）と密度（ノード数/時間）は分離して扱う:

| 軸 | 決めるもの | 根拠 |
|---|-----------|------|
| **密度**（ノード数 / span） | decay rate | 情報の洪水度。多ければ刈る |
| **成熟度**（span） | 容量上限 | プロジェクトの規模。長ければ余裕を持たせる |

```
ノード密度 = ノード数 / span

密度が高い → 淘汰圧を上げる（情報の洪水を刈る）
密度が低い → 淘汰圧を下げる（希少な情報を保護）
```

- 短期プロジェクト: 少ノード / 短 span = 中密度 → 穏やかな淘汰
- 長期プロジェクト初期: 少ノード / 長 span = 低密度 → ほぼ保護
- 長期プロジェクト成熟期: 多ノード / 長 span = 中密度 → 適度な淘汰
- 情報爆発: 多ノード / 短 span = 高密度 → 積極的淘汰

長期プロジェクトは span が大きいから容量に余裕がある。
密度が上がった時だけ淘汰圧が効く。これなら長期プロジェクトの
古い設計判断（recall されにくいが後で効く知識）も自然に保護される。

### 動的容量

固定容量ではなく、span に比例して伸ばす:

```typescript
function dynamicCapacity(spanMs: number): number {
  const days = spanMs / 86400000;
  return Math.floor(50 + days * 10);
}
// 1日 → 60, 7日 → 120, 30日 → 350
```

### マルチプロジェクト

グローバル飽和度による全プロジェクト decay 加速は導入しない（YAGNI）。
Qdrant は数万ノード程度は余裕で捌く。現実の全プロジェクト合計が
問題になる規模に達した時に再検討する。

プロジェクト単位の密度ベース淘汰だけで十分。

---

## fixed の自然降格（soft demotion）

### 現状の問題

flag（明示的なネガティブフィードバック）は:
- 「間違いを宣言する」心理的ハードルが高い
- 特に自分が push したノードに対して
- 「やや古い」「条件付きで正しい」を表現できない

### 解決: 半減期付き指数 decay

```
fixed node:
  ├─ 通常: 半減期 60日の指数 decay
  │   weight(t) = weight_at_fixed × 2^(-t / halfLife)
  │   halfLife = 60日（config で調整可能、初期値）
  ├─ recall hit: weight リセット + bump → 健全な fixed
  ├─ 長期未 recall: weight < 1.0 で自動 recent 降格
  └─ flag: 即座に降格（現状維持）
```

weight=3 で fixed 化 → 60日後 1.5 → ~100日で 1.0 以下 → recent 降格。
recall が1回でもあれば weight リセットで完全復活。

結果:
- **flag は「急いで消したい時」だけ**。日常的には不要
- 使わない知識は自然に recent に戻り、さらに使われなければ消える
- 半減期の漸近性により急激には消えない
- 動かしながらパラメータ調整（halfLife を config に出す）

---

## 消去通知: sink → ホットメモ（確率的生存の代替）

### 確率的生存は導入しない

Sphere の確率的生存は種族の多様性維持のため。engram のノードは
ユーザーが意図的に push したもの — Sphere の eval とは文脈が違う。
確率的延命は engram の哲学と合わない。

### 代替: 消去を sink に流す

```
digestor batch → ノード消去判定
  ├─ 削除実行（Qdrant から完全消去）
  └─ sink に emit:
      { summary, tags, projectId, weight, reason: "ttl_expired" | "soft_demotion" }
      └─ receptor が拾う → ホットメモの「最近消えた知識」として表示可能
      └─ ユーザーが見て必要なら re-push
```

- 確率的生存が解決しようとした「価値があるのに消える」問題を、
  **可視性** で解決する
- 「消えるものは消える」の哲学は完全に維持
- sink 機能の実用的なユースケースが増える
- ユーザーの意志で re-push = 「残すべきものは意志を持って残す」

---

## engram の哲学

**消えるものは消える。残すべきものは意志を持って残す。**

圧縮退避も確率的生存も採用しない。
engram のノードは最終的に消去される。価値があるなら:
- **再 push する** — 新鮮な文脈で再投入
- **fixed にする** — recall で自然昇格、または flag による即座の意志表示

engram のカバー範囲は短期〜中期。永続性は別のシステム領域
（receptor の persona 蒸留、Sphere の集合知）が担う。
だから代謝は厳しめでよい — 消えても困らない設計にする。

---

## 実装フェーズ

### Phase 1: 密度ベース淘汰 ✅ 実装済み (2026-03-19, `b231f80`)
- `computeDensity()`: batch scan のついでに ingestedAt の min/max を取得
- density = nodeCount / span(hours) → decayMultiplier (0.5x〜3.0x)
  - < 1 node/h → 0.5x（希少な知識を保護）
  - ~3 nodes/h → 1.0x（ベースライン）
  - > 10 nodes/h → 2.0x（情報の洪水を刈る）
  - cap at 3.0x
- effectiveDecay = config.decayPerBatch × decayMultiplier
- 追加ファイル・追加クエリなし（既存 scroll に相乗り）
- batch ログに density 情報を出力: `density=X.Xn/h×Y.Y`

### Phase 2: fixed soft demotion ✅ 実装済み (2026-03-19, `b231f80`)
- `fixedDecayFactor()`: 半減期 60日の指数 decay（`fixedHalfLifeDays` で config 可能）
- weight(t) = weight × 2^(-batchInterval / halfLife)
- weight < `fixedDemotionThreshold` (default 1.0) で自動 recent 降格
- 降格時に TTL を再付与（`ttlSeconds`）→ TTL サイクルに再突入
- flag は即座の降格として維持（既存の `applyFeedback()` は変更なし）
- batch は2パス構成: Pass 1 recent (promote/expire/decay) → Pass 2 fixed (half-life/demote)
- scroll は1回で全ノード取得（recent + fixed）、Qdrant コール数は増加なし

### Phase 3: 消去通知 → sink ✅ 実装済み (2026-03-19, `b231f80`)
- `ExpiredNodeInfo { pointId, summary, tags, projectId, weight, reason }` を定義
- `setExpireHandler()` コールバックパターン（shadow-index と同じ）
- reason: `"ttl_expired"` (recent 消去) | `"soft_demotion"` (fixed 降格)
- server.ts で handler を配線、ログ出力:
  `[digestor:sink] ttl_expired: "summary" [tags] project=X weight=Y`
- receptor hot-memo への接続は将来作業（handler を差し替えるだけ）

### 未実装（将来）
- engram_status に「最近の消去」表示を追加
- sink handler から receptor hot-memo への接続
- 動的容量上限（span ベース）の enforcement — 現状は密度で decay を調整するのみ

---

## shadow-index との共通概念

| 共通 | shadow-index | engram digestor |
|------|-------------|----------------|
| idle skip | cumulativeActiveMs | touchProject() + idleThresholdMs |
| 密度ベース淘汰 | ノード数 / activeWindow | ノード数 / span |
| 動的 lifetime | workTime ベースの activeWindow | span ベースの容量上限 |

分離すべき部分:
- shadow-index: 6軸 percentile vector（空間的圧縮） + IndexVector 退避
- engram: embedding + summary（意味的表現） + promotion/fixed 昇格 + sink 通知
