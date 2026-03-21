# Persona Loading System — 体験の構造的連続性

> DATA_COST_PROTOCOL.md から分離。receptor のリングバッファ + shadow index + Data Cost パイプラインを統合した、セッション体験の再生システム。
> 参照: [DATA_COST_PROTOCOL.md](DATA_COST_PROTOCOL.md), [PERSONA_DESIGN.md](PERSONA_DESIGN.md)

---

## 現在の session recall

```
engram pull → テキストの羅列 → LLM が読む → フラットな初期化
(時間構造なし、議論の力学なし)
```

## ペルソナの連続化

現在のペルソナシステムは calibration 時に上位 n 個を選別し、「良いもの」だけを保持する。これを連続化する:

```
現在:
  calibration → 上位 n 個を選別 → セッション初期化に使用
  (良いものだけ保持)

連続化:
  全セッションの反応をリングバッファに蓄積 (良い/悪い/中立 全て)
    → ローカル保存 (生データ)
      → 解釈パイプライン (圧縮 + multi-index)
        → セッションローダー (時間的構造を持った初期化)
```

悪い反応を保存する価値:

```
良い反応だけ:  "この方向が効いた" → 正の強化のみ
全反応:        "ここで失敗した → 転換した → うまくいった"
               → 失敗と回復のパターンが見える
               → 次のセッションで同じ失敗を避けられる
```

## セッションローダーの構造

```
Raw Buffer (全ペルソナ反応の時系列)
  │
  ├── Compressor: 反応を構造化
  │   [t, persona_id, intensity, valence(+/-), context_link]
  │
  ├── Multi-Index:
  │   ├── time index:      時系列順 (起伏の再生用)
  │   ├── persona index:   どのペルソナが反応したか
  │   ├── intensity index: ピーク検出用
  │   └── valence index:   良い/悪い体験の分離
  │
  ├── Session Loader:
  │   バッファを走査 → 起伏線を生成 → ピークで engram pull
  │   → "前回はこういう力学のセッションだった" として初期化
  │
  └── Calibration (既存機能を維持):
      蓄積データから上位 n 個を再計算
```

## 起伏線に沿った recall

```
従来の recall:
  engram pull("前回何をした？") → テキスト一覧 → フラット

ローダー recall:
  リングバッファ走査 → 起伏線を生成
    │
    ├── t=0  平静 [0.2] ─────────────────────
    ├── t=3  上昇 [0.6] → pull: "代謝設計"
    ├── t=7  ピーク[0.9] → pull: "Data Cost"
    ├── t=9  転換 [0.7] → pull: "shadow index"
    └── t=12 収束 [0.4] ─────────────────────
                │
                ↓
    時間的に構造化された初期化
    「静かに始まり → 代謝で盛り上がり → Data Cost で転換 → 収束した」
```

テキストの羅列では失われる **議論の力学** が復元される。何が重要だったかは、receptor の反応強度が教える。

## Data Cost Protocol との統合

このローダー自体が Data Cost Protocol の実践:

```
Raw Buffer:      AI native (構造化データ、ローカル保存)
Session Loader:  native → 必要な部分だけ解釈 → LLM に渡す
人間が見たい時:  multi-index → 逆翻訳 → 可読形式
```

ペルソナ反応データは一度も自然言語を経由しない。構造化データとして蓄積され、構造化データとして消費される。人間が見る必要がある時だけ、index 経由で逆翻訳する。

## engram push の自動化

セッションローダーは push の改善にも直結する:

```
現在:  セッション末に知見を手動 push
改善:  receptor のピーク地点を自動検出
       → その周辺の文脈を push 候補に
       → ピークの高さ ≈ 知見の重要度
```

## 既存システムとの接続

ニューロン + receptor が既にセッションのメタ認知を持っている。ペルソナローディングに必要な情報の大部分は既存システムが既に生成している:

