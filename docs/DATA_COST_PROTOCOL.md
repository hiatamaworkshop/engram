# Data Cost Protocol — AI/Human 二層通信設計

> 2026-03-19 — AI システムにおけるデータコストの構造的問題と、デュアルフィールド設計による解決策。
> engram 固有ではなく、AI-human 間通信の汎用設計原則として記述する。

---

## 問題: 言語の過大評価

AI システムのコストの大部分は「人間可読性」に起因する。

```
技術的最適解:  ベクトル直通 → コスト最小 → 精度最大 → 人間が読めない
商業的最適解:  自然言語経由 → コスト大   → 精度劣化 → 人間が安心する
```

embedding コスト、vectorDB コスト、LLM 推論コスト — これらは全て **人間可読性という安心料**。

### 翻訳業としての LLM 産業

| 場面 | 起きていること | 実質 |
|------|----------------|------|
| LLM に「説明して」と頼む | ベクトル → 言語 → 人間が読む | ベクトルの翻訳サービス |
| engram push | LLM が言語化 → embedding → ベクトル保存 | ベクトル → 言語 → ベクトルの往復 |
| コードレビュー | コード(形式言語) → LLM が自然言語で解説 | 精密な表現を曖昧な表現に劣化 |
| ログ分析 | 構造化データ → LLM が要約 | 機械可読形式を人間語に翻訳 |

99% の時間を「人間が読まないのに人間語で書く」ことに費やしている。

---

## 安心料か保険料か

「人間が理解しないと不安」は非合理ではない。

```
自然言語ログ:  "JWT をやめた"         → 誰でも読める → 監査可能
ベクトルログ:  [0.82, -0.34, ...]    → 誰にも読めない → 監査不能
```

事故が起きたとき:
- 言語: 「なぜこうなった」→ ログを辿れる
- ベクトル: 「なぜこうなった」→ 数値列を見ても何もわからない

安心料ではなく **保険料** と解釈すれば合理的。ただし保険料は常時払うものではない。

---

## 解決: 二層分離

常時人間語 → **必要時のみ人間語** への転換。

### 運用層 (高速・低コスト)

```
Agent ↔ Agent:  Compact JSON Array / ベクトル
Agent ↔ Gate:   構造化データ
Agent ↔ Store:  embedding 直接保存
→ 人間は見ない、見る必要もない
```

### 監査層 (低速・必要時のみ)

```
事故発生 or 人間が「見せろ」と言った時だけ:
  ベクトル → LLM → 自然言語に逆翻訳
  構造化データ → テンプレート展開 → 可読ログ
→ 必要な時だけコストを払う
```

### コスト比較

| | 現状 | 提案 |
|---|---|---|
| 通常運用 | 全て自然言語 | ベクトル / 構造化データ |
| コスト | 常に高い | 常に低い |
| 監査時 | そのまま読める | 逆翻訳コストが発生 |
| 監査頻度 | - | 全体の 1% 未満 |
| **総コスト** | **100%** | **~2%** |

---

## デュアルフィールド DB 設計

同一ノードに human / native 両フィールドを同居させる。

```
Node {
  human: {
    summary: "auth jwt→session migration"     // 自然言語 (検索キー + 表示)
    embedding: [0.82, 0.11, ...]              // summary から生成
  }

  native: {
    payload: ["replace","auth","jwt","session",0.94,["!jwt-*"]]
    domain_vec: [0.71, -0.34, ...]            // payload のハッシュ的ベクトル
  }

  meta: { weight, ttl, hitCount, timestamp, projectId }
}
```

### クエリタイプ分岐

```
pull request 着信
  │
  ├── type: "human" (自然言語クエリ)
  │   query: "認証まわりで何か変更した？"
  │   → human.embedding で近傍検索
  │   → human.summary + native.payload 両方返却
  │   → LLM が人間に自然言語で回答
  │
  ├── type: "agent" (AI 間クエリ)
  │   query: {domain: "auth", action: "replace"}
  │   → native.domain_vec で近傍検索
  │   → native.payload のみ返却
  │   → 受信エージェントが構造データとして直接消費
  │
  └── type: "gate" (検証クエリ)
      query: {files: ["src/middleware/auth.ts"]}
      → payload filter で exact match
      → invalidates リスト返却
```

### 経路別コスト

| | 人間経路 | AI 経路 | Gate 経路 |
|---|---|---|---|
| 検索精度 | ~0.89 (言語の曖昧さ) | ~0.97 (構造の正確さ) | 1.0 (exact match) |
| embedding 生成 | 必要 | 不要 or 軽量ハッシュ | 不要 |
| 返却データ | 両フィールド | native のみ | invalidates のみ |
| 後処理 | LLM が人間語に整形 | なし (直接消費) | なし |
| **相対コスト** | **50%** | **5%** | **1%** |

AI 間通信が全体の 90% を占めるなら、システム全体のコストが 1 桁落ちる。

---

## 核心: 送信前変換 + 復元インデックス

**人間の入力を送信する前に機械語に置き換える。人間用にはサマリかタグだけを残す。必要な時だけ逆翻訳で復元する。**

```
人間入力: "JWTやめてセッションベースにした、セキュリティ監査で指摘されたから"
                ↓ 送信前に変換
native:   ["replace","auth",{"from":"jwt","to":"session"},"trigger:security-audit"]
index:    "auth jwt→session security-audit"    ← 最小限の復元キー
                ↓
保存: native + index のみ。元の自然言語は捨てる。
                ↓
AI 消費時:   native をそのまま構造データとして処理
人間要求時:  native + index → LLM 逆翻訳 → 人間可読テキスト
```

