# Receptor — 実装済みアーキテクチャ解説

> 2026-03-14 時点の実装に基づく。設計思想は PREDICTIVE_INFERENCE.md、ここは動作原理。

## 全体構造

```
[Claude Code hooks]
       |
       v
  RawHookEvent { tool_name, tool_input, exit_code }
       |
       v
  Normalizer ──→ NormalizedEvent { action, path?, result?, ts }
       |
       ├──→ Commander (時間窓カウンタ)
       ├──→ PathHeatmap (ファイルアクセス集中度)
       |         |
       |         v
       |    computeEmotion() ──→ EmotionVector (6軸)
       |         |
       |         v
       |    AmbientEstimator.update() ── EMA ベースライン更新
       |         |
       |         v
       |    generateSignals() ──→ FireSignal[] (B neuron 出力)
       |         |
       |         v
       |    MetaNeuron.observe() + .process() ── C がフィールド放出
       |         |
       |         v
       |    onSignal() listeners ── 接続先へ通知（未実装）
       v
  formatState() ── 三層モニタ出力
```

---

## 1. 入力: 何を観測するか

### RawHookEvent

Claude Code の hooks が発火するたびに 1 イベントが生成される。
receptor が見るのは **ツール名、対象パス、実行結果** の3点のみ。

```typescript
interface RawHookEvent {
  tool_name: string;        // "Read", "Edit", "Bash", "Grep", etc.
  tool_input?: {
    file_path?: string;     // 対象ファイル
    path?: string;
    resultCount?: number;   // Grep/Glob の結果数
  };
  exit_code?: number;       // Bash の終了コード
}
```

### Normalizer — フレームワーク非依存化

ツール名を 7 種の正規化アクションに変換。receptor の内部モジュールは
Claude Code 固有のツール名を一切知らない。

```
Read          → file_read
Edit, Write   → file_edit
Grep, Glob    → search
Bash          → shell_exec
Agent         → delegation
engram_pull   → memory_read
engram_push   → memory_write
```

結果判定:
- `shell_exec` + exit_code !== 0 → `failure`
- `search` + resultCount === 0 → `empty`
- それ以外 → `success`

**設計意図**: Cursor や他のエディタに移行する場合、Normalizer のマッピングだけ差し替えれば
下流の emotion engine は変更不要。

---

## 2. Commander — 「何をしているか」の時間窓分析

### 時間窓

| 窓 | 長さ | 用途 |
|----|------|------|
| Short | 5分 | スパイク検知。直近の行動急変を捉える |
| Medium | 30分 | トレンド検知。持続的な行動パターンを捉える |
| Meta | セッション全体 | 統計（総イベント数、経過時間） |

窓は FIFO — 古いイベントは時間経過で自然に evict される。

### パターン分類

窓内のアクション比率から 6 種のパターンを判定:

```
stagnation:     イベント数 ≤ 3（判定不能）
wandering:      Read+Grep ≥ 70%, Edit = 0（何を探すか定まらず読み漁り）
exploration:    Read+Grep ≥ 60%, Edit ≤ 10%（調査中、まだ手を出さない）
implementation: Edit+Bash ≥ 50%（実装中、コードを書いて実行）
trial_error:    Edit↔Bash 交互 ≥ 3回 かつ bashFailRate > 40%
                （編集→実行→失敗→編集... の繰り返し）
delegation:     Agent ≥ 30%（サブエージェントに委譲中）
```

**判定順序が重要**: trial_error は implementation より先に判定。
Edit↔Bash が多くても失敗率が高ければ trial_error になる。

### WindowSnapshot

```typescript
interface WindowSnapshot {
  counts: Record<NormalizedAction, number>;  // アクション別カウント
  total: number;                             // 窓内イベント総数
  pattern: PatternKind;                      // 上記6種
  bashFailRate: number;                      // bash失敗率 (0-1)
  editBashAlternation: number;               // Edit↔Bash 遷移回数
}
```

---

## 3. Emotion Engine — パターンから感情への変換

