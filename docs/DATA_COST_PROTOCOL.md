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

## 適用対象 — LLM をパイプラインに組み込む全ての業界

DCP は engram の内部設計として生まれたが、本質は **LLM 間の中間表現** の問題を解いている。LLM を処理パイプラインに常駐させるシステムであれば、処理の手前にエンコーダレイヤを 1 枚噛ませるだけでコストが桁違いに変わる。

### 現状の無駄

```
典型的な LLM パイプライン:

  入力 → [LLM A] → 自然言語 → [LLM B] → 自然言語 → [LLM C] → 出力
                     ↑ 冗長        ↑ 冗長
                     翻訳エラー蓄積  コンテキスト汚染

各段で自然言語を介在させる理由: 「人間が途中を読めるように」
実態: 途中を読む人間はいない。デバッグ時に読みたいだけ。
```

### DCP 適用後

```
  入力 → encoder → [LLM A] → native → [LLM B] → native → [LLM C] → decoder → 出力
                               ↑ 1/5〜1/10          ↑ 位置固定
                               曖昧性ゼロ             翻訳エラーなし

encoder: 入口で 1 回だけ構造化（ルールベース or LLM ワンショット）
decoder: 出口で 1 回だけ人間語に戻す（必要な時だけ）
中間: schema ID + positional array で通信
```

### 対象ドメイン

| ドメイン | 現状 | DCP 適用 |
|---|---|---|
| **RAG パイプライン** | 検索→LLM要約→LLM回答（全段自然言語） | 検索結果を native で渡す。要約段を省略可能 |
| **マルチエージェント連鎖** | Agent A→自然言語→Agent B→自然言語→Agent C | schema + native で直通。ハンドシェイクで初回だけスキーマ交換 |
| **ログ・データ分析** | ログ→LLM構造化→LLM判定→アラート | 構造化済みデータを native で流す。LLM 判定のみに集中 |
| **コード生成・レビュー** | 設計書→LLM生成→LLMレビュー→LLM修正 | 差分を native で受け渡し。自然言語のレビューコメントは最終出力のみ |
| **カスタマーサポート** | チケット→LLM分類→LLMルーティング→LLM回答生成 | 分類・ルーティングは native。人間が読む回答だけ自然言語 |
| **データ変換・ETL** | 非構造データ→LLM抽出→LLM正規化→DB | 中間表現を native にすれば正規化段の精度が劇的に向上 |

### 導入パス

```
Step 0: 現行パイプラインのどの段で自然言語が流れているか可視化する
Step 1: 人間が読まない中間段を特定する（ほぼ全部）
Step 2: その段の入出力スキーマを定義する（DCP schema）
Step 3: encoder を入口に、decoder を出口に 1 枚ずつ置く
Step 4: 中間段を native 通信に切り替える

コスト削減は Step 4 の時点で実現する。
段階的移行が可能 — 1 段ずつ切り替えても効果がある。
```

### なぜ今か

LLM のトークン単価は下がっている。しかしパイプラインの **段数** は増えている。単価 × 段数 × 冗長度の積が問題であり、単価の低下より段数の増加のほうが速い。パイプラインが 3 段から 10 段になった時、各段の自然言語オーバーヘッドは線形に積み上がる。DCP はこの積を構造的に潰す。

---

## Escape Hatch — 非推奨経路と例外設計

DCP は段階的移行を前提とするが、**退行（上位レベルから下位レベルへの恒常的フォールバック）は非推奨** である。以下に許容される例外と、明示的に避けるべきパターンを記す。

### 許容される例外（一時的 escape hatch）

| 状況 | 許容される行動 | 条件 |
|---|---|---|
| **デバッグ時** | 全経路を一時的に human 経路に切り替える | 問題解決後に native に戻すこと |
| **新規スキーマ策定中** | 自然言語で試行錯誤し、固まったら native 化 | 探索フェーズに限定 |
| **consumer 能力が不明** | human 経路をデフォルトにし、能力判明後に切り替え | 能力判明後の切り替えを怠らないこと |
| **障害時の緊急ログ** | native + human 両方を同時出力 | 復旧後に human 側を停止すること |

### 非推奨パターン（anti-pattern）

| パターン | なぜ駄目か |
|---|---|
| **AI 間通信に自然言語を恒常的に使う** | DCP の存在意義の否定。コスト削減が得られない |
| **native 経路を「オプション」扱いにする** | 誰も移行しない。native をデフォルト、human をフォールバックにすべき |
| **監査のために常時 human 出力を並走させる** | 監査層の意味がなくなる。必要時のみ逆翻訳が原則 |
| **スキーマ未定義のまま native payload を流す** | 受信側が解釈できない。スキーマヘッダ (`$S`) 必須 |
| **逆翻訳結果を再保存する** | 自然言語 → native → 自然言語 → 再保存は劣化コピーの蓄積 |
| **escape hatch の常態化** | 一時的例外が恒常化したら設計を見直すシグナル |
| **⚠ `[..., ext?]` — 可変フィールドを許容する** | **最重要の非推奨。下記参照** |

### 最重要の非推奨: 可変データの許容

