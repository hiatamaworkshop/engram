# Engram v2 Design — Digestor + Sanitize Layer

> **Note**: This is a design-time document. Implementation details (parameter values,
> config formats) may have diverged. For current specs, refer to:
> - **Tool specifications**: `mcp-server/src/index.ts` tool descriptions (SSOT)
> - **Runtime config**: `gateway/gateway.config.json`
> - **README**: `README.md`

## Overview

Engram v1 (current commit) は「embed → Qdrant → search」の基本パイプライン。
v2 ではこれを独自の記憶システムに進化させる。

## 1. 状態モデル: recent / fixed

旧 `fresh / amber / fossil` を廃止し、2状態 + 消滅に簡素化。

```
ingest → [recent]  ← 即座に検索可能、TTL 付き
              │
              ├─ recall hit → hitCount++, TTL リセット
              │
              ├─ Digestor バッチ:
              │   ├─ score >= 閾値 → [fixed] に昇格（永続）
              │   ├─ TTL 残あり   → 生存継続
              │   └─ TTL 切れ     → 消滅（delete）
              │
              └─ プロジェクト休眠中 → TTL 停止（凍結）
```

| 状態 | 意味 | TTL | 検索対象 |
|------|------|-----|----------|
| recent | 新規投入ノード | あり（期限付き） | yes |
| fixed | 定着した知識 | なし（永続） | yes |
| (消滅) | TTL 切れ & スコア不足 | - | - |

### FIFO 廃止

旧 `maxNodesPerProject` による FIFO キャップは廃止。
ノードの生死は TTL ベースの代謝のみで決定する。

## 2. Digestor（定時バッチ）

Gateway 内の setInterval で定時実行。LLM コールなし。

### バッチ処理フロー

```
定時起動（例: 6時間ごと）
  │
  ├─ プロジェクト一覧取得（distinct projectId from Qdrant）
  │
  └─ 各プロジェクト:
      ├─ 休眠判定: lastActivityAt + dormantThreshold
      │   └─ 休眠中 → スキップ（TTL 消化しない）
      │
      ├─ recent ノード走査:
      │   ├─ score >= FIXED_THRESHOLD → status を "fixed" に更新
      │   └─ TTL 切れ（ingestedAt + ttlDays < now）→ delete
      │
      └─ 統計ログ出力
```

### スコアリング

スコアラー = ユーザーの Claude エージェント自身（recall hit が唯一のシグナル）。

```
score = recallHits
      + (crossSessionBonus)    // 異なるセッションからの hit は追加価値
      + (initialWeight * 補正)  // ingest 時の Claude 評価
```

具体的な数値は実装時に調整。旧 phi-agent の eval metrics は使わない。

### プロジェクト休眠

```typescript
// 各プロジェクト:
//   lastActivityAt = max(最後の ingest, 最後の recall)
//
// if (now - lastActivityAt > dormantThreshold)
//   → TTL 消化をスキップ（ノードは凍結保存）
//
// プロジェクト再開時（ingest or recall）:
//   → lastActivityAt 更新、TTL 再開
```

旧 Sphere の Frozen 冬眠と同じ発想。離れている間に知識が腐らない。

## 3. サニタイズ層

ingest 時に Gateway 内で実行。LLM コールなし。

```
Claude が capsuleSeeds を生成（分割 + タグ付与）
  ↓
Gateway 受信
  ↓
[Phase 1] Gate — 形式チェック（既存）
  - summary 10-200 字
  - tags 1-5 個
  - weight 0.0 - 1.0
  ↓
[Phase 2] Granularity — 粒度検証
  - summary > 150 字 → 警告/拒否（再分割を促す）
  - content が summary と実質同一 → content 削除
  ↓
[Phase 3] Dedup — 重複検知
  - 各 seed を embed
  - 既存ノード検索（cosine similarity）
  - similarity > 0.92 → マージ（hitCount 引継ぎ、summary 更新）
  - similarity <= 0.92 → 新規挿入
  ↓
[Phase 4] Normalize — タグ正規化
  - 小文字化
  - 表記揺れ統一（ハイフン区切り）
  ↓
Qdrant upsert（個別ポイント）
```

### Dedup マージの挙動

| 項目 | マージ時 |
|------|----------|
| summary | 新しい方で上書き |
| tags | 和集合（union） |
| content | 新しい方で上書き |
| weight | max(既存, 新規) |
| hitCount | 既存値を引き継ぎ |
| status | 既存値を維持 |
| vector | 新しい embedding で上書き |

