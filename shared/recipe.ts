// レシピの読み込み・確認・書き出し。Workers と手元の道具（tools/）の両方で使う。
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { MasterIndex } from "./masters.ts";

export const UNITS = [
  "g", "kg", "mL", "L", "tsp", "tbsp", "cup",
  "個", "枚", "本", "片", "束", "株", "粒", "切れ", "尾", "杯",
  "少々", "適量", "pinch",
] as const;
const UNITS_WITHOUT_AMOUNT = new Set(["少々", "適量"]);
export const STATUSES = ["published"] as const; // 将来、非公開などを足せるよう項目は残す
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface Ingredient {
  id: string;   // マスターリストの材料 id
  name: string; // 表示名（省略するとサーバーがマスターの日本語名を入れる）
  amount?: number;
  unit: string;
  approx_g?: number;
  original?: string;
  optional?: boolean;
  note?: string;
}
export interface IngredientGroup { group: string; items: Ingredient[] }
export interface Step {
  title: string;
  text: string;
  minutes?: number;
  minutes_min?: number;
  minutes_max?: number;
  oven_c?: number;
  heat?: string;
  temp_c?: number;
  equipment?: string[]; // この工程で使う道具の id（レシピの equipment に含まれるもの）
}
export interface EquipmentUse { id: string; note?: string }
export interface Source { name: string; url: string; accessed: string }
export interface DerivedFrom { id: string; author: string; relation: "fork"; note?: string }

export interface Recipe {
  id: string;
  title: string;
  genre: string; genre_name: string;
  group: string; group_name: string;
  dish: string; dish_name: string;
  author: string;
  created: string;
  updated: string;
  status: (typeof STATUSES)[number];
  summary?: string;
  yield: { amount: number; unit: string; note?: string };
  derived_from: DerivedFrom | null;
  sources: Source[];
  tags?: string[];
  equipment: EquipmentUse[];
  ingredients: IngredientGroup[];
  steps: Step[];
}

export interface RecipeFile { recipe: Recipe; notes: string }

// AIが送ってくる内容（サーバーが付ける項目を除いたもの）
export type RecipeInput = Omit<Recipe, "id" | "author" | "created" | "updated" | "status" | "derived_from"> & { notes?: string };

// ---------- 読み込みと書き出し ----------

export function parseRecipeFile(text: string): RecipeFile {
  const m = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error("ファイルの先頭に --- で囲んだ項目欄がありません");
  const recipe = parseYaml(m[1]) as Recipe;
  // YAMLが日付を Date 型にしてしまう場合に備えて文字列に戻す
  for (const k of ["created", "updated"] as const) {
    const v = (recipe as any)[k];
    if (v instanceof Date) (recipe as any)[k] = v.toISOString().slice(0, 10);
  }
  for (const s of recipe.sources ?? []) {
    if ((s as any).accessed instanceof Date) (s as any).accessed = (s as any).accessed.toISOString().slice(0, 10);
  }
  return { recipe, notes: m[2].trim() };
}

const KEY_ORDER: (keyof Recipe)[] = [
  "id", "title", "genre", "genre_name", "group", "group_name", "dish", "dish_name",
  "author", "created", "updated", "status", "summary", "yield", "derived_from",
  "sources", "tags", "equipment", "ingredients", "steps",
];

export function serializeRecipeFile({ recipe, notes }: RecipeFile): string {
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) if (recipe[k] !== undefined) ordered[k] = recipe[k];
  const yaml = stringifyYaml(ordered, { lineWidth: 0 });
  return `---\n${yaml}---\n${notes ? `\n${notes.trim()}\n` : ""}`;
}

// ---------- 確認 ----------

