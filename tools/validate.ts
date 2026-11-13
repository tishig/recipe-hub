// 使い方: npm run check
import { crossCheck, loadAll, loadMasters } from "./load.ts";

const masters = loadMasters();
for (const e of masters.errors) console.error(`✗ ${e}`);
console.log(`マスターリスト: 道具 ${masters.equipment.length}件、材料 ${masters.ingredients.length}件、互換表 ${masters.substitutions.length}件${masters.errors.length ? "（問題あり）" : ""}`);

const all = loadAll(".", masters);
let bad = 0;
for (const l of all) {
  if (l.errors.length) {
    bad++;
    console.error(`✗ ${l.path}`);
    for (const e of l.errors) console.error(`    - ${e}`);
  } else {
    console.log(`✓ ${l.path}`);
  }
}
const cross = crossCheck(all);
for (const e of cross) console.error(`✗ ${e}`);

console.log(`\n${all.length}件中 ${all.length - bad}件が様式どおり`);
if (bad || cross.length || masters.errors.length) process.exit(1);