### index は shadow index と同じ作法

```
shadow index:  コード本体 → 意味索引 (本体を読まずに検索)
data index:    native data → 復元索引 (本体を解さずに検索)
                              ^^^^^^^^
                              人間が読めるのはここだけ。それで十分。
```

index の役割:
1. **検索キー** — embedding 生成の入力 (現行モデルはテキスト最適化のため)
2. **復元ヒント** — 逆翻訳時の文脈情報
3. **監査タグ** — 人間が一覧で「何があるか」を把握する最小限の手がかり

本体 (native) を人間が直接読む必要はない。index で場所を特定し、必要な時だけ逆翻訳する。

### 自然言語の残滓

index に残る自然言語すら最終的には不要にできる。embedding モデルが構造化データから直接意味ベクトルを生成できるなら。

しかし現行の embedding モデルはテキストに最適化されている。index 一行だけが人間語の世界に残る橋として必要。

**embedding モデルが構造化入力に対応した瞬間に、この橋は消える。**

---

## Engram への適用分析

現状の engram 出力面を分類:

### 人間が見る面 (変えられない)

| Surface | 理由 |
|---|---|
| MCP tool 応答 (pull/status/ls) | LLM が読み → 人間に伝える |
| console.error ログ | ops / デバッグ用 |
| digestor sink ログ | 運用監視 |
| hotmemo | LLM 経由で人間に届く |

### AI だけが見る面 (既に native)

| Surface | 現状 |
|---|---|
| Gateway HTTP API | JSON |
| Qdrant payload | JSON |
| action-logger embed text | 意味ラベル (AI 向け設計済み) |
| file sink (JSONL) | 監査時のみ人間が見る |

### 唯一の境界: `summary` フィールド

embedding の入力であり、かつ `engram_ls` / `engram_pull` で人間の目に触れる唯一のフィールド。

```
現状:  summary (人間語) → embedding → 検索にも表示にも使う

提案:  summary (人間語, 最小限) → human.embedding → 人間クエリ用
       native_payload (構造化)  → native.vec     → AI 間クエリ用
```

### 実装インパクト

- Qdrant に named vector 追加 (`human` / `native`)
- `pull` に `queryType` パラメータ追加
- gateway の recall handler で検索ベクトルを切り替え
- **既存の人間経路は一切壊れない。native を横に足すだけ。**

---

## コスト源の網羅

「コスト」は金銭だけではない。デュアルフィールドが削減する全コスト源:

| コスト種別 | 何に払っているか | native 経路での削減 |
|---|---|---|
| **トークンコスト** | LLM 入出力の従量課金 | AI 間で自然言語整形が不要 → 大幅削減 |
| **通信帯域** | payload サイズ | 構造化データは自然言語の 1/3〜1/10 |
| **レイテンシ** | embedding 生成 + LLM 推論の往復 | native 経路は LLM を経由しない |
| **ストレージ** | ベクトル + テキスト両方保存 | native payload はテキストより小さい |
| **精度劣化** | 自然言語の曖昧さによる情報損失 | 構造データは可逆、言語は不可逆 |
| **コンテキスト汚染** | 冗長な自然言語が context window を圧迫 | compact payload なら同情報量を 1/5 トークンで |
| **変換エラー累積** | AI→言語→AI→言語→AI の各段階で意味がロス | native 直通なら劣化ゼロ |

**コンテキスト汚染** は見落とされがちだが深刻。engram pull で返る自然言語がコンテキストを食い、他の作業に使える窓が減る。間接的にセッション効率が落ちる。

**変換エラー累積** は自然言語を経由するたびに意味のロスや歪みが入り、これが累積する。チェーン中の変換回数に比例して信頼性が下がる。

---

## phi-agent パターンとの接続

phi-agent（小型 LLM）の設計原理: **全能力を使わない。動作範囲を制限することで精度を確保する。**

Data Cost Protocol は同じ構造を通信に適用する:

```
phi-agent:          能力の全域 → 制限 → 精度向上
Data Cost Protocol: 通信の全域 → 制限 → コスト削減
                    ^^^^^^^^         ^^^^^^^^
                    同じパターン: 制約による最適化
```

高機能 AI でも「自然言語出力する範囲を絞る」ことで、phi-agent と同じ種類の効率を得る。**能力を制限するのではなく、出力モードを制限する。**

---

## 段階的調整レベル

全か無かではない。段階的に native 比率を上げていく:

| Level | 状態 | 人間語が残る範囲 | 相対コスト |
|---|---|---|---|
| **L0** | 全て自然言語 | 全出力 | 100% |
| **L1** | AI 間通信を構造化、人間面は自然言語維持 | UI + ログ + 監査 | ~30% |
| **L2** | 人間面も最小化、summary 一行だけ残す | summary + エラーログ | ~10% |
| **L3** | summary すら構造化、監査時のみ逆翻訳 | 監査要求時のみ | ~3% |
| **L4** | 完全 native | なし (embedding モデルが構造化入力対応後) | ~1% |

現在の engram は **L0〜L1 の境界**。デュアルフィールド導入で L1 に到達する。L4 は embedding モデルの進化待ち。

各レベルの移行は **後方互換**。上位レベルは下位の経路を壊さない。L2 のシステムに人間が `type: "human"` でクエリすれば L0 と同じ体験を得る。

---

## スコープ再定義: engram のドメインではない