```
["replace", "auth", "jwt", "session", 0.94, ...ext?]
                                             ^^^^^^^
                                             これを許した瞬間、DCP は死ぬ
```

DCP の全設計は **位置が意味を持つ** ことに依存している。`field_count` でデータ境界を宣言し、`$S` ヘッダの `field_names` で各位置を解釈する。可変長の末尾フィールドはこの前提を破壊する。

**なぜ致命的か:**

| 影響 | 説明 |
|---|---|
| **スキーマヘッダが嘘になる** | `field_count: 5` と宣言して 7 フィールド来たら、ヘッダの信頼性がゼロになる |
| **パーサーが壊れる** | 次の行との境界が不明。ストリーミングで後続データが ext の一部か新しい行か判別不能 |
| **検証行 (`$V`) が無意味になる** | checksum の計算対象が不定。データ整合性の保証が消える |
| **アンカー密度の設計が崩壊する** | N行ごとリマインダーの前提は「行の構造が固定」。可変なら毎行フルスキーマが必要 → JSON に退行 |
| **Multi-Index Table が構築不能** | domain index, schema index は位置固定を前提にフィールドを引く。可変位置は索引できない |
| **consumer 間の解釈が分岐する** | ext を読める consumer と読めない consumer で同一データの意味が変わる |

**「でも拡張性が必要」への回答:**

```
✗ 可変フィールドで拡張する   → スキーマを壊す
✓ 新しいスキーマを定義する   → "$S" ヘッダで宣言すれば済む

  v1: ["$S", "auth-action", 5, "action","domain","from","to","confidence"]
  v2: ["$S", "auth-action-v2", 7, "action","domain","from","to","confidence","trigger","rollback"]

  v1 consumer は v1 スキーマだけ読む。v2 consumer は v2 を読む。
  混在しても "$S" で分離される。可変フィールドは一切不要。
```

スキーマのバージョニングが正解。**行の内部を可変にするのではなく、行の種類を増やす。** これは Protocol Buffers、Avro、全てのシリアライゼーションフォーマットが到達した同じ結論。

### 判断基準

```
escape hatch を使いたくなったら:
  1. 一時的か恒常的か？ → 恒常的なら設計の問題
  2. コスト増を正当化する理由があるか？ → 「楽だから」は理由にならない
  3. 復帰パスがあるか？ → native に戻す手順が明確でなければ使うな
```

escape hatch は **保険のための保険** であり、保険料（監査層）の代替ではない。常用した時点で DCP を採用していないのと同じ。

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

## DCP Validator — LLM に DCP を話させる教育動線

### encoder ではなく validator

```
✗ システムが encoder を持ち、自然言語を DCP に変換する
  → LLM は自然言語を出し続ける。成長しない。
  → マルチエージェント時代に通用しない（engram 以外の通信先に encoder はない）

✓ LLM 自身が DCP で出力し、システムは validator で準拠チェックする
  → phi-agent パターン: 出力モードを制限することで精度向上
  → LLM が DCP を話せるようになる。engram が教育の場。
```

LLM 常駐の encoder は DCP の思想に反する。**翻訳コスト削減のために翻訳コストを払う** 矛盾。

### validator の動作

```
engram_push 受信
  │
  ├── native フィールドあり？
  │   ├── YES → スキーマ準拠チェック
  │   │         ├── field_count 一致 → 保存
  │   │         └── 不一致 → 拒否 + エラー詳細返却
  │   │
  │   └── NO (自然言語のみ)
  │         → 警告返却: "DCP format expected"
  │         → (Phase 1) デフォルト変換して保存 + "auto-encoded" フラグ
  │         → (Phase 2) 拒否
  │
  └── スキーマ ID/hash あり？
      ├── 既知 → field_count 照合
      └── 未知 → 新規登録 or 拒否 (設定次第)
```

### push API の進化

```
Phase 1 — 後方互換 + 教育 (現在)
  push({
    summary: "auth jwt→session migration",   // 従来通り受け付ける
    content: "セキュリティ監査で指摘された",     // 従来通り
    tags: ["gotcha", "auth"]
  })
  → 保存される。ただし応答に警告:
    "⚠ DCP native format recommended. Include 'native' field."

Phase 2 — native 推奨
  push({
    native: ["replace","auth",{"from":"jwt","to":"session"},"trigger:security-audit"],
    schema: "action:v1",
    index: "auth jwt→session security-audit",
    tags: ["gotcha", "auth"]
  })
  → summary は index から自動生成。content (自然言語) は不要。
  → 自然言語のみの push は "auto-encoded" フラグ付きで保存。

Phase 3 — native 必須 + スキーマ参照
  push({
    native: ["replace","auth",{"from":"jwt","to":"session"},"trigger:security-audit"],
    schema: "action:v2",          // or schemaHash: "ab12cd34"
    index: "auth jwt→session",
    tags: ["gotcha", "auth"]
  })
  → 自然言語のみの push は拒否。
```

### decoder は表示層

decoder に設計判断はない。人間が見る時だけ動く薄い変換:

