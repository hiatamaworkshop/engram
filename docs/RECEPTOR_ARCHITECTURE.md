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

## 8. チューニング履歴 (2026-03-14)

### Round 1: 実作業テンポへの適応

シミュレーション（イベント間隔 5-10s）では正常動作したが、
実作業テンポ（30-120s 間隔）では減衰が速すぎて感情が蓄積しない問題を発見。

#### 半減期の延長

| 軸 | 旧値 | 新値 | 理由 |
|----|------|------|------|
| frustration | 60s | 180s (3min) | 45s gap で 40%→16% 消滅 |
| hunger | 90s | 240s (4min) | 探索中の知識ギャップは持続する |
| uncertainty | 75s | 180s (3min) | 方向性の迷いは即消えない |
| confidence | 60s | 120s (2min) | 裏付けが必要だが即消しない |
| fatigue | 5min | 10min | セッションレベル信号 |
| flow | 90s | 180s (3min) | フロー状態は慣性がある |

#### インパルス強度の増加

| パターン | 旧値 | 新値 |
|---------|------|------|
| trial_error → frustration | 0.05 | 0.08 |
| implementation → flow/confidence | 0.03/0.03 | 0.04/0.04 |
| wandering → uncertainty/hunger | 0.07/0.06 | 0.10/0.08 |
| exploration → hunger | 0.04 | 0.05 |

#### 閾値の再設計

| パラメータ | 旧値 | 新値 | 理由 |
|-----------|------|------|------|
| MIN_THRESHOLD | 0.30 | 0.25 | offset 0.20-0.25 が clamp で死んでいた |
| frustration offset | 0.25 | 0.20 | 最重要信号、早期検知 |
| flow offset | 0.25 | 0.20 | フロー認識を早める |
| hunger offset | 0.30 | 0.25 | 知識ギャップに適度な感度 |
| uncertainty offset | 0.30 | 0.25 | 同上 |
| fatigue offset | 0.35 | 0.30 | 蓄積が遅いので高めに維持 |

#### C ニューロン調整

| パラメータ | 旧値 | 新値 | 理由 |
|-----------|------|------|------|
| ADJUSTMENT_STEP | 0.02 | 0.03 | イベント疎でもフィールド蓄積 |
| MAX_ADJUSTMENT | 0.10 | 0.15 | フィールド結合の幅拡大 |
| stuck 判定閾値 | 0.30 | 0.25 | 新 MIN_THRESHOLD に合わせ |
| deep_work 判定閾値 | 0.20 | 0.15 | flow 認識を早める |

### Round 2: 主観時間キャップ

**問題**: 壁時計時間ベースの減衰は、ユーザー入力時間と LLM 推論時間を
エージェントの活動時間と区別できない。ユーザーが 2 分間入力を打っている間に
frustration が 37% 消滅する。だがエージェントは何もしていない。

**解決**: `INTER_TURN_CAP_MS = 30s` — 有効経過時間にキャップ。

```
dt < 30s     → effectiveDt = dt      (ターン内: agent 活動中、実時間で減衰)
30s < dt < 3min → effectiveDt = 30s    (ターン間: agent 休眠中、最大30s分の減衰)
dt > 3min    → effectiveDt = 0       (凍結: セッション中断)
```

**設計原則**: 神経モデルに減衰は必須だが、減衰する「時間」はエージェントの
主観時間であるべき。ユーザーの入力時間はエージェントの意識の外にある。

**効果** (frustration 半減期 180s):
- ターン内 5s gap → 残存 98%
- ターン間 2min gap → 残存 89% (30s キャップ適用)
- 旧: ターン間 2min gap → 残存 63% (37% 消滅 ← 問題)

---

## 9. 発見されたバグと修正

### Bug 1: 成功する Edit→Bash サイクルが frustration を生む

**原因**: `editBashAlternation * 0.15` が失敗の有無を問わず加算。
**修正**: `alternationRate * 0.4 * bashFailRate` — 失敗率が 0 なら寄与 0。
さらに件数ではなく比率（全遷移に対する割合）に変更。

