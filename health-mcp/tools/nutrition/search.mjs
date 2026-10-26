import { z } from 'zod';
import { ToolError, validationError, errorResult, jsonResult, num, round2 } from './common.mjs';

export const SEARCH_FOODS_DESCRIPTION =
  "Search the user's saved favorite foods by name or alias (typo and word-order tolerant). " +
  'Results are ranked exact alias match first, then similarity, then how often the favorite is used. ' +
  'Use before estimating a food: if a favorite matches, log it with match_source favorite and its my_food_id. ' +
  'The USDA database is not loaded yet, so `usda` is always empty.';

// Exactly these filler words are stripped for the second query variant.
const FILLER = /\b(?:my|usual|regular|normal|the)\b/g;

export function normalizeText(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

export function stripFiller(norm) {
  return norm.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
}

export function queryVariants(query) {
  const v1 = normalizeText(query);
  const stripped = stripFiller(v1);
  return { v1, v2: stripped === '' ? v1 : stripped };
}

// Exact: the alias equals the query, or (query had filler words) the alias with
// filler removed equals the query with filler removed.
export function isExact(aliasNorm, v1, v2) {
  if (aliasNorm === v1) return true;
  return v2 !== v1 && stripFiller(aliasNorm) === v2;
}

const SQL = `
  SELECT f.id, f.name, f.serving_qty, f.serving_unit, f.serving_grams, f.calories, f.protein_g, f.carbs_g,
         f.fat_g, f.fiber_g, f.sugar_g, f.sodium_mg, f.confidence, f.basis, f.use_count,
         a.alias_norm,
         greatest(word_similarity($1, a.alias_norm), word_similarity($2, a.alias_norm)) AS score
    FROM my_food_aliases a
    JOIN my_foods f ON f.id = a.my_food_id
   WHERE f.archived_at IS NULL
     AND (a.alias_norm = $1
          OR word_similarity($1, a.alias_norm) >= 0.4
          OR word_similarity($2, a.alias_norm) >= 0.4)`;

export async function searchFavorites(pool, query, limit = 10) {
  const { v1, v2 } = queryVariants(query);
  if (v1 === '') throw validationError('query must not be empty', 'query');
  const { rows } = await pool.query(SQL, [v1, v2]);
  const best = new Map();
  for (const r of rows) {
    const exact = isExact(r.alias_norm, v1, v2);
    const score = exact ? 1 : Number(r.score);
    const cur = best.get(r.id);
    if (!cur || (exact && !cur.exact) || (exact === cur.exact && score > cur.score)) {
      best.set(r.id, { r, exact, score });
    }
  }
  return [...best.values()]
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || b.r.use_count - a.r.use_count || Number(a.r.id) - Number(b.r.id))
    .slice(0, limit)
    .map(({ r, exact, score }) => ({
      my_food_id: Number(r.id),
      name: r.name,
      matched_alias: r.alias_norm,
      exact,
      score: round2(score),
      use_count: r.use_count,
      serving: { qty: num(r.serving_qty), unit: r.serving_unit, grams: num(r.serving_grams) },
      per_serving: {
        calories: num(r.calories),
        protein_g: num(r.protein_g),
        carbs_g: num(r.carbs_g),
        fat_g: num(r.fat_g),
        fiber_g: num(r.fiber_g),
        sugar_g: num(r.sugar_g),
        sodium_mg: num(r.sodium_mg),
      },
      confidence: r.confidence,
      basis: r.basis,
    }));
}

export function registerSearchFoods(server, { pool }) {
  server.registerTool(
    'search_foods',
    {
      title: 'Search foods',
      description: SEARCH_FOODS_DESCRIPTION,
      inputSchema: {
        query: z.string().max(200).describe('food name or phrase, e.g. "my usual oatmeal"'),
        limit: z.number().int().min(1).max(25).optional().describe('max favorites (default 10)'),
      },
    },
    async ({ query, limit }) => {
      try {
        const favorites = await searchFavorites(pool, query, limit ?? 10);
        return jsonResult({ favorites, usda: [], note: 'USDA database is not loaded yet; only your saved favorites were searched.' });
      } catch (err) {
        if (err instanceof ToolError) return errorResult(err.code, err.message, { field: err.field });
        console.error('search_foods failed:', err && err.message);
        return errorResult('DB_ERROR', 'Database error while searching foods.');
      }
    }
  );
}
