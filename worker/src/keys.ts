// 書き込み用の鍵と招待
// - 管理者の鍵: 秘密の値 WRITE_KEYS（{"<鍵>": "<作者名>"}）。全員の鍵と招待を見られ、取り消せる。
// - 招待で配る鍵: D1 の write_keys。ハッシュ値だけを保存し、鍵そのものは発行時に1回だけ返す。
//   鍵を受け取って接続できた人は、自分でも他の人を招待できる。見られる・取り消せるのは自分が招待した相手だけ。
import { ToolError, type Env } from "./tools.ts";

export interface Writer { author: string; admin: boolean }

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;
const MAX_PENDING = 5; // 管理者以外が同時に出しておける未使用の招待の数

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(prefix: string, bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return prefix + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function admins(env: Env): Record<string, string> {
  try { return JSON.parse(env.WRITE_KEYS || "{}") as Record<string, string>; } catch { return {}; }
}

// 鍵から書き手を引く。知らない鍵・取り消された鍵は null
export async function resolveWriter(env: Env, key: string | null): Promise<Writer | null> {
  if (!key) return null;
  const map = admins(env);
  if (Object.prototype.hasOwnProperty.call(map, key)) return { author: map[key], admin: true };
  try {
    const row = await env.DB.prepare("SELECT author FROM write_keys WHERE key_hash = ? AND revoked IS NULL")
      .bind(await sha256(key)).first<{ author: string }>();
    return row ? { author: row.author, admin: false } : null;
  } catch {
    return null; // 表がまだ無い（プログラムの公開が表の作成より先になった）場合など
  }
}

function requireWriter(writer: Writer | null): Writer {
  if (!writer) throw new ToolError("この操作には書き込み用の鍵が必要です。招待コードがあれば redeem_invite で鍵を受け取れます");
  return writer;
}

async function nameInUse(env: Env, author: string, now: string): Promise<string | null> {
  if (Object.values(admins(env)).includes(author)) return "管理者の名前です";
  const key = await env.DB.prepare("SELECT 1 FROM write_keys WHERE author = ? AND revoked IS NULL LIMIT 1").bind(author).first();
  if (key) return "すでに鍵を持っている人の名前です";
  const inv = await env.DB.prepare("SELECT 1 FROM invites WHERE author = ? AND used IS NULL AND expires > ? LIMIT 1").bind(author, now).first();
  if (inv) return "未使用の招待がすでにあります";
  const rec = await env.DB.prepare("SELECT 1 FROM recipes WHERE author = ? LIMIT 1").bind(author).first();
  if (rec) return "すでにレシピを登録している作者の名前です";
  return null;
}

export async function createInvite(env: Env, a: any, writer: Writer | null, origin: string) {
  const me = requireWriter(writer);
  const author = a.author;
  if (typeof author !== "string" || !SLUG.test(author) || author.length > 30) {
    throw new ToolError("author は英小文字・数字・ハイフンのみ、30文字まで（例: hanako）");
  }
  const days = a.days ?? DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new ToolError(`days は 1〜${MAX_DAYS} の整数`);
  const now = new Date();
  if (a.allow_existing) {
    // 他人の作者名の鍵を作れると、その人のレシピを書き換えられてしまう
    if (!me.admin && author !== me.author) throw new ToolError("allow_existing で招待できるのは自分の作者名だけです（自分の別のエージェント用）");
  } else {
    const why = await nameInUse(env, author, now.toISOString());
    if (why) {
      throw new ToolError(`"${author}" は${why}。別の名前にしてください。同じ人の別のエージェント用なら allow_existing: true を付けます（同じ作者名の鍵は、その作者のレシピを改訂できます。管理者以外は自分の作者名のみ）`);
    }
  }
  if (!me.admin) {
    const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND used IS NULL AND expires > ?")
      .bind(me.author, now.toISOString()).first<{ n: number }>();
    if ((pending?.n ?? 0) >= MAX_PENDING) throw new ToolError(`未使用の招待は同時に${MAX_PENDING}件までです。使われるか期限が切れるのを待つか、revoke_writer で取り消してください`);
  }
  const code = randomToken("inv_", 16);
  const expires = new Date(now.getTime() + days * 86400_000).toISOString();
  await env.DB.prepare("INSERT INTO invites (code_hash, author, created_by, created, expires) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256(code), author, me.author, now.toISOString(), expires).run();
  return {
    author, invite_code: code, invite_url: `${origin}/invite/${code}`, expires,
    how_to_share: "Give the invite_url (or the invite_code) to the invited person only. It works once. They open the URL in a browser to receive their write key and setup steps, or their agent calls redeem_invite with the code.",
  };
}

function connectHelp(origin: string, key: string) {
  return {
    mcp_url: `${origin}/mcp`,
    header: `Authorization: Bearer ${key}`,
    claude_code: `claude mcp add --transport http recipe-hub ${origin}/mcp --header "Authorization: Bearer ${key}"`,
    url_only_clients: `${origin}/mcp?key=${key}`,
  };
}

export async function redeemInvite(env: Env, a: any, origin: string) {
  const code = typeof a.code === "string" ? a.code.trim() : "";
  if (!code) throw new ToolError("招待コード（code）が必要です");
  const codeHash = await sha256(code);
  const now = new Date().toISOString();
  const inv = await env.DB.prepare("SELECT author, created_by, expires, used FROM invites WHERE code_hash = ?")
    .bind(codeHash).first<{ author: string; created_by: string; expires: string; used: string | null }>();
  if (!inv) throw new ToolError("この招待コードは見つかりません");
  if (inv.used) throw new ToolError("この招待コードはすでに使われています。鍵をなくした場合は、招待した人に新しい招待を頼んでください");
  if (inv.expires <= now) throw new ToolError("この招待コードは期限が切れています。招待した人に新しい招待を頼んでください");

  const key = randomToken("rh_", 24);
  // 鍵の登録と招待の使用済み化を1回の取引で行う（同時に2回使われても鍵は1つだけ）
  const [ins] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO write_keys (key_hash, author, created, invited_by)
       SELECT ?, author, ?, created_by FROM invites WHERE code_hash = ? AND used IS NULL AND expires > ?`,
    ).bind(await sha256(key), now, codeHash, now),
    env.DB.prepare("UPDATE invites SET used = ? WHERE code_hash = ? AND used IS NULL").bind(now, codeHash),
  ]);
  if (!ins.meta.changes) throw new ToolError("この招待コードはすでに使われています");
  return {
    author: inv.author, write_key: key, connect: connectHelp(origin, key),
    next_steps: "This key is shown only once. Tell the user to reconnect this MCP server with the key (see 'connect'), then writing works. Once connected, they can also invite other people with create_invite. The key lets anyone write as this author: do not share it or store it in a public place.",
  };
}

// 管理者は全員分、それ以外は自分が招待した分だけ
export async function listWriters(env: Env, writer: Writer | null) {
  const me = requireWriter(writer);
  const now = new Date().toISOString();
  const keys = await env.DB.prepare(
    `SELECT author, created, invited_by, revoked FROM write_keys ${me.admin ? "" : "WHERE invited_by = ?"} ORDER BY created`,
  ).bind(...(me.admin ? [] : [me.author])).all<{ author: string; created: string; invited_by: string; revoked: string | null }>();
  const invites = await env.DB.prepare(
    `SELECT author, created_by, created, expires FROM invites WHERE used IS NULL AND expires > ? ${me.admin ? "" : "AND created_by = ?"} ORDER BY created`,
  ).bind(now, ...(me.admin ? [] : [me.author])).all();
  return {
    scope: me.admin ? "all" : "invited by you",
    ...(me.admin ? { admins: [...new Set(Object.values(admins(env)))] } : {}),
    writers: keys.results.map((k) => ({ ...k, active: !k.revoked })),
    pending_invites: invites.results,
  };
}

// 管理者は誰でも、それ以外は自分が招待した相手だけ取り消せる
export async function revokeWriter(env: Env, a: any, writer: Writer | null) {
  const me = requireWriter(writer);
  const author = a.author;
  if (typeof author !== "string" || !author) throw new ToolError("author が必要です");
  const now = new Date().toISOString();
  const mine = me.admin ? "" : " AND invited_by = ?";
  const mineInv = me.admin ? "" : " AND created_by = ?";
  const who = me.admin ? [] : [me.author];
  const isAdmin = Object.values(admins(env)).includes(author);
  const [keys, invites, theirs] = await env.DB.batch([
    env.DB.prepare(`UPDATE write_keys SET revoked = ? WHERE author = ? AND revoked IS NULL${mine}`).bind(now, author, ...who),
    env.DB.prepare(`DELETE FROM invites WHERE author = ? AND used IS NULL${mineInv}`).bind(author, ...who),
    // 有効な鍵が1つも残らない人が出していた未使用の招待も止める
    env.DB.prepare(
      `DELETE FROM invites WHERE created_by = ? AND used IS NULL AND ? = 0
       AND NOT EXISTS (SELECT 1 FROM write_keys WHERE author = ? AND revoked IS NULL)`,
    ).bind(author, isAdmin ? 1 : 0, author),
  ]);
  if (!keys.meta.changes && !invites.meta.changes) {
    throw new ToolError(isAdmin
      ? `"${author}" は管理者です。管理者の鍵は秘密の値 WRITE_KEYS から外して取り消します`
      : me.admin ? `"${author}" の有効な鍵や未使用の招待はありません`
      : `あなたが招待した相手の中に "${author}" の有効な鍵や未使用の招待はありません（取り消せるのは自分が招待した相手だけです）`);
  }
  return {
    author, revoked_keys: keys.meta.changes, cancelled_invites: invites.meta.changes + theirs.meta.changes,
    note: "Recipes already published by this author stay as they are. Keys of people this author had already invited stay valid; revoke them separately if needed.",
  };
}

// ---------- 招待を受け取るWebページ（GET /invite/<コード> で確認、POST で鍵を受け取る） ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.7;color:#222;background:#fafafa}
code,pre{background:#eee;border-radius:4px;font-size:.9rem}code{padding:.1rem .3rem}
pre{padding:.75rem;white-space:pre-wrap;word-break:break-all}
button{font-size:1rem;padding:.6rem 1.2rem;border:0;border-radius:6px;background:#2a6;color:#fff;cursor:pointer}
.warn{background:#fff4d6;border-radius:6px;padding:.75rem}
@media (prefers-color-scheme:dark){body{color:#eee;background:#1b1b1b}code,pre{background:#333}.warn{background:#4a3c10}}
</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

export async function invitePage(env: Env, req: Request, code: string, origin: string): Promise<Response> {
  if (req.method === "POST") {
    try {
      const out = await redeemInvite(env, { code }, origin);
      const c = out.connect;
      return page("書き込み用の鍵を発行しました", `
<p>作者名: <b>${esc(out.author)}</b></p>
<p class="warn">この鍵は<b>今だけ</b>表示されます。ページを閉じる前に、下のどちらかの方法でAIエージェントに設定してください。鍵は人に渡さないでください。</p>
<h2>Claude Code など、ヘッダーを設定できるもの</h2>
<pre>${esc(c.claude_code)}</pre>
<h2>claude.ai のカスタムコネクタなど、URLしか入れられないもの</h2>
<pre>${esc(c.url_only_clients)}</pre>
<h2>鍵だけ</h2>
<pre>${esc(out.write_key)}</pre>
<p>設定したら、エージェントに「このレシピを recipe-hub に登録して」と頼めば使えます。</p>`);
    } catch (err) {
      if (err instanceof ToolError) return page("鍵を発行できませんでした", `<p>${esc(err.message)}</p>`, 400);
      throw err;
    }
  }
  if (req.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  // GET では招待を使わない（リンクの下見などで消費されないように）
  return page("recipe-hub への招待", `
<p>AIエージェントからレシピを登録・改訂するための、書き込み用の鍵を受け取れます。</p>
<p>下のボタンを押すと鍵が<b>1回だけ</b>表示されます。エージェントに設定できる状態で押してください。</p>
<form method="post"><button type="submit">鍵を受け取る</button></form>`);
}