### Bug 2: イベント 2 件で flow=0.90

**原因**: Read 1 + Edit 1 で `implementation` パターン判定 → flow 即発火。
**修正**: total ≤ 3 の場合は `stagnation` を返す（判定不能）。

---

## 10. 実装済み拡張 (2026-03-15)

### emotion-profile.json — 数値定数の外部化

emotion.ts, ambient.ts, meta.ts にハードコードされていた全数値定数を
`receptor/emotion-profile.json` に集約。profile.ts が型定義とローダーを提供。

```
emotion-profile.json (単一の数値定義)
       |
       v
  profile.ts (型定義 + ローダー)
       |
       ├──→ emotion.ts (halfLife, impulse, compounds, timing)
       ├──→ ambient.ts (EMA定数, offsets, thresholds)
       └──→ meta.ts (buffer, field, stateThresholds)
```

**セクション構成**:
| セクション | 内容 |
|-----------|------|
| `accumulator` | 半減期 (per axis), idleFreezeMs, interTurnCapMs |
| `impulse.event` | アクション×結果ごとのインパルス係数 |
| `impulse.pattern` | パターンごとのインパルス係数 |
| `impulse.fatigue` | base + hourlyRate |
| `signal` | defaultThreshold, holdReleaseCount, compounds 定義 |
| `ambient` | timeConstantMs, silenceGateMs, offsets, min/maxThreshold |
| `meta` | bufferSize, hitRate閾値, fieldAdjustment, stateThresholds |

**compounds の宣言的定義**: 以前は emotion.ts にハードコードされていた compound 信号
（frustration + hunger の同時発火）が JSON で宣言的に定義される。
新しい compound パターンの追加は JSON に1行追加するだけ。

**設計原理**: チューニングが1ファイルで完結し、receptor-rules.json と同じ語彙を共有。
ベクトル数値を多目的の1ファイルにハードコードすると保守が破綻するため分離した。

### Passive Receptor — 解釈層

FireSignal[] を受信し、receptor-rules.json のメソッド群をスコアリングして
配信モードに応じてディスパッチする。

```
FireSignal[] (B neuron 出力)
       |
       v
  passive.ts: onFireSignals()
       |
  [1] A gate check — flow_active 検出 → 全メソッド抑制、即 return
       |
  [2] evaluate() — 全メソッドをスコアリング
       |   score = signalMatch × stateMatch × intensity
       |         × sensitivity × (1 - falsePositiveRate) × recencyDecay
       |
  [3] FIRE_THRESHOLD (0.15) 超過のみ通過
       |
  [4] dispatch() — mode 別振り分け
       ├── auto   → autoQueue (method resolver が消費)
       ├── notify → pending (hotmemo Layer 5 が表示)
       └── background → pending (暫定、将来分離)
```

**スコアリング詳細**:
| 要素 | 値域 | 算出 |
|------|------|------|
| signalMatch | 0 or 1 | trigger.signals に signal.kind が含まれるか |
| stateMatch | 0.3 or 1.0 | trigger.states に agentState が含まれるか (不一致は ×0.3、完全排除しない) |
| intensity | 0-1 | signal.intensity (B neuron 出力) |
| sensitivity | 0-1 | trigger.sensitivity (開発者が宣言) |
| falsePositiveRate | 0 | learnedDelta (将来: receptor-learned.json から読み込み) |
| recencyDecay | 0-1 | 前回発火からの経過時間 / cooldown (連発防止) |

**recency cooldown**:
| frequency | cooldown |
|-----------|----------|
| low | 2分 |
| medium | 1分 |
| high | 15秒 |

**hotmemo 統合**: hot-memo.ts に Layer 5 として receptor 推奨を注入。
`formatRecommendations()` が pending メソッドを整形し、`drainRecommendations()` で消費。
推奨がなければ沈黙 — hotmemo のゼロノイズ原則を継承。