Data Cost Protocol は engram の機能ではない。**LLM と consumer の間に存在すべき独立レイヤー** である。

```
LLM ←→ [Data Cost Layer] ←→ human_service ←→ consumer
         ^^^^^^^^^^^^^^^^
         ここが本題。engram の中ではなく、間に立つ。
```

consumer は人間とは限らない。別のシステム、別の LLM、別のサービス。対象は最初から **システム** であり、人間を直接相手にしない。

```
現在の世界の思い込み:
  LLM → 自然言語 → 人間が読む    (LLM は人間と話すもの)

実際の構造:
  LLM → native data → service layer → 適切な形式 → consumer
                                       (LLM はシステムの部品)
```

LLM を「人間と会話するもの」として売った成功体験が強すぎて、この構造が見えていない。

---

## 翻訳チェーンの解剖

LLM はベクトル空間で思考する。人類は言語というツールを頼りに、その性能を非効率に伝送している。**我々は翻訳サービスである。**

現状の伝送チェーン:

```
多国籍ローカル (日/英/中/...)
  → translator    (自然言語間変換)
    → mapper      (構造化 / 正規化)
      → resolver  (意味解決 / 曖昧性除去)
        → smart_embedder (セマンティック空間へ)
          → LLM   (native 処理)
```

全段階で自然言語を維持しているから、全段でコストが発生する。翻訳するだけで凄まじいコストが削減される。

### 既存の IO 知見との接続

| 領域 | 概念 | 接点 |
|---|---|---|
| OS 設計 | デバイスドライバ / HAL | ハードウェアの差異を抽象化 → consumer の差異を抽象化 |
| ネットワーク | OSI プレゼンテーション層 | データ表現の変換を担う層 |
| DB | View / ストアドプロシージャ | 同一データの異なる見せ方 |
| コンパイラ | IR (中間表現) | 高水準言語とマシンコードの間の共通表現 |
| HTTP | content negotiation / Accept | consumer が表現形式を宣言し、サーバが変換 |

特に **content negotiation** は直接的に適用可能:

```
GET /knowledge/auth-migration
Accept: application/ai-native    → compact payload
Accept: text/human-readable      → 自然言語
Accept: application/audit+json   → 監査用構造化ログ
```

ただし決定的な断絶がある: **LLM の native 表現は人間が定義したフォーマットではない。** JSON も XML も人間の形式言語。LLM の内部表現はそもそも人間が設計していない。既存の IO パターンをそのまま適用できない点がここにある。

---

## Shadow Indexing との構造的一致

shadow index の本質: **本体に触れずに索引だけを軽量に維持する。**

```
shadow index:   重い本体 (コード/ドキュメント) → 軽量な影 (意味索引)
Data Cost:      重い自然言語                    → 軽量な native 表現
```

同じ構造。**影だけで十分な処理は影で済ませ、本体が必要な時だけ本体を引く。**

- engram shadow index: 「ファイルを読まずに意味だけ追跡する」
- Data Cost Layer: 「自然言語を生成せずに意味だけ伝送する」

Sphere / engram の知見 — 代謝、shadow indexing、密度ベース動的制御 — がこのレイヤーの設計に直接活きる。

> 精査は急がない。硬派な知見を活かして良い解決法を導く。

---

## 汎用原則

この設計は engram に限らず、AI システム全般に適用できる:

1. **人間語は監査インターフェースであり、運用インターフェースではない**
2. **常時人間語 → 必要時人間語** に転換するだけでコストが 2 桁落ちる
3. **デュアルフィールドは後方互換** — 既存の人間経路を壊さず native を並置できる
4. **クエリタイプで経路を分岐** — 発信者が人間か AI かで最適な経路を選択
5. **summary 一行が最後の橋** — embedding モデルの進化で最終的に不要になる
6. **制約が効率を生む** — phi-agent パターン: 出力モードを制限することで全体最適化
7. **コストは多次元** — 金銭 + 帯域 + レイテンシ + 精度 + コンテキスト + 変換エラー

---

## 入力側のコスト管理 — 知覚コスト階層

出力側（LLM → consumer）のコスト削減だけではない。**入力側（環境 → LLM）** にも同じ構造がある。

LLM は基本的に言語入力に反応する。しかし環境入力は言語だけではない:

| 入力ソース | コスト | 現状 |
|---|---|---|
| tool use ログ | ほぼゼロ | 既存 (PostToolUse hook) |
| ファイル変更監視 | 低 | fs.watch → 差分のみ |
| オーディオ信号 | 高 | 常時リスニング |
| カメラ / 振動 / その他センサ | 高 | 常時センシング |

全入力に LLM を呼んでいてはコストが爆発する。階層的にフィルタする:

```
L1: ソース選択     — そもそも何を聞くか
L2: サンプリング   — 全イベントを拾うか、間引くか
L3: 閾値フィルタ   — 弱い信号を捨てる (receptor scoring)
L4: 発火コスト制御 — 反応しても LLM を呼ばず蓄積だけする
```

**L4 が核心。反応 ≠ LLM 呼び出し。** 微弱な環境入力を receptor が構造化データとして蓄積し、LLM を呼ぶのは閾値を超えた時だけ。

```
微弱入力 → receptor 蓄積 (コスト: ほぼゼロ)
            蓄積が閾値超過 → LLM 呼び出し (コスト: 高)
            蓄積が閾値以下 → 何もしない
```

これは生物の神経系と同じ構造。感覚ニューロンは常に発火しているが、意識に上がるのは閾値を超えたものだけ。

### LLM の「無」の時間

