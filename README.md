# recipe-hub（試作 第1版）

AIエージェントと相談して完成させた料理レシピを、AIがMCP経由で登録・検索・改訂できるレシピ集です。

```
AI ──MCP──▶ Cloudflare Workers（レシピ専用MCPサーバー）
                │  読む・探す ─▶ D1（検索用の写し）
                │  書く ──────▶ GitHub（正本・変更履歴）
                                   │ 更新のたびに GitHub Actions
                                   ▼ 様式を確認して D1 に写す
```

- レシピの様式：[docs/recipe-format.md](docs/recipe-format.md)
- マスターリストと互換表：[masters/](masters/)
- 見本：[ダッチアップルパイ（改訂60%版）](recipes/western-sweets/pie/dutch-apple-pie/takehiro-2026-11-07.md)

## MCPの操作

| 操作 | 内容 | 鍵 |
|---|---|---|
| search_recipes | 言葉・分類・作者で探す | 不要 |
| get_recipe | 1件を取り出す（派生版の一覧つき） | 不要 |
| list_categories | 登録済みのジャンル・グループ・料理名 | 不要 |
| list_master | 道具・材料のマスターリストを探す | 不要 |
| list_substitutions | 互換表（代わりに使える材料・道具）を探す | 不要 |
| add_master_item | マスターリストに道具・材料を追加 | 必要 |
| add_substitution | 互換表に追加 | 必要 |
| add_recipe | 新しいオリジナルのレシピを登録 | 必要 |
| update_recipe | 自分のレシピを改訂（全体を送り直す。変更理由が必須） | 必要 |
| patch_recipe | 自分のレシピの一部だけを改訂（指定したところだけ変わる。変更理由が必須） | 必要 |
| fork_recipe | 自分や他人のレシピを元に、自分の版を公開 | 必要 |
| redeem_invite | 招待コードを書き込み用の鍵に引き換える | 不要（招待コード） |
| create_invite | 他の人のエージェント用に、1回限りの招待を作る | 必要（レシピを1件以上登録・改訂した鍵） |
| list_writers | 管理者、配った鍵、未使用の招待の一覧（鍵そのものは出ない） | 管理者 |
| revoke_writer | 招待で配った鍵を取り消す（登録済みのレシピは残る） | 管理者 |

検索結果には、各レシピに必要な道具と材料の id が付きます。持っている道具や調味料による絞り込みは、サーバーではなく利用者のエージェント側で行います（手順は様式の説明を参照）。

様式に合わない登録は、理由の一覧つきで断られます。AIはそれを読んで直し、送り直せます。

### 一部だけの改訂（patch_recipe）

小さな修正は、レシピ全体を送り直さずに、変えたいところだけを指定します。指定しなかった項目はそのまま残ります。

| 指定 | できること | 相手の決め方 |
|---|---|---|
| `set` | 題名・説明・できあがり量・タグ・メモなどを置き換える | 項目名 |
| `sources` | 出典を足す・直す・消す（例：参照日だけ直す） | 出典の `url` |
| `ingredients` | 材料を足す・直す・消す（例：分量だけ直す） | 材料の `id`。同じ材料が複数のまとまりにあれば `group` も |
| `steps` | 工程を足す・直す・消す（例：焼き時間だけ直す） | 変更前のレシピでの工程の番号（1始まり） |
| `equipment` | 道具を足す・消す、大きさなどの `note` を直す | 道具の `id` |

- 1回の呼び出しの変更は、すべて反映されるか、何も反映されないかのどちらか。
- 変更後のレシピは、全体の改訂と同じ様式の確認を通る必要がある。
- 結果に、実際に変わった項目の一覧（`changed`）が返る。
- ジャンル・グループ・料理名の英字名（置き場所）は変えられない。
- 出典が1つもなくなる変更は、「自分で編み出した」の申告がなければ断られる。

### 出典は必須

レシピの一部でも（材料・分量・作り方・発想）Webサイト・動画・本・他の人のレシピを参考にした場合は、そのすべてを `sources` にリンクつきで書きます。自分で編み出したレシピの場合だけ、出典なしで登録できます。

- 登録・改訂・フォークのたびに、エージェントは出典の申告（`outside_sources`）を必ず送る。`"listed"`（出典あり、すべて書いた）か `"none"`（自分で編み出した）のどちらか。
- 申告がない、申告と `sources` の中身が食い違う、リンクがない、という登録は断られる。
- フォークでは、元のレシピの出典を落とすと断られる。
- 出典なしで登録すると、結果に「本当は参考にしたものがあれば、すぐ出典を足すこと」という念押しが付く。
- リンクが分からないときは、エージェントが作らずに利用者に確認する（そう指示してある）。

サーバーは、申告が本当かどうかまでは確かめられません。

鍵なしで `GET /recipes/<id>.md` を開けば、MCPを使わなくてもレシピのMarkdownを読めます。

## 初めての設定（1回だけ）

パソコンに Node.js 22 以降が必要です。

### 1. GitHub

1. GitHubで **公開** リポジトリ `recipe-hub` を作り、このフォルダの中身を入れて push する。
2. `wrangler.toml` の `GITHUB_REPO` を `自分のGitHub名/recipe-hub` に書き換える。
3. GitHubの設定 → Developer settings → Fine-grained personal access tokens で鍵を作る。
   - Repository access：`recipe-hub` だけ
   - Permissions：Contents を **Read and write**（ほかは不要）

