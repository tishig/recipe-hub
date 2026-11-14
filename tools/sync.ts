// 使い方: npm run db:sync:remote（手元の試験用のデータベースには db:sync:local）
// recipes/ と masters/ のファイルを D1 の今の中身と比べ、違う行だけを書き換える。
// - ファイルにあって D1 にない行・中身が違う行 → 入れる（INSERT OR REPLACE）
// - D1 にあってファイルにない行 → 消す
// 同じなら何も書かない。途中で失敗しても、もう一度実行すれば同じ結果になる。
//   --dry-run  何が変わるかを表示するだけで、書き込まない
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { desiredRows, insertSql, q, TABLES, type Row, type TableSpec } from "./rows.ts";

const args = process.argv.slice(2);
const target = args.includes("--remote") ? "--remote" : args.includes("--local") ? "--local" : null;
const dryRun = args.includes("--dry-run");
if (!target) { console.error("--remote か --local を指定してください"); process.exit(1); }

const DB = "recipes";
function wrangler(extra: string[]): string {
  return execFileSync("npx", ["wrangler", "d1", "execute", DB, target!, ...extra], {
    encoding: "utf8", maxBuffer: 1024 * 1024 * 512, stdio: ["ignore", "pipe", "inherit"],
  });
}

// レシピの本文（body）はファイルそのものなので、指紋（sha）が同じなら同じ。大きいので読み出さない
const compared = (t: TableSpec) => t.columns.filter((c) => !(t.name === "recipes" && c === "body"));

function currentRows(t: TableSpec): Row[] {
  const out = wrangler(["--json", "--command", `SELECT ${compared(t).join(", ")} FROM ${t.name}`]);
  // 今の中身を読めなかったときは、何も書かずに止める（空とみなして全部入れ直したりしない）
  try {
    const start = out.search(/^\[/m);
    const results = JSON.parse(out.slice(start))[0]?.results;
    if (start < 0 || !Array.isArray(results)) throw new Error("results がありません");
    return results as Row[];
  } catch (err) {
    console.error(`${t.name} の今の中身を読めませんでした: ${(err as Error).message}\n${out.slice(0, 500)}`);
    return process.exit(1);
  }
}

const keyOf = (t: TableSpec, r: Row) => t.key.map((k) => String(r[k])).join("\u0000");
const same = (t: TableSpec, a: Row, b: Row) => compared(t).every((c) => String(a[c] ?? null) === String(b[c] ?? null));

const desired = desiredRows();
const sql: string[] = [];
const summary: string[] = [];
for (const t of TABLES) {
  const now = new Map(currentRows(t).map((r) => [keyOf(t, r), r]));
  const want = new Map(desired[t.name].map((r) => [keyOf(t, r), r]));
  let added = 0, changed = 0, removed = 0;
  for (const [k, row] of want) {
    const cur = now.get(k);
    if (cur && same(t, cur, row)) continue;
    cur ? changed++ : added++;
    sql.push(insertSql(t, row, "INSERT OR REPLACE"));
    console.log(`${cur ? "直す" : "足す"}: ${t.name} ${t.key.map((c) => row[c]).join(" / ")}`);
  }
  for (const [k, row] of now) {
    if (want.has(k)) continue;
    removed++;
    sql.push(`DELETE FROM ${t.name} WHERE ${t.key.map((c) => `${c} = ${q(row[c])}`).join(" AND ")};`);
    console.log(`消す: ${t.name} ${t.key.map((c) => row[c]).join(" / ")}`);
  }
  summary.push(`${t.name}: ${want.size}件中 足す${added}・直す${changed}・消す${removed}`);
}

console.log(summary.join("\n"));
if (!sql.length) { console.log("D1 はファイルと同じです。何も書き込みません。"); process.exit(0); }
if (dryRun) { console.log(`--dry-run のため書き込みません（${sql.length}行分）`); process.exit(0); }

mkdirSync("build", { recursive: true });
writeFileSync("build/sync.sql", sql.join("\n") + "\n");
wrangler(["--file=build/sync.sql", "--yes"]);
console.log(`${sql.length}行分を書き込みました`);
