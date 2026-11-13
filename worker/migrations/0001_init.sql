-- レシピの写し（正本はGitHub）。検索と読み込みに使う。
CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  genre TEXT NOT NULL,
  genre_name TEXT NOT NULL,
  grp TEXT NOT NULL,
  group_name TEXT NOT NULL,
  dish TEXT NOT NULL,
  dish_name TEXT NOT NULL,
  author TEXT NOT NULL,
  status TEXT NOT NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  derived_from TEXT,
  relation TEXT,
  tags TEXT NOT NULL DEFAULT '',
  ingredients_text TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  equipment_ids TEXT NOT NULL DEFAULT '[]',   -- 使う道具の id（JSON）
  ingredient_ids TEXT NOT NULL DEFAULT '[]',  -- 使う材料の id（JSON、省略可なら optional: true）
  body TEXT NOT NULL,
  sha TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recipes_dish ON recipes (genre, grp, dish);
CREATE INDEX IF NOT EXISTS idx_recipes_derived ON recipes (derived_from);
CREATE INDEX IF NOT EXISTS idx_recipes_author ON recipes (author);

-- マスターリストと互換表の写し（正本は masters/*.yaml）
CREATE TABLE IF NOT EXISTS masters (
  kind TEXT NOT NULL,          -- equipment / ingredients
  id TEXT NOT NULL,
  name_ja TEXT NOT NULL,
  name_en TEXT NOT NULL,
  category TEXT NOT NULL,
  parent TEXT,
  provides TEXT NOT NULL DEFAULT '[]',
  aliases TEXT NOT NULL DEFAULT '[]',
  data TEXT NOT NULL,          -- 項目全体（JSON）
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS substitutions (
  kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  both INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (kind, from_id, to_id)
);