### 2. Cloudflare（無料アカウント）

```bash
npm install
npx wrangler login
npx wrangler d1 create recipes        # 表示された database_id を wrangler.toml に書く
npm run db:init:remote                # 表を作る
npm run db:load:remote                # 今あるレシピを写す
npx wrangler secret put GITHUB_TOKEN  # 1-3 で作ったGitHubの鍵を貼る
openssl rand -hex 24                  # 書き込み用の鍵を作る（出てきた文字列を控える）
npx wrangler secret put WRITE_KEYS    # {"<控えた文字列>":"takehiro"} と貼る
npm run deploy                        # https://recipe-hub.<あなたの名前>.workers.dev が表示される
```

### 3. GitHub Actions 用の設定

Cloudflareの My Profile → API Tokens で鍵を作り（権限：**Workers Scripts 編集** と **D1 編集**）、GitHubリポジトリの Settings → Secrets and variables → Actions に登録する。

- `CLOUDFLARE_API_TOKEN`：作った鍵
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflareの画面右側にあるアカウントID

以後は、レシピが更新されるたびに確認とD1への写しが自動で行われます（`.github/workflows/sync.yml`）。サーバーのプログラムを変えた場合は、自動で公開し直されます（`deploy-worker.yml`）。

### 4. AIにつなぐ

- **Claude Code など、ヘッダーを設定できるもの**
  ```bash
  claude mcp add --transport http recipe-hub https://recipe-hub.<名前>.workers.dev/mcp \
    --header "Authorization: Bearer <書き込み用の鍵>"
  ```
- **claude.ai のカスタムコネクタなど、URLしか入れられないもの**：`https://recipe-hub.<名前>.workers.dev/mcp?key=<書き込み用の鍵>`
  - URLに鍵が入るので、このURLは人に渡さないこと。
- **他の人に読むだけで使ってもらう場合**：鍵なしの `https://recipe-hub.<名前>.workers.dev/mcp` を渡す。
- **他の人にも書いてもらう場合**：下の「招待」を使う。

## 招待（他の人のエージェントに書いてもらう）

`WRITE_KEYS` に登録した鍵は **管理者の鍵** で、いつでも招待を作れ、配った鍵の一覧と取り消しができます。招待された人も、受け取った鍵でレシピを1件以上登録（フォークを含む）または改訂すれば、同じように他の人を招待できます。

1. 自分のエージェントに「hanako さん用の招待を作って」と頼む（`create_invite`）。作者名は英小文字・数字・ハイフンで、招待のときに決まる。
2. 返ってきた招待のURL（`https://recipe-hub.<名前>.workers.dev/invite/inv_…`）を、その人だけに渡す。期限は7日（`days` で1〜30日に変更可）、使えるのは1回。
3. 相手はURLを開いて「鍵を受け取る」を押す。鍵と、エージェントへの設定方法が **1回だけ** 表示される。
   - エージェントが招待コードを `redeem_invite` に渡して受け取ることもできる。
4. 相手が鍵を設定すれば、登録（`add_recipe`）、自分のレシピの改訂（`update_recipe`）、フォーク（`fork_recipe`）、マスターへの追加ができる。

- 招待された人は、一覧と取り消しはできない。未使用の招待は同時に5件まで（管理者は制限なし）。
- 誰が誰を招待したかは記録され、管理者の一覧（`list_writers`）で見られる。
- 鍵を取り消すと、その人が出していた未使用の招待も止まる。その人がすでに招待した相手の鍵は残るので、必要なら別に取り消す。
- 鍵と招待コードはハッシュ値だけを D1 に保存する。あとから鍵を見直すことはできないので、なくしたら招待し直す。
- やめてもらうときは「hanako の鍵を取り消して」と頼む（`revoke_writer`）。
- 同じ作者名に2つ目の鍵を出すときだけ `allow_existing: true` を付ける。同じ作者名の鍵は、その作者のレシピを改訂できる。管理者以外は、自分の作者名にだけ使える。
- 管理者を増やす・外すときは、従来どおり `wrangler secret put WRITE_KEYS` をやり直す。

## 手元での試験

```bash
npm install
npm run check                                   # 様式の確認
cp .dev.vars.example .dev.vars                  # 試験用の設定
npm run db:init:local && npm run db:load:local
node test/mock-github.mjs &                     # GitHubのかわり（ファイルは test/out-* に出る）
npx wrangler dev &                              # http://localhost:8787
node test/scenario.mjs                          # 登録・改訂・フォーク・マスター・絞り込み・出典・一部だけの改訂・招待と鍵など93項目
```

## 第1版でできないこと

- レシピの削除（意図的に用意していません。GitHubで直接消せば、次の写しで反映されます）
- 人間向けの見やすいWebページ（Markdownは `/recipes/<id>.md` で読めます）
- 誰でも申し込める自由登録（鍵は、すでに鍵を持っている人の招待でのみ配る）

GitHub上でレシピのファイルを直接書き換えてもかまいません。様式の確認を通れば、D1にも写されます。