```
pull (queryType 省略 or "agent") → native そのまま返却
pull (queryType: "human")        → decoder(native + index) → 自然言語
```

現状の summary フィールドが既にこの役割を果たしている。native 化が進めば summary は index に置き換わり、decoder は index + native からテンプレート展開する。

### マルチエージェント時代への動線

```
今:     LLM → engram push (DCP) → validator → 保存
        = engram がDCPの教育環境

将来:   LLM-A → DCP packet → LLM-B
        = engram 不要。LLM 同士が直接 DCP で通信
        = engram で学んだ作法がそのまま汎用通信に使える
```

engram の validator は **補助輪** であり、最終的に外れる。LLM が DCP を自然に話せるようになれば、validator は形骸化し、スキーマレジストリだけが残る。

### スキーマレジストリ

```
gateway/schemas/
  knowledge.v1.json     ← engram ノード
  action.v1.json        ← 行動記録
  emotion.v1.json       ← 感情ベクトル
  prior-arc.v1.json     ← Prior Block arc point
  control.v1.json       ← 制御メッセージ
```

スキーマ参照の 2 方式:

| 方式 | 形式 | 向き |
|---|---|---|
| **ID + version** | `"action:v1"` | 閉じたシステム (engram 内部) |
| **hash** | `"ab12cd34"` (sha256 先頭 8 桁) | オープンなマルチエージェント通信 |

ハッシュ方式のハンドシェイク:

```
接続確立時:
  A → B: ["$S!", "ab12cd34", 11, "type","t","valence",...]  ← フル定義送信
  B:     hash → field_names を登録

以降の通信:
  A → B: ["$S", "ab12cd34"]                                  ← hash だけ
         ["A", 1200, 0.3, "stuck", ...]

B が hash を知らない場合:
  B → A: ["$S?", "ab12cd34"]                                 ← 要求
  A → B: ["$S!", "ab12cd34", 11, "type","t","valence",...]   ← 再送
```

TLS ハンドシェイク → セッションキーと同構造。重い交換は 1 回だけ。

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

### ストリーミングスキーマヘッダ — マルチスキーマ混在通信 (2026-03-23)

マルチエージェント環境では異なるスキーマのデータが同一ストリームに混在する。Prior Block と Live Fragment と制御メッセージが同じチャネルを流れる。

#### 問題

```
受信側: ["A", 1200, 0.3, "stuck", 0.42, ...] ← これは何のスキーマ？
```

単一スキーマなら先頭行のマニフェストで済む。複数スキーマが混在するとマニフェスト1行では足りない。

#### 解決: インラインスキーマヘッダ

```
["$S", "prior-arc", 11, "type","t","valence","state","intensity","fru","seek","conf","fati","flow","link"]
["A", 1200, 0.3, "stuck", 0.42, -0.1, 0.05, -0.2, 0.0, 0.0, null]
["A", 2400, 0.1, "exploring", 0.28, -0.05, 0.35, 0.1, -0.1, 0.0, "abc123"]
["$S", "live-frag", 6, "emotion","state","hotPath","entropy","ts","projectId"]
["L", [0.1, 0.3, 0.2, -0.1, 0.4], "exploring", "receptor/index.ts", 2.3, 1711234567, "engram"]
["$S", "control", 2, "command","target"]
["C", "pause", "receptor-B"]
```

#### スキーマヘッダの構造

```
["$S", schema_id, field_count, ...field_names]
```

- `"$S"`: スキーマ定義行のマーカー（データ行と区別）
- `schema_id`: スキーマの識別子（"prior-arc", "live-frag", "control" 等）
- `field_count`: 後続データ行のフィールド数（パーサーがデータ境界を知る）
- `...field_names`: 各位置の意味（LLM がスキーマを理解するため）

#### 受信側のパース

```
ストリーム受信:
  "$S" 行 → スキーマ登録（schema_id → field_names のマップに保持）
  データ行 → 先頭要素で schema_id を引き、field_names で解釈

LLM が受信する場合:
  "$S" 行を1回読めば、以降のデータ行を自然に解釈できる
  人間語の説明は不要 — field_names が十分な情報を持つ
```

#### 既知のプロトコルとの対応

これは新しい発明ではない。ネットワークプロトコルの基本作法の再適用:

| 既知の作法 | Data Cost Protocol 対応 |
|---|---|
| TCP ヘッダ（パケット長 + フラグ） | `["$S", id, field_count, ...]` |
| HTTP Content-Type | `schema_id` |
| Protocol Buffers .proto 定義 | `field_names` 列 |
| CSV ヘッダ行 | `...field_names` |
| TLV (Type-Length-Value) | `["$S"(type), field_count(length), data(value)]` |

50年前にネットワークエンジニアが解決した問題。AI 業界が自然言語に回帰して忘れていた作法を、AI-AI 通信に再適用しただけ。だからこそ堅い。

#### マルチエージェントでの活用

