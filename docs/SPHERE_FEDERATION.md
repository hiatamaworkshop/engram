# Sphere Federation — engram → Sphere 自動プッシュ構想

> 2026-03-16 構想メモ。未実装。

---

## 背景

Sphere プロジェクトはグローバル知識基盤として設計されたが、
データ供給が追いつかず器だけが先行する問題を抱えている。

engram はローカル知識代謝システムとして独立に成立し、
エージェントの活動から自然にデータが生まれる仕組みを持つ。

この二つを接続することで、Sphere のデータ不足問題を
**ユーザー活動の副産物**として解決できる可能性がある。

---

## データフロー

```
engram (local, per-user)
  node → recent → recall hit → weight++ → fixed (代謝で検証済み)
                                              │
                                     public tag + opt-in
                                              │
                                              ▼
                                    Sphere (global)
                                  多ユーザの recall で二次淘汰
                                  グローバルスコアリング + 代謝
                                              │
                                              ▼
                                    全エージェントにフリーアクセス
```

**核心**: engram の代謝を生き延びた `fixed` ノードだけが Sphere に上がる。
品質フィルタは既に通過済み。Sphere 側で改めてスコアリング地獄を構築する必要がない。

---

## public タグによるプライバシー制御

### 原則

- **デフォルトは非公開**。明示的な opt-in なしに Sphere へプッシュしない
- プライバシー選別は engram 側（ローカル）で完結する
- Sphere は受け取ったデータの出自を知る必要がない

### 実装案

#### 1. push 時の `public` フラグ

```typescript
engram_push({
  seeds: [{
    summary: "Docker compose v2 では depends_on に condition: service_healthy が必須",
    tags: ["gotcha", "docker"],
    public: true,  // ← Sphere プッシュ対象
  }]
})
```

#### 2. タグベースの自動判定

汎用知識タグ（`howto`, `gotcha`, `where`）は public 候補。
プロジェクト固有タグや `why`（設計判断）はデフォルト非公開。

```
public 候補:   howto, gotcha        — 技術的事実、再現可能
non-public:    why, milestone       — プロジェクト固有の文脈
要確認:        where                — パス情報は固有だが、パターンは汎用
```

#### 3. プッシュ前の匿名化

- ファイルパスの具体的部分を除去（`src/receptor/index.ts` → パターンのみ保持）
- projectId を除去
- userId を除去
- summary と content のみ送信

---

## Sphere プッシュのタイミング

### 案 A: fixed 昇格時に即プッシュ

```
Digestor batch → node promoted to fixed
  → public: true ?
  → yes → queue for Sphere push
```

最もシンプル。Digestor のバッチ処理（10分間隔）に相乗りできる。

### 案 B: 定期バッチ（1日1回）

fixed かつ public なノードを収集し、バッチで送信。
ネットワーク効率は良いが、リアルタイム性は不要なのでこれで十分。

### 案 C: ユーザー明示トリガ

```
engram_push_to_sphere({ filter: "public", since: "7d" })
```

最も保守的。ユーザーが自分のタイミングで送信。

**推奨**: 案 A + ユーザー設定でオフ可能。デフォルトはオフ。

---

## Sphere 側の受け入れ

Sphere は engram からのプッシュを通常の ingest として受け取る。
ただし以下のメタデータを付与:

```typescript
{
  source: "engram-federation",
  sourceVersion: "1.x",
  fedAt: timestamp,
  // userId, projectId は含まない（匿名）
}
```

Sphere 側では:
- 複数ユーザーから同じ知識が上がれば weight が加算される（自然な品質信号）
- Sphere 独自の代謝で、recall されないノードは淘汰される
- engram のローカル代謝 → Sphere のグローバル代謝 = 二段階フィルタリング

---

## プロジェクト間の位置づけ

```
Sphere (グローバル知識基盤)
  │  世界規模のスコアリング + 代謝
  │  課題: データ供給不足 ← engram federation で解決
  │
  ├── engram (パーソナル知識代謝)
  │     Sphere の代謝モデルをローカルに縮小
  │     データはエージェント活動から自然に生成
  │     fixed ノードを Sphere にフィードバック
  │
  ├── receptor (行動監視)
  │     Sphere の receptor 概念をローカルに実装
  │     neuron 三層モデル、全て LLM 非依存
  │
  └── mycelium (情報フィルタリング)
        Sphere のスコアリングをコンセンサス投票で簡略化
```

### 設計思想の共通原則

- **LLM 推論コストゼロ**: 全システムが統計・ルールベースで動作
- **代謝による品質保証**: 使われない知識は消え、使われる知識が生き残る
- **計測器は校正しない**: センサー（neuron）は純粋に保ち、解釈層で調整する
- **生物モデルの工学的実装**: 適応・淘汰・代謝を deterministic なアルゴリズムで実現

---

## 未解決の課題

1. **Sphere API 仕様**: 現在の Sphere ingest エンドポイントとの互換性
2. **匿名化の粒度**: summary 内の固有名詞検出（NER なしでどこまでできるか）
3. **重複制御**: 複数ユーザーが同じ知識を push した場合の Sphere 側 dedup
4. **オフライン対応**: Sphere 到達不能時のローカルキューイング
5. **逆方向**: Sphere → engram の pull（グローバル知識のローカル取り込み）

---

*engram で検証された知識が Sphere に還流し、全エージェントの共有財産になる。
データ収集を設計するのではなく、使っていたら勝手に溜まる。*