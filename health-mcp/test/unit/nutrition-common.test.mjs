// T6 spec (unit, no DB): shared nutrition helpers for log_food.
//
// Module interface assumed (health-mcp/tools/nutrition/common.mjs):
//   resolveItemTime(item, { now = new Date(), allowBackfill = false } = {})
//       -> { eaten_at, meal }
//     item: { eaten_at?, day?, meal? } as sent to log_food.
//     - `now` is injectable so tests can freeze the clock; production omits it.
//     - eaten_at with an offset is taken as-is; without one it is read as
//       America/Los_Angeles local time.
//     - day + meal (no eaten_at) gives the default LA time for that meal:
//       breakfast 08:00, lunch 12:30, snack 15:30, dinner 19:00.
//     - meal, when absent, is inferred from the LA local time.
//     - eaten_at must fall within [now - 60 days, now + 6 h]; allowBackfill only
//       lifts the lower bound (a future time is never allowed).
//     - Returned eaten_at is a Date (or an ISO string); tests read it with
//       new Date(x).toISOString().
//     - Invalid input throws an Error with .code === 'VALIDATION_ERROR' and
//       .field === 'eaten_at' for a time-window violation.
//   atwaterWarning({ calories, protein_g, carbs_g, fat_g })
//       -> null when |4P + 4C + 9F - kcal| <= max(60, 25% of kcal), else
//          { code: 'ATWATER_MISMATCH', message: string }
//   itemsSchema
//       zod schema for the log_food `items` array (1..25 items).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveItemTime, atwaterWarning, itemsSchema } from '../../tools/nutrition/common.mjs';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function iso(x) {
  return new Date(x).toISOString();
}

function assertValidationError(fn, field) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, 'VALIDATION_ERROR', `expected code VALIDATION_ERROR, got ${err.code} (${err.message})`);
    if (field) assert.equal(err.field, field);
    return true;
  });
}

// 21:00 PDT on 2026-10-25 (DST ends 2026-11-01).
const NOW = new Date('2026-10-26T04:00:00Z');

describe('(a) eaten_at without an offset is LA local time', () => {
  test('2026-10-25T08:00 resolves to 2026-10-25T15:00Z', () => {
    const r = resolveItemTime({ eaten_at: '2026-10-25T08:00', meal: 'breakfast' }, { now: NOW });
    assert.equal(iso(r.eaten_at), '2026-10-25T15:00:00.000Z');
  });

  test('eaten_at with an offset is taken as-is', () => {
    const r = resolveItemTime({ eaten_at: '2026-10-25T08:00:00Z', meal: 'breakfast' }, { now: NOW });
    assert.equal(iso(r.eaten_at), '2026-10-25T08:00:00.000Z');
  });
});

describe('(b) day + meal gives the default LA time', () => {
  const cases = [
    ['dinner', '2026-10-25T02:00:00.000Z'], // 2026-10-24 19:00 PDT
    ['breakfast', '2026-10-24T15:00:00.000Z'], // 08:00 PDT
    ['lunch', '2026-10-24T19:30:00.000Z'], // 12:30 PDT
    ['snack', '2026-10-24T22:30:00.000Z'], // 15:30 PDT
  ];
  for (const [meal, expected] of cases) {
    test(`day=2026-10-24 meal=${meal} -> ${expected}`, () => {
      const r = resolveItemTime({ day: '2026-10-24', meal }, { now: NOW });
      assert.equal(iso(r.eaten_at), expected);
      assert.equal(r.meal, meal);
    });
  }

  test('dinner after DST ends is still 19:00 LA (PST, UTC-8)', () => {
    const r = resolveItemTime({ day: '2026-11-05', meal: 'dinner' }, { now: new Date('2026-11-06T12:00:00Z') });
    assert.equal(iso(r.eaten_at), '2026-11-06T03:00:00.000Z');
  });
});

describe('(c) meal inference from LA local time', () => {
  const cases = [
    ['2026-10-25T09:00', 'breakfast'],
    ['2026-10-25T13:00', 'lunch'],
    ['2026-10-25T18:00', 'dinner'],
    ['2026-10-25T16:00:00Z', 'breakfast'], // 09:00 PDT
    ['2026-10-26T01:00:00Z', 'dinner'], // 18:00 PDT on 10-25
  ];
  for (const [eaten_at, meal] of cases) {
    test(`eaten_at=${eaten_at} with no meal infers ${meal}`, () => {
      const r = resolveItemTime({ eaten_at }, { now: NOW });
      assert.equal(r.meal, meal);
    });
  }
});