### ターン境界トラッキング

ツール呼び出し回数だけでは work intensity を算出できない（分母がない）。
`UserPromptSubmit` と `Stop` フックでターン境界を検出し、tools/turn 比率を算出。

```
[UserPromptSubmit hook] → POST /turn {"type":"user"}  → commander.recordTurn("user")
[Stop hook]             → POST /turn {"type":"agent"} → commander.recordTurn("agent")
```

**WindowSnapshot に追加されたフィールド**:
| フィールド | 意味 |
|-----------|------|
| `turns` | ウィンドウ内の完了ターン数 (agent Stop の数) |
| `toolsPerTurn` | total / turns (0 = ターンデータ未着) |

**表示例**:
```
  5m:  [Rd:4 Ed:12 Sh:5] n=21  turns=3 t/t=7.0
```
`t/t=7.0` = 1ターンあたり7ツール使用 = 集中的な実装バースト。

**算出可能な指標**:
| 指標 | 式 | 意味 |
|------|-----|------|
| work intensity | tools / turn | ターンあたりの道具使用密度 |
| interaction tempo | turns / hour | 対話頻度 |
| output efficiency | edits / turn | ターンあたりの編集出力 |
| search efficiency | found / (found + empty) per turn | 探索精度 |

**ファイル構成**:
| ファイル | 役割 |
|---------|------|
| `~/.claude/hooks/engram-turn-hook.sh` | ターン境界を `/turn` に送信 |
| `~/.claude/settings.json` | UserPromptSubmit, Stop フック登録 |
| `receptor/http.ts` | `/turn` エンドポイント |
| `receptor/commander.ts` | TurnMark 蓄積 + _turnsInWindow() |

### hunger_spike の false positive 対策

**問題**: hunger は情報消費量 (intake rate) を測っており、欠乏状態ではない。
設計議論で資料を読むだけで hunger 0.98 に到達し、passive receptor が不要な発火をする。

**対策**: receptor-rules.json で解釈層側で抑制。
- `engram_probe`: signals を `compound_frustration_hunger` のみに限定、states を `stuck` のみに
- `mycelium_walk`: signals から `hunger_spike` を除去、`uncertainty_sustained` のみに

**設計方針**: neuron (センサー) 側は修正せず、解釈層で文脈判断する。
hunger が高くても frustration が低ければ「健全な学習」と判断して抑制。

---

### Service Registry + Method Resolver — executor の宣言的管理

passive.ts が auto queue にメソッドを入れた後、誰がそのメソッドを実行するかを決定する層。
以前は `index.ts` に if 分岐でハードコードされていたが、Map ベースの動的 dispatch に移行。

```
passive.ts: autoQueue に ScoredMethod を push
       |
       v
  index.ts: executeAutoQueue()
       |
       v
  registry.ts: resolveAndExecute(method, context)
       |
  [1] method.action.tool が null → notify-only (message のみ) → return false
       |
  [2] _registry.get(toolName)
       |
       ├── found  → entry.handler(method, context) → return true
       └── not found → console.error → return false
```

**Registry API**:
| 関数 | 用途 |
|------|------|
| `registerExecutor(toolName, entry)` | executor 登録 |
| `unregisterExecutor(toolName)` | executor 削除 |
| `hasExecutor(toolName)` | 登録確認 |
| `registeredTools()` | 全登録済みツール名 |
| `resolveAndExecute(method, context)` | dispatch |

**ExecutorEntry**:
```typescript
interface ExecutorEntry {
  type: "internal" | "mcp" | "shell" | "http";
  handler: (method: ScoredMethod, context: ExecutorContext) => Promise<void>;
}
```

**登録フロー**: internal executor は `index.ts` の `setMethodExecutor()` で登録。
external executor は後述の Service Loader が startup 時に一括登録。

### MCP Executor — 外部 MCP サーバー呼び出し

外部 MCP サーバーを子プロセスとして spawn し、stdio transport で接続。
接続プールにより同一サーバーへの重複接続を防止。

