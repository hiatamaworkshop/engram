# Subsystem Integration — 汎用サブシステム登録の作法

> 2026-03-16 実装に基づく。外部 MCP サーバを receptor のサブシステムとして接続する手順。

---

## 概要

receptor は任意の MCP サーバを「サブシステム」として登録し、
感情トリガに基づいてバックグラウンド実行できる。

サブシステムに特権はない。engram 内部の `engram_pull` も外部の `mycelium_filter` も
同じ registry + FIFO + sink を通る。

```
receptor trigger (感情ベクトル)
  → passive receptor scoring
  → method resolver → service registry lookup
  → MCP executor (subprocess spawn + tool call)
  → output router → sink 群 (subsystem FIFO, file, log)
  → hotmemo Layer 6 (未表示分のみ)
```

---

## 1. サブシステムの登録

### Step 1: executor-services.json にサービス定義を追加

```jsonc
// mcp-server/src/receptor/executor-services.json
{
  "services": [
    {
      "tool": "mycelium_filter",
      "type": "mcp",
      "server": {
        "command": "node",
        "args": ["dist/server.js"],
        "cwd": "../../../../mycelium_universal",
        "env": {
          "SOURCE_QDRANT_URL": "http://localhost:6333",
          "SOURCE_COLLECTIONS": "engram"
        }
      }
    }
  ]
}
```

| フィールド | 意味 |
|-----------|------|
| `tool` | MCP server 側の tool 名。registry のキーになる |
| `type` | `"mcp"` (MCP server), `"shell"`, `"http"` は将来 |
| `server.command` | 起動コマンド |
| `server.args` | 引数 |
| `server.cwd` | 作業ディレクトリ。**`dist/receptor/` からの相対パス** (gotcha) |
| `server.env` | 環境変数 (optional) |

`service-loader.ts` が起動時に読み込み `registerExecutor()` を呼ぶ。

### Step 2: receptor-rules.json にメソッド定義を追加

```jsonc
// mcp-server/src/receptor/receptor-rules.json
{
  "id": "mycelium_filter",
  "type": "knowledge_filter",
  "mode": "background",
  "trigger": {
    "signals": ["frustration_spike", "compound_frustration_hunger"],
    "states": ["stuck", "exploring"],
    "sensitivity": 0.5,
    "frequency": "low"
  },
  "action": {
    "tool": "mycelium_filter",
    "args": {},
    "output": {
      "targets": ["subsystem", "file", "log"],
      "format": "summary",
      "maxLength": 200
    }
  }
}
```

以上。コード変更なし。

---

## 2. output.targets — 結果の行き先

| target | 行き先 | 用途 |
|--------|--------|------|
| `"hotmemo"` | subsystem FIFO → hotmemo Layer 6 | エージェントへの通知 |
| `"subsystem"` | subsystem FIFO → hotmemo Layer 6 | `"hotmemo"` と同義 |
| `"file"` | `receptor-output/receptor-results.jsonl` | 永続ログ (JSONL) |
| `"log"` | stderr | MCP server ログ |
| `"engram"` | engram push (deferred) | 結果を engram に保存 |
| `"silent"` | 破棄 | fire-and-forget |

`"hotmemo"` と `"subsystem"` は同じ ring buffer に合流する。
どちらを指定しても動作は同じ。セマンティクスの違いのみ:
- `"hotmemo"` — engram 内部の executor 結果
- `"subsystem"` — 外部サブシステムの executor 結果

---

## 3. Subsystem FIFO

### 構造

```
subsystem-fifo.ts
  _fifo: FifoEntry[]  (max 20)
  FifoEntry = { system, fn, ts, message, shownAt }
```

### 1行フォーマット

```
mycelium | filter | 2026-03-16 14:32:00 | 47/120 survived (39%)
engram   | pull   | 2026-03-16 14:35:12 | 3 results for "receptor wiring"
```

`system` と `fn` は `toolName` から自動導出:
- `mycelium_filter` → system=`mycelium`, fn=`filter`
- `engram_pull` → system=`engram`, fn=`pull`

### shownAt マーカー

- push 時: `shownAt = 0` (未表示)
- hotmemo display 時: 未表示エントリのみ返し、`shownAt = now` に更新
- `allSubsystemResults()`: 全件返す (`shownAt` 無視)

同じメッセージが繰り返し表示されることはない。

### hotmemo Layer 6

```
[subsystem]
mycelium | filter | 2026-03-16 14:32:00 | 47/120 survived
engram   | pull   | 2026-03-16 14:35:12 | 3 results
```

最新 3 件まで。未表示がなければ沈黙 (ゼロノイズ)。

---

## 4. エージェントからの動線

```
1. hotmemo (受動的)
   → engram tool 呼び出し時に Layer 6 として自動表示
   → 未表示分のみ、最新 3 件

2. file sink (能動的)
   → receptor-output/receptor-results.jsonl を読む
   → 全件、JSONL 形式、永続

3. heatmap sink (参照用)
   → receptor-output/heatmap.json を読む
   → 5分間隔で上書き更新、上位15パス + ヒット数
   → エージェントの作業領域を非同期参照
```

---

## 5. 配信モード選択ガイド

| サブシステムの性質 | 推奨 mode | output.targets |
|------------------|-----------|---------------|
| 重い処理 (mycelium 等) | `background` | `["subsystem", "file", "log"]` |
| 軽い内部処理 (engram_pull 等) | `auto` | `["hotmemo", "log"]` |
| 通知のみ (実行なし) | `notify` | — (message ベース) |

`background` と `auto` の違い:
- 両方とも `_autoQueue` に入り `executeAutoQueue()` で実行される
- `background` は output.targets に `"hotmemo"` を含めないことで暗黙的にサイレント化する設計意図
- ただし `"subsystem"` を指定すれば hotmemo に表示される (設計者の選択)

---

## 6. cwd の gotcha

`executor-services.json` の `server.cwd` は **runtime の `dist/receptor/` からの相対パス**。

```
dist/receptor/executor-services.json  ← ここが起点
  ../../../../mycelium_universal      ← DockerFiles/mycelium_universal
```

`src/receptor/` ではない。`import.meta.url` が `dist/` を指すため。

---

## 7. 新サブシステム追加チェックリスト

1. [ ] サブシステム側に MCP server を実装 (tool 定義 + handler)
2. [ ] `executor-services.json` にサービス定義を追加
3. [ ] `receptor-rules.json` にメソッド定義を追加 (trigger, mode, output.targets)
4. [ ] `npx tsc` — ビルド確認 (JSON のみなので通常は不要)
5. [ ] MCP server 再起動 — `service-loader.ts` が起動時に読み込む

コード変更は不要。JSON 2 ファイルの編集のみ。

---

## 関連ドキュメント

- `PASSIVE_RECEPTOR_DESIGN.md` — スコアリング、配信モード、learnedDelta
- `RECEPTOR_ARCHITECTURE.md` — neuron A/B/C、emotion engine
- `PREDICTIVE_INFERENCE.md` — 予測推論パイプライン構想