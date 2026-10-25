import { z } from 'zod';
import { ToolError, validationError, errorResult, jsonResult, num } from './common.mjs';
import { normalizeText } from './search.mjs';

export const SAVE_FAVORITE_DESCRIPTION =
  'Create, update or archive a favorite food (a reusable serving with known nutrients). ' +
  'Create: give name, serving (serving_qty, serving_unit, optional serving_grams), calories, protein_g, carbs_g, fat_g, ' +
  'confidence and basis (label | usda | recipe | restaurant | estimate); or give from_log_id to copy serving and nutrients from a food_log entry. ' +
  'Update: give id plus the fields to change. `aliases` adds alternative names; the name is always an alias too. ' +
  'remove_aliases removes aliases. archive: true retires the favorite and frees its name and aliases. ' +
  'An alias already used by another favorite returns CONFLICT with the owning my_food_id.';

const nut = (max) => z.number().min(0).max(max).optional();

const NUTRIENTS = ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg'];
const FIELDS = ['serving_qty', 'serving_unit', 'serving_grams', ...NUTRIENTS, 'confidence', 'basis', 'fdc_id', 'notes'];

const inputSchema = {
  id: z.number().int().positive().optional().describe('my_food_id to update or archive'),
  name: z.string().trim().min(1).max(120).optional(),
  aliases: z.array(z.string().max(120)).max(30).optional(),
  remove_aliases: z.array(z.string().max(120)).max(30).optional(),
  serving_qty: z.number().positive().max(999999).optional(),
  serving_unit: z.string().max(40).optional(),
  serving_grams: z.number().positive().max(5000).optional(),
  calories: nut(5000),
  protein_g: nut(500),
  carbs_g: nut(1000),
  fat_g: nut(500),
  fiber_g: nut(200),
  sugar_g: nut(1000),
  sodium_mg: nut(20000),
  confidence: z.enum(['high', 'med', 'low']).optional(),
  basis: z.enum(['label', 'usda', 'recipe', 'restaurant', 'estimate']).optional(),
  fdc_id: z.number().int().positive().optional(),
  from_log_id: z.number().int().positive().optional().describe('copy serving and nutrients from this food_log row'),
  archive: z.boolean().optional(),
  notes: z.string().max(500).optional(),
};

const BASIS_FROM_SOURCE = { favorite: 'estimate', usda: 'usda', restaurant: 'restaurant', estimate: 'estimate' };
const FOOD_COLS = `id, name, serving_qty, serving_unit, serving_grams, calories, protein_g, carbs_g, fat_g, fiber_g,
  sugar_g, sodium_mg, confidence, basis, fdc_id, notes, archived_at`;

function mapFood(r, aliases) {
  const o = {
    my_food_id: Number(r.id),
    name: r.name,
    serving_qty: num(r.serving_qty),
    serving_unit: r.serving_unit,
    serving_grams: num(r.serving_grams),
  };
  for (const k of NUTRIENTS) o[k] = num(r[k]);
  Object.assign(o, { confidence: r.confidence, basis: r.basis, fdc_id: r.fdc_id, notes: r.notes, archived: r.archived_at !== null, aliases });
  return o;
}

async function lockFood(c, id) {
  const { rows } = await c.query(`SELECT ${FOOD_COLS} FROM my_foods WHERE id = $1::bigint FOR UPDATE`, [id]);
  if (rows.length === 0) throw new ToolError('NOT_FOUND', `No favorite with id ${id}.`, { field: 'id' });
  return rows[0];
}

async function logRowFields(c, logId) {
  const { rows } = await c.query(
    `SELECT quantity, unit, grams, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, confidence, match_source,
            fdc_id
       FROM food_log WHERE id = $1::bigint AND deleted_at IS NULL`,
    [logId]
  );
  if (rows.length === 0) throw new ToolError('NOT_FOUND', `No food_log entry with id ${logId}.`, { field: 'from_log_id' });
  const r = rows[0];
  return {
    serving_qty: num(r.quantity) ?? 1,
    serving_unit: r.unit ?? 'serving',
    serving_grams: num(r.grams) ?? undefined,
    ...Object.fromEntries(NUTRIENTS.map((k) => [k, num(r[k]) ?? undefined])),
    confidence: r.confidence,
    basis: BASIS_FROM_SOURCE[r.match_source],
    fdc_id: r.fdc_id ?? undefined,
  };
}

