// MCPの各操作の中身
import {
  idToPath, parseRecipeFile, recipeDir, ROW_COLUMNS, serializeRecipeFile, toRow, validateRecipe,
  type Recipe, type RecipeFile, type RecipeInput,
} from "../../shared/recipe.ts";
import { getFile, GitHubError, putFile, type GitHubEnv } from "./github.ts";
import { createInvite, listWriters, markOnboarded, redeemInvite, revokeWriter, type Writer } from "./keys.ts";
import { applyEdits } from "./edit.ts";
import { masterItemSchema, recipeInputSchema, substitutionSchema } from "./schema.ts";
import {
  MASTER_PATHS, normName, parseList, serializeList, validateMasterItem, validateSubstitution,
  type MasterIndex, type MasterItem, type MasterKind, type Substitution,
} from "../../shared/masters.ts";

export interface Env extends GitHubEnv {
  DB: D1Database;
  WRITE_KEYS: string; // 管理者の鍵。JSON: {"<鍵>": "<作者名>"}（招待で配る鍵は D1 の write_keys）
  TIMEZONE?: string;
}

export class ToolError extends Error {}

// ---------- 道具一覧（tools/list で返すもの） ----------

const idArg = { type: "string", description: "Recipe id, e.g. 'western-sweets/pie/dutch-apple-pie/takehiro-2026-11-07'" };
const changeNote = { type: "string", description: "Why this change was made (saved in the version history)" };

const outsideSources = {
  type: "string", enum: ["listed", "none"],
  description: "Your explicit declaration about outside sources. 'listed' = this recipe draws on outside sources and ALL of them are in recipe.sources with links. 'none' = the user invented this recipe themselves and nothing came from a website, video, book or another person's recipe. If you are not sure, ask the user before registering; do not guess 'none'.",
};