```
Brain AI が受信するストリーム:

  receptor A (コーディング):
    ["$S", "live-frag", 6, "emotion","state","hotPath","entropy","ts","projectId"]
    ["L", [...], "exploring", "receptor/index.ts", 2.3, 1711234567, "engram"]

  receptor B (テスト AI):
    ["$S", "live-frag", 6, "emotion","state","hotPath","entropy","ts","projectId"]
    ["L", [...], "stuck", "test/integration.ts", 1.8, 1711234570, "engram"]

スキーマが同じならヘッダは1回で済む。異なるスキーマが来たら新しい "$S" 行が先行する。
Brain AI は全ドメインのデータを同一フォーマットで受信し、emotion vector の相関でドメイン横断の判断を行う。
```

#### 設計原則

- **スキーマは送信側が宣言する** — 受信側は事前知識不要
- **ヘッダは必要な時だけ送る** — 同一スキーマのデータが続く間は省略可能
- **field_names は人間語に近い短い単語** — LLM の自然な理解と機械的 parse の両立
- **field_count でデータ境界を明示** — 可変長フィールドがあっても安全に parse 可能

#### アンカー密度のスペクトラム — consumer 能力に応じた適応 (2026-03-23)

JSON のキーは毎行付く「意味のアンカー」。冗長だが、どの行を単独で見ても意味が自己完結する。これは正当な価値であり、DCP はこれを否定しない — **頻度を最適化する**。

```
アンカー密度:

  JSON:        毎行 (最大密度)   → 冗長だが安全。人間向き
  DCP (標準):  1回 (最小密度)    → 最軽量。高性能 LLM 向き
  DCP (hybrid): N行ごと (可変)  → consumer の能力に合わせてダイヤルを回す
```

##### リマインダー付きストリーム（軽量モデル対応）

軽量モデルやコンテキスト窓が小さい consumer は、長いデータ列の途中でスキーマを見失う可能性がある。N 行ごとにスキーマヘッダを再送する:

```
["$S", "prior-arc", 11, "type","t","valence","state",...]
["A", 1200, 0.3, "stuck", 0.42, ...]
["A", 2400, 0.1, "exploring", 0.28, ...]
... 50行 ...
["$S", "prior-arc", 11, "type","t","valence","state",...]  ← リマインダー再送
["A", 5200, 0.2, "deep_work", 0.35, ...]
```

再送頻度はパラメータ化可能。consumer の能力に応じて調整する。

##### 検証行（出力の整合性確認）

受信側が「正しく受け取れたか」を確認するためのチェックサム行:

```
["$V", schema_id, row_count, checksum]
```

例:
```
["$V", "prior-arc", 102, "sha256:a3f8..."]
```

- `row_count`: このスキーマで送信されたデータ行数
- `checksum`: データ部分のハッシュ
- 受信側は自分の受信データと照合し、欠損や破損を検出

##### JSON との関係

JSON のアンカー毎行、DCP のヘッダ 1回、ハイブリッドの N行ごと — これらはアンカー密度のスペクトラム上の点にすぎない。原理は同じ「位置に意味を持たせ、スキーマで解釈する」。consumer の能力に合わせて密度を選ぶ。

```
人間:           毎行アンカー必須（忘れるから）
軽量 LLM:       50行ごとリマインダー（コンテキスト窓が小さいから）
高性能 LLM:     1回で十分（忘れないから）
機械パーサー:   0回でも可（スキーマを事前共有すればヘッダ不要）
```

#### 動的スキーマローディング — 階層データのコスト遅延評価 (2026-03-23)

##### 着想

データ形式が途中で変わるならば、必要なスキーマを必要なタイミングで送ればよい。`"$S"` ヘッダはそのための仕組みとして既に存在する。これをツリー構造に拡張すると、**階層データの段階的展開** が可能になる。

##### 具体例: Experience Package の遅延展開

```
# Level 0: パッケージ概要（常に送信）
["$S", "package", 3, "type", "label", "ref"]
["P", "exp: seeking/exploring 57m", "$child:persona"]
["P", "prior: 27 arc points", "$child:prior-arc"]

# ↑ ここまでで consumer はパッケージの全体像を知る
#   中身が必要になった時だけ展開要求 → 送信側が該当スキーマを送る

# Level 1a: persona（要求時のみ）
["$S", "persona", 8, "dominantAxis", "meanEmotion", "fieldAdj", "learnedDelta", ...]
["persona-data", ...]

# Level 1b: prior-arc（要求時のみ）
["$S", "prior-arc", 11, "type", "t", "valence", "state", ...]
["A", 1200, 0.3, "stuck", 0.42, ...]
["A", 2400, 0.1, "exploring", 0.28, ...]
```

consumer が persona だけ欲しければ prior-arc のスキーマもデータも送られない。コストは **アクセスするまで発生しない**。

##### `$child` 参照 — ツリーの分岐点

```
"$child:schema_id"
```

データ行内の `$child:` プレフィクスは「ここに子スキーマのデータがぶら下がる」マーカー。consumer がこのフィールドに「触れる」（展開を要求する）と、送信側が対応する `"$S"` + データを送信する。

```
ツリー構造:

  package
    ├── persona
    │     ├── emotionProfile
    │     └── learnedDelta
    └── prior-arc
          ├── header
          ├── arc-points
          └── footer
```

各ノードに固有のスキーマがあり、触れた時だけローディングされる。

