// マスターリスト（道具・材料の正式な一覧）と互換表
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const EQUIPMENT_CATEGORIES = ["heat-source", "cookware", "bakeware", "tool", "appliance", "storage", "consumable"] as const;
export const INGREDIENT_CATEGORIES = [
  "vegetable", "fruit", "meat", "seafood", "dairy-egg", "grain-flour", "sugar-sweetener",
  "seasoning", "spice-herb", "oil-fat", "other",
] as const;

export interface MasterItem {
  id: string;
  name_ja: string;
  name_en: string;
  category: string;
  aliases?: string[];
  parent?: string;      // 材料のみ: より広い分類（無塩バター → バター）
  provides?: string[];  // 道具のみ: 兼ねる道具（オーブンレンジ → オーブン, 電子レンジ）
  note?: string;
  added_by: string;
}
export interface Substitution {
  kind: "ingredient" | "equipment";
  from: string;
  to: string;
  ratio?: number;
  both: boolean;
  note: string;
  added_by: string;
}
export type MasterKind = "equipment" | "ingredients";

export const MASTER_PATHS = {
  equipment: "masters/equipment.yaml",
  ingredients: "masters/ingredients.yaml",
  substitutions: "masters/substitutions.yaml",
} as const;

const HEADERS = {
  equipment: "# 道具のマスターリスト。provides: この道具が兼ねる道具\n",
  ingredients: "# 材料のマスターリスト。parent: より広い分類の材料（無塩バター → バター）\n",
  substitutions: "# 互換表。from の代わりに to を使える。both: true なら逆向きも可。ratio: from 1 に対する to の量\n",
};

export function parseList<T>(raw: string): T[] {
  const v = parseYaml(raw);
  return Array.isArray(v) ? (v as T[]) : [];
}
export function serializeList(kind: keyof typeof HEADERS, items: unknown[]): string {
  return HEADERS[kind] + stringifyYaml(items, { lineWidth: 0 });
}

// 名前の重複を見つけるための正規化（全角半角・大文字小文字・空白をそろえる）
export const normName = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s・\-_]/g, "");

export interface MasterIndex {
  equipment: Map<string, MasterItem>;
  ingredients: Map<string, MasterItem>;
}
export function indexMasters(equipment: MasterItem[], ingredients: MasterItem[]): MasterIndex {
  return { equipment: new Map(equipment.map((x) => [x.id, x])), ingredients: new Map(ingredients.map((x) => [x.id, x])) };
}

// 1項目の確認。existing は同じ種類の既存項目（重複の確認用）
export function validateMasterItem(kind: MasterKind, it: any, existing: MasterItem[]): string[] {
  const e: string[] = [];
  const cats: readonly string[] = kind === "equipment" ? EQUIPMENT_CATEGORIES : INGREDIENT_CATEGORIES;
  if (!it?.id || !SLUG.test(it.id)) e.push(`id は英小文字・数字・ハイフンのみ: "${it?.id}"`);
  if (!it?.name_ja) e.push("name_ja（日本語名）がありません");
  if (!it?.name_en) e.push("name_en（英語名）がありません");
  if (!cats.includes(it?.category)) e.push(`category は ${cats.join(", ")} のどれか`);
  if (kind === "equipment" && it?.parent) e.push("道具には parent ではなく provides（兼ねる道具）を使います");
  if (kind === "ingredients" && it?.provides) e.push("材料には provides ではなく parent（より広い分類）を使います");
  const ids = new Set(existing.map((x) => x.id));
  if (it?.parent && !ids.has(it.parent)) e.push(`parent "${it.parent}" はマスターリストにありません`);
  for (const p of it?.provides ?? []) if (!ids.has(p)) e.push(`provides "${p}" はマスターリストにありません`);

  // 同じものが別の id で二重登録されるのを防ぐ
  const names = [it?.name_ja, it?.name_en, ...(it?.aliases ?? [])].filter(Boolean).map(normName);
  for (const x of existing) {
    if (x.id === it?.id) { e.push(`id "${it.id}" は登録済みです`); continue; }
    const theirs = [x.name_ja, x.name_en, ...(x.aliases ?? [])].map(normName);
    const hit = names.find((n) => theirs.includes(n));
    if (hit) e.push(`同じ名前の項目が登録済みです: ${x.id}（${x.name_ja}）。それを使うか、別名（aliases）への追加を検討してください`);
  }
  return e;
}

export function validateSubstitution(s: any, idx: MasterIndex, existing: Substitution[]): string[] {
  const e: string[] = [];
  if (s?.kind !== "ingredient" && s?.kind !== "equipment") return ["kind は ingredient か equipment"];
  const map = s.kind === "equipment" ? idx.equipment : idx.ingredients;
  if (!map.has(s.from)) e.push(`from "${s.from}" はマスターリストにありません`);
  if (!map.has(s.to)) e.push(`to "${s.to}" はマスターリストにありません`);
  if (s.from === s.to) e.push("from と to が同じです");
  if (!s.note) e.push("note（使い方や注意点）が必要です");
  if (s.ratio !== undefined && (typeof s.ratio !== "number" || s.ratio <= 0)) e.push("ratio は正の数値で");
  if (typeof s.both !== "boolean") e.push("both は true か false");
  const dup = existing.find((x) => x.kind === s.kind && ((x.from === s.from && x.to === s.to) || (x.both && x.from === s.to && x.to === s.from)));
  if (dup) e.push(`同じ組み合わせが登録済みです: ${dup.from} → ${dup.to}`);
  return e;
}

// マスターリスト全体の確認（手元の道具と Actions で使う）
export function validateAllMasters(eq: MasterItem[], ing: MasterItem[], subs: Substitution[]): string[] {
  const out: string[] = [];
  const check = (kind: MasterKind, list: MasterItem[]) =>
    list.forEach((it, i) => {
      const others = list.filter((_, j) => j !== i);
      for (const err of validateMasterItem(kind, it, others)) out.push(`${MASTER_PATHS[kind]} ${it?.id}: ${err}`);
    });
  check("equipment", eq);
  check("ingredients", ing);
  const idx = indexMasters(eq, ing);
  subs.forEach((s, i) => {
    for (const err of validateSubstitution(s, idx, subs.slice(0, i))) out.push(`${MASTER_PATHS.substitutions} ${s?.from}→${s?.to}: ${err}`);
  });
  return [...new Set(out)];
}