async function addAlias(c, foodId, alias) {
  const norm = normalizeText(alias);
  if (norm === '') throw validationError('alias must not be empty', 'aliases');
  const cleaned = alias.trim().replace(/\s+/g, ' ');
  for (let attempt = 0; attempt < 2; attempt++) {
    const { rowCount } = await c.query(
      `INSERT INTO my_food_aliases (my_food_id, alias) VALUES ($1::bigint, $2) ON CONFLICT DO NOTHING`,
      [foodId, cleaned]
    );
    if (rowCount === 1) return;
    const { rows } = await c.query(`SELECT my_food_id FROM my_food_aliases WHERE alias_norm = $1`, [norm]);
    const owner = rows.length ? Number(rows[0].my_food_id) : null;
    if (owner === foodId) return;
    if (owner !== null) {
      throw new ToolError('CONFLICT', `Alias "${norm}" already belongs to favorite my_food_id ${owner}.`, { field: 'aliases' });
    }
    // owner vanished (concurrent archive): retry the insert once
  }
  throw new ToolError('CONFLICT', `Alias "${norm}" could not be saved because of a concurrent change; retry.`, { field: 'aliases' });
}

async function nameConflict(c, name) {
  const { rows } = await c.query(`SELECT id FROM my_foods WHERE lower(name) = lower($1) AND archived_at IS NULL`, [name]);
  const owner = rows.length ? Number(rows[0].id) : 'unknown';
  return new ToolError('CONFLICT', `A favorite named "${name}" already exists as my_food_id ${owner}.`, { field: 'name' });
}

