import { z } from 'zod';
import {
  ToolError,
  validationError,
  errorResult,
  jsonResult,
  num,
  round1,
  round2,
  itemsSchema,
  zodToToolError,
  resolveItemTime,
  laDayString,
  atwaterWarning,
} from './common.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LOG_FOOD_DESCRIPTION =
  'Log one or more foods the user ate (up to 25 per call, all or none). ' +
  'Call first WITHOUT `confirm` (default false): nothing is written, and you get the computed rows plus projected day totals. ' +
  'Show the user a compact table (item, amount, kcal, P/C/F, confidence, source) and the projected day total, ' +
  'then call again with the same items and `confirm: true` only after the user agrees. ' +
  'Each item needs description, calories, protein_g, carbs_g, fat_g (grams), `confidence` (high = favorite, weighed or labelled; ' +
  'med = USDA match with a stated portion; low = photo, vague portion, restaurant guess or mixed dish) and match_source ' +
  '(favorite | usda | restaurant | estimate). For a favorite give my_food_id and optional `servings` and omit the nutrients: the server scales them. ' +
  'match_source usda also needs fdc_id. Optional per item: meal, eaten_at (ISO; no offset means Los Angeles time), day (YYYY-MM-DD, with meal), ' +
  'quantity, unit, grams, fiber_g, sugar_g, sodium_mg, ref_label, notes. Use request_id (UUID) to make a confirmed call safe to retry.';

const ITEM_COLUMNS = `id, eaten_at, day::text AS day, meal, description, quantity, unit, grams, calories, protein_g,
  carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, confidence, match_source, my_food_id, fdc_id, ref_label, notes`;

function mapDbRow(r, computed) {
  const row = {
    id: Number(r.id),
    day: r.day,
    meal: r.meal,
    eaten_at: new Date(r.eaten_at).toISOString(),
    description: r.description,
    quantity: num(r.quantity),
    unit: r.unit,
    grams: num(r.grams),
    calories: num(r.calories),
    protein_g: num(r.protein_g),
    carbs_g: num(r.carbs_g),
    fat_g: num(r.fat_g),
    fiber_g: num(r.fiber_g),
    sugar_g: num(r.sugar_g),
    sodium_mg: num(r.sodium_mg),
    confidence: r.confidence,
    match_source: r.match_source,
    my_food_id: r.my_food_id === null ? null : Number(r.my_food_id),
    fdc_id: r.fdc_id,
    ref_label: r.ref_label,
    notes: r.notes,
  };
  if (computed !== undefined) row.computed_by_server = computed;
  return row;
}

function mapTotals(r) {
  return {
    calories: num(r.calories),
    protein_g: num(r.protein_g),
    carbs_g: num(r.carbs_g),
    fat_g: num(r.fat_g),
    fiber_g: num(r.fiber_g),
    sugar_g: num(r.sugar_g),
    sodium_mg: num(r.sodium_mg),
    items: Number(r.items),
    items_missing_micros: Number(r.items_missing_micros),
    low_confidence_items: Number(r.low_confidence_items),
  };
}

async function dailyTotals(q, days) {
  const { rows } = await q.query(
    `SELECT day::text AS day, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, items,
            items_missing_micros, low_confidence_items
       FROM food_log_daily WHERE day = ANY($1::date[])`,
    [days]
  );
  const out = {};
  for (const r of rows) out[r.day] = mapTotals(r);
  return out;
}

const EMPTY_TOTALS = {
  calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: null, sugar_g: null, sodium_mg: null,
  items: 0, items_missing_micros: 0, low_confidence_items: 0,
};

function addNullable(a, b) {
  if (a === null && b === null) return null;
  return round1((a ?? 0) + (b ?? 0));
}

function projectTotals(base, rows) {
  const out = {};
  for (const [day, t] of Object.entries(base)) out[day] = { ...t };
  for (const r of rows) {
    const t = (out[r.day] ??= { ...EMPTY_TOTALS });
    t.calories = round1(t.calories + r.calories);
    t.protein_g = round1(t.protein_g + r.protein_g);
    t.carbs_g = round1(t.carbs_g + r.carbs_g);
    t.fat_g = round1(t.fat_g + r.fat_g);
    t.fiber_g = addNullable(t.fiber_g, r.fiber_g);
    t.sugar_g = addNullable(t.sugar_g, r.sugar_g);
    t.sodium_mg = addNullable(t.sodium_mg, r.sodium_mg);
    t.items += 1;
    if (r.fiber_g === null || r.sugar_g === null || r.sodium_mg === null) t.items_missing_micros += 1;
    if (r.confidence === 'low') t.low_confidence_items += 1;
  }
  return out;
}