```
callMcpTool(serverDef, toolName, args)
       |
  [1] serverKey(def) → "node|dist/server.js|/abs/path/to/receptor-echo"
       |
  [2] _pool.get(key)
       ├── hit  → refCount++ → 既存 client 返却
       └── miss → spawn + StdioClientTransport + client.connect()
                  → _pool.set(key, { client, transport, refCount: 1 })
       |
  [3] client.callTool({ name, arguments })
       |
  [4] MCP response → text content 抽出 → string 返却
```

**接続プール**: `Map<serverKey, PoolEntry>` — key は `command|args|resolvedCwd`。
1 つの MCP サーバープロセスが複数ツールを提供する場合、接続は共有される。

**cwd 解決**: `configDir()` = `dirname(fileURLToPath(import.meta.url))` = ランタイム時 `dist/receptor/`。
executor-services.json の `cwd` はこのディレクトリからの相対パス。

**shutdown**: `closeAllMcpClients()` で全プール接続を一括切断（プロセス終了時に呼ぶ）。

### Service Loader — executor-services.json から宣言的登録

起動時に `executor-services.json` を読み込み、外部 executor を registry に登録。
internal executor はコード登録のまま、external (mcp/shell/http) のみ JSON 定義。

```
executor-services.json
       |
  service-loader.ts: loadExternalServices()
       |
  for each ServiceDef:
       ├── type === "mcp" → registerExecutor(toolName, { type: "mcp", handler })
       ├── type === "shell" → (future)
       └── type === "http"  → (future)
```

**executor-services.json 構造**:
```json
{
  "services": [
    {
      "tool": "echo_ping",
      "type": "mcp",
      "server": {
        "command": "node",
        "args": ["dist/server.js"],
        "cwd": "../../../../receptor-echo"
      }
    }
  ]
}
```

**MCP handler の動作**:
1. `context.topPaths` からヒートマップ上位パスを取得
2. `args.query` が未設定なら、パス末尾2セグメントを unique 結合して query に注入
3. `callMcpTool(serverDef, toolName, args)` で外部 MCP サーバー呼び出し
4. 結果を `pushAutoResult("[receptor → toolName] agentState | result")` で hotmemo に注入
5. 起動ログ: `[service-loader] registered: echo_ping (mcp → node)`

**cwd パスの注意**: `cwd` は `dist/receptor/` からの相対パス。
`../../receptor-echo` では `mcp-server/receptor-echo` に解決されてしまう。
`DockerFiles/receptor-echo` に到達するには `../../../../receptor-echo` が正しい。

---

### Output Router — 宣言的出力ルーティング

executor の実行結果をどこに流すかを、receptor-rules.json で宣言的に制御する。
以前は `pushAutoResult()` で hotmemo に直接流していたが、出口を多重化。

```
executor result → routeOutput(payload)
                       |
                       ├── OutputConfig から targets を読む
                       |
                 ┌─────┼─────┬──────────┐
                 v     v     v          v
             hotmemo  log  engram    silent
             (agent   (stderr) (ingest)  (discard)
              prompt)
```

**OutputConfig** (receptor-rules.json の `action.output`):
```json
{
  "targets": ["hotmemo", "log"],
  "format": "summary",
  "maxLength": 200
}
```

| フィールド | 型 | デフォルト | 意味 |
|-----------|-----|----------|------|
| `targets` | string[] | `["hotmemo"]` | 出力先 |
| `format` | `"raw" \| "summary" \| "json"` | `"raw"` | 整形方式 |
| `maxLength` | number | 無制限 | 切り詰め文字数 |

**Sink registry**: `registerSink(target, fn)` で出力先を追加可能。
engram sink は `index.ts` で ctx 取得後に遅延登録（receptor モジュールが engram API に直接依存しない）。