## 4. Qdrant Payload スキーマ（v2）

```typescript
interface PointPayload {
  // --- コンテンツ ---
  summary: string;
  tags: string[];
  content: string;

  // --- メタデータ ---
  projectId: string;
  source: string;         // "mcp-ingest"
  trigger: string;        // "session-end" | "milestone" | ...

  // --- 代謝 ---
  status: "recent" | "fixed";
  weight: number;         // 0.0 - 1.0
  hitCount: number;       // recall hit → 昇格シグナル
  sessionHits: string[];  // hit した sessionId 一覧（crossSession 判定用）

  // --- タイムスタンプ ---
  ingestedAt: number;     // 投入時刻
  lastAccessedAt: number; // 最後の recall hit
  ttlExpiresAt: number;   // ingestedAt + ttlDays（recent のみ有効）
}
```

## 5. 検索

recall 時、recent + fixed を横断検索。同一 Qdrant collection 内の status フィルタ。

```
recall(query, projectId?)
  → embed query
  → Qdrant search（filter: projectId, status IN ["recent", "fixed"]）
  → 結果に fixed が含まれれば優先度を上げる（optional boost）
  → hitCount++ (fire-and-forget)
  → TTL リセット（recent ノードのみ）
```

## 6. MCP Tools（変更なし）

| Tool | 役割 |
|------|------|
| engram_pull | セマンティック検索 / ID 指定取得 |
| engram_push | capsuleSeeds 投入（Claude が分割済み） |
| engram_flag | 負の weight シグナル |
| engram_ls | タグ/ステータスでリスト |
| engram_status | 統計情報 |

## 7. 実装変更マップ

### 新規

| ファイル | 内容 |
|----------|------|
| `gateway/src/digestor.ts` | Digestor バッチ処理 |
| `gateway/src/sanitize.ts` | Phase 2-4 サニタイズ |

### 変更

| ファイル | 変更 |
|----------|------|
| `gateway/src/types.ts` | AmberStatus → NodeStatus ("recent" \| "fixed"), sessionHits 追加, ttlExpiresAt 追加 |
| `gateway/src/amber.ts` | → リネーム or 統合。recent/fixed ロジックに書き換え |
| `gateway/src/upper-layer/types.ts` | payload スキーマ更新、FIFO 設定削除 |
| `gateway/src/upper-layer/index.ts` | FIFO eviction 削除、TTL リセットロジック追加 |
| `gateway/src/handlers/ingest.ts` | sanitize 層を挟む |
| `gateway/src/server.ts` | Digestor 起動 (setInterval) |
| `gateway/src/config.ts` | digestor / sanitize / ttl 設定追加 |
| `gateway/gateway.config.json` | maxNodesPerProject 削除、digestor 設定追加 |
| `gateway/src/upper-layer/qdrant-client.ts` | status index 追加 |
| `mcp-server/src/types.ts` | AmberStatus → NodeStatus |

### 削除

| 項目 | 理由 |
|------|------|
| `maxNodesPerProject` config | FIFO 廃止 |
| `evictExcess()` in upper-layer/index.ts | FIFO 廃止 |
| `shouldFossilize()` in amber.ts | fossil 状態廃止 |

## 8. 設定パラメータ（v2 設計時）

> **Diverged**: 実装では config 形式・値が変更されている。
> 現行値は `gateway/gateway.config.json` を参照。

```json
{
  "server": { "port": 3100 },
  "upperLayer": {
    "qdrantUrl": "http://localhost:6333",
    "collection": "engram",
    "embeddingModel": "Xenova/all-MiniLM-L6-v2",
    "embeddingDimension": 384
  },
  "digestor": {
    "intervalHours": 6,
    "dormantThresholdDays": 14,
    "ttlDays": 30,
    "fixedThreshold": 3
  },
  "sanitize": {
    "dedupSimilarityThreshold": 0.92,
    "maxSummaryLength": 150,
    "normalizeTagCase": true
  }
}
```

## 9. 実装優先順

Phase A — DB アクセス基盤（今回実装）:
1. types.ts 更新（recent/fixed 状態モデル）
2. payload スキーマ更新
3. sanitize.ts（Phase 2-4）
4. ingest handler にサニタイズ統合
5. recall の TTL リセット

Phase B — Digestor:
6. digestor.ts（バッチ処理本体）
7. server.ts に Digestor 起動
8. config 統合

Phase C — 仕上げ:
9. FIFO 関連コード削除
10. amber.ts → recent/fixed ロジックに置換
11. tsc clean 確認
