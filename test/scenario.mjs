// 一連の操作を試す: node test/scenario.mjs
const URL_ = process.env.MCP_URL ?? "http://localhost:8787/mcp";
let n = 0;
async function rpc(method, params, key) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
  });
  return res.json();
}
async function tool(name, args, key) {
  const r = await rpc("tools/call", { name, arguments: args }, key);
  const c = r.result;
  return { ok: !c.isError, data: c.structuredContent, text: c.content[0].text };
}
let pass = 0, fail = 0;
function expect(label, cond, extra = "") {
  if (cond) { pass++; console.log(`✓ ${label}`); } else { fail++; console.log(`✗ ${label} ${extra}`); }
}

const T = "testkey-takehiro", H = "testkey-hanako";
const PIE = "western-sweets/pie/dutch-apple-pie/takehiro-2026-11-07";

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
expect("initialize", init.result?.serverInfo?.name === "recipe-hub");
const list = await rpc("tools/list", {});
expect("tools/list に10", list.result.tools.length === 10);
expect("試作と取り込みの操作はない", !list.result.tools.some((t) => /branch|merge/.test(t.name)));

let r = await tool("search_recipes", { query: "りんご パイ" });
expect("検索で見本が出る", r.data?.count === 1, r.text);
expect("検索結果に必要な道具と材料が付く", r.data?.recipes?.[0]?.needs?.equipment?.includes("oven") && r.data.recipes[0].needs.ingredients.some((x) => x.id === "cardamom" && x.optional), r.text);
r = await tool("list_categories", {});
expect("分類一覧", r.data?.dishes?.[0]?.dish_name === "ダッチアップルパイ", r.text);
const got = await tool("get_recipe", { id: PIE });
expect("1件取得", got.data?.recipe?.ingredients?.length === 3, got.text);
const base = got.data.recipe;

const input = (over = {}) => {
  const { id, author, created, updated, status, derived_from, ...b } = structuredClone(base);
  return { ...b, ...over };
};

r = await tool("add_recipe", { recipe: input() });
expect("鍵なしの書き込みは断られる", !r.ok && r.text.includes("鍵"), r.text);

const bad = input({ title: "変なレシピ" });
bad.ingredients[1].items[0].unit = "ポンド";
bad.ingredients[1].items[1].amount = "1/4";
bad.steps[7] = { title: "焼く", text: "200℃で焼く" };
r = await tool("add_recipe", { recipe: bad }, H);
expect("様式違いは理由つきで断られる", !r.ok && r.text.includes("ポンド") && r.text.includes("0.25") && r.text.includes("oven_c"), r.text);

r = await tool("add_recipe", { recipe: input({ genre_name: "デザート" }) }, H);
expect("既存ジャンルと日本語名が違うと断られる", !r.ok && r.text.includes("洋菓子"), r.text);

r = await tool("add_recipe", { recipe: input({ title: "ダッチアップルパイ（花子版）", notes: "花子のオリジナル" }) }, H);
expect("同じ料理名で別人が新規登録できる", r.ok && r.data.id.includes("/hanako-"), r.text);
const hanakoId = r.data?.id;

r = await tool("add_recipe", { recipe: input({ title: "ダッチアップルパイ（花子版その2）" }) }, H);
expect("同じ人・同じ日なら -2 が付く", r.ok && r.data.id.endsWith("-2"), r.text);

r = await tool("update_recipe", { id: PIE, recipe: input(), change_note: "勝手に変更" }, H);
expect("他人のレシピは更新できない", !r.ok && r.text.includes("fork_recipe"), r.text);

r = await tool("fork_recipe", { source_id: PIE, recipe: input({ title: "ダッチアップルパイ（花子の甘さ控えめ版）" }), note: "砂糖を減らした" }, H);
expect("他人のレシピをフォークできる", r.ok, r.text);
const forkId = r.data?.id;
const fk = await tool("get_recipe", { id: forkId });
expect("フォークに元へのリンクと元の作者が付く", fk.data?.recipe?.derived_from?.author === "takehiro" && fk.data.recipe.derived_from.relation === "fork", fk.text);

const trial = input({ title: "ダッチアップルパイ（改訂60%版）" });
trial.ingredients[1].items[7].amount = 1.5;
r = await tool("update_recipe", { id: PIE, recipe: trial, change_note: "シナモンを小さじ1.5に増やした" }, T);
expect("自分のレシピを改訂できる", r.ok, r.text);
const after = await tool("get_recipe", { id: PIE });
expect("改訂後のシナモンが1.5、作者や作成日はそのまま", after.data?.recipe?.ingredients[1].items[7].amount === 1.5 && after.data.recipe.author === "takehiro" && after.data.recipe.created === "2026-11-07", after.text);
expect("元レシピにフォークの一覧が付く", after.data?.derived_versions?.length === 1, JSON.stringify(after.data?.derived_versions));

r = await tool("update_recipe", { id: hanakoId, recipe: input({ title: "ダッチアップルパイ（花子版・改）", sources: [{ name: "例のサイト", url: "https://example.com/pie", accessed: "2026-11-07" }] }), change_note: "出典を追記" }, H);
expect("自分のレシピは出典つきで更新できる", r.ok, r.text);

