import { z } from 'zod';
import {
  ToolError,
  MEALS,
  validationError,
  errorResult,
  jsonResult,
  round1,
  round2,
  resolveItemTime,
  atwaterWarning,
  laDayString,
} from './common.mjs';
import { ITEM_COLUMNS, mapDbRow, dailyTotals, EMPTY_TOTALS } from './log-food.mjs';
import { parseDay } from './summary.mjs';

export const UPDATE_LOG_ENTRY_DESCRIPTION =
  'Correct a logged item (wrong portion, wrong meal, wrong day, better estimate). Get ids from get_day_summary. ' +
  'patch may contain only: eaten_at, day, meal, description, quantity, unit, grams, servings, calories, protein_g, carbs_g, ' +
  'fat_g, fiber_g, sugar_g, sodium_mg, confidence, match_source, my_food_id, fdc_id, ref_label, notes; any other field is rejected. ' +
  'Patching `servings` on a favorite entry without nutrients rescales the nutrients from the favorite. ' +
  'Returns {before, after, day_totals}, with totals for both days if the day changed.';

export const DELETE_LOG_ENTRY_DESCRIPTION =
  'Remove logged items (soft delete; reversible with restore=true). ' +
  'Confirm with the user before deleting more than 3 items. Up to 25 ids per call; nothing changes if any id does not exist. ' +
  'Returns {affected, unchanged, day_totals}.';

export const MARK_DAY_COMPLETE_DESCRIPTION =
  'Mark a day (default: today in Los Angeles) as fully logged or not, with an optional note. ' +
  'Use after the user says they have logged everything for the day.';


const patchSchema = z
  .object({
    eaten_at: z.string().max(64),
    day: z.string().max(10),
    meal: z.enum(MEALS),
    description: z.string().trim().min(1).max(200),
    quantity: z.number().positive().max(999999).nullable(),
    unit: z.string().max(40).nullable(),
    grams: z.number().positive().max(5000).nullable(),
    servings: z.number().positive().max(100),
    calories: z.number().min(0).max(5000),
    protein_g: z.number().min(0).max(500),
    carbs_g: z.number().min(0).max(1000),
    fat_g: z.number().min(0).max(500),
    fiber_g: z.number().min(0).max(200).nullable(),
    sugar_g: z.number().min(0).max(1000).nullable(),
    sodium_mg: z.number().min(0).max(20000).nullable(),
    confidence: z.enum(['high', 'med', 'low']),
    match_source: z.enum(['favorite', 'usda', 'restaurant', 'estimate']),
    my_food_id: z.number().int().positive().nullable(),
    fdc_id: z.number().int().positive().nullable(),
    ref_label: z.string().max(200).nullable(),
    notes: z.string().max(500).nullable(),
  })
  .partial()
  .strict();

const NUTRIENTS = ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg'];
const ROUND1 = new Set([...NUTRIENTS, 'grams']);
// Fixed whitelist of directly-settable columns; values are always bound parameters.
const DIRECT = [
  'meal', 'description', 'quantity', 'unit', 'grams', ...NUTRIENTS,
  'confidence', 'match_source', 'my_food_id', 'fdc_id', 'ref_label', 'notes',
];

function patchError(error) {
  const issue = error.issues[0];
  const field = issue.code === 'unrecognized_keys' && issue.keys?.length ? issue.keys[0] : issue.path[0];
  const msg = issue.code === 'unrecognized_keys' ? `patch field not allowed: ${issue.keys.join(', ')}` : issue.message;
  return validationError(msg, field === undefined ? 'patch' : String(field));
}

async function totalsFor(q, days) {
  const found = await dailyTotals(q, days);
  const out = {};
  for (const d of days) out[d] = found[d] ?? { ...EMPTY_TOTALS };
  return out;
}

function mapDbError(err) {
  if (err && err.code === '23514') return validationError('The change violates a data constraint (check the values).');
  if (err && err.code === '23503') return new ToolError('NOT_FOUND', 'Referenced favorite (my_food_id) does not exist.', { field: 'my_food_id' });
  return null;
}

