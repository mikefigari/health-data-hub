// T3-spec. Contract pinned here:
//
// analyzeHealth.mjs exports WEEKLY_SYSTEM_PROMPT (string) and buildWeeklyUserMessage(ctx).
// Importing it needs no network/API key: the Anthropic client is built inside analyzeHealth(), not at import.
// (db.mjs creates its pg Pool lazily and the Notion client is built inside functions, so importing
//  buildWeeklyContext.mjs is also side-effect free.)
//
// buildWeeklyContext.mjs exports pure buildWeeklyContextFrom(rows, opts):
//   rows: [{ day:'YYYY-MM-DD', nutrition:{calories, goal_calories, logged_complete}, ... }]  (may span >7 days)
//   opts: { today:'YYYY-MM-DD', weighIns:[{day, weight_kg}], goals:{ target_weight_kg },
//           windowSummary?, plannedNextWeek?, notionRefs? }
//   returns ctx with at least:
//     mode:'weekly', date:today, weekStart, weekEnd   (prior Mon-Sun, LA)
//     nutritionWeek: weeklyDeficit() result computed over weekStart..weekEnd rows only,
//                    plus maintenance_method ('goal_calories' | 'scale_calibrated')
//     weightTrend:   weightTrend() result (latest_kg, kg_to_target, ...)
//     days, windowSummary, plannedNextWeek, notionRefs (as before)
//   ctx has no deficitAdherence / deficitAdherenceStr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { WEEKLY_SYSTEM_PROMPT, buildWeeklyUserMessage } from '../../src/anthropic/analyzeHealth.mjs';
import { buildWeeklyContextFrom } from '../../src/utils/buildWeeklyContext.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

// 2026-10-24 .. 2026-11-03; in-week (10-26..11-01) = 2000 kcal vs goal 2600 (deficit 600); outside = 5000 kcal.
const rows = Array.from({ length: 11 }, (_, i) => {
  const day = addDays('2026-10-24', i);
  const inWeek = day >= '2026-10-26' && day <= '2026-11-01';
  return { day, nutrition: { calories: inWeek ? 2000 : 5000, goal_calories: 2600, logged_complete: true } };
});
const weighIns = [
  { day: '2026-10-20', weight_kg: 104 }, { day: '2026-10-25', weight_kg: 103.4 },
  { day: '2026-10-30', weight_kg: 102.9 }, { day: '2026-11-01', weight_kg: 102.5 },
];
const opts = { today: '2026-11-02', weighIns, goals: { target_weight_kg: 90 } };

test('(a) prompt drops stale goal/TDEE and states D1 numbers', () => {
  assert.equal(typeof WEEKLY_SYSTEM_PROMPT, 'string');
  assert.doesNotMatch(WEEKLY_SYSTEM_PROMPT, /27\s?kg/i);
  assert.doesNotMatch(WEEKLY_SYSTEM_PROMPT, /2,?800/);
  assert.match(WEEKLY_SYSTEM_PROMPT, /0\.75\s?kg/);
  assert.match(WEEKLY_SYSTEM_PROMPT, /825/);
  assert.match(WEEKLY_SYSTEM_PROMPT, /5,?775/);
});

test('(b) Nutrition section judges the 7-day average and states coverage + method', () => {
  for (const h of ['## Week in numbers', '## Recovery and fatigue', '## Nutrition', '## Weight and w/kg trend', '## What the data is saying']) {
    assert.ok(WEEKLY_SYSTEM_PROMPT.includes(h), `missing heading ${h}`);
  }
  const start = WEEKLY_SYSTEM_PROMPT.indexOf('## Nutrition');
  const next = WEEKLY_SYSTEM_PROMPT.indexOf('## Weight and w/kg trend');
  assert.ok(start >= 0 && next > start);
  const section = WEEKLY_SYSTEM_PROMPT.slice(start, next);
  assert.match(section, /7-day average/i);
  assert.match(section, /not (?:individual|single)(?: days?)?|never (?:individual|single)/i);
  assert.match(section, /N of 7 days logged/);
  assert.match(section, /maintenance/i);
  assert.match(section, /method/i);
  assert.doesNotMatch(WEEKLY_SYSTEM_PROMPT, /DEFICIT_ADHERENCE/);
  assert.match(WEEKLY_SYSTEM_PROMPT, /NUTRITION_WEEK/);
  assert.match(WEEKLY_SYSTEM_PROMPT, /WEIGHT_TREND/);
});

test('(c) user message carries NUTRITION_WEEK and WEIGHT_TREND JSON, no DEFICIT_ADHERENCE', () => {
  const ctx = buildWeeklyContextFrom(rows, opts);
  const msg = buildWeeklyUserMessage(ctx);
  assert.ok(msg.includes('NUTRITION_WEEK:'));
  assert.ok(msg.includes('WEIGHT_TREND:'));
  assert.ok(!msg.includes('DEFICIT_ADHERENCE:'));
  assert.match(msg, /"avg_deficit":\s*600/);
  assert.match(msg, /"latest_kg":\s*102\.5/);
  assert.match(msg, /goal_calories/); // maintenance method is surfaced
  assert.ok(msg.includes('PLANNED_NEXT_WEEK:'));
});

test('(d) buildWeeklyContext source no longer has the hardcoded TDEE', () => {
  const src = readFileSync(join(here, '..', '..', 'src', 'utils', 'buildWeeklyContext.mjs'), 'utf8');
  assert.ok(!src.includes('TDEE_BASELINE'));
  assert.ok(!src.includes('computeDeficitAdherence'));
});

test('(e) buildWeeklyContextFrom reviews the prior Mon-Sun only', () => {
  const ctx = buildWeeklyContextFrom(rows, opts);
  assert.equal(ctx.mode, 'weekly');
  assert.equal(ctx.weekStart, '2026-10-26');
  assert.equal(ctx.weekEnd, '2026-11-01');
  assert.equal(ctx.nutritionWeek.n_logged, 7);
  assert.equal(ctx.nutritionWeek.n_usable, 7);
  assert.equal(ctx.nutritionWeek.avg_deficit, 600);
  assert.equal(ctx.nutritionWeek.maintenance_method, 'goal_calories');
  assert.equal(ctx.nutritionWeek.target_total, 5775);
  assert.equal(ctx.weightTrend.latest_kg, 102.5);
  assert.equal(ctx.weightTrend.kg_to_target, 12.5);
  assert.ok(!('deficitAdherence' in ctx) && !('deficitAdherenceStr' in ctx));
});