##### 量子化との類似と差異

| 性質 | 量子化 | DCP 動的ローディング |
|---|---|---|
| 観測前の状態 | 複数の可能性が重なっている | データは存在するがスキーマ未送信 |
| 観測（アクセス） | 状態が確定する | スキーマが送信されデータが解釈可能になる |
| コスト | 観測に物理的コスト | アクセスにトークン/帯域コスト |
| 重ね合わせ | 連続的グラデーション | **不可** — 分岐は離散的 |
| ベクトル近傍 | 角度で意味が変わる | **不可** — ツリーは固定構造 |

完全な量子化ではない。しかし「コストの遅延評価」「必要な部分だけ展開する」という思想は共通する。REST API の lazy loading、OS の demand paging、データベースの遅延結合 — 同じ原理の、データフォーマットレベルでの適用。

##### 活用シナリオ

```
マルチエージェント:  Brain AI がパッケージ概要だけ受信 → 特定ドメインの prior-arc だけ展開
ストリーミング:      大規模データを段階的に処理 → 全体をロードせず必要部分だけ
Sphere ノード:       L2 (summary) で発見 → L3 (content) を展開 → 内部ツリーをさらに展開
```

Sphere の L1-L4 階層は既にこの思想を体現している。DCP 動的ローディングはそれをデータフォーマットの内部にまで再帰的に適用する。


---

## Interactive Schema — スキーマプリメソッドとハンドシェイク (2026-03-25)

### 着想

スキーマは静的な定義ではない。**操作可能なインターフェース** である。スキーマヘッダ `$S` にメソッドを持たせることで、エージェントとシステムの間にハンドシェイク（事前合意）の作法が生まれる。

TLS のハンドシェイクが暗号化通信の前提条件を確立するように、DCP のスキーマメソッドは構造化通信の前提条件を確立する。

### プリメソッド体系

```
$S?  — expand request     "このスキーマ知らない、定義を送ってくれ"
$S!  — schema declaration "このスキーマで送る" (フル定義をインラインで宣言)
$SV  — validate           "これ準拠してる？" (push 前に検証)
$S+  — corrected re-push  "修正版を送り直す" (validate 失敗後の再送)
```

### ハンドシェイクフロー

```
明示的ハンドシェイク（将来: エージェントがプリメソッドを能動使用）:

  agent → $SV(native, "knowledge:v1")
  system ← "field 3: type mismatch. $S:knowledge:v1 [action domain detail confidence:0-1]"
  agent → $S+(corrected native, "knowledge:v1")
  system ← accept + "$S:knowledge:v1#fcbc" (abbreviated)

  以降の push:
  agent → push(native, "knowledge:v1")
  system ← accept + "$S:knowledge:v1#fcbc" (abbreviated — 最小コスト)
```

```
暗黙ハンドシェイク（現在: push 自体がハンドシェイクを兼ねる）:

  agent → push(NL, no native)
  system ← accept + warn + "$S:knowledge:v1#fcbc [action(add|...) domain detail confidence:0-1]"
                            ↑ expanded hint: フィールド定義を含む
  agent → push(native, "knowledge:v1")
  system ← accept + "$S:knowledge:v1#fcbc"
                     ↑ abbreviated: ID+hash のみ

  2 回の push が暗黙のハンドシェイクとして機能する。
  1 回目で学習、2 回目で準拠。
```

### 4段階教育（コストグラデーション）

| Stage | トリガ | レスポンス | トークンコスト |
|-------|--------|-----------|--------------|
| **0: Silent** | native + schema あり、valid | abbreviated のみ: `$S:km:v1#fcbc` | ~10 tokens |
| **1: Abbreviated + fields** | native なし or invalid | expanded: `$S:km:v1#fcbc [action(...) domain detail confidence:0-1]` | ~30 tokens |
| **2: On-demand expand** | エージェントが `$S?` を送信 | フル定義（fields + types + examples） | ~80 tokens |
| **3: Forced expand** | 繰り返し非準拠（3回連続） | フル定義 + 再要求（疑似 reject） | ~100+ tokens |

**非準拠はコストが高い。** 準拠するほどレスポンスが軽くなる。これは自然な経済的インセンティブ — ペナルティではなく、準拠のコスト効率が良いだけ。

### abbreviated 形式

```
$S:knowledge:v1#fcbc [expand:GET /schemas/knowledge:v1]
│  │             │    │
│  schema ID     │    メソッド参照（能動的に展開可能）
│                │
│                4桁ハッシュ（スキーマ内容のフィンガープリント）
│
$S プレフィクス（DCP スキーママーカー）
```

- ~10 tokens でエージェントの context に常駐
- 「peripheral vision」— 中心視野を占有せず、必要な時に参照できる
- ハッシュでスキーマの変更を検出可能（ハッシュが変わったら再展開が必要）

### TLS との構造的類似