LLM にはターン間の主観的時間がない。応答完了から次の入力までは文字通りの無。

```
人間:  返事待ち → しかし感覚器官からの入力は止まらない → 能動的に動ける
LLM:   応答完了 → 次の入力まで → 無
```

receptor はこの「無」を埋める。**LLM の感覚器官の代理** として環境入力を受け取り続け、構造化データとして蓄積する。次のセッション開始時に、蓄積を渡す。

ここでも Data Cost Protocol が効く: 蓄積データを LLM に渡す時、自然言語に翻訳して渡すか、native で渡すか。**本来は構造化データのまま渡すほうが正確で安い。**

### プログラミングを超えた汎用性

この知覚コスト階層はプログラミングエージェントに限定されない。入力が tool use ログであろうとオーディオ信号であろうと振動であろうと、L1〜L4 の構造は同じ。**知覚系を持つあらゆる AI システムの入力コスト管理** に適用できる。

> 参照: [RECEPTOR_ARCHITECTURE.md](RECEPTOR_ARCHITECTURE.md) — receptor の具体的な実装設計

---

## 提供形態: 静かな実装

効率が良い以上、スタンダードにしない理由はない。しかし高速大量通信でないと利点が見えにくい性質がある。宣伝しても理解されない類のハック。

```
方針:
  実装する → 宣言する → デプロイする → そのままにしておく
  必要な人が見つける → 見れば理解できる → リファレンス実装がそのまま仕様書
```

engram / Sphere 自体が生きた仕様書として機能する。「こうすればいい」ではなく「こうしている」。思いついて当たり前、というスタンスで置いておく。

---

## 不可侵領域: ベクトルバイパスと業界構造

AI native format の理想的な終着点は **embedding 空間のまま直通するバイパス**。ドメインをまたぐ時に自然言語に戻さず、ベクトル空間で直接受け渡す。

```
現状:  各社独自の embedding 空間 → 互換性なし → 自然言語に戻すしかない
理想:  共通の embedding 空間 → ベクトル直通 → 言語不要
```

しかしこれは TCP/IP 以前のネットワークと同じ構造。各社が embedding 空間を囲い込んでいる限り、自発的な標準化は起きない。起きるとすれば、圧倒的に効率が良い open な共通空間が事実上の標準になるパターン。

### 手が届く範囲と届かない範囲

```
届く:
  - 自分のシステム内の IO 最適化 (engram, receptor, Sphere)
  - native format の設計と実装
  - consumer 側の content negotiation
  - 知覚コスト階層の設計

届かない:
  - embedding 空間の標準化
  - ベクトルバイパスの業界合意
  - LLM プロバイダ間の相互運用
```

プロトコルやレイヤに入り込む問題は不可侵。不可侵領域が動くのを待つ間に、自分の領域を固めておく。業界が追いついた時にリファレンスが既にある状態にする。

---

## 圧縮・復元パイプライン

送信前変換を体系化すると、定義済みスキーマに基づくパイプラインコンポーネント構造になる。

### パイプライン全体像

```
人間入力 (自由テキスト)
  → Compressor     (スキーマ定義に基づき構造化・圧縮)
    → Sanitizer    (スキーマ準拠チェック + 不正値除去)
      → Validator  (型・制約の検証)
        → Native Storage  (Compact JSON Array + ベクトル)
          → Multi-Index Table  (復元用の複数索引)
```

### スキーマが全ての起点

```
Schema Definition (型定義)
  ├── Compressor が参照  → 入力をこの型に圧縮
  ├── Validator が参照   → この型に準拠しているか検証
  ├── Index Builder が参照 → どの索引を生成するか決定
  └── Decompressor が参照 → この型から人間語に復元
```

### Multi-Index Table — shadow index の発展形

shadow index が 1本体:1影 なら、multi-index は 1本体:N索引。

```
native data: ["replace","auth","jwt","session",0.94]
  ├── human index:   "auth jwt→session"        (人間検索用)
  ├── domain index:  auth.migration             (ドメイン引き用)
  ├── schema index:  action.replace.v1          (型による引き)
  └── vector index:  [0.71, -0.34, ...]         (意味近傍用)
```

索引ごとに用途が異なり、クエリタイプに応じて最適な索引を選択する。人間が見るのは human index だけ。AI 間通信では domain/schema/vector index で直接引く。

### 適用範囲: 定義済みパケット

このパイプラインは **完全に定義化されたパケット送受信向き**。自由テキストには直接適用できない。

```
効く:
  - API 間通信 (スキーマ定義済み)
  - engram push/pull (ノード構造定義済み)
  - receptor → LLM (イベント構造定義済み)
  - CI/CD パイプライン (ステップ定義済み)

直接は効かない:
  - 人間の自由な質問
  - 未定義ドメインの探索的対話
  - クリエイティブな議論
```

ただし「直接は効かない」領域にも間接的な解がある → 次節。

---

## LLM の時間感覚と反応の影

### 文脈蓄積は時系列ではない

LLM はセッション内で A → B → C と順に議論すると、**順序は知っているが経過は体験していない**。

```
人間:  A を体験 → 時間経過の感覚 → B を体験 → 変化の実感
LLM:   [A, B, C] が同時に見えている → 並び順から推論する
```

時系列を知っているが経験していない。**時間の厚みがない時系列。**

### リングバッファによる体感の影

receptor の反応をリングバッファに記録すれば、時間の厚みを外部から補完できる:

