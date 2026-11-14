// recipes/ と masters/ のファイルから、D1 に入っているべき行を作る（build-sql と sync で共用）
import { ROW_COLUMNS, toRow } from "../shared/recipe.ts";
import { crossCheck, loadAll, loadMasters } from "./load.ts";

export type Row = Record<string, string | number | null>;
export interface TableSpec { name: string; key: string[]; columns: string[] }

export const TABLES: TableSpec[] = [
  { name: "masters", key: ["kind", "id"], columns: ["kind", "id", "name_ja", "name_en", "category", "parent", "provides", "aliases", "data"] },
  { name: "substitutions", key: ["kind", "from_id", "to_id"], columns: ["kind", "from_id", "to_id", "both", "data"] },
  { name: "recipes", key: ["id"], columns: ROW_COLUMNS as string[] },
];

export const q = (v: unknown) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

export const insertSql = (t: TableSpec, row: Row, verb = "INSERT") =>
  `${verb} INTO ${t.name} (${t.columns.join(", ")}) VALUES (${t.columns.map((c) => q(row[c])).join(", ")});`;

// 様式に合わないファイルがあれば止める
export function desiredRows(): Record<string, Row[]> {
  const masters = loadMasters();
  const all = loadAll(".", masters);
  if (all.some((l) => l.errors.length) || crossCheck(all).length || masters.errors.length) {
    console.error("様式に合わないファイルがあります。先に npm run check で確認してください。");
    process.exit(1);
  }
  const masterRows: Row[] = [];
  for (const kind of ["equipment", "ingredients"] as const) {
    for (const m of masters[kind]) {
      masterRows.push({
        kind, id: m.id, name_ja: m.name_ja, name_en: m.name_en, category: m.category, parent: m.parent ?? null,
        provides: JSON.stringify(m.provides ?? []), aliases: JSON.stringify(m.aliases ?? []), data: JSON.stringify(m),
      });
    }
  }
  return {
    masters: masterRows,
    substitutions: masters.substitutions.map((s) => ({ kind: s.kind, from_id: s.from, to_id: s.to, both: s.both ? 1 : 0, data: JSON.stringify(s) })),
    recipes: all.map((l) => toRow(l.file!, l.raw, l.sha) as unknown as Row),
  };
}