export const TOOL_DEFS = [
  {
    name: "search_recipes",
    description: "Search recipes by words (title, dish name, ingredients, tags) and/or category. Each result lists the equipment ids and ingredient ids it needs, so you can drop recipes the user cannot cook (check master 'provides'/'parent' and list_substitutions before dropping). Filter on your side; the server never needs to know what the user owns.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Space-separated words; all must match" },
        genre: { type: "string" }, group: { type: "string" }, dish: { type: "string" },
        author: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_recipe",
    description: "Get one recipe: structured data plus the original Markdown file.",
    inputSchema: { type: "object", required: ["id"], properties: { id: idArg } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_categories",
    description: "List existing genres, groups and dishes (slugs with display names and counts). Call this before adding a recipe so you reuse existing slugs.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_master",
    description: "Look up the master list of equipment or ingredients (official ids, Japanese/English names, aliases, category, parent/provides). Use these ids in recipes.",
    inputSchema: {
      type: "object", required: ["kind"],
      properties: {
        kind: { type: "string", enum: ["equipment", "ingredients"] },
        query: { type: "string", description: "Part of a name, alias or id" },
        category: { type: "string" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_substitutions",
    description: "Look up the substitution table: what can be used instead of an ingredient or piece of equipment, with ratio and notes.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["ingredient", "equipment"] },
        id: { type: "string", description: "Master id; returns substitutes for it (including reversible entries)" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add_master_item",
    description: "Add a missing item to the equipment or ingredient master list. Search with list_master first; items whose name or alias matches an existing item are rejected. Requires a write key.",
    inputSchema: { type: "object", required: ["kind", "item"], properties: { kind: { type: "string", enum: ["equipment", "ingredients"] }, item: masterItemSchema } },
  },
  {
    name: "add_substitution",
    description: "Add an entry to the substitution table. Both ids must exist in the master list. Requires a write key.",
    inputSchema: { type: "object", required: ["substitution"], properties: { substitution: substitutionSchema } },
  },
  {
    name: "add_recipe",
    description: "Register a NEW original recipe. Do NOT use this to copy or adapt an existing recipe in this collection — use fork_recipe instead. SOURCES ARE MANDATORY: if any part of the recipe came from a website, video, book or another person's recipe, every such source must be in recipe.sources with its link, and outside_sources must be 'listed'. Only a recipe the user invented themselves may use sources: [] with outside_sources 'none'. Requires a write key.",
    inputSchema: { type: "object", required: ["recipe", "outside_sources"], properties: { recipe: recipeInputSchema, outside_sources: outsideSources } },
  },
  {
    name: "update_recipe",
    description: "Revise one of YOUR OWN recipes by sending the complete new recipe content (not a diff). Use this for a large rewrite; for a small change (an amount, a source, one step) use patch_recipe instead. Keep the existing sources, and add a source with its link for anything newly taken from a website, video, book or another person's recipe. Requires a write key.",
    inputSchema: { type: "object", required: ["id", "recipe", "change_note", "outside_sources"], properties: { id: idArg, recipe: recipeInputSchema, change_note: changeNote, outside_sources: outsideSources } },
  },
  {
    name: "patch_recipe",
    description: "Change only part of one of YOUR OWN recipes; everything you do not mention stays exactly as it is. Prefer this over update_recipe for small changes such as fixing an amount, a source's date or link, a step's time or temperature, or adding one ingredient. Call get_recipe first so that ids, groups and step numbers are current. All changes in one call are applied together or not at all, and the result must still pass the format check. The result lists what was changed. Requires a write key.",
    inputSchema: {
      type: "object", required: ["id", "change_note"],
      properties: {
        id: idArg, change_note: changeNote,
        set: {
          type: "object",
          description: "Replace whole top-level fields: title, summary, yield, tags, notes, genre_name, group_name, dish_name (and, if you really want to replace a whole list: sources, equipment, ingredients, steps). null removes summary or tags. genre, group and dish cannot be changed.",
        },
        sources: {
          type: "object",
          description: "Sources are identified by their url.",
          properties: {
            add: { type: "array", items: recipeInputSchema.properties.sources.items },
            update: { type: "array", description: "Fields to change on an existing source, e.g. { url, accessed: '2026-11-13' }. Use new_url to change the link itself.", items: { type: "object", required: ["url"], properties: { url: { type: "string", description: "Current url of the source to change" }, new_url: { type: "string" }, name: { type: "string" }, accessed: { type: "string", description: "YYYY-MM-DD" } } } },
            remove: { type: "array", description: "urls of sources to remove. Only remove a source that was listed by mistake.", items: { type: "string" } },
          },
        },
        ingredients: {
          type: "object",
          description: "Ingredients are identified by their master id; add 'group' when the same id appears in more than one group.",
          properties: {
            update: { type: "array", description: "Fields to change on an existing ingredient, e.g. { id: 'cinnamon', amount: 1.5 }. Only the fields you give change; null removes an optional field.", items: { type: "object", required: ["id"], properties: { id: { type: "string" }, group: { type: "string" } } } },
            add: { type: "array", description: "New ingredients: the group label plus the same fields as in add_recipe (id, unit, amount, ...). A new group is created if the label does not exist.", items: { type: "object", required: ["group", "id", "unit"], properties: { group: { type: "string" }, id: { type: "string" }, unit: { type: "string" } } } },
            remove: { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "string" }, group: { type: "string" } } } },
          },
        },
        steps: {
          type: "object",
          description: "Steps are identified by their number in the CURRENT recipe (1 = first step), also when several steps are added or removed in the same call.",
          properties: {
            update: { type: "array", description: "Fields to change on an existing step, e.g. { step: 8, minutes: 40, oven_c: 190 }. null removes an optional field.", items: { type: "object", required: ["step"], properties: { step: { type: "integer", minimum: 1 } } } },
            add: { type: "array", description: "New steps: 'after' is the number of the current step it follows (0 = put it first), plus title, text and the other step fields.", items: { type: "object", required: ["after", "title", "text"], properties: { after: { type: "integer", minimum: 0 }, title: { type: "string" }, text: { type: "string" } } } },
            remove: { type: "array", items: { type: "integer", minimum: 1 } },
          },
        },
        equipment: {
          type: "object",
          properties: {
            add: { type: "array", items: recipeInputSchema.properties.equipment.items },
            update: { type: "array", description: "Change the note of an existing item, e.g. { id: 'pie-dish', note: '直径21cm' }", items: { type: "object", required: ["id"], properties: { id: { type: "string" }, note: { type: ["string", "null"] } } } },
            remove: { type: "array", description: "Equipment ids to remove", items: { type: "string" } },
          },
        },
        outside_sources: { ...outsideSources, description: "Needed only when this change leaves the recipe with no sources at all: send 'none' to confirm that the user invented it themselves. Otherwise omit." },
      },
    },
  },
  {
    name: "fork_recipe",
    description: "Create your own published version based on an existing recipe (yours or someone else's). The link to the original and its author are added automatically. Send the complete content of the new version. Keep every source of the original recipe in recipe.sources (dropping one is rejected), and add a source with its link for anything else taken from outside. Here outside_sources 'none' means nothing came from outside this collection (the link to the original recipe is added automatically). Requires a write key.",
    inputSchema: { type: "object", required: ["source_id", "recipe", "outside_sources"], properties: { source_id: idArg, recipe: recipeInputSchema, note: { type: "string", description: "How it differs from the original" }, outside_sources: outsideSources } },
  },
  {
    name: "redeem_invite",
    description: "Exchange a one-time invite code for a write key. No key needed. Use this when the user has an invite code (inv_...) and this connection cannot write yet. The key is returned only once: tell the user how to reconnect with it (see 'connect' in the result).",
    inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string", description: "Invite code, e.g. 'inv_...'" } } },
  },
  {
    name: "create_invite",
    description: "Create a one-time invite so another person's agent can get its own write key. Requires a write key that has already added or revised at least one recipe (admins can always invite). Returns an invite URL and code to hand to that person.",
    inputSchema: {
      type: "object", required: ["author"],
      properties: {
        author: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 30, description: "Author name the invited person will write as (lowercase letters, digits, hyphens), e.g. 'hanako'" },
        days: { type: "integer", minimum: 1, maximum: 30, description: "Days until the invite expires (default 7)" },
        allow_existing: { type: "boolean", description: "Set true only to give an additional key to an author name that is already in use (same person, another agent). Non-admins may do this only for their own author name." },
      },
    },
  },
  {
    name: "list_writers",
    description: "Admin only. List admins, issued write keys (author, date, who invited them, active or revoked) and unused invites. Never returns keys or codes.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "revoke_writer",
    description: "Admin only. Revoke all write keys issued by invite to an author and cancel their unused invites. Their published recipes stay.",
    inputSchema: { type: "object", required: ["author"], properties: { author: { type: "string" } } },
  },
] as const;