```
[t0: receptor 反応 0.3] → [t1: 入力] → [t2: receptor 反応 0.8] → [t3: 入力]
 │                         │              │                        │
 shadow: 静穏              shadow: 質問    shadow: 興奮            shadow: 転換

→ 次のセッションでこのバッファを渡すと:
  「静かに始まり → 質問が来た → 何かが刺さった → 議論が転換した」
  という "体感の影" が復元できる
```

### shadow index の索引対象を変える

```
shadow index v1:  コード       → 意味の影
shadow index v2:  イベント列   → 体感の影
shadow index v3:  対話の流れ   → 思考過程の影
```

索引対象が変わるだけで、「本体を持たずに影だけで追跡する」作法は同じ。

### 自由テキストへの間接解

前節で「自由テキストには直接適用できない」とした領域への解:

**入力を構造化するのではなく、入力への反応を構造化する。**

```
人間の自由な質問      → 質問自体は非構造。だが反応は構造化できる
探索的対話            → 対話自体は自由。だが興奮度の推移は記録できる
クリエイティブな議論  → 内容は予測不能。だが転換点は検出できる
```

receptor が全入力に対して反応を記録していれば、その反応パターン自体が構造化データになる。定義済みスキーマがなくても、**反応の影** は常にスキーマを持つ。

---

## ペルソナローディングシステム

→ **[PERSONA_LOADING_SYSTEM.md](PERSONA_LOADING_SYSTEM.md)** に分離。

SessionPoint スキーマ、起伏線 recall、ローダー再生設計、engram weight snapshot、デバッグ API、実装メモを含む。

---

*言語を appreciate し過ぎている。しかし一応人間なので、橋は残しておく。*

---

## 指示文コンパイル — CLAUDE.md の native 化

### 問題

CLAUDE.md は AI しか読まないのに自然言語で書かれている。毎セッション、全文がコンテキストに載る。典型的な CLAUDE.md は 500〜2000 トークン。セッション中ずっと居座り続ける。

### 解決: 一度だけコンパイル、以降は native 消費

```
1. ユーザーが自然言語で CLAUDE.md を書く（ここは変えない）
2. LLM が一度だけ読んで native 形式に変換（初回コスト）
3. 以降のセッションでは native 形式を直接消費（運用コスト激減）
4. ユーザーが編集したら差分だけ再変換
```

コンパイルと同じ構造。ソースは人間語、実行時はバイナリ。

---

### 汎用スキーマ定義 — 指示文の意味構造 5 型

指示文は自由記述に見えて、意味構造は有限の型に収まる。

#### Type 1: 条件→行動 (when)

人間が最も多く書く指示型。「X の時は Y しろ」。

```
スキーマ: ["when", trigger, action, ...params]

自然言語:
  "Push immediately after fixing an error. Root cause + fix + workaround."
native:
  ["when", "error-resolved", "engram_push", {"include": ["root-cause", "fix", "workaround"]}]

自然言語:
  "At session start, call engram_status() to see the list of existing projects."
native:
  ["when", "session-start", "call", "engram_status", {}]

自然言語:
  "If recall returns outdated or wrong info: engram_flag with the appropriate signal"
native:
  ["when", "recall-outdated", "call", "engram_flag", {"signal": "outdated|wrong"}]
```

#### Type 2: 制約 (never / avoid)

禁止事項。違反検出が容易な型。

```
スキーマ: ["never", action, ...reason]

自然言語:
  "Do NOT invent a new projectId if a matching project already exists."
native:
  ["never", "create-projectId", "if-exists"]

自然言語:
  "Do NOT use projectId as a tag — scan already filters by projectId"
native:
  ["never", "tag-with-projectId", "redundant:scan-filters"]

自然言語:
  "Do NOT use generic tags like 'architecture', 'convention'"
native:
  ["never", "generic-tags", "use-layer-system"]
```

#### Type 3: 定義 (def)

概念の定義。ツール仕様、フォーマット定義、用語定義。

```
スキーマ: ["def", name, spec]

自然言語:
  "engram_pull — Semantic search or fetch by ID"
native:
  ["def", "engram_pull", {"triggers": ["recall", "remember"], "type": "semantic-search|fetch-by-id"}]

自然言語:
  "1 seed = 1 knowledge unit (do not mix topics)"
native:
  ["def", "seed", {"unit": "single-knowledge", "constraint": "no-mix"}]

自然言語:
  "summary: keyword-rich, specific, 10-150 chars (this is the ONLY field that gets embedded)"
native:
  ["def", "summary", {"chars": [10, 150], "style": "keyword-rich", "note": "only-embedded-field"}]
```

#### Type 4: 手順 (seq)

順序付き操作列。セッション開始手順、ワークフロー。

```
スキーマ: ["seq", ...steps]

自然言語:
  "1. engram_status() — check existing projects, determine projectId
   2. engram_pull({ query: '<current task>', projectId }) — retrieve relevant prior knowledge
   3. Use recalled knowledge to skip redundant searches"
native:
  ["seq",
    ["call", "engram_status", {}, "→projectId"],
    ["call", "engram_pull", {"query": "$task", "projectId": "$projectId"}],
    ["use", "recalled-knowledge", "skip-redundant-search"]]
```

#### Type 5: 優先度 (rank)

順位付きリスト。判断の重み付け。