// masters を渡すと、道具と材料の id がマスターリストにあるかも確かめる
export function validateRecipe(r: any, expectedId?: string, masters?: MasterIndex): string[] {
  const e: string[] = [];
  const req = (k: string) => {
    if (r?.[k] === undefined || r?.[k] === null || r?.[k] === "") e.push(`${k} がありません`);
  };
  if (typeof r !== "object" || r === null) return ["レシピの中身が空です"];

  for (const k of ["id", "title", "genre", "genre_name", "group", "group_name", "dish", "dish_name",
    "author", "created", "updated", "status", "yield", "equipment", "ingredients", "steps"]) req(k);
  if (!("derived_from" in r)) e.push("derived_from がありません（元がなければ null）");
  if (!Array.isArray(r.sources)) e.push("sources は一覧で書いてください（なければ []）");

  for (const k of ["genre", "group", "dish"]) {
    if (r[k] && !SLUG.test(r[k])) e.push(`${k} は英小文字・数字・ハイフンのみ: "${r[k]}"`);
  }
  if (r.author && !SLUG.test(r.author)) e.push(`author は英小文字・数字・ハイフンのみ: "${r.author}"`);
  for (const k of ["created", "updated"]) if (r[k] && !DATE.test(r[k])) e.push(`${k} は YYYY-MM-DD 形式で`);
  if (r.status && !STATUSES.includes(r.status)) e.push(`status は ${STATUSES.join(" / ")} のどれか`);

  if (r.id && r.genre && r.group && r.dish) {
    const prefix = `${r.genre}/${r.group}/${r.dish}/`;
    if (!r.id.startsWith(prefix)) e.push(`id がジャンル・グループ・料理名と合っていません: ${r.id}`);
  }
  if (expectedId && r.id !== expectedId) e.push(`id（${r.id}）がファイルの置き場所（${expectedId}）と合っていません`);

  if (r.yield) {
    if (typeof r.yield.amount !== "number" || r.yield.amount <= 0) e.push("yield.amount は正の数値で");
    if (!r.yield.unit) e.push("yield.unit がありません");
  }

  if (r.derived_from) {
    const d = r.derived_from;
    if (!d.id || !d.author) e.push("derived_from には id と author が必要です");
    if (d.relation !== "fork") e.push("derived_from.relation は fork");
  }

  (Array.isArray(r.sources) ? r.sources : []).forEach((s: any, i: number) => {
    if (!s?.name || !s?.url || !s?.accessed) e.push(`sources[${i}] には name・url・accessed が必要です`);
    else if (!/^https?:\/\//.test(s.url)) e.push(`sources[${i}].url は http(s):// で始めてください`);
    else if (!DATE.test(String(s.accessed))) e.push(`sources[${i}].accessed は YYYY-MM-DD 形式で`);
  });

  const eqIds = new Set<string>();
  if (!Array.isArray(r.equipment) || r.equipment.length === 0) e.push("equipment（使う道具）が空です");
  else r.equipment.forEach((q: any, i: number) => {
    if (!q?.id) { e.push(`equipment[${i}].id がありません`); return; }
    eqIds.add(q.id);
    if (masters && !masters.equipment.has(q.id)) e.push(`道具 "${q.id}" はマスターリストにありません。list_master で探し、なければ add_master_item で追加してください`);
  });

  if (!Array.isArray(r.ingredients) || r.ingredients.length === 0) e.push("ingredients が空です");
  else r.ingredients.forEach((g: any, gi: number) => {
    if (!g?.group) e.push(`ingredients[${gi}].group（まとまりの名前）がありません`);
    if (!Array.isArray(g?.items) || g.items.length === 0) { e.push(`ingredients[${gi}].items が空です`); return; }
    g.items.forEach((it: any, ii: number) => {
      const where = `材料「${it?.name ?? `${gi}-${ii}`}」`;
      if (!it?.name) e.push(`ingredients[${gi}].items[${ii}].name がありません`);
      if (!it?.id) e.push(`${where}: id（マスターリストの材料 id）がありません`);
      else if (masters && !masters.ingredients.has(it.id)) e.push(`${where}: 材料 "${it.id}" はマスターリストにありません。list_master で探し、なければ add_master_item で追加してください`);
      if (!UNITS.includes(it?.unit)) e.push(`${where}: 単位 "${it?.unit}" は使えません（使える単位: ${UNITS.join(", ")}）`);
      if (UNITS_WITHOUT_AMOUNT.has(it?.unit)) {
        if (it.amount !== undefined && typeof it.amount !== "number") e.push(`${where}: amount は数値で`);
      } else if (typeof it?.amount !== "number" || !(it.amount > 0)) {
        e.push(`${where}: amount は正の数値で（分数は小数に。例 1/4 → 0.25）`);
      }
      if (it?.approx_g !== undefined && (typeof it.approx_g !== "number" || it.approx_g <= 0)) e.push(`${where}: approx_g は正の数値で`);
    });
  });

  if (!Array.isArray(r.steps) || r.steps.length === 0) e.push("steps が空です");
  else r.steps.forEach((s: any, i: number) => {
    const where = `工程${i + 1}「${s?.title ?? ""}」`;
    if (!s?.title) e.push(`工程${i + 1}: title がありません`);
    if (!s?.text) e.push(`${where}: text がありません`);
    for (const k of ["minutes", "minutes_min", "minutes_max", "oven_c", "temp_c"]) {
      if (s?.[k] !== undefined && (typeof s[k] !== "number" || s[k] <= 0)) e.push(`${where}: ${k} は正の数値で`);
    }
    if ((s?.minutes_min !== undefined) !== (s?.minutes_max !== undefined)) e.push(`${where}: minutes_min と minutes_max は両方そろえて`);
    if (s?.minutes_min > s?.minutes_max) e.push(`${where}: minutes_min が minutes_max より大きいです`);
    if (s?.equipment !== undefined) {
      if (!Array.isArray(s.equipment)) e.push(`${where}: equipment は道具 id の一覧で`);
      else for (const q of s.equipment) if (!eqIds.has(q)) e.push(`${where}: 道具 "${q}" がレシピの equipment にありません`);
    }
    // 加熱する工程には加熱機器を書く（持っていない家庭で外したり置き換えたりするため）
    if (masters && (s?.oven_c !== undefined || s?.heat !== undefined || s?.temp_c !== undefined)) {
      const heats = (Array.isArray(s.equipment) ? s.equipment : []).filter((q: string) => masters.equipment.get(q)?.category === "heat-source");
      if (heats.length === 0) e.push(`${where}: 加熱する工程です。equipment に加熱機器（oven, stove など）を入れてください`);
    }
    // 本文に温度や時間が書いてあるのに項目がない場合（ロボットが読めない）
    if (s?.text && /\d+\s*℃/.test(s.text) && s.oven_c === undefined && s.temp_c === undefined) {
      e.push(`${where}: 本文に温度があります。oven_c か temp_c にも入れてください`);
    }
  });

  return e;
}

// ---------- 置き場所 ----------

export function recipeDir(r: Pick<Recipe, "genre" | "group" | "dish">): string {
  return `${r.genre}/${r.group}/${r.dish}`;
}
export function idToPath(id: string): string {
  return `recipes/${id}.md`;
}
export function pathToId(path: string): string {
  return path.replace(/^recipes\//, "").replace(/\.md$/, "");
}

// ---------- データベース（D1）用の1行 ----------

export interface RecipeRow {
  id: string; path: string; title: string;
  genre: string; genre_name: string; grp: string; group_name: string;
  dish: string; dish_name: string; author: string; status: string;
  created: string; updated: string; derived_from: string | null; relation: string | null;
  tags: string; ingredients_text: string; summary: string;
  equipment_ids: string; ingredient_ids: string;
  body: string; sha: string;
}

export function toRow(file: RecipeFile, raw: string, sha: string): RecipeRow {
  const r = file.recipe;
  return {
    id: r.id, path: idToPath(r.id), title: r.title,
    genre: r.genre, genre_name: r.genre_name, grp: r.group, group_name: r.group_name,
    dish: r.dish, dish_name: r.dish_name, author: r.author, status: r.status,
    created: r.created, updated: r.updated,
    derived_from: r.derived_from?.id ?? null, relation: r.derived_from?.relation ?? null,
    tags: (r.tags ?? []).join(" "),
    ingredients_text: r.ingredients.flatMap((g) => g.items.map((i) => `${i.name} ${i.id}`)).join(" "),
    equipment_ids: JSON.stringify(r.equipment.map((q) => q.id)),
    ingredient_ids: JSON.stringify(r.ingredients.flatMap((g) => g.items.map((i) => (i.optional ? { id: i.id, optional: true } : { id: i.id })))),
    summary: r.summary ?? "",
    body: raw, sha,
  };
}

export const ROW_COLUMNS: (keyof RecipeRow)[] = [
  "id", "path", "title", "genre", "genre_name", "grp", "group_name", "dish", "dish_name",
  "author", "status", "created", "updated", "derived_from", "relation", "tags",
  "ingredients_text", "summary", "equipment_ids", "ingredient_ids", "body", "sha",
];