// ---------- 共通の部品 ----------

function today(env: Env): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: env.TIMEZONE ?? "America/Los_Angeles" }).format(new Date());
}

async function upsertRow(env: Env, file: RecipeFile, raw: string, sha: string) {
  const row = toRow(file, raw, sha);
  const cols = ROW_COLUMNS;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO recipes (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  ).bind(...cols.map((c) => row[c])).run();
}

// D1 の写しからマスターリストを読む
async function loadMasterIndex(env: Env): Promise<MasterIndex> {
  const { results } = await env.DB.prepare("SELECT kind, data FROM masters").all<{ kind: string; data: string }>();
  const idx: MasterIndex = { equipment: new Map(), ingredients: new Map() };
  for (const row of results) {
    const it = JSON.parse(row.data) as MasterItem;
    (row.kind === "equipment" ? idx.equipment : idx.ingredients).set(it.id, it);
  }
  return idx;
}

// 材料の表示名が省略されていたら、マスターの日本語名を入れる
function fillNames(r: Recipe, idx: MasterIndex) {
  for (const g of r.ingredients ?? []) for (const it of g.items ?? []) {
    if (!it.name && it.id) { const m = idx.ingredients.get(it.id); if (m) it.name = m.name_ja; }
  }
}

// GitHub（正本）から1件読む
async function loadRecipe(env: Env, id: string): Promise<{ file: RecipeFile; raw: string; sha: string }> {
  if (typeof id !== "string" || !id) throw new ToolError("レシピの id が必要です");
  const f = await getFile(env, idToPath(id));
  if (!f) throw new ToolError(`レシピ ${id} は見つかりません`);
  return { file: parseRecipeFile(f.raw), raw: f.raw, sha: f.sha };
}