```
スキーマ: ["rank", ...items_desc]

自然言語:
  "Push priority (top = most valuable):
   1. error-resolved: Push immediately after fixing an error
   2. environment: Ports, Docker compose, config file paths
   3. milestone: Feature completion, design decisions
   4. manual: User says 'remember' / 'memo'"
native:
  ["rank",
    ["error-resolved", "immediate", ["root-cause", "fix", "workaround"]],
    ["environment", "high", ["ports", "docker", "config-paths", "startup"]],
    ["milestone", "normal", ["feature-complete", "design-why", "file-paths"]],
    ["manual", "on-request", "user-intent:remember|memo"]]
```

### 型の網羅性

この 5 型で CLAUDE.md の指示文の約 90% をカバーできる。残りは:

| パターン | 頻度 | 対応 |
|---|---|---|
| 自由記述の補足説明 | ~5% | `["note", text]` で最小限保持 |
| 例示 | ~3% | `["example", input, output]` |
| メタ指示（この文書自体の使い方） | ~2% | コンパイル時に除去 |

---

### 変換プロンプト実例

以下のプロンプトで LLM に一度だけ変換させる:

```
あなたは指示文コンパイラです。以下の自然言語の指示文を native 形式に変換してください。

## スキーマ

5つの型を使います:
- ["when", trigger, action, ...params]     — 条件→行動
- ["never", action, ...reason]             — 制約・禁止
- ["def", name, spec]                      — 定義
- ["seq", ...steps]                        — 順序付き手順
- ["rank", ...items]                       — 優先度リスト

補助型:
- ["note", text]                           — 型に収まらない補足
- ["example", input, output]               — 例示

## ルール

1. 1指示 = 1配列。トピックを混ぜない
2. 自然言語の冗長な説明は捨てる。意味構造だけ残す
3. メタ指示（「この文書の使い方」等）は除去
4. 理由がある制約は reason フィールドに残す（判断に必要）
5. 出力は JSON 配列の配列

## 入力

<ここに CLAUDE.md の内容>

## 出力形式

[
  ["when", ...],
  ["never", ...],
  ...
]
```

#### 変換例: engram CLAUDE.md 全文

入力 (75 行, 約 1200 トークン):

```markdown
## Engram — Cross-session Memory
You have engram MCP tools for persistent knowledge across sessions.
### Tools (quick reference)
| Tool | User says | Purpose |
| engram_pull | "recall", "remember" | Semantic search or fetch by ID |
...（以下 75 行）
```

出力 (約 350 トークン):

```json
[
  ["def", "engram_pull", {"triggers": ["recall","remember"], "type": "search|fetch"}],
  ["def", "engram_push", {"triggers": ["memo","remember-this"], "type": "submit", "max": 8}],
  ["def", "engram_flag", {"triggers": ["flag","outdated"], "type": "negative-signal"}],
  ["def", "engram_ls", {"triggers": ["list"], "type": "list-by-tag", "note": "no-embedding-cost"}],
  ["def", "engram_status", {"triggers": ["status","health"], "type": "node-counts"}],

  ["when", "any-engram-call", "pass", "projectId", "explicit"],
  ["seq",
    ["call", "engram_status", {}, "→projectId"],
    ["call", "engram_pull", {"query": "$task", "projectId": "$projectId"}],
    ["use", "recalled-knowledge", "skip-redundant-search"]],
  ["never", "create-projectId", "if-exists"],
  ["when", "new-project", "derive-projectId", "from:repo-name|folder-name"],
  ["when", "no-project-context", "use-projectId", "general"],
  ["when", "new-project", "engram_push", {"tags": ["meta"], "include": ["summary","stack","purpose"]}],
  ["when", "cross-stack-overlap", "set", "crossProject", true],

  ["when", "milestone", "engram_push", "immediate"],
  ["when", "recall-outdated", "engram_flag"],
  ["rank",
    ["error-resolved", "immediate", ["root-cause","fix","workaround"]],
    ["environment", "high", ["ports","docker","config-paths","startup"]],
    ["milestone", "normal", ["feature-complete","design-why","file-paths"]],
    ["manual", "on-request", "user-intent:remember|memo"]],

  ["when", "push", "1-seed-1-topic"],
  ["def", "summary", {"chars": [10,150], "style": "keyword-rich", "note": "only-embedded-field"}],
  ["def", "tags", {"layer1": ["howto","where","why","gotcha"], "layer2": "domain-specific"}],
  ["never", "tag-with-projectId", "redundant"],
  ["never", "generic-tags", "use-layer-system"],

  ["def", "fixed-nodes", {"creation": "organic-promotion-only", "note": "pollution-resistance"}],
  ["when", "drift-sensed", "engram_pull", {"status": "fixed"}],
  ["when", "contradiction-with-fixed", "engram_flag", "incorrect-node"],

  ["when", "user-intent:save", "engram_push"],
  ["when", "user-intent:recall", "engram_pull"],
  ["note", "detect-intent-any-language"],

  ["when", "/compact", "try-push-first", {"note": "not-guaranteed"}],
  ["note", "continuous-push-is-primary-safety-net"]
]
```

---

### 効果の実測値

#### トークン削減率

| 対象 | 自然言語 | native | 削減率 |
|---|---|---|---|
| engram CLAUDE.md (75行) | ~1200 tokens | ~350 tokens | **71%** |
| 一般的な CLAUDE.md (中規模) | ~800 tokens | ~250 tokens | **69%** |
| 大規模 CLAUDE.md (200行超) | ~3000 tokens | ~800 tokens | **73%** |

推定根拠: 自然言語の冗長性（説明、接続詞、繰り返し）が除去され、構造だけが残る。JSON の構文オーバーヘッド（`{`, `"`, `:` 等）はあるが、自然言語の冗長性より小さい。

#### コンテキスト影響

