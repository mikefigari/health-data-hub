import { z } from 'zod';

export const TZ = 'America/Los_Angeles';
export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
const MAX_ITEMS = 25;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_MEAL_TIME = { breakfast: [8, 0], lunch: [12, 30], snack: [15, 30], dinner: [19, 0] };

// ---------------------------------------------------------------- errors

export class ToolError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra); // item_index, field
  }
}

export function validationError(message, field, item_index) {
  const extra = {};
  if (field !== undefined) extra.field = field;
  if (item_index !== undefined) extra.item_index = item_index;
  return new ToolError('VALIDATION_ERROR', message, extra);
}

export function errorResult(code, message, extra = {}) {
  const error = { code, message };
  if (extra.item_index !== undefined) error.item_index = extra.item_index;
  if (extra.field !== undefined) error.field = extra.field;
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] };
}

export function jsonResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

// ---------------------------------------------------------------- numbers

// NUMERIC columns arrive from pg as strings; convert here only (never globally).
export function num(v) {
  return v === null || v === undefined ? null : Number(v);
}
export const round1 = (x) => Math.round(x * 10) / 10;
export const round2 = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------- items

const nutrient = (max) => z.number().min(0).max(max).optional();

const itemSchema = z
  .object({
    description: z.string().trim().min(1).max(200),
    meal: z.enum(MEALS).optional(),
    eaten_at: z.string().max(64).optional(),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    quantity: z.number().positive().max(999999).optional(),
    unit: z.string().max(40).optional(),
    grams: z.number().positive().max(5000).optional(),
    calories: nutrient(5000),
    protein_g: nutrient(500),
    carbs_g: nutrient(1000),
    fat_g: nutrient(500),
    fiber_g: nutrient(200),
    sugar_g: nutrient(1000),
    sodium_mg: nutrient(20000),
    confidence: z.enum(['high', 'med', 'low']),
    match_source: z.enum(['favorite', 'usda', 'restaurant', 'estimate']),
    my_food_id: z.number().int().positive().optional(),
    servings: z.number().positive().max(100).optional(),
    fdc_id: z.number().int().positive().optional(),
    ref_label: z.string().max(200).optional(),
    notes: z.string().max(500).optional(),
  })
  .strict()
  .superRefine((it, ctx) => {
    if (it.match_source === 'favorite' && it.my_food_id === undefined) {
      ctx.addIssue({ code: 'custom', path: ['my_food_id'], message: 'my_food_id is required for match_source favorite' });
    }
    if (it.match_source === 'usda' && it.fdc_id === undefined) {
      ctx.addIssue({ code: 'custom', path: ['fdc_id'], message: 'fdc_id is required for match_source usda' });
    }
    const missing = ['calories', 'protein_g', 'carbs_g', 'fat_g'].filter((k) => it[k] === undefined);
    const computable = it.match_source === 'favorite' && missing.length === 4;
    if (missing.length > 0 && !computable) {
      ctx.addIssue({ code: 'custom', path: [missing[0]], message: `${missing[0]} is required` });
    }
  });

export const itemsSchema = z
  .array(itemSchema)
  .min(1, 'at least one item is required')
  .max(MAX_ITEMS, `at most ${MAX_ITEMS} items per call`);

// Converts the first zod issue into a ToolError with item_index and field.
export function zodToToolError(error) {
  const issue = error.issues[0];
  const path = issue.path;
  let item_index;
  let field;
  if (typeof path[0] === 'number') {
    item_index = path[0];
    field = path[1] !== undefined ? String(path[1]) : undefined;
    if (issue.code === 'unrecognized_keys' && issue.keys?.length) field = issue.keys[0];
  }
  return validationError(issue.message, field, item_index);
}

// ---------------------------------------------------------------- time

const laFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function laParts(ms) {
  const p = {};
  for (const { type, value } of laFormatter.formatToParts(new Date(ms))) p[type] = Number(value);
  return p;
}

function laOffsetMs(ms) {
  const p = laParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

function laWallToUtcMs(y, mo, d, h, mi, s) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = guess - laOffsetMs(guess);
  return guess - laOffsetMs(first);
}

function validCalendar(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function laDayString(dateOrMs) {
  const p = laParts(new Date(dateOrMs).getTime());
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function inferMeal(ms) {
  const h = laParts(ms).hour;
  if (h < 11) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h < 17) return 'snack';
  if (h < 22) return 'dinner';
  return 'snack';
}

const HAS_OFFSET = /[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}(:?\d{2})?)$/i;
const LOCAL_DT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// Resolves { eaten_at?, day?, meal? } to { eaten_at: Date, meal }.
export function resolveItemTime(item, { now = new Date(), allowBackfill = false } = {}) {
  const nowMs = new Date(now).getTime();
  let ms;
  let dayStr = item.day;
  let raw = item.eaten_at;

  if (raw !== undefined && DATE_ONLY.test(raw)) {
    if (dayStr !== undefined && dayStr !== raw) throw validationError('day conflicts with eaten_at', 'day');
    dayStr = raw;
    raw = undefined;
  }

  if (raw !== undefined) {
    if (HAS_OFFSET.test(raw)) {
      ms = new Date(raw).getTime();
    } else {
      const m = LOCAL_DT.exec(raw);
      if (!m) throw validationError('eaten_at must be an ISO 8601 date-time', 'eaten_at');
      const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
      if (!validCalendar(y, mo, d) || h > 23 || mi > 59 || s > 59) {
        throw validationError('eaten_at is not a valid date-time', 'eaten_at');
      }
      ms = laWallToUtcMs(y, mo, d, h, mi, s);
    }
    if (!Number.isFinite(ms)) throw validationError('eaten_at is not a valid date-time', 'eaten_at');
    if (dayStr !== undefined && dayStr !== laDayString(ms)) throw validationError('day conflicts with eaten_at', 'day');
  } else if (dayStr !== undefined) {
    const m = DATE_ONLY.exec(dayStr);
    const [y, mo, d] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
    if (!m || !validCalendar(y, mo, d)) throw validationError('day must be a valid YYYY-MM-DD date', 'day');
    if (!item.meal) throw validationError('meal is required when only day is given', 'meal');
    const [h, mi] = DEFAULT_MEAL_TIME[item.meal];
    ms = laWallToUtcMs(y, mo, d, h, mi, 0);
  } else {
    ms = nowMs;
  }

  if (ms > nowMs + 6 * HOUR_MS) throw validationError('eaten_at is more than 6 hours in the future', 'eaten_at');
  if (!allowBackfill && ms < nowMs - 60 * DAY_MS) {
    throw validationError('eaten_at is more than 60 days ago; set allow_backfill to log it anyway', 'eaten_at');
  }

  return { eaten_at: new Date(ms), meal: item.meal ?? inferMeal(ms) };
}

// ---------------------------------------------------------------- Atwater

export function atwaterWarning({ calories, protein_g, carbs_g, fat_g }) {
  const expected = 4 * protein_g + 4 * carbs_g + 9 * fat_g;
  const gap = Math.abs(expected - calories);
  if (gap > Math.max(60, 0.25 * calories)) {
    return {
      code: 'ATWATER_MISMATCH',
      message: `Calories (${calories}) differ from 4P+4C+9F (${round1(expected)}) by ${round1(gap)} kcal; check the numbers.`,
    };
  }
  return null;
}