6 軸の感情ベクトルを毎イベント算出。各軸は 0.0〜1.0 にクランプ。

### 各軸の算出ロジック

#### frustration（苛立ち — 解法が見えない状態）

```
= alternationRate × 0.4 × bashFailRate   // 失敗を伴う Edit↔Bash 交互
+ bashFailRate × 0.4                      // bash 失敗率の直接寄与
+ (pattern === trial_error ? 0.3 : 0)     // 短期パターン
+ (medium.pattern === trial_error ? 0.1 : 0)  // 中期パターン
```

**ポイント**: `alternationRate` は比率（交互遷移数 / 全遷移数）。
成功する Edit→Bash サイクルは frustration を生まない。
失敗率が 0 なら alternation の寄与も 0 になる。

#### hunger（知識ギャップ — 知らないことがある）

```
= (medium.pattern === exploration ? 0.3 : 0)   // 探索が持続
+ (medium.pattern === wandering ? 0.4 : 0)      // 彷徨いはより深刻
+ (engram_pull が存在 ? 0.2 : 0)                // 記憶検索 = ギャップの兆候
+ (lastEvent === memory_read + empty ? 0.3 : 0) // 記憶検索空振り
```

#### uncertainty（方向性不明 — 何をすべきかわからない）

```
= (short.pattern === wandering ? 0.4 : 0)       // 短期で彷徨い
+ (edits=0 かつ events>5 ? 0.2 : 0)             // 読むだけで手が出ない
+ (heatmap shift ? 0.3 : 0)                      // ホットパスが急変
```

#### confidence（自信 — 仮説が確認された）

```
= (implementation + bashFailRate < 20% ? 0.4 : 0)  // 実装パターンで成功率高
+ (lastEvent === bash success ? 0.2 : 0)             // 直前の bash 成功
+ (lastEvent === edit success ? 0.2 : 0)              // 直前の edit 成功
```

#### fatigue（疲労 — 認知負荷の蓄積）

```
= min(elapsedHours × 0.15, 0.5)    // 時間経過で最大 0.5 まで
+ (events > 200 ? 0.2 : events > 100 ? 0.1 : 0)  // イベント量
```

**特性**: fatigue は monotonic に増加する。減少しない。
これは設計意図 — セッション中の疲労は蓄積するのみ。

#### flow（フロー — 思考と行動が一致）

```
= (implementation + bashFailRate === 0 ? 0.4 : 0)  // 完全成功の実装
+ (confidence > 0.3 かつ frustration < 0.2 ? 0.3 : 0)  // 自信あり苛立ちなし
+ (medium.pattern === implementation ? 0.2 : 0)    // 中期でも実装持続
```

**条件が厳しい**: bash 失敗率が 0% でないと flow は発生しない。
これは意図的 — flow は「全てが噛み合っている」稀な状態。

---

## 4. ニューロントライアングル — A/B/C の三層

```
     [A] Flow Gate
     ┌────────┐
     │ flow   │  ← 閾値は AmbientEstimator から取得
     │ ≥ thr? │     flow 発火 → 他の全シグナルを抑制
     └────┬───┘     C も A の閾値を変更できない（不可侵）
          │
          │ flow 未発火の場合のみ通過
          v
     [B] Emotion Engine
     ┌──────────────────┐
     │ 6軸の感情ベクトル │  ← 各軸に動的閾値
     │ shouldFire(axis)  │     閾値 = EMA baseline + offset + C.fieldAdjustment
     │ hold/release      │     hold: 発火後、3回連続で閾値未満でないと解放しない
     └────────┬─────────┘
              │ FireSignal[]
              v
     [C] Meta Neuron
     ┌──────────────────┐
     │ FIFO buffer (20) │  ← B の発火を観測（dominant axis を記録）
     │ hit rates        │     hit rate = axis count / buffer size
     │ agent state      │     state: deep_work, exploring, stuck, idle, delegating
     │ field emission   │  → AmbientEstimator.fieldAdjustment に書き込み
     └─────────────────┘     B の閾値が間接的に変わる（B は理由を知らない）
```