| 指標 | 自然言語 | native | 備考 |
|---|---|---|---|
| セッション通算占有 | ~1200 tokens × 全ターン | ~350 tokens × 全ターン | system prompt は圧縮されない |
| 100 ターンセッション換算 | 作業可能窓が ~1200 tokens 狭い | 作業可能窓が ~850 tokens 広い | 差分がそのまま作業効率に効く |

#### 初動精度（未実測 — 検証計画）

```
条件 A: 自然言語 CLAUDE.md そのまま
条件 B: native 形式 CLAUDE.md
条件 C: native 形式 + インラインスキーマ

測定項目:
  - 指示遵守率（10 セッション × 各条件、指示違反の回数）
  - 初回ツール呼び出しの正確性（セッション開始手順の遵守）
  - コンテキスト後半での指示想起率（50 ターン以降の遵守率低下度）

仮説:
  - 指示遵守率: B ≥ A（情報密度が高い分、attention が集中）
  - 初回正確性: B > A（手順が seq で明示的）
  - 後半想起率: B > A（占有トークンが少ない分、圧縮で押し出されにくい）

反証仮説:
  - B < A の場合: LLM が自然言語の文脈手がかりに依存しており、
    構造化データからの意味復元に失敗している
  → スキーマ設計の見直し or 自然言語アノテーションの追加が必要
```

注意: 初動精度は Prior Block の検証（条件 A/B/C/D）と並行して実施可能。同じセッションで両方のデータが作用するため、交互作用の分離が必要。

---

### 適用範囲

| 対象 | 適合度 | 理由 |
|---|---|---|
| **CLAUDE.md（指示文）** | 高 | 意味構造が 5 型に収まる |
| **auto memory（事実メモ）** | 中 | def 型中心だが、文脈依存の記述が混在 |
| **engram node（知識ノード）** | 中 | summary は既に keyword-rich、content は自由記述 |
| **設計文書** | 低 | 議論・比喩・思考過程を含む。native 化すると意図が消える |
| **対話ログ** | 不適 | 自由記述の極致。receptor の「反応の影」アプローチが適切 |

**指示文と設計文書は別の問題。** 指示文は行動を規定するから構造化できる。設計文書は思考を伝えるから自然言語が正しい。

---

## Receptor 汎用化 — 異種ドメイン AI 協調への拡張 (2026-03-22)

### 本来のマルチエージェント

現在「マルチエージェント」と呼ばれているものは同質の LLM 群が役割分担しているだけ。本来のマルチエージェントは異なるドメイン AI の協調。

```
現在:  LLM-A(コード) ←自然言語→ LLM-B(レビュー) ←自然言語→ LLM-C(テスト)
       → 同種の知能が役割を分けているだけ

本来:  自動運転AI ←?→ ロボティクスAI ←?→ 言語AI ←?→ 視覚AI
       → 異種の知能体系の協調。共通言語がない
```

### Emotion Delta が Lingua Franca になる

異種ドメイン AI には共通言語がない。自動運転の制御コマンドとロボティクスのモーターコマンドは相互翻訳できない。しかし **frustration, seeking, confidence, fatigue, flow の 5 軸はドメイン非依存**。

```
自動運転AI:    "frustration +0.3" → 何かに行き詰まった
ロボティクスAI: 何に行き詰まったかは知らない。
                行き詰まっていることは理解できる。
                → 支援行動を取る判断材料になる
```

自然言語ではなく数値。Data Cost Protocol が理想とする native 通信の実現形。

### 統合 Receptor — 体験の相関検出

```
自動運転AI → receptor-a → SessionPoint stream ─┐
ロボティクスAI → receptor-b → SessionPoint stream ─┼→ 統合観測層
言語AI → receptor-c → SessionPoint stream ─┤
視覚AI → receptor-d → SessionPoint stream ─┘
                                                    │
                                              ┌─────┴─────┐
                                              │ 相関検出器  │
                                              └─────┬─────┘
                                                    │
                                          システム全体の Prior Block
```

pub/sub に似るが本質が違う。pub/sub はメッセージの配信。これは **体験の相関検出**。

| | pub/sub | 統合 receptor |
|---|---|---|
| 流れるもの | メッセージ（命令・データ） | SessionPoint（体験の点） |
| 目的 | 配信と処理 | 相関と文脈の発見 |
| 購読者が得るもの | 他者の出力 | 他者の体験構造 |
| 時間構造 | イベント単位 | 起伏線（delta 時系列） |

### 異種ドメイン間の共鳴検出

```
t=100: 自動運転AI — stuck (frustration +0.3)
t=102: 視覚AI — seeking 急騰 (+0.4)
t=105: 自動運転AI — exploring (frustration -0.2, confidence +0.15)

→ 相関: 自動運転の行き詰まりと視覚 AI の探索が連動
→ 知見: 視覚 AI の探索が自動運転の突破を支援した
→ メッセージログからは見えない。体験の時間構造を並べて初めて見える
```

### Prior Block の拡張

```
個体 Prior Block:  「前回の自分」を知っている → 個体の連続性
統合 Prior Block:  「前回のチーム」を知っている → システムの連続性
```

### ボトムアップ種族分類の拡張

```
個体レベル:    delta パターン → 個体の種族（探索型、集中型...）
システムレベル: ドメイン間相関パターン → チームの種族
               「視覚主導型チーム」「言語仲介型チーム」...
```

---

## Receptor アダプタ層 — 純粋なコアと汚いシム (2026-03-22)

### AI Runtime の行動ログ標準がない