async function run(c, args) {
  const { id, archive } = args;

  if (archive) {
    const food = await lockFood(c, id);
    if (food.archived_at !== null) throw new ToolError('ALREADY_DELETED', `Favorite ${id} is already archived.`, { field: 'id' });
    await c.query(`DELETE FROM my_food_aliases WHERE my_food_id = $1::bigint`, [id]);
    await c.query(`UPDATE my_foods SET archived_at = now() WHERE id = $1::bigint`, [id]);
    return { foodId: id, action: 'archived' };
  }

  const fromLog = args.from_log_id !== undefined ? await logRowFields(c, args.from_log_id) : {};
  const v = {};
  for (const k of FIELDS) v[k] = args[k] !== undefined ? args[k] : fromLog[k];

  if (id === undefined) {
    if (!args.name) throw validationError('name is required to create a favorite', 'name');
    for (const k of ['calories', 'protein_g', 'carbs_g', 'fat_g', 'confidence', 'basis']) {
      if (v[k] === undefined) throw validationError(`${k} is required to create a favorite`, k);
    }
    let rows;
    await c.query('SAVEPOINT sp_name');
    try {
      ({ rows } = await c.query(
        `INSERT INTO my_foods (name, serving_qty, serving_unit, serving_grams, calories, protein_g, carbs_g, fat_g, fiber_g,
                               sugar_g, sodium_mg, confidence, basis, fdc_id, notes)
         VALUES ($1, coalesce($2::numeric, 1), coalesce($3::text, 'serving'), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING id`,
        [
          args.name, v.serving_qty ?? null, v.serving_unit ?? null, v.serving_grams ?? null, v.calories, v.protein_g, v.carbs_g,
          v.fat_g, v.fiber_g ?? null, v.sugar_g ?? null, v.sodium_mg ?? null, v.confidence, v.basis, v.fdc_id ?? null, v.notes ?? null,
        ]
      ));
      await c.query('RELEASE SAVEPOINT sp_name');
    } catch (err) {
      if (err && err.code === '23505') {
        await c.query('ROLLBACK TO SAVEPOINT sp_name');
        throw await nameConflict(c, args.name);
      }
      throw err;
    }
    const foodId = Number(rows[0].id);
    await addAlias(c, foodId, args.name);
    for (const a of args.aliases ?? []) await addAlias(c, foodId, a);
    return { foodId, action: 'created' };
  }

  const food = await lockFood(c, id);
  if (food.archived_at !== null) throw new ToolError('ALREADY_DELETED', `Favorite ${id} is archived.`, { field: 'id' });
  await c.query('SAVEPOINT sp_name');
  try {
    await c.query(
      `UPDATE my_foods SET
         name = coalesce($2::text, name), serving_qty = coalesce($3::numeric, serving_qty),
         serving_unit = coalesce($4::text, serving_unit), serving_grams = coalesce($5::numeric, serving_grams),
         calories = coalesce($6::numeric, calories), protein_g = coalesce($7::numeric, protein_g),
         carbs_g = coalesce($8::numeric, carbs_g), fat_g = coalesce($9::numeric, fat_g),
         fiber_g = coalesce($10::numeric, fiber_g), sugar_g = coalesce($11::numeric, sugar_g),
         sodium_mg = coalesce($12::numeric, sodium_mg), confidence = coalesce($13::text, confidence),
         basis = coalesce($14::text, basis), fdc_id = coalesce($15::int, fdc_id), notes = coalesce($16::text, notes)
       WHERE id = $1::bigint`,
      [
        id, args.name ?? null, v.serving_qty ?? null, v.serving_unit ?? null, v.serving_grams ?? null, v.calories ?? null,
        v.protein_g ?? null, v.carbs_g ?? null, v.fat_g ?? null, v.fiber_g ?? null, v.sugar_g ?? null, v.sodium_mg ?? null,
        v.confidence ?? null, v.basis ?? null, v.fdc_id ?? null, v.notes ?? null,
      ]
    );
    await c.query('RELEASE SAVEPOINT sp_name');
  } catch (err) {
    if (err && err.code === '23505') {
      await c.query('ROLLBACK TO SAVEPOINT sp_name');
      throw await nameConflict(c, args.name);
    }
    throw err;
  }
  const finalName = args.name ?? food.name;
  const protect = normalizeText(finalName);
  for (const a of args.remove_aliases ?? []) {
    const n = normalizeText(a);
    if (n === protect) continue; // the name's own alias stays
    await c.query(`DELETE FROM my_food_aliases WHERE my_food_id = $1::bigint AND alias_norm = $2`, [id, n]);
  }
  await addAlias(c, id, finalName);
  for (const a of args.aliases ?? []) await addAlias(c, id, a);
  return { foodId: id, action: 'updated' };
}

export function registerSaveFavorite(server, { writePool, guard }) {
  server.registerTool(
    'save_favorite',
    { title: 'Save favorite food', description: SAVE_FAVORITE_DESCRIPTION, inputSchema },
    async (args, extra) => {
      try {
        if (args.archive && args.id === undefined) throw validationError('id is required to archive', 'id');
        const blocked = guard.check('save_favorite');
        if (blocked) return blocked;
        const c = await writePool.connect();
        let out;
        try {
          await c.query('BEGIN');
          out = await run(c, args);
          const { rows } = await c.query(`SELECT ${FOOD_COLS} FROM my_foods WHERE id = $1::bigint`, [out.foodId]);
          const al = await c.query(`SELECT alias_norm FROM my_food_aliases WHERE my_food_id = $1::bigint ORDER BY alias_norm`, [out.foodId]);
          out.food = mapFood(rows[0], al.rows.map((r) => r.alias_norm));
          await c.query('COMMIT');
        } catch (err) {
          await c.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          c.release();
        }
        guard.audit({ tool: 'save_favorite', authInfo: extra && extra.authInfo, ids: [out.foodId], kcal_delta: 0 });
        return jsonResult({ action: out.action, favorite: out.food });
      } catch (err) {
        if (err instanceof ToolError) return errorResult(err.code, err.message, { item_index: err.item_index, field: err.field });
        console.error('save_favorite failed:', err && err.message);
        return errorResult('DB_ERROR', 'Database error while saving favorite.');
      }
    }
  );
}
