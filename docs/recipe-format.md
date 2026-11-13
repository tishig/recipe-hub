# レシピの様式（第2版）

1つのレシピは1つのMarkdownファイルです。ファイルの先頭の `---` で囲んだ部分に、機械が読むための項目（YAML形式）を書き、その下に人間向けのメモを自由に書きます。

## 置き場所とファイル名

```
recipes/<料理ジャンル>/<料理グループ>/<料理名>/<作者>-<作成日>[-番号].md
```

- フォルダ名は英小文字・数字・ハイフンのみ（例：`western-sweets/pie/dutch-apple-pie`）。日本語名はファイルの中の `*_name` 項目に書く。
- 同じ料理名のレシピは何件あってもよい。同じ作者・同じ日に複数作ると `-2`, `-3` が付く。
- 置き場所とファイル名はMCPサーバーが決める。AIが直接指定することはできない。

## 項目

| 項目 | 必須 | 内容 |
|---|---|---|
| id | ○ | 置き場所から `.md` を除いたもの。サーバーが付ける |
| title | ○ | 表示用の名前（例：ダッチアップルパイ（改訂60%版）） |
| genre / genre_name | ○ | 料理ジャンルの英字名／日本語名 |
| group / group_name | ○ | 料理グループの英字名／日本語名 |
| dish / dish_name | ○ | 料理名の英字名／日本語名 |
| author | ○ | 作者。サーバーが付ける |
| created / updated | ○ | 作成日／更新日（YYYY-MM-DD）。サーバーが付ける |
| status | ○ | 今は `published`（公開）のみ。サーバーが付ける |
| summary |  | ひとことの説明 |
| yield | ○ | できあがり量。`amount`（数値）、`unit`（人分・台・個など）、`note` |
| derived_from | ○ | 元にしたレシピ。元がなければ `null`。サーバーが付ける |
| sources | ○ | 外部の出典の一覧。外から情報を取ってきた場合は必須。各要素に `name`、`url`、`accessed`（参照日） |
| tags |  | 検索用の言葉 |
| equipment | ○ | 使う道具の一覧。各要素に `id`（道具のマスターリストの id）と `note`（大きさなど） |
| ingredients | ○ | 材料のまとまり（後述） |
| steps | ○ | 工程（後述） |

### 材料（ingredients）

まとまり（`group`：パイ生地、フィリングなど）ごとに `items` を並べます。

| 項目 | 必須 | 内容 |
|---|---|---|
| id | ○ | 材料のマスターリストの id |
| name | ○ | このレシピでの表示名。登録時に省略すると、マスターの日本語名が入る |
| amount | ○※ | 数値のみ（分数は小数で。小さじ1/4 → 0.25） |
| unit | ○ | 下の単位の一覧から選ぶ |
| approx_g |  | 計量スプーンなどで量る材料の、おおよその重さ（g） |
| original |  | 元の表記（例：`"3 lb"`） |
| optional |  | 省略できる材料なら `true` |
| note |  | 補足 |

※ 単位が `少々`・`適量` のときだけ `amount` を省略できる。

**使える単位**：g, kg, mL, L, tsp（小さじ）, tbsp（大さじ）, cup, 個, 枚, 本, 片, 束, 株, 粒, 切れ, 尾, 杯, 少々, 適量, pinch

### 工程（steps）

| 項目 | 必須 | 内容 |
|---|---|---|
| title | ○ | 短い見出し |
| text | ○ | やること |
| minutes |  | かかる時間（分） |
| minutes_min / minutes_max |  | 時間に幅があるとき（例：25〜35分） |
| oven_c |  | オーブンの温度（℃） |
| heat |  | 火加減（弱火・中火・強火など） |
| temp_c |  | 油や液体の温度（℃） |
| equipment |  | この工程で使う道具の id（レシピの equipment に含まれるもの） |

- 温度と時間は本文に書くだけでなく、必ずこれらの項目にも入れる。ロボットはこちらを読む。
- `oven_c`・`heat`・`temp_c` のある工程は、`equipment` に加熱機器（category が heat-source の道具）を必ず入れる。持っていない家庭で、その工程を外したり置き換えたりするため。

## 元にしたレシピとの関係（derived_from）

既存のレシピ（自分のものでも他人のものでも）を写して自分の版を作るときは、`fork_recipe` を使います。元レシピへのリンクと元の作者がサーバーによって付けられます。

```yaml
derived_from:
  id: western-sweets/pie/dutch-apple-pie/someone-2026-10-01
  author: someone
  relation: fork
  note: 元レシピの60%量
```

- 既存のレシピを元にするときは、必ず `fork_recipe` を使う。`add_recipe` で写して新規登録してはいけない。
- 自分のレシピの改良は `update_recipe`。前の版はGitHubの変更履歴に残るので、いつでも戻せる。
- 試しに作る段階の内容は、使っているAIの記憶やメモで持つ（このレシピ集には完成したものを登録する）。

## マスターリスト（道具と材料の正式な一覧）

| ファイル | 中身 |
|---|---|
| `masters/equipment.yaml` | 道具。`provides` はその道具が兼ねる道具（オーブンレンジ → オーブン、電子レンジ） |
| `masters/ingredients.yaml` | 材料。`parent` はより広い分類の材料（無塩バター → バター） |
| `masters/substitutions.yaml` | 互換表。`from` の代わりに `to` を使える。`both: true` なら逆向きも可。`ratio` は from 1 に対する to の量 |

各項目には `id`（英小文字・数字・ハイフン）、`name_ja`、`name_en`、`category`、必要なら `aliases`（別名）を書きます。

- **道具の分類**：heat-source（加熱機器）、cookware（鍋類）、bakeware（焼き型）、tool（道具）、appliance（電動の道具）、storage（冷蔵庫など）、consumable（アルミホイルなど）
- **材料の分類**：vegetable、fruit、meat、seafood、dairy-egg、grain-flour、sugar-sweetener、seasoning、spice-herb、oil-fat、other

レシピで使う道具と材料は、必ずこの一覧から選びます。一覧にないものは、エージェントが `add_master_item` で追加してから使います。名前や別名が既存の項目と同じものは、二重登録にならないよう断られます。

## 作れるレシピの絞り込み（利用者側で行う）

持っている道具や調味料の情報はサーバーに送りません。次の流れで、利用者のエージェントが手元で絞り込みます。

1. `search_recipes` で探す。結果の各レシピに、必要な道具と材料の id（`needs`）が付いている。
2. 持っている道具を `provides` で広げる（オーブンレンジを持っていれば、オーブンと電子レンジも持っているとみなす）。材料も同じように `parent` で照らし合わせる。
3. 足りないものは `list_substitutions` で代わりを探す。
4. 代わりもないレシピを外す。代わりで作れるものは、互換表の `note` に沿って手順を直して見せる。
