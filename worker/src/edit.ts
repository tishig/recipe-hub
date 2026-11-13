// レシピの一部だけを書き換える（patch_recipe の中身）。
// 今のレシピに変更を当てた結果を返すだけで、保存や様式の確認は呼び出し側で行う。
import type { Ingredient, Recipe, Source, Step } from "../../shared/recipe.ts";

export interface EditResult { recipe: Recipe; notes: string; changed: string[]; errors: string[] }

// set でそのまま置き換えられる項目（置き場所を決める genre / group / dish と、サーバーが付ける項目は変えられない）
const SETTABLE = [
  "title", "summary", "yield", "tags", "genre_name", "group_name", "dish_name",
  "sources", "equipment", "ingredients", "steps",
] as const;
const REMOVABLE = new Set(["summary", "tags"]); // null で消せる項目

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): any[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

// fields の値を target に写す。null はその項目を消す。変えた項目名を返す
function assign(target: Record<string, any>, fields: Record<string, any>, skip: string[]): string[] {
  const done: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (skip.includes(k)) continue;
    if (v === null) { if (k in target) { delete target[k]; done.push(`${k} を削除`); } continue; }
    if (JSON.stringify(target[k]) !== JSON.stringify(v)) { target[k] = v; done.push(k); }
  }
  return done;
}

