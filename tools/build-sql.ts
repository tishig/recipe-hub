// 使い方: npm run build
// recipes/ と masters/ の全ファイルから、D1の中身を丸ごと入れ替えるSQLを build/recipes.sql に書き出す。
// 初めての設定と、手元の試験用。ふだんの同期は、変わった行だけを書く tools/sync.ts を使う。
import { mkdirSync, writeFileSync } from "node:fs";
import { desiredRows, insertSql, TABLES } from "./rows.ts";

const rows = desiredRows();
const lines = ["DELETE FROM recipes;", "DELETE FROM masters;", "DELETE FROM substitutions;"];
for (const t of TABLES) for (const row of rows[t.name]) lines.push(insertSql(t, row));

mkdirSync("build", { recursive: true });
writeFileSync("build/recipes.sql", lines.join("\n") + "\n");
console.log(`build/recipes.sql に レシピ${rows.recipes.length}件、マスター${rows.masters.length}件、互換${rows.substitutions.length}件を書き出しました`);