### A: Flow Gate（ハードニューロン）

**役割**: フロー状態の検知と全介入の即座停止。

- flow が閾値を超えた → `flow_active` シグナルのみ発火、他の全シグナルを**抑制**
- 閾値は AmbientEstimator から取得するが、C の fieldAdjustment は flow に対して常に 0
- C は flow の閾値を変更できない — **不可侵の安全弁**
- soundLimiter の A ニューロン（瞬間ピーク検知）と同原理

**存在意義**: エージェントが集中して生産的に動いている時に、
receptor が介入して集中を妨げることを構造的に防ぐ。

### B: Emotion Engine（ソフトニューロン）

**役割**: 6 軸の感情を算出し、閾値超過でシグナルを発火。

#### 動的閾値

```
effectiveThreshold(axis) = EMA_baseline + offset + fieldAdjustment
                           clamped to [0.30, 0.85]
```

| 成分 | 意味 | 変動速度 |
|------|------|----------|
| EMA baseline | 「このエージェントの通常レベル」 | 遅い (TC=10分) |
| offset | 「通常からどれだけ乖離したらスパイクか」 | 固定 |
| fieldAdjustment | C が放出したフィールド | 中速 (±0.02/event) |

**デフォルト offset**:
```
frustration: 0.25   hunger: 0.30   uncertainty: 0.30
confidence:  0.25   fatigue: 0.35  flow: 0.25
```

fatigue の offset が最大 — 疲労は蓄積が遅いので、閾値も高く設定。

#### Hold/Release（ポンピング防止）

```
1. value ≥ threshold → 発火 + hold ON
2. value < threshold → hold カウンタ++
3. カウンタ ≥ 3 → release（本当に安全）
4. カウンタ < 3 → hold 継続（シグナル維持）
```

**問題の防止**: frustration 0.7 → 0.59 → 0.65 → 0.55 のような振動で
シグナルが ON/OFF/ON/OFF とフラッピングすることを防ぐ。
3 回連続で閾値を下回って初めてリリース。

#### 発火優先度

```
1. flow_active              → return（A gate、他を全て抑制）
2. compound: frust + hunger → return（最も危険な複合状態）
3. 個別: frustration_spike, hunger_spike, uncertainty_sustained,
         confidence_sustained, fatigue_rising
```

compound は frustration と hunger が**同時に**閾値を超えた場合のみ。
「解法を知らない + 知識が足りない」= 最も介入が必要な状態。

### C: Meta Neuron（メタニューロン）

**役割**: B の発火パターンを観測し、B の閾値フィールドを間接調整。

#### FIFO バッファ

- 容量 20（≈ 5〜15分の発火履歴）
- B がシグナルを発火するたびに、最強シグナルの dominant axis を記録
- B が発火しないイベントでは記録しない（バッファは静かな時は成長しない）
- 古いエントリは新しいエントリに押し出される（自然な減衰）

```
buffer: [frust, frust, frust, hunger, frust, frust, ...]
hit rate: frustration=80%, hunger=20%
```

#### エージェントステート導出

```
isSilenced (idle 中)           → idle
pattern === delegation         → delegating
frustration > 0.5 + trial_error → stuck
flow > 0.4 + implementation    → deep_work
exploration | wandering        → exploring
default                        → exploring
```

#### フィールド放出

C は **直接シグナルを発しない**。AmbientEstimator の fieldAdjustment に書き込むだけ。
B は閾値が変わったことに気づくが、なぜ変わったかは知らない。

```
frustration hit rate > 50% (危険環境):
  hunger threshold    -= 0.02 (per event, max -0.10)
  uncertainty threshold -= 0.02
  → 知識ギャップの検知をより敏感にする（先回り介入）

frustration hit rate < 20% (安全環境):
  hunger, uncertainty → 0 に向かって decay

state === deep_work:
  frustration threshold += 0.02 (max +0.10)
  → 集中を邪魔しない

state === stuck:
  frustration threshold -= 0.02 (max -0.10)
  → 苦戦中はより敏感に検知

fatigue threshold: C は変更しない（安全原則）
flow threshold: C は変更しない（A の不可侵性）
```