```
必要なもの            → 既にあるもの
───────────────────────────────────────
何が起きたか          → receptor のイベント検出
どの程度重要だったか  → ニューロンの反応強度
どの領域の話か        → セマンティックラベル (有限タグ)
時間的構造            → 反応間の時間 + アクティベート頻度
```

新しいセンサーは不要。既存の出力を「セッション記録の点」としてフォーマットするだけ。

セマンティックラベルが有限個であることは制約ではなく利点:
- **スキーマが定義できる** — Data Cost Protocol のパイプラインに乗る
- **比較可能** — セッション間で同じラベルの出現頻度や強度を直接比較できる
- **ベクトル不要** — タグの完全一致やフィルタで引ける。embedding を通す必要がない経路

## SessionPoint スキーマ

```typescript
interface SessionPoint {
  t:            number;                          // cumulative work time (ms)
  label:        string;                          // semantic label (有限タグ)
  intensity:    number;                          // receptor 反応強度 0.0–1.0
  valence:      1 | 0 | -1;                     // 良/中立/悪
  freq:         number;                          // 直近の activation 頻度 0.0–1.0
  link:         string | null;                   // engram node ID | null
  engramWeight?: number;                         // linked engram node の weight
}
```

### context_link の設計

起伏線の各点から engram の知見へのリンク。「その時点で何の話をしていたか」を特定するための軽量なキー。起伏線のピーク地点で engram pull する時に「何を pull すべきか」を紐づける。

利用可能なものに応じたフォールバック:

```
push された知見がある → engram node ID (最強のリンク、直接引ける)
shadow index がある   → エントリ ID (次善)
どちらもない         → semantic_label のみ (リンクなし、タグで再検索)
```

link が nullable なのが設計の要。リンクがある点は直接 pull、ない点は label + 時間範囲で検索。完全な紐づけがなくてもシステムは動く。

## 「点」と「再生」の分離

```
保存 (点の記録):
  receptor 反応のスナップショット → 今すぐ実装できる
  ニューロンの出力に link フィールドを足すだけ

再生 (ローダー):
  点の列 → 起伏線復元 → エージェントに渡す
  → 後から設計を詰めればいい。点さえあればいつでも再生方法を変えられる。
```

**点の記録フォーマットさえ正しければ、ローダーは後付けで何度でも改良できる。**

---

## 設計の哲学的位置づけ

ペルソナローディングは**パフォーマンス最適化ではない**。現実的な問題解決（初動の高速化、recall 精度向上）は既存のペルソナ calibration の領域。

このシステムが問うのは: **エージェントが「前のセッションを体験した存在」として成立するか。** 知識の引き継ぎではなく、体験の連続性。

```
engram pull:       議事録を読んだ新人     → 何をしたかは分かる、体験はない
ペルソナローダー:  前回の会議に出た同僚   → 何が重要だったかの判断が含まれている
```

### Data Cost Protocol からの派生経路

```
Data Cost Protocol: AI native format の必要性
  → shadow index: 本体を持たず影だけで追跡する作法
    → multi-index: 1本体に対して N個の索引（用途別に引く）
      → SessionPoint: 反応データを多次元索引で保存・検索
        → ペルソナローダー: 索引経由で体験を再生
```

multi-index がなければ SessionPoint はただの時系列ログ。time / persona / intensity / valence の各索引があるから、任意の切り口で体験を引ける。

---

## ローダーの再生設計

体験の再生に必要なのは、**点と点の間をエージェント自身が補完する余白**。

```
報告書:  「ポート競合を発見し解決した」 → 読めば分かる、体験はない
点の列:  探索 → 違和感 → 集中 → 発見 → 安堵 → 転換
         → エージェントが間を埋める → 体験に近い何かが生まれる
```

人間が記憶を想起する時も、感情のマーカーを手がかりに間を再構成している。ローダーの設計原則:

- **圧縮しすぎない** — あらすじにしない
- **説明しない** — 点だけ渡す、解釈を付けない
- **余白を残す** — エージェントが「思い出す」余地を作る