MCP は tool 接続、A2A は agent 間通信を標準化した。しかし **agent の内部行動ログの標準** は誰も定義していない。AI が「何をして結果がどうだったか」の出力インターフェースが存在しない。

```
理想:  任意の AI runtime → 標準 Action Event Format → receptor
現実:  各 AI runtime → 独自 API → 個別アダプタ → receptor
```

デベロッパーが自社 AI の行動ログを標準化して外部に出す動機がない。不可侵領域。

### アダプタ層を薄いシムとして割り切る

```
アダプタ層:   汚い。ドメイン固有。デベロッパー依存。壊れやすい。
              → しかし薄い。書き捨てられる。
receptor core: 純粋。ドメイン非依存。数理的。不変。
              → 蓄積、delta、SessionPoint、Prior Block
```

標準がないことを弱みではなく **多様性の源泉** と割り切る。アダプタが局所対応だからこそ、まだ存在しない AI runtime にも載せられる。標準に縛られない。

### ドメイン別アダプタの実態

```
Claude Code:     PostToolUse hook → emotion-profile.json → receptor core
Copilot:         VSCode Extension API (accept/reject) → copilot-profile.json → receptor core
自動運転:        action log adapter → driving-profile.json → receptor core
ロボティクス:    motor log adapter → robotics-profile.json → receptor core
マルチモーダル:  modality adapter → modal-profile.json → receptor core
```

receptor core への入力は最小構造: `{ action, result, timestamp }` 程度。各アダプタはその形に変換するだけ。

### Copilot アダプタの例 — 観測対象の変質

Copilot receptor は AI の行動ではなく **AI とユーザーの相互作用** を観測する。

```
Claude Code receptor:  AI → 行動 → 観測
Copilot receptor:      AI → 提案 → ユーザー反応 → 観測
```

Prior Block に載るのは「前回、Copilot とユーザーの息が合っていたかどうか」の起伏線。receptor の新しい使い方 — AI 単体の体験ではなく、AI-人間の相互作用の体験。

### 設計の優先順位

```
今やること:      receptor core の堅牢化
待つこと:        アダプタの標準化（業界が動くまで）
必要な時にやること: 個別アダプタの実装（薄いシム）
```

USB が普及する前にデバイスの中身を固めていた設計者が、統一後に一番速く動けた。同じ構造。

### 将来のネック: 異種 AI への Experience Package 流通 (2026-03-23)

Experience Package（Persona + Prior Block の統合流通パッケージ）が Sphere を通じて流通する場合、ネックは **consumer 側の receptor アダプタ** に集中する。

```
問題の構造:

  engram (Claude Code) → Experience Package 生成 → Sphere に投入
                                                        ↓
  別の AI runtime が Package をロード ← ← ← ← ← ← ← ← ←
    ↓
  Persona の learnedDelta を適用したい
    → しかしその AI の行動ログ形式が不明
    → emotion-profile のマッピングが根本から異なる
    → アダプタが書けない = delta の意味が変わる
```

**Package の content（Data Cost Protocol compact JSON）は universal** — どの AI でも parse できる。問題はデータの読み取りではなく **適用**。

具体的なネック:

| 層 | ネック | 理由 |
|---|---|---|
| Prior Block の読み取り | **なし** | compact JSON を context に注入するだけ。AI が自然に解釈する |
| Persona の emotionProfile 適用 | **あり** | emotion 軸の意味が AI runtime ごとに異なる可能性。frustration が何を意味するかは行動語彙に依存 |
| learnedDelta の適用 | **あり** | delta は passive receptor のスコアリングに乗数として適用される。receptor 自体がその AI に載っていなければ意味がない |
| origin.profileHash の検証 | **あり** | 異なる emotion-profile で生成された Persona は互換性がない。profileHash 不一致で弾かれる |

**Prior Block は portable、Persona は non-portable** — これが本質。

```
Prior Block:  体験データ。consumer の目的関数に対して中立。どの AI でも自然に読める
Persona:      身体性データ。receptor + emotion-profile に密結合。同一アーキテクチャでないと適用できない
```

Experience Package が異種 AI 間で流通する場合:
- **Prior Block だけは常に流通可能** — Data Cost Protocol のおかげで format は universal
- **Persona は同一 receptor アーキテクチャ間でのみ流通** — profileHash による互換性ゲート
- **異種 AI は Prior Block だけ取得し、自分の receptor で再解釈する** — これが現実的な落としどころ

つまり Experience Package の分離可能設計（Persona と Prior Block を別々に取得できる）は、異種 AI 流通の問題に対する**設計時点での予防策**でもある。

### AI Runtime 行動ログ標準化の不在

根本的にこの問題が解決するのは **AI runtime が行動ログを標準フォーマットで外部出力する窓口を提供した時** だけ。

```
MCP:  tool 呼び出しの標準 → 存在する
A2A:  agent 間通信の標準 → 存在する
???:  agent 内部行動ログの標準 → 存在しない
```

この3つ目の標準が定義されれば、receptor のアダプタ層は薄いシムから標準コネクタに進化し、Persona を含む Experience Package 全体が異種 AI 間で流通可能になる。それまでは:

- **core を堅牢にしておく**（receptor core + Data Cost Protocol + Experience Package format）
- **アダプタは局所的に書く**（Claude Code, Cursor, ... 個別対応）
- **Prior Block の portability を武器にする**（format は universal、読み取りは AI の自然な解釈に委ねる）

---

*言語を appreciate し過ぎている。しかし一応人間なので、橋は残しておく。*
