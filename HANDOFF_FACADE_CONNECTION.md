# Engram — Facade 接続引継ぎ

作成日: 2026-03-18
作成元: sphere-facade セッション

---

## 背景

sphere-facade に `/push` と `/lookup` の2エンドポイントが実装済み（commit `5ffe34b`）。
engram 側の sphere-shaper と future-probe にフォールバックルートを追加すれば接続が成立する。

---

## Facade 側の実装済み API

### 1. `POST /push` — engram → Sphere 投入中継

**重要: Facade は capsule の中身を検査しない。ルーティングのみ。**

engram (sphere-shaper) が ExperienceCapsule 形式に成型済みで送ること。

**リクエスト:**
```json
{
  "capsule": { ... },
  "source": "engram-receptor",
  "techStack": ["typescript", "qdrant", "docker", "mcp"],
  "domain": ["ai-agent", "memory-system", "knowledge-graph"]
}
```

- `capsule`: ExperienceCapsule そのまま（Sphere `/sphere/contribute` に中継される）
- `source`: 任意の識別子
- `techStack` / `domain`: Sphere ルーティング用（project-meta.json から取得）

**レスポンス:**
```json
{
  "success": true,
  "routed": 1,
  "accepted": 1,
  "outcomes": [
    {
      "sphereId": "sphere-genesis",
      "status": 200,
      "accepted": true,
      "reply": { ... }
    }
  ]
}
```

- `accepted: false` + `reply` に Sphere の reject 理由が入る
- マッチする Sphere がない場合 → `locker:unrouted` に一時保管される

**Sphere が期待する capsule 形式** (`POST /sphere/contribute`):
```json
{
  "source": "engram-receptor",
  "capsule": {
    "topTier": [
      { "summary": "...", "payload": "...", "initialHeat": 50, "flags": 0 }
    ],
    "normalNodes": [],
    "ghostNodes": [],
    "timestamp": 1742300000000
  }
}
```

→ sphere-shaper の `exportEnrichedCentroid()` 出力（SpherePayload）を ExperienceCapsule に変換するロジックが必要。

---

### 2. `POST /lookup` — future-probe → Sphere 検索中継

**暫定方式: テキストクエリを Sphere の `/sphere/explore?q=` に渡す。**

**リクエスト:**
```json
{
  "query": "Docker port conflict workaround",
  "techStack": ["typescript", "docker"],
  "domain": ["ai-agent"],
  "limit": 5
}
```

- `query`: summary テキスト（Sphere が内部で vectorize する）
- ベクトル直接検索は未対応（将来 Sphere 側に追加予定）

**レスポンス:**
```json
{
  "results": [
    {
      "id": "sphere-node-uuid",
      "score": 0.72,
      "summary": "...",
      "kind": "active",
      "tags": ["gotcha", "docker"],
      "heat": 50,
      "source": "sphere",
      "sphereId": "sphere-genesis"
    }
  ],
  "meta": { "matched_spheres": 1 }
}
```

- `score` = 1 - cosine_distance (0〜1, 高い方が類似)
- マッチ Sphere なし → `{ results: [], meta: { matched_spheres: 0 } }`

---

## engram 側の接続作業

### 1. sphere-shaper: ExperienceCapsule 変換 + HTTP push

**ファイル:** `mcp-server/src/receptor/sphere-shaper.ts`

現状: `writeSpherePayload()` が `sphere-ready.jsonl` にファイル出力。
変更: facadeUrl があれば HTTP push に切り替え。

```
SpherePayload (enriched centroid)
  → ExperienceCapsule に変換
    - pattern/outcome/linked_knowledge → summary + payload
    - emotion intensity → initialHeat 導出
  → POST facadeUrl/push { capsule, source, techStack, domain }
  → outcomes の accepted/reply を確認
  → reject 時は stderr ログ（リトライ不要）
```

- `techStack` / `domain` は `project-meta.json` から取得（既に定義済み）
- `facadeUrl` は `project-meta.json` に定義済み（未使用）

### 2. future-probe: Facade lookup 追加

**ファイル:** `mcp-server/src/receptor/future-probe.ts`

現状: `executeSearch()` が Qdrant (action_log + engram) のみ検索。
変更: facadeUrl があれば Sphere 検索結果もマージ。

```
executeSearch()
  → 既存 Qdrant 検索 (action_log + engram)
  → [追加] POST facadeUrl/lookup { query: top結果のsummary, techStack, domain, limit: 3 }
  → Sphere 結果を ProbeResult[] に変換 (source: "sphere" を追加？)
  → 全結果をスコア順マージ → top 5
```

- ProbeResult の source 型に "sphere" を追加する必要あり
- lookup の query には top 結果の summary か、enriched centroid の pattern を渡す

---

## 設定（project-meta.json）

```json
{
  "techStack": ["typescript", "qdrant", "docker", "mcp"],
  "domain": ["ai-agent", "memory-system", "knowledge-graph"],
  "facadeUrl": "http://localhost:3100"
}
```

facadeUrl が未設定 or 空の場合は従来通りローカルのみで動作（フォールバック）。

---

## 優先順位

1. **sphere-shaper の ExperienceCapsule 変換 + push** — データ投入が先
2. **future-probe の lookup 追加** — データが入ってから意味が出る

---

## 参照先

- Facade 本体: `../sphere-facade/services/facade/src/server.ts`
- Sphere contribute API: `../sphere-original/docker_compose_sphere_v1/services/periphery/src/server.ts`
- Sphere explore API: 同上 (GET /sphere/explore)
- engram 設計: `docs/SPHERE_FEDERATION.md`