---

## 5. AmbientEstimator — 共有フィールド

A, B, C いずれにも属さない独立エンティティ。
「今のエージェントの通常行動レベル」を EMA で推定する。

### EMA（指数移動平均）

```
alpha = 1 - exp(-dt / timeConstant)
ema[axis] += alpha * (value - ema[axis])
```

- **Time constant**: 600,000ms (10分)
- 数回のツール呼び出しでは baseline は動かない
- 持続的なパターン変化には数分で追従

### 沈黙ゲート

```
3分間イベントなし → silenced = true
次のイベント      → EMA を現在値で再シード（velocity 暴発防止）
```

idle 中に EMA を更新すると、「何もしていない = 全て 0」が baseline に混入する。
沈黙ゲートはこの汚染を防ぐ。

### SILENCE_FLOOR

```
value < 0.05 の場合 → EMA 更新をスキップ
例外: fatigue は常に更新（安全原則）
```

微小な値を EMA に入れると baseline が不必要に下がる。
fatigue だけは例外 — 低くても追跡し続ける。

### Heatmap Shift → Reset

PathHeatmap がホットパスの過半数変化を検知した場合:
```
ambient.reset() → silenced = true → 次のイベントで再シード
```

コンテキスト切り替え（別のタスクに移行）時に、
前のタスクの baseline が残って誤判定することを防ぐ。

---

## 6. PathHeatmap — ファイルアクセス集中度

ファイルパスをセグメント分割し、ツリー構造でアクセス回数を記録。

```
src/main.ts      → ["src", "main.ts"] → count++
src/main.ts      → ["src", "main.ts"] → count++
src/config.ts    → ["src", "config.ts"] → count++

topPaths(3) → [{ path: "src/main.ts", count: 2 }, ...]
```

### detectShift()

前回の上位パスと現在の上位パスを比較。
過半数が入れ替わった場合 `{ shifted: true }` を返す。

用途:
1. uncertainty の算出（コンテキスト急変 → 方向性不明）
2. AmbientEstimator の reset トリガ

---

## 7. シミュレーション結果から見えた挙動特性

### 回復の遅延（設計通り）

stuck → flow への遷移には **5分窓から失敗イベントが evict されるまで** かかる。
これは意図的 — 1回の成功で即座に「回復した」と判定するのは危険。

```
[2:40] frustration 1.00, pattern: trial_error, C: stuck
[6:25] frustration 0.37, pattern: implementation, C: exploring  ← evict 開始
[6:55] frustration 0.18, signals: (none)                        ← hold release
[7:20] frustration 0.09, flow: 0.50, C: deep_work              ← 完全回復
```

回復に約 4 分。5 分窓の設計と整合。

### C の field emission のタイムライン

```
stuck 中:
  frustration field: -0.10 (最大引き下げ — 感度 UP)
  hunger field: -0.10
  uncertainty field: -0.10

exploring に遷移:
  frustration field: -0.10 → -0.08 → -0.06 → ... → 0.00 (decay)
  hunger/uncertainty: -0.10 のまま (frustration hit rate はまだ高い)

deep_work に遷移:
  frustration field: +0.02 → +0.04 → ... → +0.10 (感度 DOWN)
```

C の field は「急に変わらない」。0.02/event のステップで漸進的に変化。
これが「フィールド結合」の本質 — 直接制御ではなく、場の変化による間接誘導。

### EMA baseline の追従

```
frustration 0.00 → 高止まり 1.00 の間、baseline は:
  0.00 → 0.03 → 0.07 → 0.11 → ... → 0.36 (7分間で)
```

10 分の time constant に対して 7 分で 0.36 まで追従。
これは `1 - e^(-7/10) ≈ 0.50` に近い — EMA の数学的挙動通り。

baseline が上がると `effectiveThreshold = baseline + 0.25` も上がる。
frustration が 0.48 まで下がってきた時、threshold が 0.48 に達していれば発火しない。
**動的閾値による自動適応**。

---