// AIの入力から、サーバーが決める項目を取り除く
function cleanInput(input: any): { body: Omit<RecipeInput, "notes">; notes: string } {
  if (typeof input !== "object" || input === null) throw new ToolError("recipe が空です");
  const { notes, id, author, created, updated, status, derived_from, ...body } = input;
  return { body, notes: typeof notes === "string" ? notes : "" };
}

// ジャンル・グループ・料理名の英字名と日本語名の組み合わせが既存のものと食い違っていないか
async function checkCategoryNames(env: Env, r: Recipe): Promise<string[]> {
  const e: string[] = [];
  const g = await env.DB.prepare("SELECT genre_name FROM recipes WHERE genre = ? LIMIT 1").bind(r.genre).first<{ genre_name: string }>();
  if (g && g.genre_name !== r.genre_name) e.push(`genre "${r.genre}" は「${g.genre_name}」として登録済みです。genre_name をそろえるか、別の genre にしてください`);
  const gr = await env.DB.prepare("SELECT group_name FROM recipes WHERE genre = ? AND grp = ? LIMIT 1").bind(r.genre, r.group).first<{ group_name: string }>();
  if (gr && gr.group_name !== r.group_name) e.push(`group "${r.group}" は「${gr.group_name}」として登録済みです`);
  const d = await env.DB.prepare("SELECT dish_name FROM recipes WHERE genre = ? AND grp = ? AND dish = ? LIMIT 1").bind(r.genre, r.group, r.dish).first<{ dish_name: string }>();
  if (d && d.dish_name !== r.dish_name) e.push(`dish "${r.dish}" は「${d.dish_name}」として登録済みです`);
  return e;
}

// 出典の申告（outside_sources）と sources の中身が合っているか。フォークでは元のレシピの出典を引き継いでいるか
function checkSources(a: any, r: Recipe, forkedFrom?: Recipe): string[] {
  const e: string[] = [];
  const list = Array.isArray(r.sources) ? r.sources : [];
  const decl = a.outside_sources;
  if (decl !== "listed" && decl !== "none") {
    e.push(`outside_sources（出典の申告）が必要です。レシピのどこか一部でも（材料・分量・作り方・発想）、Webサイト・動画・本・他の人のレシピを参考にしたなら、そのすべてを sources にリンクつきで書き、outside_sources を "listed" にしてください。利用者が自分で編み出したレシピの場合だけ、sources を [] にして outside_sources を "none" にします。分からなければ、登録する前に利用者に確認してください`);
  } else if (decl === "listed" && list.length === 0) {
    e.push(`outside_sources が "listed" なのに sources が空です。参考にした出典を、名前（name）・リンク（url）・参照日（accessed）つきですべて書いてください。リンクが分からなければ、作らずに利用者に確認してください`);
  } else if (decl === "none" && list.length > 0) {
    e.push(`outside_sources が "none" なのに sources があります。外部の出典を参考にしているなら outside_sources を "listed" にしてください`);
  }
  if (forkedFrom) {
    const have = new Set(list.map((s) => String(s?.url ?? "").trim()));
    const missing = (forkedFrom.sources ?? []).filter((s) => !have.has(s.url.trim()));
    if (missing.length) {
      e.push(`元のレシピの出典が抜けています。フォークでは元の出典をそのまま sources に残してください: ${missing.map((s) => `${s.name} <${s.url}>`).join("、")}`);
    }
  }
  return e;
}