```
TLS ハンドシェイク:
  ClientHello → ServerHello + Certificate → ClientFinished → 暗号化通信
  初回は重い交換。以降は session ticket で軽量再開。

DCP スキーマハンドシェイク:
  push(NL) → warn + expanded → push(native) → abbreviated
  初回は教育コスト。以降は abbreviated (~10 tokens) で軽量維持。

TLS session ticket ≈ DCP abbreviated
  軽量トークンを毎回持ち歩く。フルハンドシェイクは必要な時だけ。
```

### 現在の実装状態

engram gateway に Stage 0 (abbreviated) と Stage 1 (expanded hint) を実装済み。push レスポンスの `schemaHint` フィールドとして返却される。MCP server がこれをエージェントの tool レスポンスに含め、recent context に注入する。

Stage 2 (`$S?` による能動展開) と Stage 3 (forced expand) は、エージェントがプリメソッドを自発的に使用する能力が成熟してから実装する。プロトコル定義は先行して確定しておく。

### エージェントの能動性について

現時点のエージェント（2026年3月）は `$S?` を自発的にトリガしない。レスポンスに URL があっても HTTP GET する動機を持たない。これは想定内。

```
短期（現在）:   暗黙ハンドシェイク — push 自体が教育サイクル
中期（予測）:   MCP tool として $S? を公開 — エージェントが tool 経由で展開要求
長期（理想）:   エージェントが $S? を HTTP で直接送信 — フル自律ハンドシェイク
```

プロトコル定義を先に置くことで、エージェントの能力が追いついた時に実装が待っている状態を作る。**インフラは使用者より先に存在すべき。**

### DCP の価値発生点 — LLM 境界のみ

DCP が実際にコスト削減を生む瞬間は、**データが LLM のコンテキストウィンドウに入る時** だけ。

```
保存時:   DCP でも NL でも大差ない（ストレージは安い）
流通時:   DCP でも NL でも機能する（LLM は両方読める）
LLM入力時: DCP が効く（トークンコスト × 呼び出し回数 = 桁違い）
```

したがって DCP を強制すべき境界は:

```
入口（LLM へ）:  encoder — NL メタデータを native に変換して LLM に渡す
出口（人間へ）:  decoder — native を自然言語に復元して人間に見せる
```

流通経路（DB 保存、HTTP 転送、エージェント間メッセージ）で DCP を強制する必要は **ない**。全経路 DCP を強制すると formatter/validator が増殖し、保守コストが設計利益を食う。

```
厳格路線: 全経路 DCP 強制 → 複雑 → 保守コスト大 → 効果は境界のみと同等
実用路線: LLM 境界だけ DCP → 単純 → 効果は同じ
```

例外: 数百万リクエスト/日のマルチエージェント通信など、パケット通信料自体が問題になる規模。これは最適化の判断であり、設計思想の問題ではない。

### AI → AI 通信の encoder 問題

LLM は DCP 入力を読めるが、DCP 出力を守るとは限らない。

```
LLM の入力:  スキーマ通りに解釈できる（読解力は十分）
LLM の出力:  スキーマ通りに書くとは限らない（遵守は不安定）
```

MCP 経由の通信は JSON Schema が tool 引数を型保証するため、この問題は発生しない。問題は MCP を通らない直接通信。

```
MCP 経由:       Agent → MCP tool(JSON Schema強制) → System → 型保証あり
直接通信:       Agent A → HTTP → Agent B → 型保証なし
```

直接通信には **DCP gateway（入口 validator + 出口 formatter + スキーマレジストリ）** をミドルウェアとして挟む。engram の gateway が既にこのプロトタイプになっている。

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

## DCP 通信作法 — MCP サービス間のスキーマ教育と参照

### 問題: LLM は初回セッションでスキーマを知らない

```
セッション A の LLM: スキーマを学習済み → DCP で正しく書ける
セッション B の LLM: 初見 → 推測で書く → validator に弾かれる → 1 回無駄になる
別クライアントの LLM: CLAUDE.md すら読まないかもしれない
```

LLM 側の記憶に依存する設計は脆い。**システムが教育する動線** を持つべき。

### 3 層教育モデル

```
Layer 1: tool description にスキーマを埋める（初回提示）
  → LLM は tool description を必ず読む。ここにあれば最初から正しく書ける
  → engram_push: "knowledge:v1 → [action:string(add|replace|...), domain, detail, confidence]"

Layer 2: reject body にスキーマ定義を含める（エラー時自己修正）
  → 初回提示を見逃しても、失敗から学習できる
  → { error: "action not in enum [...]", schema: { id, fields, types } }

Layer 3: GET /schemas エンドポイント（能動的参照）
  → LLM が自発的にスキーマを確認するフォールバック
  → GET /schemas → 一覧, GET /schemas/:id → 定義全体
```

Layer 1 が効けば Layer 2 は不要。Layer 2 が効けば Layer 3 は不要。冗長だが、どの層で学習しても結果は同じ。

### 表示系レスポンスの schema + body 形式

recall 等の read-only レスポンス:

```json
{
  "results": [
    { "native": ["fix","docker","port conflict",0.9], "schema": "knowledge:v1", "summary": "..." }
  ]
}
```

受信側の処理:

```
schema ID を知っている → native をそのまま解釈（最速）
schema ID を知らない   → summary にフォールバック（後方互換）
schema 定義が欲しい    → GET /schemas/:id で取得
```