export function applyEdits(old: Recipe, oldNotes: string, a: any): EditResult {
  const r = structuredClone(old) as Recipe;
  let notes = oldNotes;
  const changed: string[] = [];
  const errors: string[] = [];

  // ---- 項目をそのまま置き換える ----
  if (a.set !== undefined) {
    if (!isObj(a.set)) errors.push("set は { 項目名: 新しい値 } の形で書いてください");
    else for (const [k, v] of Object.entries(a.set)) {
      if (k === "notes") {
        if (typeof v !== "string") errors.push("set.notes は文字列で書いてください（消すなら \"\"）");
        else if (v.trim() !== notes.trim()) { notes = v; changed.push("notes"); }
      } else if (!(SETTABLE as readonly string[]).includes(k)) {
        errors.push(`set.${k} は変えられません（変えられる項目: ${[...SETTABLE, "notes"].join(", ")}）。ジャンルや料理名の置き場所を変えたい場合は fork_recipe で新しく作ってください`);
      } else if (v === null) {
        if (!REMOVABLE.has(k)) errors.push(`set.${k} は消せません`);
        else if (k in r) { delete (r as any)[k]; changed.push(`${k} を削除`); }
      } else if (JSON.stringify((r as any)[k]) !== JSON.stringify(v)) {
        (r as any)[k] = v; changed.push(k);
      }
    }
  }

  // ---- 出典 ----
  const src = a.sources ?? {};
  if (!isObj(src)) errors.push("sources は { add, update, remove } の形で書いてください");
  else {
    const find = (url: unknown) => r.sources.findIndex((s) => s.url.trim() === String(url ?? "").trim());
    for (const u of list(src.update)) {
      const i = find(u?.url);
      if (i < 0) { errors.push(`sources.update: url "${u?.url}" の出典はありません（今の出典: ${r.sources.map((s) => s.url).join(", ") || "なし"}）`); continue; }
      const { url, new_url, ...rest } = u;
      const done = assign(r.sources[i] as any, { ...rest, ...(new_url ? { url: new_url } : {}) }, []);
      if (done.length) changed.push(`出典「${r.sources[i].name}」の ${done.join("・")}`);
    }
    for (const url of list(src.remove)) {
      const i = find(url);
      if (i < 0) errors.push(`sources.remove: url "${url}" の出典はありません`);
      else changed.push(`出典「${r.sources.splice(i, 1)[0].name}」を削除`);
    }
    for (const s of list(src.add) as Source[]) {
      if (find(s?.url) >= 0) { errors.push(`sources.add: url "${s?.url}" の出典はすでにあります。直すなら sources.update を使ってください`); continue; }
      r.sources.push(s); changed.push(`出典「${s?.name}」を追加`);
    }
  }

  // ---- 道具 ----
  const eq = a.equipment ?? {};
  if (!isObj(eq)) errors.push("equipment は { add, update, remove } の形で書いてください");
  else {
    const find = (id: unknown) => r.equipment.findIndex((e) => e.id === id);
    for (const u of list(eq.update)) {
      const i = find(u?.id);
      if (i < 0) { errors.push(`equipment.update: 道具 "${u?.id}" はこのレシピにありません`); continue; }
      const done = assign(r.equipment[i] as any, u, ["id"]);
      if (done.length) changed.push(`道具 ${u.id} の ${done.join("・")}`);
    }
    for (const id of list(eq.remove)) {
      const i = find(id);
      if (i < 0) errors.push(`equipment.remove: 道具 "${id}" はこのレシピにありません`);
      else { r.equipment.splice(i, 1); changed.push(`道具 ${id} を削除`); }
    }
    for (const e of list(eq.add)) {
      if (find(e?.id) >= 0) { errors.push(`equipment.add: 道具 "${e?.id}" はすでにあります`); continue; }
      r.equipment.push(e); changed.push(`道具 ${e?.id} を追加`);
    }
  }

  // ---- 材料 ----
  const ing = a.ingredients ?? {};
  if (!isObj(ing)) errors.push("ingredients は { add, update, remove } の形で書いてください");
  else {
    // id（と、あれば group）で1つに決める。同じ材料が複数のまとまりにあるときは group が要る
    const locate = (what: string, sel: any): { g: number; i: number } | null => {
      const hits: { g: number; i: number }[] = [];
      r.ingredients.forEach((grp, g) => grp.items.forEach((it, i) => {
        if (it.id === sel?.id && (sel?.group === undefined || grp.group === sel.group)) hits.push({ g, i });
      }));
      if (hits.length === 1) return hits[0];
      errors.push(hits.length === 0
        ? `${what}: 材料 "${sel?.id}"${sel?.group ? `（${sel.group}）` : ""} はこのレシピにありません`
        : `${what}: 材料 "${sel?.id}" は複数のまとまり（${hits.map((h) => r.ingredients[h.g].group).join("、")}）にあります。group も指定してください`);
      return null;
    };
    for (const u of list(ing.update)) {
      const at = locate("ingredients.update", u);
      if (!at) continue;
      const item = r.ingredients[at.g].items[at.i];
      const done = assign(item as any, u, ["id", "group"]);
      if (done.length) changed.push(`${r.ingredients[at.g].group} の ${item.name ?? item.id} の ${done.join("・")}`);
    }
    for (const sel of list(ing.remove)) {
      const at = locate("ingredients.remove", isObj(sel) ? sel : { id: sel });
      if (!at) continue;
      const [gone] = r.ingredients[at.g].items.splice(at.i, 1);
      changed.push(`${r.ingredients[at.g].group} の ${gone.name ?? gone.id} を削除`);
    }
    for (const add of list(ing.add)) {
      if (!isObj(add) || typeof add.group !== "string" || !add.group) { errors.push("ingredients.add: group（まとまりの名前）が必要です"); continue; }
      const { group, ...item } = add;
      let grp = r.ingredients.find((x) => x.group === group);
      if (!grp) { grp = { group, items: [] }; r.ingredients.push(grp); }
      if (grp.items.some((x) => x.id === item.id)) { errors.push(`ingredients.add: 材料 "${item.id}" は ${group} にすでにあります。直すなら ingredients.update を使ってください`); continue; }
      grp.items.push(item as Ingredient); changed.push(`${group} に ${item.name ?? item.id} を追加`);
    }
    // 材料がなくなったまとまりは消す
    r.ingredients = r.ingredients.filter((g) => g.items.length > 0);
  }

  // ---- 工程（番号は、変更前のレシピでの 1 始まりの番号） ----
  const st = a.steps ?? {};
  if (!isObj(st)) errors.push("steps は { add, update, remove } の形で書いてください");
  else {
    const n = old.steps.length;
    const valid = (what: string, no: unknown, min: number) => {
      if (Number.isInteger(no) && (no as number) >= min && (no as number) <= n) return true;
      errors.push(`${what}: 工程の番号は ${min}〜${n} で指定してください（今の工程は${n}個。get_recipe の steps の並び順で 1 から数える）`);
      return false;
    };
    const slots: { step: Step; keep: boolean; after: Step[] }[] = r.steps.map((step) => ({ step, keep: true, after: [] }));
    const first: Step[] = [];
    for (const u of list(st.update)) {
      if (!valid("steps.update", u?.step, 1)) continue;
      const done = assign(slots[u.step - 1].step as any, u, ["step"]);
      if (done.length) changed.push(`工程${u.step}「${slots[u.step - 1].step.title}」の ${done.join("・")}`);
    }
    for (const no of list(st.remove)) {
      if (!valid("steps.remove", no, 1)) continue;
      slots[no - 1].keep = false; changed.push(`工程${no}「${slots[no - 1].step.title}」を削除`);
    }
    for (const add of list(st.add)) {
      if (!isObj(add) || !valid("steps.add（after）", add.after, 0)) continue;
      const { after, ...step } = add;
      (after === 0 ? first : slots[after - 1].after).push(step as Step);
      changed.push(after === 0 ? `先頭に工程「${step.title}」を追加` : `工程${after}の後に「${step.title}」を追加`);
    }
    r.steps = [...first, ...slots.flatMap((s) => [...(s.keep ? [s.step] : []), ...s.after])];
  }

  return { recipe: r, notes, changed, errors };
}