**delivery mode との関係**:
| mode | エージェントに見えるか | 典型的な targets |
|------|----------------------|-----------------|
| auto | 見える | `["hotmemo"]` or `["hotmemo", "log"]` |
| notify | 見える（推奨表示） | hotmemo Layer 5 経由 |
| background | **見えない** | `["engram", "log"]` or `["silent"]` |

background mode は output-router の targets から hotmemo を外すことで実現。
エージェントに見えない副作用（data statistics 挿入、自動クリーンアップ等）に使う。

### learnedDelta — 軸単位のキャリブレーション（実装済み）

#### 居場所: Passive Receptor のスコアリング

learnedDelta は neuron 内部（入力ゲイン、閾値）には **触らない**。
解釈層のスコアリングに `(1 + δ)` として乗算。

```
score(method, signal) =
    signalMatch                        // trigger.signals にマッチするか
  × stateMatch                         // trigger.states にマッチするか (×0.3)
  × signal.intensity                   // B neuron の発火強度
  × method.trigger.sensitivity         // 開発者が宣言した感度
  × (1 + δ[axis])                      // ← learnedDelta (±0.30)
  × receptorSuppression²               // 軸特異的不応期
```

#### 設計原則: 計測器は校正しない、計測値の解釈を調整する

PREDICTIVE_INFERENCE.md の三層原則:
> C (Meta): B の閾値を調整。**直接ゲインを操作しない**

learnedDelta もこの原則を継承。active 側 (B neuron) は純粋なセンサーとして保つ。
A gate (flow) の不可侵性も維持 — flow は δ 対象外。

#### receptor-learned.json

```json
{
  "delta": {
    "frustration": 0.00,
    "hunger": 0.00,
    "uncertainty": 0.00,
    "confidence": 0.00,
    "fatigue": 0.00
  }
}
```

- **粒度**: 軸単位（5軸）。methodId 単位ではない
  - 「hunger にどう反応するか」= 個体差（δ）
  - 「hunger_spike で何を呼ぶか」= ポリシー（receptor-rules.json）
- **bounds**: ±0.30（sphere と同じ設計）
- **flow 除外**: A gate の不可侵性を維持
- **compound signal**: 複数軸の場合、最大絶対値の δ を採用

#### キャリブレーション

開発者がオンデマンドで実行し、δ を receptor-learned.json に反映する。

```
npx tsx src/receptor/calibrate.ts [--dry-run] [--merge | --fresh]
```

- `--fresh`: δ をゼロから再計算（デフォルト、現行動作）
- `--merge`: 現在の δ を起点に、誤差を LEARNING_RATE で混合

シナリオ定義（calibration-scenarios.json）の期待値とニューロン出力の誤差から δ を算出。
冪等。Phase 1 実装済み（16シナリオ）。チューニングはシナリオの追加・期待値調整で行う。

#### 前例

| プロジェクト | 構造 | 適用先 |
|-------------|------|--------|
| sphere | `effective = base × (1 + δ)`, δ ±0.3 | flagBias, returnWeights, qualityVector |
| mycelium | `personality × feelings → actionProbs` | personality 行列 (immutable) |
| receptor | `score × (1 + δ)`, δ ±0.3 | passive scoring の軸感度 |

共通原則: base は不変、δ は bounded、校正者は外部。

## 11. 未実装（スコープ外）

- **background mode handler**: passive.ts の dispatch で background → output-router 直接ルーティング
- **shell / http executor**: Service Loader に型定義のみ、handler 未実装

---

## 11. HTTP Bridge — リアルタイムイベント配信

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
  engram-receptor-hook.sh
       |
       | read port from ~/.engram/receptor.port
       | POST http://127.0.0.1:{port}/receptor
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
| `~/.claude/hooks/engram-receptor-hook.sh` | discovery file からポート読み取り + curl POST |
| `~/.claude/settings.json` | PostToolUse catch-all フック登録 |
| `~/.engram/receptor.port` | バインドポート番号 (自動生成・自動削除) |

### http.ts の責務

