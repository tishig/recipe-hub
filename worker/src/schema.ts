// AIに見せるレシピ入力の形（JSON Schema）。サーバーが付ける項目（id, author, 日付, status, derived_from）は含めない。
import { UNITS } from "../../shared/recipe.ts";

const slug = { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" };
const posNum = { type: "number", exclusiveMinimum: 0 };

export const recipeInputSchema = {
  type: "object",
  required: ["title", "genre", "genre_name", "group", "group_name", "dish", "dish_name", "yield", "sources", "equipment", "ingredients", "steps"],
  properties: {
    title: { type: "string", description: "Display title, e.g. 'ダッチアップルパイ（改訂60%版）'" },
    genre: { ...slug, description: "Cuisine genre slug (lowercase English), e.g. 'western-sweets'. Reuse existing ones from list_categories." },
    genre_name: { type: "string", description: "Genre name in the recipe's language, e.g. '洋菓子'" },
    group: { ...slug, description: "Dish group slug, e.g. 'pie'" },
    group_name: { type: "string", description: "e.g. 'パイ'" },
    dish: { ...slug, description: "Dish slug, e.g. 'dutch-apple-pie'. Same dish may have many recipes." },
    dish_name: { type: "string", description: "e.g. 'ダッチアップルパイ'" },
    summary: { type: "string" },
    yield: {
      type: "object", required: ["amount", "unit"],
      properties: { amount: posNum, unit: { type: "string", description: "e.g. 人分, 台, 個" }, note: { type: "string" } },
    },
    sources: {
      type: "array",
      description: "Every outside source this recipe draws on, each with a link. MANDATORY whenever ANY part (ingredients, amounts, method, idea) came from a website, video, book, magazine, package or another person's recipe, including recipes you or the user adapted, scaled or translated. For a book or magazine, link to its publisher or bookstore page. Use [] ONLY for a recipe the user invented themselves. Never invent a URL: if the user used a source but you do not have the link, ask the user for it before registering.",
      items: {
        type: "object", required: ["name", "url", "accessed"],
        properties: { name: { type: "string", description: "Site, video, book or author name" }, url: { type: "string", description: "Link to the source (http:// or https://)" }, accessed: { type: "string", description: "YYYY-MM-DD" } },
      },
    },
    tags: { type: "array", items: { type: "string" } },
    equipment: {
      type: "array", minItems: 1,
      description: "All equipment used. ids must come from the equipment master list (list_master kind=equipment). Add missing ones with add_master_item first.",
      items: { type: "object", required: ["id"], properties: { id: { type: "string" }, note: { type: "string", description: "Size or detail, e.g. '直径23cm'" } } },
    },
    ingredients: {
      type: "array", minItems: 1,
      items: {
        type: "object", required: ["group", "items"],
        properties: {
          group: { type: "string", description: "Group label, e.g. 'パイ生地', 'フィリング'" },
          items: {
            type: "array", minItems: 1,
            items: {
              type: "object", required: ["id", "unit"],
              properties: {
                id: { type: "string", description: "Ingredient id from the master list (list_master kind=ingredients). Add missing ones with add_master_item first." },
                name: { type: "string", description: "Display name in this recipe. Omit to use the master list's Japanese name." },
                amount: { ...posNum, description: "Number only. Fractions as decimals (1/4 tsp -> 0.25). Omit only for 少々/適量." },
                unit: { type: "string", enum: [...UNITS] },
                approx_g: { ...posNum, description: "Approximate grams for spoon/cup measures" },
                original: { type: "string", description: "Original notation, e.g. '3 lb'" },
                optional: { type: "boolean" },
                note: { type: "string" },
              },
            },
          },
        },
      },
    },
    steps: {
      type: "array", minItems: 1,
      items: {
        type: "object", required: ["title", "text"],
        properties: {
          title: { type: "string" },
          text: { type: "string" },
          minutes: { ...posNum, description: "Duration in minutes" },
          minutes_min: posNum,
          minutes_max: posNum,
          oven_c: { ...posNum, description: "Oven temperature in °C. Required if the text mentions an oven temperature." },
          heat: { type: "string", description: "弱火 / 中火 / 強火 etc." },
          temp_c: { ...posNum, description: "Oil or liquid temperature in °C" },
          equipment: { type: "array", items: { type: "string" }, description: "Equipment ids used in this step (subset of the recipe's equipment). Must include a heat source when oven_c, heat or temp_c is set." },
        },
      },
    },
    notes: { type: "string", description: "Free-form Markdown notes for humans (tips, why amounts were rounded, etc.)" },
  },
} as const;

export const masterItemSchema = {
  type: "object",
  required: ["id", "name_ja", "name_en", "category"],
  properties: {
    id: { ...slug, description: "Lowercase English slug, e.g. 'pie-dish'" },
    name_ja: { type: "string" },
    name_en: { type: "string" },
    category: {
      type: "string",
      description: "equipment: heat-source, cookware, bakeware, tool, appliance, storage, consumable / ingredients: vegetable, fruit, meat, seafood, dairy-egg, grain-flour, sugar-sweetener, seasoning, spice-herb, oil-fat, other",
    },
    aliases: { type: "array", items: { type: "string" }, description: "Other names for the same thing" },
    parent: { type: "string", description: "Ingredients only: broader ingredient id (unsalted-butter -> butter)" },
    provides: { type: "array", items: { type: "string" }, description: "Equipment only: equipment ids this one can also serve as (microwave-oven -> oven, microwave)" },
    note: { type: "string" },
  },
} as const;

export const substitutionSchema = {
  type: "object",
  required: ["kind", "from", "to", "both", "note"],
  properties: {
    kind: { type: "string", enum: ["ingredient", "equipment"] },
    from: { type: "string", description: "Master id of what the recipe calls for" },
    to: { type: "string", description: "Master id of what can be used instead" },
    ratio: { ...posNum, description: "Amount of 'to' per 1 of 'from' (ingredients)" },
    both: { type: "boolean", description: "true if it also works the other way" },
    note: { type: "string", description: "How to substitute and what changes (time, temperature, taste)" },
  },
} as const;
