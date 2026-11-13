// recipes/ フォルダのファイルをすべて読み込み、確認する（validate と build-sql で共用）
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { parseRecipeFile, pathToId, validateRecipe, type RecipeFile } from "../shared/recipe.ts";
import {
  indexMasters, MASTER_PATHS, parseList, validateAllMasters,
  type MasterItem, type Substitution,
} from "../shared/masters.ts";

export interface Masters { equipment: MasterItem[]; ingredients: MasterItem[]; substitutions: Substitution[]; errors: string[] }

export function loadMasters(root = "."): Masters {
  const read = <T>(p: string) => parseList<T>(readFileSync(join(root, p), "utf8"));
  const equipment = read<MasterItem>(MASTER_PATHS.equipment);
  const ingredients = read<MasterItem>(MASTER_PATHS.ingredients);
  const substitutions = read<Substitution>(MASTER_PATHS.substitutions);
  return { equipment, ingredients, substitutions, errors: validateAllMasters(equipment, ingredients, substitutions) };
}

export interface Loaded { path: string; raw: string; sha: string; file?: RecipeFile; errors: string[] }

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".md") ? [p] : [];
  });
}

// GitHubと同じ方法でファイルの指紋（blob sha）を計算する
export function gitBlobSha(raw: string): string {
  const buf = Buffer.from(raw, "utf8");
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

export function loadAll(root = ".", masters = loadMasters(root)): Loaded[] {
  const idx = indexMasters(masters.equipment, masters.ingredients);
  const base = join(root, "recipes");
  return walk(base).sort().map((full) => {
    const path = relative(root, full).split(sep).join("/");
    const raw = readFileSync(full, "utf8");
    const out: Loaded = { path, raw, sha: gitBlobSha(raw), errors: [] };
    try {
      out.file = parseRecipeFile(raw);
      out.errors = validateRecipe(out.file.recipe, pathToId(path), idx);
    } catch (err) {
      out.errors = [(err as Error).message];
    }
    return out;
  });
}

// 同じ id が二重にないか、derived_from の先が存在するか
export function crossCheck(all: Loaded[]): string[] {
  const ids = new Set(all.map((l) => l.file?.recipe.id).filter(Boolean));
  const e: string[] = [];
  for (const l of all) {
    const d = l.file?.recipe.derived_from;
    if (d && !ids.has(d.id)) e.push(`${l.path}: 元レシピ ${d.id} が見つかりません`);
  }
  return e;
}