1. **動的ポートバインド**: 優先ポート (3101) を試行、EADDRINUSE なら OS 空きポートにフォールバック
2. **Discovery file**: バインドしたポート番号を `~/.engram/receptor.port` に書き込み
3. **MCP プレフィクス除去**: `mcp__engram__engram_pull` → `engram_pull`
4. **Bash exit_code 抽出**: `tool_response` から複数フィールドを試行
5. **Search resultCount 抽出**: `tool_response` の "Found N files" パターン等
6. **tool_response は normalizer に渡さない**: 必要な情報だけ抽出し、残りは捨てる
7. **シャットダウン時**: discovery file を削除

### ポート解決 (動的ポート + discovery file)

**問題**: VSCode MCP と CLI MCP が同時起動すると固定ポート 3101 が衝突する (EADDRINUSE)。
先にポートを取ったプロセスが勝ち、後発はサイレントに HTTP bridge を失う。

**解決**:
```
1. listen(3101) を試行
2. EADDRINUSE → listen(0) で OS が空きポートを割り当て
3. バインド成功 → ~/.engram/receptor.port にポート番号を書き込み
4. hook スクリプトが discovery file からポートを読む
5. サーバー停止時に discovery file を削除
```

**フォールバック**: discovery file がない場合、hook は環境変数 `RECEPTOR_PORT` (デフォルト 3101) を使用。

**制約**: 複数 MCP プロセスが同時に discovery file を書く場合、最後に書いた方が勝つ。
watch ON にした側のプロセスが最後に書くため、意図通り動作する。

### 設定

```jsonc
// ~/.claude/settings.json — PostToolUse
{
  "matcher": ".*",        // 全ツールにマッチ（regex catch-all）
  "hooks": [{
    "type": "command",
    "command": "bash ~/.claude/hooks/engram-receptor-hook.sh",
    "timeout": 2          // localhost なので 2s で十分
  }]
}
```

### 使い方

```
1. セッション起動 → MCP サーバー起動 → HTTP リスナー自動起動 (ポート自動決定)
2. engram_watch(enabled=true)  — 監視開始
3. 普通に作業（Read, Edit, Bash, Grep ...）
   → 全ツール PostToolUse → hook → curl → receptor → ingestEvent
4. engram_watch()  — メトリクス確認（いつでも何度でも）
5. engram_watch(enabled=false)  — 停止 + サマリー
```

### 検証済み事項

- ✅ HTTP bridge (localhost:3101) は Windows 環境で動作確認
- ✅ curl (Git Bash 同梱版) で POST 成功
- ✅ hook スクリプト (`engram-receptor-hook.sh`) のパイプ動作確認
- ✅ 手動イベント投入による全ニューロン層 (A/B/C) の動作確認
- ✅ compound 発火 → 回復 → flow gate の完全遷移を確認
- ✅ 動的ポートバインド + discovery file による EADDRINUSE 回避 (2026-03-14)
- ✅ 実 hook payload 構造の検証 + extractExitCode/extractSearchResultCount 修正 (2026-03-14)

### 実 hook payload 構造 (検証: 2026-03-14)

| ツール | tool_response キー |
|--------|-------------------|
| **Bash (成功)** | `stdout, stderr, interrupted, isImage, noOutputExpected` |
| **Bash (失敗)** | 上記 + `returnCodeInterpretation` |
| **Grep** | `mode, filenames, numFiles` |
| **Glob** | `filenames, durationMs, numFiles, truncated` |
| **Edit** | `filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll` |

**重要な発見:**
- Bash に `exit_code` フィールドは**存在しない**。失敗判定は `returnCodeInterpretation` の有無で行う
- Grep/Glob の結果数は `numFiles` フィールド（構造化JSON）で取得。テキストパターン解析は不要
- Edit の `tool_response` にはパッチ情報が含まれる（将来の edit 成否判定に利用可能）

### 未検証事項

- VSCode + CLI 同時起動での discovery file 競合動作
- Grep `output_mode: "content"` 時の tool_response 構造
- Read の tool_response 構造（file_read の成否判定）