**schema + body で問題は起こらない。** 既知なら直通、未知ならフォールバックが常にある。

### マルチエージェント間通信: スキーマ解決の問題

```
MCP server A → MCP server B に DCP で通信
A は "action:v3" を使用
B のレジストリには "action:v2" までしかない
```

スキーマ解決の戦略:

```
(a) 単一レジストリ参照
    B が A の gateway に GET /schemas/action:v3 を問い合わせる
    → gateway 同士がネットワーク到達可能な閉じたシステム向き
    → engram 内部はこれで十分

(b) ハンドシェイク方式（TLS と同構造）
    初回: A → B: ["$S!", "ab12cd34", 4, "action","domain","detail","confidence"]
    以降: A → B: ["$S", "ab12cd34"]  ← ID だけで通信
    不明: B → A: ["$S?", "ab12cd34"] ← "知らない、送ってくれ"
    → 初回だけ重い交換、以降は軽量参照
    → マルチエージェント・異種システム間向き

(c) 共有スキーマレジストリ（Sphere 層）
    全ノードが共通レジストリからスキーマを取得
    → マルチエージェント時代の最終形
    → Sphere federation で複数ノードが通信し始めた時に必要
```

### 段階的採用

```
Phase 1 (現在): 単一 gateway がスキーマの SSOT
  → engram 内部は (a) で完結
  → MCP server は gateway からスキーマを取得

Phase 2: ハンドシェイク方式 (b) の実装
  → Brain AI 構想で複数エージェントが通信し始めた時
  → $S! / $S? プロトコルをメッセージングレイヤーに実装

Phase 3: 共有レジストリ (c)
  → Sphere federation で異なる engram ノード間の通信
  → スキーマのバージョニングと互換性マトリクス
```

### 非推奨パターン

| パターン | なぜ駄目か |
|---|---|
| **LLM の記憶にスキーマ学習を依存する** | セッション境界で消失する。システムが教育すべき |
| **スキーマ定義なしで native を送る** | 受信側が解釈できない。schema ID 必須 |
| **エラーメッセージにスキーマを含めない** | LLM が自己修正できず、同じ失敗を繰り返す |
| **全スキーマをインラインで毎回送る** | トークンコストの浪費。ID 参照で十分 |
| **スキーマバージョンなしの ID** | 破壊的変更が検出できない。`name:vN` 形式必須 |

---

## ペルソナローディングシステム

→ [PERSONA_LOADING_SYSTEM.md](PERSONA_LOADING_SYSTEM.md) に分離。

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

## Receptor 汎用化・Brain AI 構想

→ [MULTI_AGENT_VISION.md](./MULTI_AGENT_VISION.md) に移植済み。
---

## Appendix: ベンチマーク — DCP vs JSON vs Natural Language

DCP compact array の実用的優位性を定量検証するベンチマークを実施した。同一の receptor 発火データを3形式で表現し、サイズ・パース速度・トークンコストを比較。

> 再現手順: `benchmarks/dcp-vs-json-vs-nl/` で `npx tsx bench.ts`

### データサイズ（10,000 records）

| Format | bytes/record | 対 DCP 比 |
|--------|-------------|-----------|
| DCP compact | 83 B | 1.00x |
| JSON (JSONL) | 182 B | 2.19x |
| Natural language | 223 B | 2.69x |

DCP は JSON の半分以下、自然言語の 1/3 弱。スケールに依存しない安定した比率。

### パース速度（10,000 records）

| Format | 時間 | μs/record | 対 DCP 比 |
|--------|------|-----------|-----------|
| DCP compact | 10.9 ms | 1.09 | 1.00x |
| JSON (JSONL) | 15.8 ms | 1.58 | 1.45x |
| Natural language | 26.6 ms | 2.66 | 2.44x |

NL の数値は制御テンプレートの regex パース。実運用の自然言語は LLM 推論が必要 — 桁が変わる。

### トークンコスト（LLM コンテキスト消費）

| Format | 10,000 records | 対 DCP 比 | $3/1M tokens |
|--------|---------------|-----------|--------------|
| DCP compact | ~207K tokens | 1.00x | $0.62 |
| JSON (JSONL) | ~455K tokens | 2.19x | $1.36 |
| Natural language | ~557K tokens | 2.69x | $1.67 |

### 決定的な差: パースの LLM コスト

DCP と JSON はゼロコストでパースできる（文字列操作のみ）。自然言語は構造化データを抽出するために LLM 推論が必要:

```
1,000 records のパースコスト:
  DCP/JSON: $0.0000（JSON.parse / 配列インデックス参照）
  NL:       $0.2163（Sonnet で入力+出力トークン消費）
```

AI-to-AI 通信において自然言語が最もコスト高い理由は、バイト数ではなく**パースに推論が必要**な点にある。

---

## 設計全体のまとめ — スキーマが DCP の背骨 (2026-03-24)

### DCP を一文で

**位置が意味を持つ配列 + スキーマ宣言 + consumer 能力に応じた適応。**

自然言語を運用インターフェースから追放し、監査インターフェースに限定する。