// Validates and computes the rows for every item. Reads favorites through `q`.
async function buildRows(q, rawItems, allowBackfill) {
  const parsed = itemsSchema.safeParse(rawItems);
  if (!parsed.success) throw zodToToolError(parsed.error);
  const items = parsed.data;
  const now = new Date();

  const favIds = [...new Set(items.filter((i) => i.my_food_id !== undefined).map((i) => i.my_food_id))];
  const favs = new Map();
  if (favIds.length > 0) {
    const { rows } = await q.query('SELECT * FROM my_foods WHERE id = ANY($1::bigint[]) AND archived_at IS NULL', [favIds]);
    for (const r of rows) favs.set(Number(r.id), r);
  }

  const warnings = [];
  const rows = items.map((it, index) => {
    const wrap = (fn) => {
      try {
        return fn();
      } catch (err) {
        if (err instanceof ToolError && err.item_index === undefined) err.item_index = index;
        throw err;
      }
    };
    const { eaten_at, meal } = wrap(() => resolveItemTime(it, { now, allowBackfill }));

    let fav = null;
    if (it.my_food_id !== undefined) {
      fav = favs.get(it.my_food_id);
      if (!fav) throw new ToolError('NOT_FOUND', `my_food_id ${it.my_food_id} not found or archived`, { item_index: index, field: 'my_food_id' });
    }

    const computed = it.match_source === 'favorite' && it.calories === undefined;
    let n;
    let quantity = it.quantity;
    let unit = it.unit;
    let grams = it.grams;
    if (computed) {
      const s = it.servings ?? 1;
      const scale = (v) => (v === null || v === undefined ? null : round1(Number(v) * s));
      n = {
        calories: scale(fav.calories),
        protein_g: scale(fav.protein_g),
        carbs_g: scale(fav.carbs_g),
        fat_g: scale(fav.fat_g),
        fiber_g: it.fiber_g ?? scale(fav.fiber_g),
        sugar_g: it.sugar_g ?? scale(fav.sugar_g),
        sodium_mg: it.sodium_mg ?? scale(fav.sodium_mg),
      };
      quantity ??= round2(Number(fav.serving_qty) * s);
      unit ??= fav.serving_unit;
      grams ??= fav.serving_grams === null ? undefined : round1(Number(fav.serving_grams) * s);
      const limits = { calories: 5000, protein_g: 500, carbs_g: 1000, fat_g: 500 };
      for (const [k, max] of Object.entries(limits)) {
        if (n[k] > max) throw validationError(`${k} exceeds ${max} after scaling by servings`, 'servings', index);
      }
      if (grams !== undefined && grams > 5000) throw validationError('grams exceeds 5000 after scaling by servings', 'servings', index);
    } else {
      n = {
        calories: round1(it.calories),
        protein_g: round1(it.protein_g),
        carbs_g: round1(it.carbs_g),
        fat_g: round1(it.fat_g),
        fiber_g: it.fiber_g === undefined ? null : round1(it.fiber_g),
        sugar_g: it.sugar_g === undefined ? null : round1(it.sugar_g),
        sodium_mg: it.sodium_mg === undefined ? null : round1(it.sodium_mg),
      };
    }

    const w = atwaterWarning(n);
    if (w) warnings.push({ ...w, item_index: index });

    return {
      eaten_at,
      day: laDayString(eaten_at),
      meal,
      description: it.description,
      quantity: quantity === undefined ? null : round2(quantity),
      unit: unit ?? null,
      grams: grams === undefined ? null : round1(grams),
      ...n,
      confidence: it.confidence,
      match_source: it.match_source,
      my_food_id: it.my_food_id ?? null,
      fdc_id: it.fdc_id ?? null,
      ref_label: it.ref_label ?? null,
      notes: it.notes ?? null,
      computed_by_server: computed,
    };
  });
  return { rows, warnings };
}

function previewRow(r) {
  return { ...r, id: null, eaten_at: r.eaten_at.toISOString() };
}

async function loggedByRequest(q, requestId) {
  const { rows } = await q.query(
    `SELECT ${ITEM_COLUMNS} FROM food_log WHERE request_id = $1::uuid AND deleted_at IS NULL ORDER BY request_line`,
    [requestId]
  );
  return rows;
}