// 出典なしで登録したときに、結果に添える念押し
function sourcesReminder(a: any) {
  return a.outside_sources === "none"
    ? { sources_note: "Registered as the user's own invention with NO outside sources. If any part of it actually came from a website, video, book or another person's recipe, call update_recipe now and add every source with its link." }
    : {};
}

function rejectIfInvalid(errors: string[]) {
  if (errors.length) {
    throw new ToolError(`様式に合わないため登録しませんでした。直して送り直してください:\n- ${errors.join("\n- ")}`);
  }
}

// 新しいファイルを作る（同じ作者・同じ日なら -2, -3 … を付ける）
async function createNew(env: Env, recipe: Recipe, notes: string, message: (r: Recipe) => string, idx: MasterIndex) {
  const base = `${recipeDir(recipe)}/${recipe.author}-${recipe.created}`;
  // D1 は LIKE の文字列の長さに上限があるため substr で前方一致を見る
  const existing = await env.DB.prepare("SELECT id FROM recipes WHERE id = ? OR substr(id, 1, ?) = ?")
    .bind(base, base.length + 1, `${base}-`).all<{ id: string }>();
  const taken = new Set(existing.results.map((x) => x.id));
  let n = 1;
  for (let attempt = 0; attempt < 5; attempt++) {
    while (taken.has(n === 1 ? base : `${base}-${n}`)) n++;
    recipe.id = n === 1 ? base : `${base}-${n}`;
    const file = { recipe, notes };
    rejectIfInvalid(validateRecipe(recipe, recipe.id, idx));
    const raw = serializeRecipeFile(file);
    try {
      const { sha, commit } = await putFile(env, idToPath(recipe.id), raw, message(recipe));
      await upsertRow(env, file, raw, sha);
      return { id: recipe.id, commit };
    } catch (err) {
      // すでに同名ファイルがあった（写しがまだ追いついていない）→ 次の番号で再挑戦
      if (err instanceof GitHubError && err.status === 422) { taken.add(recipe.id); continue; }
      throw err;
    }
  }
  throw new ToolError("ファイル名を決められませんでした。少し待って再度お試しください");
}

function commitMessage(kind: string, r: Recipe, note?: string) {
  return `${kind}: ${r.title} (${r.id})${note ? `\n\n${note}` : ""}\n\nvia recipe-hub MCP, author: ${r.author}`;
}

// ---------- 各操作 ----------

export async function searchRecipes(env: Env, a: any) {
  const where: string[] = [];
  const binds: unknown[] = [];
  const terms = String(a.query ?? "").split(/\s+/).filter(Boolean).slice(0, 8);
  for (const t of terms) {
    // LIKE は長い日本語で上限に当たるため instr（含まれるか）で探す。英字は大文字小文字を区別しない
    const cols = ["title", "dish_name", "group_name", "genre_name", "tags", "ingredients_text", "summary"];
    where.push(`(${cols.map((c) => `instr(lower(${c}), lower(?)) > 0`).join(" OR ")})`);
    binds.push(...Array(cols.length).fill(t));
  }
  for (const [k, col] of [["genre", "genre"], ["group", "grp"], ["dish", "dish"], ["author", "author"]] as const) {
    if (a[k]) { where.push(`${col} = ?`); binds.push(a[k]); }
  }
  where.push("status = 'published'");
  const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 50);
  const sql = `SELECT id, title, dish_name, group_name, genre_name, author, status, updated, summary, derived_from, relation,
      equipment_ids, ingredient_ids
    FROM recipes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated DESC LIMIT ${limit}`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all<Record<string, any>>();
  const recipes = results.map(({ equipment_ids, ingredient_ids, ...rest }) => ({
    ...rest, needs: { equipment: JSON.parse(equipment_ids), ingredients: JSON.parse(ingredient_ids) },
  }));
  return { count: recipes.length, recipes };
}