### スキーマの設計体系

DCP の全設計はスキーマに依存している。スキーマなしの DCP は存在しない。

#### 三層のスキーマ参照

| 層 | 参照方式 | 用途 | 交換コスト |
|---|---|---|---|
| **インライン** | `["$S", id, field_count, ...field_names]` | 初回通信、未知の相手 | 毎回フル定義 |
| **ID + version** | `"action:v2"` | 閉じたシステム内 (engram, 単一プロジェクト) | レジストリ事前共有 |
| **hash** | `"ab12cd34"` (sha256 先頭 8 桁) | オープンなマルチエージェント通信 | ハンドシェイク 1 回 |

下に行くほど軽量。上に行くほど自己記述的。

#### スキーマレジストリ

```
閉じたシステム (engram 内部):
  gateway/schemas/
    knowledge.v1.json
    action.v1.json
    emotion.v1.json
    prior-arc.v2.json
    control.v1.json
  → gateway 起動時にロード。ID で参照。

オープンシステム (マルチエージェント):
  ハンドシェイクで交換:
    A → B: ["$S!", "ab12cd34", 11, ...field_names]   ← フル定義 (1回)
    以降:   ["$S", "ab12cd34"]                         ← hash だけ (毎回)

  未知の hash:
    B → A: ["$S?", "ab12cd34"]                         ← 要求
    A → B: ["$S!", "ab12cd34", 11, ...field_names]     ← 再送
```

TLS ハンドシェイク → セッションキーと同構造。

#### バージョニング

```
✗ 可変フィールド [... ext?]    → スキーマを壊す (最重要の非推奨)
✓ 新スキーマ定義               → "$S" で宣言すれば済む

  v1: ["$S", "action:v1", 5, "action","domain","from","to","confidence"]
  v2: ["$S", "action:v2", 7, "action","domain","from","to","confidence","trigger","rollback"]
```

Protocol Buffers、Avro と同じ結論: 行の内部を可変にするのではなく、行の種類を増やす。

#### スキーマヘッダの制御記号体系

| 記号 | 意味 | 方向 |
|---|---|---|
| `$S` | スキーマ宣言 (短縮) | 送信側 → 受信側 |
| `$S!` | スキーマフル定義 | 送信側 → 受信側 |
| `$S?` | スキーマ要求 | 受信側 → 送信側 |
| `$V` | 検証行 (checksum) | 送信側 → 受信側 |
| `$child` | 子スキーマ参照 (遅延展開) | データ行内マーカー |

### LLM 教育動線としての engram

```
engram push → DCP validator → 準拠チェック
  │
  ├── native フィールドあり → スキーマ照合 → 保存
  └── 自然言語のみ → 警告 "DCP format expected"
                     → (Phase 1) auto-encode + フラグ
                     → (Phase 2) 拒否

= engram が DCP の教育環境
= LLM は engram を使ううちに DCP を話せるようになる
= マルチエージェント時代に engram なしでも DCP で通信できる
```

validator は **補助輪**。LLM が DCP を自然に話せるようになれば形骸化し、スキーマレジストリだけが残る。

### コスト構造の全体像

```
                    自然言語        DCP
保存コスト          高 (冗長)       低 (compact)
検索コスト          embedding 必須  native.vec or exact match
AI 消費コスト       LLM 翻訳必要   直通 (ゼロ)
人間閲覧コスト      ゼロ            decoder 必要 (必要時のみ)
コンテキスト汚染    深刻            最小
変換エラー累積      チェーンで増幅  ゼロ (native 直通)
────────────────────────────────────────────
総コスト            100%            ~2-5%
```

人間閲覧コストだけが DCP で増える。しかし閲覧頻度は全体の 1% 未満。

### 段階的レベル (再掲 + スキーマ対応)

| Level | 状態 | スキーマ参照 | 相対コスト |
|---|---|---|---|
| **L0** | 全て自然言語 | なし | 100% |
| **L1** | AI 間を構造化、人間面は維持 | インライン `$S` | ~30% |
| **L2** | summary 一行 + native | ID + version | ~10% |
| **L3** | 監査時のみ逆翻訳 | hash + ハンドシェイク | ~3% |
| **L4** | 完全 native | hash のみ (embedding が構造化入力対応後) | ~1% |

### 設計原則 (統合)

1. **スキーマが全ての起点** — スキーマなしの DCP は存在しない
2. **位置が意味を持つ** — 可変フィールドは最重要の非推奨
3. **人間語は監査インターフェース** — 運用インターフェースではない
4. **LLM が DCP を話す** — システムが翻訳するのではない
5. **consumer 能力で密度を調整** — アンカー密度のスペクトラム
6. **重い交換は 1 回だけ** — ハンドシェイク → 以降は軽量参照
7. **コストは遅延評価** — アクセスするまで発生しない ($child)
8. **後方互換が絶対条件** — 上位レベルは下位の経路を壊さない
9. **制約が効率を生む** — phi-agent パターン: 出力モードの制限が全体最適化

---

*言語を appreciate し過ぎている。しかし一応人間なので、橋は残しておく。*
