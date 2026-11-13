// 使い方: npm run build
// recipes/ の全ファイルから、D1の中身を丸ごと入れ替えるSQLを build/recipes.sql に書き出す
import { mkdirSync, writeFileSync } from "node:fs";
import { ROW_COLUMNS, toRow } from "../shared/recipe.ts";
import { crossCheck, loadAll, loadMasters } from "./load.ts";

const masters = loadMasters();
const all = loadAll(".", masters);
const broken = all.filter((l) => l.errors.length);
if (broken.length || crossCheck(all).length || masters.errors.length) {
  console.error("様式に合わないファイルがあります。先に npm run check で確認してください。");
  process.exit(1);
}

const q = (v: unknown) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

const lines = ["DELETE FROM recipes;", "DELETE FROM masters;", "DELETE FROM substitutions;"];
for (const kind of ["equipment", "ingredients"] as const) {
  for (const m of masters[kind]) {
    lines.push(`INSERT INTO masters (kind, id, name_ja, name_en, category, parent, provides, aliases, data) VALUES (${[
      kind, m.id, m.name_ja, m.name_en, m.category, m.parent ?? null,
      JSON.stringify(m.provides ?? []), JSON.stringify(m.aliases ?? []), JSON.stringify(m),
    ].map(q).join(", ")});`);
  }
}
for (const s of masters.substitutions) {
  lines.push(`INSERT INTO substitutions (kind, from_id, to_id, both, data) VALUES (${[s.kind, s.from, s.to, s.both ? 1 : 0, JSON.stringify(s)].map(q).join(", ")});`);
}
for (const l of all) {
  const row = toRow(l.file!, l.raw, l.sha);
  lines.push(
    `INSERT INTO recipes (${ROW_COLUMNS.join(", ")}) VALUES (${ROW_COLUMNS.map((c) => q(row[c])).join(", ")});`,
  );
}

mkdirSync("build", { recursive: true });
writeFileSync("build/recipes.sql", lines.join("\n") + "\n");
console.log(`build/recipes.sql に レシピ${all.length}件、道具${masters.equipment.length}件、材料${masters.ingredients.length}件、互換${masters.substitutions.length}件を書き出しました`);