## 8. 発見されたバグと修正

### Bug 1: 成功する Edit→Bash サイクルが frustration を生む

**原因**: `editBashAlternation * 0.15` が失敗の有無を問わず加算。
**修正**: `alternationRate * 0.4 * bashFailRate` — 失敗率が 0 なら寄与 0。
さらに件数ではなく比率（全遷移に対する割合）に変更。

### Bug 2: イベント 2 件で flow=0.90

**原因**: Read 1 + Edit 1 で `implementation` パターン判定 → flow 即発火。
**修正**: total ≤ 3 の場合は `stagnation` を返す（判定不能）。

---

## 9. 未実装（スコープ外）

- **Interpretation Layer**: 発火シグナルの解釈とトリガ選定（passive receptor）
- **receptor-rules.json**: 発火パターン → アクションのマッピング定義
- **配信モード**: silent / passive / notification / active の判定
- **learnedDelta**: 過去の false positive 率による校正
- **接続先**: mycelium probe, engram push 推奨等の実アクション

現時点では receptor はシグナルを**発火して listener に通知する**ところまで。
シグナルの「意味」を解釈して行動に変換する層は別途実装予定。

---

## 10. HTTP Bridge — リアルタイムイベント配信 (2026-03-14 追加)

### 課題

Claude Code の PostToolUse フックはシェルコマンドしか実行できない。
MCP ツール（`engram_watch`）を直接呼ぶことはできない。
→ フックからイベントを receptor に流す橋渡しが必要。

### 解決: HTTP Bridge

MCP サーバープロセス内に軽量 HTTP リスナーを立て、
フックスクリプトが `curl` で POST する構成。

```
[Claude Code PostToolUse hook]
       |
       | stdin: { tool_name, tool_input, tool_response, ... }
       v
  engram-receptor-hook.sh (cat | curl)
       |
       | POST http://127.0.0.1:3101/receptor
       v
  receptor/http.ts  parseHookPayload()
       |
       | RawHookEvent { tool_name, tool_input, exit_code? }
       v
  receptor/index.ts  ingestEvent()
```

### ファイル構成

| ファイル | 役割 |
|---------|------|
| `src/receptor/http.ts` | HTTP リスナー + hook payload → RawHookEvent 変換 |
| `~/.claude/hooks/engram-receptor-hook.sh` | dumb pipe (stdin → curl POST) |
| `~/.claude/settings.json` | PostToolUse catch-all フック登録 |

### http.ts の責務

1. **MCP プレフィクス除去**: `mcp__engram__engram_pull` → `engram_pull`
2. **Bash exit_code 抽出**: `tool_response` から複数フィールドを試行
3. **Search resultCount 抽出**: `tool_response` の "Found N files" パターン等
4. **tool_response は normalizer に渡さない**: 必要な情報だけ抽出し、残りは捨てる

### 設定

```jsonc
// ~/.claude/settings.json — PostToolUse
{
  "matcher": "",          // 全ツールにマッチ
  "hooks": [{
    "type": "command",
    "command": "bash ~/.claude/hooks/engram-receptor-hook.sh",
    "timeout": 2          // localhost なので 2s で十分
  }]
}
```

### ポート

- デフォルト: `3101`
- 環境変数 `RECEPTOR_PORT` で変更可
- `EADDRINUSE` 時はログのみ出力、MCP サーバー本体は影響なし

### 使い方

```
1. セッション起動 → MCP サーバー起動 → HTTP リスナー自動起動
2. engram_watch(enabled=true)  — 監視開始
3. 普通に作業（Read, Edit, Bash, Grep ...）
   → 全ツール PostToolUse → hook → curl → receptor → ingestEvent
4. engram_watch()  — メトリクス確認（いつでも何度でも）
5. engram_watch(enabled=false)  — 停止 + サマリー
```

### 未検証事項

- matcher `""` が全ツールにマッチするか（`"*"` が正しい可能性）
- Bash `tool_response` 内の exit_code フィールド名
- Windows 環境の curl 可用性（Git Bash 同梱版を想定）