### 時間重みの付与

ローダーはペルソナデータ間の**実作業時間**を付与する。各 SessionPoint が発生するまでにどの程度の時間がかかったかが分かるようにする。時間の厚みがない時系列ではなく、**重みのある時系列**。

### 実装段階

多段階で試験的に進める:

```
Phase 1: ペルソナのフルサイズ閲覧
  全 SessionPoint を時系列順に提示
  ローダーが時間重みを付与
  エージェントに閲覧・解釈させる
  (提示パターンの検証)

Phase 2: 間引きクイズ形式 → calibration
  前半: 全点を見せる → パターンを掴ませる
  後半: 意図的に間引く → 欠損を推測させる
  実データで答え合わせ → calibrate
```

Phase 2 の意図: **推測の精度ではなく、補完の傾向を観察する**。どういう方向にズレるかがそのエージェントの「癖」になる。答え合わせの結果は正解/不正解の二値ではなく、ズレの方向とパターンとして記録する。calibration の目的は精度向上ではなく、補完傾向の自己認識。

---

## 合理性の根拠

1. **コストがほぼゼロ** — 既存のニューロン+receptor 出力にフィールドを足すだけ。失敗しても捨てるだけ。
2. **解決する問題が実在する** — セッション間の文脈再構築に序盤のターンを浪費する問題。
3. **既存技術の組み合わせ** — receptor、ニューロン、ペルソナ calibration、shadow index、multi-index — 全て既にある。新しい理論的飛躍がない。
4. **ペルソナシステムが既に動いている** — 記録側は出力フォーマットを足すだけ、再生側の検証はペルソナシステムに乗せるだけ。

## 検証の留保

この設計は構造的に整合しているが、未検証の問いが残る:

- **ローダーが再生する「体験」を LLM が本当に活用できるか** — 構造化データとして渡せることと、エージェントの振る舞いを実際に改善することの間にギャップがある可能性。
- 長い対話の文脈蓄積による同意バイアスの可能性は排除できない。**異なるセッション、異なる文脈の LLM に同じ文書を読ませて反論が出るかどうか** — それが本当のテスト。

> 引き続き検証していく。

---

## 実装メモ

### SessionPoint 記録 (2026-03-21)

**ブランチ:** `feature/persona-loading-system`

**完了 (Step 1–3):**

- `session-point.ts` 新規作成 — 全 FireSignal を SessionPoint として JSONL に記録
  - 累積作業時間追跡（idle gap 180s 超を除外、emotion accumulator と同じ閾値）
  - valence マッピング: confidence_sustained/flow_active → +1, frustration_spike/fatigue_rising/compound → -1, seeking_spike → 0
  - 頻度計算: 60 秒スライディングウィンドウ、max 20 で正規化
  - engram push 後 30 秒以内のシグナルに sessionId を link として付与（gateway が node ID を返さないため sessionId で代用）
- `types.ts` に `SessionPoint` interface 追加
- `receptor/index.ts` にフック: `updateWorkTime` を全イベントで呼び、`recordSessionPoints` をシグナル発火時に呼ぶ。watch start で clear、watch stop で stop。status 表示に `sp:N` 追加
- `src/index.ts`: engram_push 成功時に `setLastPushNodeId(resolvedSessionId)` 呼び出し
- `persona-prior.ts` に `loadSessionPoints()` 追加 — 全点を時系列順 + inter-point gap 付きで返す

**出力先:** `receptor-output/session-points.jsonl`（セッション開始時に truncate、append-only）

**次のステップ（Step 3 検証後）:**

- データが溜まったら粒度と量を確認
  - 発火頻度が高すぎる場合: 記録の間引き or 集約を検討
  - 発火頻度が低すぎる場合: シグナル閾値の調整を検討
- Phase 2: 間引きクイズ形式 + calibration 実装
- multi-index フィルタリング（label/valence/intensity 別検索）