function failure(tool, err) {
  if (err instanceof ToolError) return errorResult(err.code, err.message, { item_index: err.item_index, field: err.field });
  const mapped = mapDbError(err);
  if (mapped) return errorResult(mapped.code, mapped.message, { field: mapped.field });
  console.error(`${tool} failed:`, err && err.message);
  return errorResult('DB_ERROR', 'Database error while saving.');
}

async function withTx(writePool, fn) {
  const client = await writePool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function updateEntry(writePool, id, patch, time) {
  return withTx(writePool, async (c) => {
    const cur = (await c.query(`SELECT ${ITEM_COLUMNS}, deleted_at FROM food_log WHERE id = $1::bigint FOR UPDATE`, [id])).rows[0];
    if (!cur) throw new ToolError('NOT_FOUND', `No food_log entry with id ${id}.`, { field: 'id' });
    if (cur.deleted_at !== null) {
      throw new ToolError('ALREADY_DELETED', `Entry ${id} is deleted; restore it with delete_log_entry restore=true first.`, { field: 'id' });
    }
    const before = mapDbRow(cur);

    const sets = [];
    const params = [id];
    const put = (col, val) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    // Time: eaten_at wins; a bare day keeps the local time of day (validated before the guard).
    if (time.eaten_at !== undefined) {
      put('eaten_at', time.eaten_at);
    } else if (time.day !== undefined) {
      params.push(time.day);
      sets.push(
        `eaten_at = ($${params.length}::date + (eaten_at AT TIME ZONE 'America/Los_Angeles')::time) AT TIME ZONE 'America/Los_Angeles'`
      );
    }

    const eff = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([k]) => DIRECT.includes(k))) };
    const values = {};
    for (const k of DIRECT) {
      if (patch[k] === undefined) continue;
      const v = patch[k];
      values[k] = v === null || typeof v !== 'number' ? v : k === 'quantity' ? round2(v) : ROUND1.has(k) ? round1(v) : v;
    }

    // Servings: rescale from the favorite unless nutrients were given.
    if (patch.servings !== undefined) {
      if (eff.match_source !== 'favorite' || eff.my_food_id === null) {
        throw validationError('servings only applies to favorite entries', 'servings');
      }
      const fav = (await c.query('SELECT * FROM my_foods WHERE id = $1::bigint', [eff.my_food_id])).rows[0];
      if (!fav) throw new ToolError('NOT_FOUND', `my_food_id ${eff.my_food_id} not found`, { field: 'my_food_id' });
      const s = patch.servings;
      const scale = (v) => (v === null || v === undefined ? null : round1(Number(v) * s));
      for (const k of NUTRIENTS) if (patch[k] === undefined) values[k] = scale(fav[k]);
      if (patch.quantity === undefined) values.quantity = round2(Number(fav.serving_qty) * s);
      if (patch.unit === undefined) values.unit = fav.serving_unit;
      if (patch.grams === undefined && fav.serving_grams !== null) values.grams = round1(Number(fav.serving_grams) * s);
    }

    for (const [k, v] of Object.entries(values)) put(k, v);
    if (sets.length === 0) throw validationError('patch changed nothing', 'patch');

    const after = mapDbRow((await c.query(`UPDATE food_log SET ${sets.join(', ')} WHERE id = $1::bigint RETURNING ${ITEM_COLUMNS}`, params)).rows[0]);
    const days = [...new Set([before.day, after.day])];
    const warn = atwaterWarning(after);
    return { before, after, day_totals: await totalsFor(c, days), warnings: warn ? [warn] : [] };
  });
}

async function setDeleted(writePool, ids, restore) {
  return withTx(writePool, async (c) => {
    const { rows } = await c.query(
      'SELECT id, day::text AS day, calories, (deleted_at IS NOT NULL) AS is_deleted FROM food_log WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE',
      [ids]
    );
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const missing = ids.filter((i) => !byId.has(i));
    if (missing.length > 0) {
      throw new ToolError('NOT_FOUND', `No food_log entries with id: ${missing.join(', ')}. Nothing was changed.`, { field: 'ids' });
    }
    const affected = ids.filter((i) => byId.get(i).is_deleted === restore);
    const unchanged = ids.filter((i) => byId.get(i).is_deleted !== restore);
    if (affected.length > 0) {
      await c.query(
        `UPDATE food_log SET deleted_at = ${restore ? 'NULL' : 'now()'} WHERE id = ANY($1::bigint[])`,
        [affected]
      );
    }
    const days = [...new Set(ids.map((i) => byId.get(i).day))];
    const kcal = affected.reduce((s, i) => s + Number(byId.get(i).calories), 0);
    return { affected, unchanged, day_totals: await totalsFor(c, days), kcal_delta: Math.round(restore ? kcal : -kcal) };
  });
}