describe('(d) eaten_at window [now - 60 days, now + 6 h]', () => {
  const now = new Date('2026-10-25T20:00:00Z');

  test('90 days ago is rejected without allow_backfill', () => {
    const eaten_at = iso(now.getTime() - 90 * DAY);
    assertValidationError(() => resolveItemTime({ eaten_at, meal: 'lunch' }, { now }), 'eaten_at');
  });

  test('90 days ago is accepted with allowBackfill', () => {
    const eaten_at = iso(now.getTime() - 90 * DAY);
    const r = resolveItemTime({ eaten_at, meal: 'lunch' }, { now, allowBackfill: true });
    assert.equal(iso(r.eaten_at), eaten_at);
  });

  test('now + 7 h is rejected', () => {
    const eaten_at = iso(now.getTime() + 7 * HOUR);
    assertValidationError(() => resolveItemTime({ eaten_at, meal: 'dinner' }, { now }), 'eaten_at');
  });

  test('now + 7 h is rejected even with allowBackfill', () => {
    const eaten_at = iso(now.getTime() + 7 * HOUR);
    assertValidationError(() => resolveItemTime({ eaten_at, meal: 'dinner' }, { now, allowBackfill: true }), 'eaten_at');
  });

  test('59 days ago and now + 5 h are accepted', () => {
    for (const t of [now.getTime() - 59 * DAY, now.getTime() + 5 * HOUR]) {
      const eaten_at = iso(t);
      const r = resolveItemTime({ eaten_at, meal: 'snack' }, { now });
      assert.equal(iso(r.eaten_at), eaten_at);
    }
  });
});

describe('(e) Atwater check: warn when |4P+4C+9F-kcal| > max(60, 25%)', () => {
  function isWarning(w) {
    assert.ok(w, 'expected a warning');
    assert.equal(w.code, 'ATWATER_MISMATCH');
    assert.equal(typeof w.message, 'string');
  }

  test('consistent macros give no warning', () => {
    // 4*20 + 4*50 + 9*10 = 370
    assert.equal(atwaterWarning({ calories: 370, protein_g: 20, carbs_g: 50, fat_g: 10 }) ?? null, null);
  });

  test('small item: a gap of 70 kcal exceeds the 60 kcal floor', () => {
    // 4*10 + 4*10 + 0 = 80; kcal 150 -> gap 70 > max(60, 37.5)
    isWarning(atwaterWarning({ calories: 150, protein_g: 10, carbs_g: 10, fat_g: 0 }));
  });

  test('small item: a gap of 50 kcal is under the 60 kcal floor', () => {
    // 80 vs 130 -> gap 50 <= 60
    assert.equal(atwaterWarning({ calories: 130, protein_g: 10, carbs_g: 10, fat_g: 0 }) ?? null, null);
  });

  test('large item: a gap of 190 kcal is within 25%', () => {
    // 4*50 + 4*100 + 9*40 = 960; kcal 1150 -> gap 190 > 60 but < 25%
    assert.equal(atwaterWarning({ calories: 1150, protein_g: 50, carbs_g: 100, fat_g: 40 }) ?? null, null);
  });

  test('large item: a gap of 260 kcal exceeds 25%', () => {
    // 960 vs 700 -> gap 260 > 25%
    isWarning(atwaterWarning({ calories: 700, protein_g: 50, carbs_g: 100, fat_g: 40 }));
  });
});

describe('(f) batch size', () => {
  const item = {
    description: 'Apple',
    calories: 95,
    protein_g: 0.5,
    carbs_g: 25,
    fat_g: 0.3,
    confidence: 'med',
    match_source: 'estimate',
  };

  test('25 items are accepted', () => {
    const r = itemsSchema.safeParse(Array.from({ length: 25 }, () => ({ ...item })));
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
  });

  test('26 items are rejected', () => {
    const r = itemsSchema.safeParse(Array.from({ length: 26 }, () => ({ ...item })));
    assert.equal(r.success, false);
  });
});