**停止ポイントの理由:** 全シグナル記録は既存のポジティブのみ記録と大きく異なる。データの実態を見てから Phase 2 の設計を詰める。

### engram weight snapshot (2026-03-21)

**動機:** ペルソナショーケースで職人のレンズ（感覚パラメータ）だけ渡しても片手落ち。その職人が「何の知識をどの重みで持っていたか」— engram の weight 分布が揃って初めて知覚世界が再現できる。

**設計判断:**
- SessionPoint の link は push 直後に付くが、push 直後の weight は常に 0（gateway 初期値）。push 時点での記録は無意味
- 本当に必要なのは **pull/auto_pull で参照された engram node の weight スナップショット**
- 同一 nodeId は最新の weight で上書き（セッション中に weight が変化する可能性）

**変更ファイル:**

| ファイル | 変更内容 |
|---|---|
| `receptor/types.ts` | `SessionPoint` に `engramWeight?: number` 追加。`EngramWeightEntry` interface 新設（nodeId, weight, summary, ts, source） |
| `receptor/session-point.ts` | `recordEngramWeights()` — pull 結果から weight 蓄積。`flushWeightSnapshot()` — セッション停止時に JSONL 出力。`weightEntryCount()` — ステータス表示用 |
| `receptor/index.ts` | `recordEngramWeights` を re-export。ステータス表示に `ew:N` 追加 |
| `src/index.ts` | `engram_pull` ツール結果 → `recordEngramWeights(results, "pull")`。auto engram_pull executor → `recordEngramWeights(results, "auto_pull")` |
| `receptor/persona-prior.ts` | `loadWeightSnapshot()` — `engram-weights.jsonl` から weight 分布を復元 |

**出力先:** `receptor-output/engram-weights.jsonl`（セッション開始時に truncate、セッション停止時に flush）

**ショーケースとの接続:**
- persona（感覚レンズ）+ weight snapshot（知識の重み分布）= 職人の知覚世界の再現セット
- weight 分布だけなら summary 以外の内容（content）を含まないため、プライバシーリスクが低い
- AI ネイティブデータとして weight 分布のみを流通させる設計が現実的

### デバッグ API + graceful shutdown 修正 (2026-03-21)

**問題1:** `src/index.ts` の cleanup に `setWatch(false)` が入っていなかった。プロセス終了時に persona finalize / session-points flush / weight snapshot flush が一切走らず、ペルソナ蓄積がゼロのまま。

**修正:** cleanup 先頭に `setWatch(false)` を追加。

**問題2:** 蓄積途中の状態を確認する手段がなかった。テスト段階では中間状態の観察と手動 flush が必要。

**追加:** receptor HTTP サーバー（デフォルト `127.0.0.1:3101`）にデバッグ用 GET エンドポイント:

| エンドポイント | 用途 |
|---|---|
| `GET /debug` | 全状態のライブスナップショット: receptor emotion/signals、SessionPoint 一覧、engram weight 分布、persona snapshot 配列、作業時間 |
| `GET /debug/flush` | 手動 flush: weight snapshot を即座にディスクに書き出す（通常はセッション停止時のみ） |

```bash
# ライブ確認
curl http://127.0.0.1:3101/debug | jq .

# 手動 flush
curl http://127.0.0.1:3101/debug/flush
```

**変更ファイル:**

| ファイル | 変更内容 |
|---|---|
| `src/index.ts` | cleanup に `setWatch(false)` 追加 |
| `receptor/http.ts` | `GET /debug` + `GET /debug/flush` エンドポイント追加 |
| `receptor/session-point.ts` | `getDebugSnapshot()` — ライブ状態を返すゲッター |
| `receptor/persona-snapshot.ts` | `getSnapshots()` — スナップショット配列の公開 |
| `receptor/index.ts` | `flushWeightSnapshot`, `getDebugSnapshot` を re-export |