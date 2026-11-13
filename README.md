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
| update_recipe | 自分のレシピを改訂（変更理由が必須） | 必要 |
| fork_recipe | 自分や他人のレシピを元に、自分の版を公開 | 必要 |

検索結果には、各レシピに必要な道具と材料の id が付きます。持っている道具や調味料による絞り込みは、サーバーではなく利用者のエージェント側で行います（手順は様式の説明を参照）。

様式に合わない登録は、理由の一覧つきで断られます。AIはそれを読んで直し、送り直せます。

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
- **他の人にも書いてもらう場合**：その人用の鍵を作り、`WRITE_KEYS` に `"<鍵>":"その人の名前"` を足して `wrangler secret put WRITE_KEYS` し直す。

## 手元での試験

```bash
npm install
npm run check                                   # 様式の確認
cp .dev.vars.example .dev.vars                  # 試験用の設定
npm run db:init:local && npm run db:load:local
node test/mock-github.mjs &                     # GitHubのかわり（ファイルは test/out-* に出る）
npx wrangler dev &                              # http://localhost:8787
node test/scenario.mjs                          # 登録・改訂・フォーク・マスター・絞り込みの例など35項目
```

## 第1版でできないこと

- レシピの削除（意図的に用意していません。GitHubで直接消せば、次の写しで反映されます）
- 人間向けの見やすいWebページ（Markdownは `/recipes/<id>.md` で読めます）
- 鍵の発行は手作業（`WRITE_KEYS` に追記）

GitHub上でレシピのファイルを直接書き換えてもかまいません。様式の確認を通れば、D1にも写されます。