export function registerEditTools(server, { writePool, guard, now }) {
  server.registerTool(
    'update_log_entry',
    {
      title: 'Update log entry',
      description: UPDATE_LOG_ENTRY_DESCRIPTION,
      inputSchema: {
        id: z.number().int().positive().describe('food_log id from get_day_summary'),
        patch: z.any().describe('fields to change; see the tool description'),
      },
    },
    async ({ id, patch }, extra) => {
      try {
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
          throw validationError('patch must be an object', 'patch');
        }
        const parsed = patchSchema.safeParse(patch);
        if (!parsed.success) throw patchError(parsed.error);
        if (Object.keys(parsed.data).length === 0) throw validationError('patch must not be empty', 'patch');
        const time = {};
        if (parsed.data.eaten_at !== undefined) {
          time.eaten_at = resolveItemTime(
            { eaten_at: parsed.data.eaten_at, day: parsed.data.day },
            { now: now(), allowBackfill: true }
          ).eaten_at;
        } else if (parsed.data.day !== undefined) {
          time.day = parseDay(parsed.data.day);
        }
        const blocked = guard.check('update_log_entry');
        if (blocked) return blocked;
        const result = await updateEntry(writePool, id, parsed.data, time);
        guard.audit({
          tool: 'update_log_entry',
          authInfo: extra && extra.authInfo,
          ids: [id],
          kcal_delta: Math.round(result.after.calories - result.before.calories),
        });
        return jsonResult(result);
      } catch (err) {
        return failure('update_log_entry', err);
      }
    }
  );

  server.registerTool(
    'delete_log_entry',
    {
      title: 'Delete log entries',
      description: DELETE_LOG_ENTRY_DESCRIPTION,
      inputSchema: {
        ids: z.array(z.number().int().positive()).min(1).max(25).describe('food_log ids'),
        restore: z.boolean().optional().describe('true brings deleted entries back; default false'),
      },
    },
    async ({ ids, restore = false }, extra) => {
      try {
        const unique = [...new Set(ids)];
        const blocked = guard.check('delete_log_entry');
        if (blocked) return blocked;
        const { kcal_delta, ...result } = await setDeleted(writePool, unique, restore);
        guard.audit({ tool: 'delete_log_entry', authInfo: extra && extra.authInfo, ids: result.affected, kcal_delta });
        return jsonResult(result);
      } catch (err) {
        return failure('delete_log_entry', err);
      }
    }
  );

  server.registerTool(
    'mark_day_complete',
    {
      title: 'Mark day complete',
      description: MARK_DAY_COMPLETE_DESCRIPTION,
      inputSchema: {
        day: z.string().optional().describe('YYYY-MM-DD; default today in Los Angeles'),
        complete: z.boolean().describe('true when everything eaten that day is logged'),
        note: z.string().max(300).optional(),
      },
    },
    async ({ day, complete, note }, extra) => {
      try {
        const d = day === undefined ? laDayString(now()) : parseDay(day);
        const blocked = guard.check('mark_day_complete');
        if (blocked) return blocked;
        const { rows } = await writePool.query(
          `INSERT INTO nutrition_day_status (day, logged_complete, note) VALUES ($1::date, $2, $3)
           ON CONFLICT (day) DO UPDATE SET logged_complete = EXCLUDED.logged_complete,
                                           note = COALESCE(EXCLUDED.note, nutrition_day_status.note)
           RETURNING day::text AS day, logged_complete, note`,
          [d, complete, note ?? null]
        );
        guard.audit({ tool: 'mark_day_complete', authInfo: extra && extra.authInfo, ids: [], kcal_delta: 0 });
        return jsonResult(rows[0]);
      } catch (err) {
        return failure('mark_day_complete', err);
      }
    }
  );
}

