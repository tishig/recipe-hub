// レシピ専用MCPサーバー（Cloudflare Workers）
// MCP の Streamable HTTP 方式を、状態を持たない最小構成で実装している（POST /mcp に JSON-RPC を送る）。
import { callTool, TOOL_DEFS, ToolError, type Env } from "./tools.ts";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "recipe-hub", version: "0.2.0" };

const INSTRUCTIONS = `Recipe collection for people and AI agents.
- Read and search freely; writing requires a write key.
- Before adding, call list_categories and reuse existing genre/group/dish slugs.
- Equipment and ingredients are chosen from master lists (list_master). If something is missing, add it with add_master_item, then use its id.
- To find recipes the user can cook, filter search results on your side using each result's "needs", the master lists ("provides" for equipment, "parent" for ingredients) and list_substitutions. Do not send the user's inventory to this server.
- Many recipes may share the same dish. But if a recipe is based on an existing one in this collection (yours or anyone's), use fork_recipe (your own version, linked to the original), never add_recipe.
- To improve your own recipe, use update_recipe. Every change is kept in the version history.
- If any information comes from an outside website or book, list it in sources (name, url, accessed date).
- Amounts are numbers + units from the allowed list. Put oven temperature and times into oven_c / minutes fields, not only in the text.
- If a write is rejected, read the listed problems, fix them and send again.`;

type RpcId = string | number | null;
interface RpcRequest { jsonrpc: "2.0"; id?: RpcId; method: string; params?: any }

const rpcResult = (id: RpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

// 書き込み用の鍵から作者名を引く。鍵は Authorization: Bearer <鍵> か URL の ?key=<鍵>
function authorFor(req: Request, env: Env): string | null {
  const url = new URL(req.url);
  const key = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || url.searchParams.get("key");
  if (!key) return null;
  try {
    const map = JSON.parse(env.WRITE_KEYS || "{}") as Record<string, string>;
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
  } catch {
    return null;
  }
}

async function handleRpc(msg: RpcRequest, env: Env, author: string | null) {
  const id = msg.id ?? null;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOL_DEFS });
    case "tools/call": {
      const name = msg.params?.name;
      try {
        const out = await callTool(env, name, msg.params?.arguments ?? {}, author);
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        });
      } catch (err) {
        // 様式違いなどは「道具の結果としての失敗」で返し、AIが自分で直せるようにする
        const message = err instanceof ToolError ? err.message : `サーバー内部の失敗: ${(err as Error).message}`;
        return rpcResult(id, { content: [{ type: "text", text: message }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `未対応のメソッド: ${msg.method}`);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/mcp") {
      if (req.method === "GET") return new Response("このサーバーはPOSTのみ対応です", { status: 405, headers: { Allow: "POST" } });
      if (req.method === "DELETE") return new Response(null, { status: 405 });
      if (req.method !== "POST") return new Response(null, { status: 405 });

      let body: unknown;
      try { body = await req.json(); } catch { return json(rpcError(null, -32700, "JSONとして読めません"), 400); }
      const author = authorFor(req, env);
      const msgs = (Array.isArray(body) ? body : [body]) as RpcRequest[];
      const replies = [];
      for (const m of msgs) {
        if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") { replies.push(rpcError(null, -32600, "JSON-RPC 2.0 の形ではありません")); continue; }
        if (m.id === undefined) continue; // 通知には返事をしない
        replies.push(await handleRpc(m, env, author));
      }
      if (replies.length === 0) return new Response(null, { status: 202 });
      return json(Array.isArray(body) ? replies : replies[0]);
    }

    // MCPを使わない人やエージェント向け: レシピのMarkdownをそのまま返す
    if (req.method === "GET" && url.pathname.startsWith("/recipes/") && url.pathname.endsWith(".md")) {
      const id = decodeURIComponent(url.pathname.slice("/recipes/".length, -3));
      const row = await env.DB.prepare("SELECT body FROM recipes WHERE id = ?").bind(id).first<{ body: string }>();
      if (!row) return new Response("見つかりません", { status: 404 });
      return new Response(row.body, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
    }

    if (req.method === "GET" && url.pathname === "/") {
      return new Response(
        `recipe-hub: AIエージェント向けレシピ集\nMCP: POST ${url.origin}/mcp\nレシピ本文: GET ${url.origin}/recipes/<id>.md\n`,
        { headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }
    return new Response("見つかりません", { status: 404 });
  },
};