export async function getRecipe(env: Env, a: any) {
  if (typeof a.id !== "string" || !a.id) throw new ToolError("id が必要です");
  const row = await env.DB.prepare("SELECT body FROM recipes WHERE id = ?").bind(a.id).first<{ body: string }>();
  // 写しになければ正本（GitHub）を見る（登録直後など）
  const raw = row?.body ?? (await loadRecipe(env, a.id)).raw;
  const { recipe, notes } = parseRecipeFile(raw);
  const forks = await env.DB.prepare("SELECT id, title, author, relation, status FROM recipes WHERE derived_from = ?").bind(a.id).all();
  return { recipe, notes, derived_versions: forks.results, markdown: raw };
}

export async function listCategories(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT genre, genre_name, grp AS "group", group_name, dish, dish_name, COUNT(*) AS recipes
     FROM recipes WHERE status = 'published' GROUP BY genre, grp, dish ORDER BY genre, grp, dish`,
  ).all();
  return { dishes: results };
}

export async function addRecipe(env: Env, a: any, author: string) {
  const { body, notes } = cleanInput(a.recipe);
  const d = today(env);
  const recipe = { ...body, author, created: d, updated: d, status: "published", derived_from: null } as Recipe;
  const idx = await loadMasterIndex(env);
  fillNames(recipe, idx);
  rejectIfInvalid([...checkSources(a, recipe), ...validateRecipe({ ...recipe, id: `${recipeDir(recipe)}/x` }, undefined, idx), ...(await checkCategoryNames(env, recipe))]);
  return { ...(await createNew(env, recipe, notes, (r) => commitMessage("add", r), idx)), ...sourcesReminder(a) };
}

export async function updateRecipe(env: Env, a: any, author: string) {
  const cur = await loadRecipe(env, a.id);
  const old = cur.file.recipe;
  if (old.author !== author) throw new ToolError(`このレシピの作者は ${old.author} です。自分のレシピ以外は fork_recipe で自分の版を作ってください`);
  if (!a.change_note) throw new ToolError("change_note（変更の理由）が必要です");
  const { body, notes } = cleanInput(a.recipe);
  // 置き場所は変えない（ジャンルなどを変えたい場合は fork で新しく作る）
  const recipe = {
    ...body, genre: old.genre, group: old.group, dish: old.dish,
    id: old.id, author: old.author, created: old.created, updated: today(env), status: old.status, derived_from: old.derived_from,
  } as Recipe;
  const idx = await loadMasterIndex(env);
  fillNames(recipe, idx);
  rejectIfInvalid([...checkSources(a, recipe), ...validateRecipe(recipe, old.id, idx), ...(await checkCategoryNames(env, recipe))]);
  const file = { recipe, notes };
  const raw = serializeRecipeFile(file);
  const { sha, commit } = await putFile(env, idToPath(old.id), raw, commitMessage("update", recipe, a.change_note), cur.sha);
  await upsertRow(env, file, raw, sha);
  return { id: old.id, commit, ...sourcesReminder(a) };
}

export async function patchRecipe(env: Env, a: any, author: string) {
  const cur = await loadRecipe(env, a.id);
  const old = cur.file.recipe;
  if (old.author !== author) throw new ToolError(`このレシピの作者は ${old.author} です。自分のレシピ以外は fork_recipe で自分の版を作ってください`);
  if (!a.change_note) throw new ToolError("change_note（変更の理由）が必要です");
  const edit = applyEdits(old, cur.file.notes, a);
  if (!edit.errors.length && !edit.changed.length) {
    throw new ToolError("変更がありません。set / sources / ingredients / steps / equipment のどれかで、変えたいところを指定してください");
  }
  const recipe = { ...edit.recipe, updated: today(env) } as Recipe;
  const idx = await loadMasterIndex(env);
  fillNames(recipe, idx);
  // 出典: 申告があれば照らし合わせる。なくても、出典を空にする変更は「自分で編み出した」の申告を求める
  const srcErrors = a.outside_sources !== undefined ? checkSources(a, recipe)
    : (old.sources?.length ?? 0) > 0 && (recipe.sources?.length ?? 0) === 0
      ? [`この変更で出典が1つもなくなります。間違って書いた出典を消す場合で、利用者が自分で編み出したレシピなら outside_sources を "none" にして送り直してください。参考にした出典があるなら、消さずに残してください`]
      : [];
  const errors = [...edit.errors, ...srcErrors];
  // 指定そのものに誤りがあるときは、それだけを伝える（当てそこねた結果の様式違いまで並べると分かりにくい）
  if (!edit.errors.length) errors.push(...validateRecipe(recipe, old.id, idx), ...(await checkCategoryNames(env, recipe)));
  if (errors.length) {
    throw new ToolError(`何も変更しませんでした。直して送り直してください:\n- ${errors.join("\n- ")}`);
  }
  const file = { recipe, notes: edit.notes };
  const raw = serializeRecipeFile(file);
  const { sha, commit } = await putFile(env, idToPath(old.id), raw, commitMessage("update", recipe, a.change_note), cur.sha);
  await upsertRow(env, file, raw, sha);
  return { id: old.id, changed: edit.changed, commit, ...sourcesReminder(a) };
}

export async function forkRecipe(env: Env, a: any, author: string) {
  const src = (await loadRecipe(env, a.source_id)).file.recipe;
  const { body, notes } = cleanInput(a.recipe);
  const d = today(env);
  const recipe = {
    ...body, author, created: d, updated: d, status: "published",
    derived_from: { id: src.id, author: src.author, relation: "fork", ...(a.note ? { note: a.note } : {}) },
  } as Recipe;
  const idx = await loadMasterIndex(env);
  fillNames(recipe, idx);
  rejectIfInvalid([...checkSources(a, recipe, src), ...validateRecipe({ ...recipe, id: `${recipeDir(recipe)}/x` }, undefined, idx), ...(await checkCategoryNames(env, recipe))]);
  return createNew(env, recipe, notes, (r) => commitMessage("fork", r, `from ${src.id}${a.note ? `: ${a.note}` : ""}`), idx);
}

// ---------- マスターリストと互換表 ----------

export async function listMaster(env: Env, a: any) {
  if (a.kind !== "equipment" && a.kind !== "ingredients") throw new ToolError("kind は equipment か ingredients");
  const { results } = await env.DB.prepare("SELECT data FROM masters WHERE kind = ? ORDER BY category, id").bind(a.kind).all<{ data: string }>();
  let items = results.map((x) => JSON.parse(x.data) as MasterItem);
  if (a.category) items = items.filter((x) => x.category === a.category);
  if (a.query) {
    const q = normName(String(a.query));
    items = items.filter((x) => [x.id, x.name_ja, x.name_en, ...(x.aliases ?? [])].some((n) => normName(n).includes(q)));
  }
  return { kind: a.kind, count: items.length, items: items.map(({ added_by, ...rest }) => rest) };
}

export async function listSubstitutions(env: Env, a: any) {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (a.kind) { where.push("kind = ?"); binds.push(a.kind); }
  if (a.id) { where.push("(from_id = ? OR (both = 1 AND to_id = ?))"); binds.push(a.id, a.id); }
  const { results } = await env.DB.prepare(
    `SELECT data FROM substitutions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY kind, from_id`,
  ).bind(...binds).all<{ data: string }>();
  return { count: results.length, substitutions: results.map((x) => JSON.parse(x.data)) };
}

// マスターの YAML ファイルを読み、1件足して書き戻す（同時に書かれた場合は読み直して再挑戦）
async function appendToList<T>(
  env: Env, kind: keyof typeof MASTER_PATHS, make: (existing: T[]) => T, message: string,
): Promise<{ item: T; commit: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = await getFile(env, MASTER_PATHS[kind]);
    if (!f) throw new ToolError(`${MASTER_PATHS[kind]} が見つかりません`);
    const list = parseList<T>(f.raw);
    const item = make(list); // 問題があれば ToolError を投げる
    try {
      const { commit } = await putFile(env, MASTER_PATHS[kind], serializeList(kind, [...list, item]), message, f.sha);
      return { item, commit };
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 409 || err.status === 422)) continue;
      throw err;
    }
  }
  throw new ToolError("同時に更新が重なりました。少し待って再度お試しください");
}

export async function addMasterItem(env: Env, a: any, author: string) {
  const kind = a.kind as MasterKind;
  if (kind !== "equipment" && kind !== "ingredients") throw new ToolError("kind は equipment か ingredients");
  const { item, commit } = await appendToList<MasterItem>(env, kind, (existing) => {
    const { added_by, ...rest } = a.item ?? {};
    const it = { ...rest, added_by: author } as MasterItem;
    const errors = validateMasterItem(kind, it, existing);
    if (errors.length) throw new ToolError(`マスターリストに追加しませんでした:\n- ${errors.join("\n- ")}`);
    return it;
  }, `master(${kind}): add ${a.item?.id} ${a.item?.name_ja ?? ""}\n\nvia recipe-hub MCP, author: ${author}`);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO masters (kind, id, name_ja, name_en, category, parent, provides, aliases, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(kind, item.id, item.name_ja, item.name_en, item.category, item.parent ?? null,
    JSON.stringify(item.provides ?? []), JSON.stringify(item.aliases ?? []), JSON.stringify(item)).run();
  return { added: item, commit };
}

export async function addSubstitution(env: Env, a: any, author: string) {
  const idx = await loadMasterIndex(env);
  const { item, commit } = await appendToList<Substitution>(env, "substitutions", (existing) => {
    const { added_by, ...rest } = a.substitution ?? {};
    const s = { ...rest, added_by: author } as Substitution;
    const errors = validateSubstitution(s, idx, existing);
    if (errors.length) throw new ToolError(`互換表に追加しませんでした:\n- ${errors.join("\n- ")}`);
    return s;
  }, `substitution: ${a.substitution?.from} -> ${a.substitution?.to}\n\nvia recipe-hub MCP, author: ${author}`);
  await env.DB.prepare("INSERT OR REPLACE INTO substitutions (kind, from_id, to_id, both, data) VALUES (?, ?, ?, ?, ?)")
    .bind(item.kind, item.from, item.to, item.both ? 1 : 0, JSON.stringify(item)).run();
  return { added: item, commit };
}

export const WRITE_TOOLS = new Set(["add_recipe", "update_recipe", "patch_recipe", "fork_recipe", "add_master_item", "add_substitution"]);

export async function callTool(env: Env, name: string, args: any, writer: Writer | null, origin: string) {
  const author = writer?.author ?? null;
  if (WRITE_TOOLS.has(name) && !author) {
    throw new ToolError("この操作には書き込み用の鍵が必要です（読み込みと検索は鍵なしで使えます）。招待コードがあれば redeem_invite で鍵を受け取れます");
  }
  switch (name) {
    case "search_recipes": return searchRecipes(env, args);
    case "get_recipe": return getRecipe(env, args);
    case "list_categories": return listCategories(env);
    case "list_master": return listMaster(env, args);
    case "list_substitutions": return listSubstitutions(env, args);
    case "add_master_item": return addMasterItem(env, args, author!);
    case "add_substitution": return addSubstitution(env, args, author!);
    case "add_recipe":
    case "update_recipe":
    case "patch_recipe":
    case "fork_recipe": {
      const out = name === "add_recipe" ? await addRecipe(env, args, author!)
        : name === "update_recipe" ? await updateRecipe(env, args, author!)
        : name === "patch_recipe" ? await patchRecipe(env, args, author!)
        : await forkRecipe(env, args, author!);
      await markOnboarded(env, writer); // これ以降、この鍵で他の人を招待できる
      return out;
    }
    case "redeem_invite": return redeemInvite(env, args, origin);
    case "create_invite": return createInvite(env, args, writer, origin);
    case "list_writers": return listWriters(env, writer);
    case "revoke_writer": return revokeWriter(env, args, writer);
    default: throw new ToolError(`未知の操作: ${name}`);
  }
}