const INSERT_SQL = `
  INSERT INTO food_log (eaten_at, meal, description, quantity, unit, grams, calories, protein_g, carbs_g, fat_g,
                        fiber_g, sugar_g, sodium_mg, confidence, match_source, my_food_id, fdc_id, ref_label,
                        created_via, request_id, request_line, notes)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'claude_mcp', $19, $20, $21)
  RETURNING ${ITEM_COLUMNS}`;

async function insertRows(writePool, rows, requestId) {
  const client = await writePool.connect();
  try {
    await client.query('BEGIN');
    if (requestId) {
      const existing = await loggedByRequest(client, requestId);
      if (existing.length > 0) {
        const days = [...new Set(existing.map((r) => r.day))];
        const totals = await dailyTotals(client, days);
        await client.query('COMMIT');
        return { duplicate: true, logged: existing.map((r) => mapDbRow(r)), totals };
      }
    }
    const logged = [];
    for (const [i, r] of rows.entries()) {
      const res = await client.query(INSERT_SQL, [
        r.eaten_at, r.meal, r.description, r.quantity, r.unit, r.grams, r.calories, r.protein_g, r.carbs_g, r.fat_g,
        r.fiber_g, r.sugar_g, r.sodium_mg, r.confidence, r.match_source, r.my_food_id, r.fdc_id, r.ref_label,
        requestId ?? null, requestId ? i : null, r.notes,
      ]);
      logged.push(mapDbRow(res.rows[0], r.computed_by_server));
      if (r.match_source === 'favorite' && r.my_food_id !== null) {
        await client.query('UPDATE my_foods SET use_count = use_count + 1, last_used_at = now() WHERE id = $1::bigint', [r.my_food_id]);
      }
    }
    const totals = await dailyTotals(client, [...new Set(logged.map((r) => r.day))]);
    await client.query('COMMIT');
    return { duplicate: false, logged, totals };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function registerLogFood(server, { pool, writePool, guard }) {
  server.registerTool(
    'log_food',
    {
      title: 'Log food',
      description: LOG_FOOD_DESCRIPTION,
      // Items are validated in the handler so errors carry item_index and field.
      inputSchema: {
        items: z.array(z.any()).describe('1 to 25 food items; see the tool description for fields'),
        confirm: z.boolean().optional().describe('false (default) previews only; true writes'),
        request_id: z.string().optional().describe('UUID idempotency key for a confirmed call'),
        allow_backfill: z.boolean().optional().describe('allow eaten_at older than 60 days'),
      },
    },
    async (args, extra) => {
      try {
        const { items, confirm = false, request_id, allow_backfill = false } = args;
        if (request_id !== undefined && !UUID_RE.test(request_id)) {
          throw validationError('request_id must be a UUID', 'request_id');
        }

        if (!confirm) {
          const { rows, warnings } = await buildRows(pool, items, allow_backfill);
          const base = await dailyTotals(pool, [...new Set(rows.map((r) => r.day))]);
          return jsonResult({
            preview: true,
            would_log: rows.map(previewRow),
            warnings,
            day_totals: projectTotals(base, rows),
          });
        }

        const blocked = guard.check('log_food');
        if (blocked) return blocked;

        const { rows, warnings } = await buildRows(writePool, items, allow_backfill);
        let result;
        try {
          result = await insertRows(writePool, rows, request_id);
        } catch (err) {
          if (err && err.code === '23505' && request_id) {
            // A concurrent call with the same request_id won the race.
            result = await insertRows(writePool, rows, request_id);
          } else {
            throw err;
          }
        }
        if (!result.duplicate) {
          guard.audit({
            tool: 'log_food',
            authInfo: extra && extra.authInfo,
            ids: result.logged.map((r) => r.id),
            kcal_delta: Math.round(result.logged.reduce((s, r) => s + r.calories, 0)),
          });
        }
        return jsonResult({
          preview: false,
          logged: result.logged,
          warnings: result.duplicate ? [] : warnings,
          day_totals: result.totals,
          duplicate: result.duplicate,
        });
      } catch (err) {
        if (err instanceof ToolError) {
          return errorResult(err.code, err.message, { item_index: err.item_index, field: err.field });
        }
        console.error('log_food failed:', err && err.message);
        return errorResult('DB_ERROR', 'Database error while logging food.');
      }
    }
  );
}