// ---- マスターリストと互換表 ----
r = await tool("list_master", { kind: "ingredients", query: "バター" });
expect("マスターを名前で探せる（バター、無塩、有塩、バターミルク）", r.data?.count === 4, r.text);
r = await tool("add_master_item", { kind: "ingredients", item: { id: "white-sugar", name_ja: "砂糖", name_en: "white sugar", category: "sugar-sweetener" } }, T);
expect("同じ名前の材料は二重登録できない", !r.ok && r.text.includes("sugar"), r.text);
r = await tool("add_master_item", { kind: "ingredients", item: { id: "rhubarb", name_ja: "ルバーブ", name_en: "rhubarb", category: "vegetable" } });
expect("マスター追加にも鍵が要る", !r.ok, r.text);
r = await tool("add_master_item", { kind: "ingredients", item: { id: "rhubarb", name_ja: "ルバーブ", name_en: "rhubarb", category: "vegetable" } }, T);
expect("足りない材料をマスターに追加できる", r.ok, r.text);

const rhubarb = input({ title: "ルバーブパイ", dish: "rhubarb-pie", dish_name: "ルバーブパイ" });
rhubarb.ingredients[1].items[0] = { id: "rhubarb-stalk", amount: 800, unit: "g" };
r = await tool("add_recipe", { recipe: rhubarb }, T);
expect("マスターにない材料は断られる", !r.ok && r.text.includes("add_master_item"), r.text);
rhubarb.ingredients[1].items[0] = { id: "rhubarb", amount: 800, unit: "g" };
rhubarb.steps[7] = { ...rhubarb.steps[7], equipment: ["pie-dish"] };
r = await tool("add_recipe", { recipe: rhubarb }, T);
expect("オーブンの温度がある工程に加熱機器がないと断られる", !r.ok && r.text.includes("加熱機器"), r.text);
rhubarb.steps[7] = { ...rhubarb.steps[7], equipment: ["oven", "pie-dish"] };
r = await tool("add_recipe", { recipe: rhubarb }, T);
expect("追加した材料を使って登録できる", r.ok, r.text);
const rb = await tool("get_recipe", { id: r.data?.id });
expect("材料名を省略するとマスターの名前が入る", rb.data?.recipe?.ingredients[1].items[0].name === "ルバーブ", rb.text);

r = await tool("list_substitutions", { id: "japanese-white-sugar" });
expect("逆向きも使える互換が見つかる", r.data?.substitutions?.some((x) => x.from === "granulated-sugar"), r.text);
r = await tool("add_substitution", { substitution: { kind: "equipment", from: "pie-dish", to: "cake-pan", both: false, note: "直径が近いものを使う。縁の焼き色は弱くなる" } }, T);
expect("互換表に追加できる", r.ok, r.text);
r = await tool("add_substitution", { substitution: { kind: "equipment", from: "pie-dish", to: "cake-pan", both: false, note: "重複" } }, T);
expect("同じ組み合わせは二重登録できない", !r.ok, r.text);
r = await tool("add_substitution", { substitution: { kind: "equipment", from: "oven", to: "kamado", both: false, note: "かまど" } }, T);
expect("マスターにない道具の互換は断られる", !r.ok, r.text);

// ---- 利用者側（エージェント）での絞り込みの例 ----
const eq = (await tool("list_master", { kind: "equipment" })).data.items;
const provides = new Map(eq.map((x) => [x.id, x.provides ?? []]));
const subs = (await tool("list_substitutions", { kind: "equipment" })).data.substitutions;
function canCook(needs, owned) {
  const have = new Set(owned.flatMap((id) => [id, ...(provides.get(id) ?? [])]));
  const missing = needs.equipment.filter((id) => !have.has(id));
  const fixable = missing.filter((id) => subs.some((s) => (s.from === id && have.has(s.to)) || (s.both && s.to === id && have.has(s.from))));
  return { ok: missing.length === fixable.length, missing, fixable };
}
const found = (await tool("search_recipes", { query: "パイ" })).data.recipes;
const kitchenBase = ["stove", "pot", "pie-dish", "baking-sheet", "knife", "peeler", "mixing-bowl", "whisk", "rubber-spatula", "tray", "refrigerator", "cooling-rack", "aluminum-foil"];
expect("オーブンがない家庭では作れないと判定", found.every((x) => !canCook(x.needs, kitchenBase).ok));
expect("オーブンレンジがあれば作れると判定", found.every((x) => canCook(x.needs, [...kitchenBase, "microwave-oven"]).ok));
expect("オーブントースターなら互換表で作れると判定", found.every((x) => canCook(x.needs, [...kitchenBase, "toaster-oven"]).ok));

const md = await fetch(URL_.replace("/mcp", `/recipes/${PIE}.md`)).then((x) => x.text());
expect("Markdownを直接取得できる", md.startsWith("---\nid: " + PIE));

console.log(`\n${pass}件成功 / ${fail}件失敗`);
process.exit(fail ? 1 : 0);
