// T3 spec: pure aggregation. buildDashboard(inputs) -> dashboard JSON contract.
// No SQL, no HTTP, no clock: `today` is always passed in.
// Module interface assumed: src/aggregate.mjs exports buildDashboard(inputs).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildDashboard } from '../../src/aggregate.mjs';

const TODAY = '2026-10-26'; // a Monday

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diffDays(a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}

function base(over = {}) {
  return {
    today: TODAY,
    rangeDays: 7,
    planKgPerWeek: 0.75,
    proteinPctMin: 35,
    proteinPctMax: 40,
    weights: [],
    nutrition: [],
    goals: [],
    rideKj: [],
    ftp: [],
    ...over,
  };
}
function nut(day, o = {}) {
  return {
    day,
    calories: 2000,
    protein_g: 150,
    carbs_g: 200,
    fat_g: 70,
    goal_calories: 2200,
    goal_protein_g: 180,
    logged_complete: true,
    ...o,
  };
}
const GOAL = {
  effective_from: '2026-10-01',
  target_weight_kg: 100,
  base_calories: 2600,
  cycling_kj_factor: 1.0,
  protein_g: 170,
};
const near = (a, b, tol = 0.011) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

// Reference EMA (alpha 0.1) over a gap-free daily series of kg values.
function refTrend(kgs) {
  const out = [kgs[0]];
  for (let i = 1; i < kgs.length; i++) out.push(out[i - 1] + 0.1 * (kgs[i] - out[i - 1]));
  return out;
}

describe('structure and range', () => {
  test('top-level fields and goals echo', () => {
    const r = buildDashboard(base({ goals: [GOAL] }));
    assert.equal(r.today, TODAY);
    assert.equal(r.range_days, 7);
    assert.deepEqual(r.goals, {
      target_weight_kg: 100,
      base_calories: 2600,
      protein_pct_min: 35,
      protein_pct_max: 40,
      plan_kg_per_week: 0.75,
    });
  });

  for (const n of [7, 30, 90, 365]) {
    test(`nutrition.days has exactly ${n} entries, oldest first, ending today`, () => {
      const r = buildDashboard(base({ rangeDays: n }));
      const days = r.nutrition.days.map((d) => d.day);
      assert.equal(days.length, n);
      assert.equal(days[0], addDays(TODAY, -(n - 1)));
      assert.equal(days[n - 1], TODAY);
      assert.deepEqual([...days].sort(), days);
      assert.ok(r.nutrition.days.every((d) => d.status === 'missing'));
    });
  }
});

describe('status and summary (D7)', () => {
  const nutrition = [
    nut('2026-10-20'), // logged
    // 10-21 no row -> missing
    nut('2026-10-22', { calories: 0 }), // missing
    nut('2026-10-23', { calories: null }), // missing
    nut('2026-10-24', { calories: 1800, logged_complete: false }), // incomplete
    nut('2026-10-25', { calories: 2100, protein_g: 190, goal_calories: 2000, logged_complete: null }), // logged
    nut('2026-10-26', { calories: 900 }), // partial
  ];
  const r = buildDashboard(base({ nutrition }));
  const st = Object.fromEntries(r.nutrition.days.map((d) => [d.day, d.status]));

  test('status per day', () => {
    assert.deepEqual(st, {
      '2026-10-20': 'logged',
      '2026-10-21': 'missing',
      '2026-10-22': 'missing',
      '2026-10-23': 'missing',
      '2026-10-24': 'incomplete',
      '2026-10-25': 'logged',
      '2026-10-26': 'partial',
    });
  });

  test('summary uses logged days only (today excluded)', () => {
    const s = r.nutrition.summary;
    assert.equal(s.days_logged, 2);
    assert.equal(s.avg_calories, 2050);
    assert.equal(s.avg_goal_calories, 2100);
    assert.equal(s.avg_balance_kcal, -50); // ((2000-2200)+(2100-2000))/2
    assert.ok(!('protein_days_met' in s), 'protein_days_met removed (D12)');
    assert.equal(s.calorie_days_met, 1); // 2000<=2200 yes, 2100<=2000 no
  });

  test('day rows carry values and goals', () => {
    const d = r.nutrition.days.find((x) => x.day === '2026-10-25');
    assert.equal(d.calories, 2100);
    assert.equal(d.protein_g, 190);
    assert.equal(d.goal_calories, 2000);
    assert.ok(!('goal_protein_g' in d), 'goal_protein_g removed (D12)');
  });
});

describe('macro kcal', () => {
  const dayOf = (r, day) => r.nutrition.days.find((x) => x.day === day);

  test('remainder clamps at zero when macros exceed calories', () => {
    const r = buildDashboard(base({
      nutrition: [nut('2026-10-25', { calories: 2000, protein_g: 150, carbs_g: 200, fat_g: 70 })],
    }));
    const d = dayOf(r, '2026-10-25');
    assert.equal(d.kcal_protein, 600);
    assert.equal(d.kcal_carbs, 800);
    assert.equal(d.kcal_fat, 630);
    assert.equal(d.kcal_other, 0); // sum 2030 > 2000
  });

  test('remainder is calories minus macro kcal', () => {
    const r = buildDashboard(base({
      nutrition: [nut('2026-10-25', { calories: 2300, protein_g: 150, carbs_g: 200, fat_g: 70 })],
    }));
    assert.equal(dayOf(r, '2026-10-25').kcal_other, 270);
  });

  test('fractional grams: kcal rounded, grams 1 dp', () => {
    const r = buildDashboard(base({
      nutrition: [nut('2026-10-25', { calories: 2500, protein_g: 150.44, carbs_g: 200.3, fat_g: 70.25 })],
    }));
    const d = dayOf(r, '2026-10-25');
    assert.equal(d.kcal_protein, 602);
    assert.equal(d.kcal_carbs, 801);
    assert.equal(d.kcal_fat, 632);
    assert.equal(d.protein_g, 150.4);
    assert.equal(d.carbs_g, 200.3);
  });
});

describe('goal fallback (LESSONS: days with no logged rows)', () => {
  const goals = [
    GOAL,
    { effective_from: '2026-10-24', target_weight_kg: 100, base_calories: 2620, cycling_kj_factor: 0.5, protein_g: 180 },
  ];
  const rideKj = [
    { day: '2026-10-22', kj: 500.4 },
    { day: '2026-10-25', kj: 801.4 },
  ];
  const r = buildDashboard(base({
    goals,
    rideKj,
    nutrition: [
      nut('2026-10-25', { goal_calories: null, goal_protein_g: null }),
      nut('2026-10-20', { goal_calories: 2222, goal_protein_g: 175 }),
    ],
  }));
  const get = (d) => r.nutrition.days.find((x) => x.day === d);

  test('missing day uses goals row effective that day plus ride kJ', () => {
    assert.equal(get('2026-10-22').goal_calories, 3100); // 2600 + round(1.0*500.4)
    assert.equal(get('2026-10-21').goal_calories, 2600);
  });
  test('logged row with null goal falls back, newer goals row applies', () => {
    assert.equal(get('2026-10-25').goal_calories, 3021); // 2620 + round(0.5*801.4)
    assert.equal(get('2026-10-26').goal_calories, 2620);
  });
  test('explicit goal on the row is kept', () => {
    assert.equal(get('2026-10-20').goal_calories, 2222);
  });
  test('no effective goals row leaves goal null', () => {
    const r2 = buildDashboard(base({ rangeDays: 90, goals }));
    const d = r2.nutrition.days.find((x) => x.day === '2026-09-20');
    assert.equal(d.goal_calories, null);
  });
});

describe('today_rings', () => {
  test('uses today row', () => {
    const r = buildDashboard(base({ goals: [GOAL], nutrition: [nut(TODAY, { calories: 900, protein_g: 60 })] }));
    assert.deepEqual(r.today_rings, {
      calories: 900,
      goal_calories: 2200,
      protein_pct: 26.7, // 4*60/900
      logged: true,
    });
  });
  test('zeros and fallback goals when no row', () => {
    const r = buildDashboard(base({ goals: [GOAL], rideKj: [{ day: TODAY, kj: 400 }] }));
    assert.deepEqual(r.today_rings, {
      calories: 0,
      goal_calories: 3000,
      protein_pct: 0,
      logged: false,
    });
  });
});

describe('weight trend', () => {
  test('EMA with gap interpolation: 100.00, 100.10, 100.29', () => {
    const r = buildDashboard(base({
      weights: [{ day: '2026-10-20', kg: 100.0 }, { day: '2026-10-22', kg: 102.0 }],
    }));
    assert.deepEqual(r.weight.trend, [
      { day: '2026-10-20', kg: 100.0 },
      { day: '2026-10-21', kg: 100.1 },
      { day: '2026-10-22', kg: 100.29 },
    ]);
    assert.deepEqual(r.weight.scale, [
      { day: '2026-10-20', kg: 100.0 },
      { day: '2026-10-22', kg: 102.0 },
    ]);
    assert.equal(r.weight.last_weigh_in_day, '2026-10-22');
    assert.equal(r.weight.days_since_weigh_in, 4);
    assert.equal(r.weight.current_trend_kg, 100.29);
  });

  test('gap over 30 days restarts the trend', () => {
    const r = buildDashboard(base({
      rangeDays: 365,
      weights: [{ day: '2026-08-01', kg: 100.0 }, { day: '2026-10-20', kg: 90.0 }],
    }));
    const t = Object.fromEntries(r.weight.trend.map((p) => [p.day, p.kg]));
    assert.equal(t['2026-08-01'], 100.0);
    assert.equal(t['2026-10-20'], 90.0);
    assert.equal(r.weight.current_trend_kg, 90.0);
  });

  test('trend and scale are clipped to the range, no extrapolation', () => {
    const weights = [];
    for (let i = 0; i < 20; i++) weights.push({ day: addDays('2026-10-07', i), kg: 100 });
    const r = buildDashboard(base({ weights })); // range 10-20..10-26, last weigh-in 10-26
    assert.equal(r.weight.trend[0].day, '2026-10-20');
    assert.equal(r.weight.trend.at(-1).day, '2026-10-26');
    assert.equal(r.weight.scale.length, 7);

    const r2 = buildDashboard(base({ weights: [{ day: '2026-10-22', kg: 100 }] }));
    assert.deepEqual(r2.weight.trend, [{ day: '2026-10-22', kg: 100 }]);
  });

  test('current_trend_kg is independent of range; empty range handled', () => {
    const r = buildDashboard(base({ weights: [{ day: '2026-06-01', kg: 110 }] }));
    assert.equal(r.weight.current_trend_kg, 110);
    assert.equal(r.weight.last_weigh_in_day, '2026-06-01');
    assert.equal(r.weight.days_since_weigh_in, diffDays(TODAY, '2026-06-01'));
    assert.deepEqual(r.weight.trend, []);
    assert.deepEqual(r.weight.scale, []);
    assert.equal(r.weight.range_change_kg, null);
    assert.equal(r.weight.weekly_rate_kg, null);
  });

  test('range_change_kg and weekly_rate_kg', () => {
    const weights = [];
    for (let i = 0; i < 20; i++) {
      weights.push({ day: addDays('2026-10-07', i), kg: Number((110 - 0.2 * i).toFixed(2)) });
    }
    const t = refTrend(weights.map((w) => w.kg)); // t[19] is 10-26
    const r = buildDashboard(base({ weights }));
    near(r.weight.range_change_kg, t[19] - t[13]);
    near(r.weight.weekly_rate_kg, (t[19] - t[5]) / 2);
    near(r.weight.current_trend_kg, t[19]);
  });

  test('weekly_rate_kg is null when the day 14 days earlier has no trend', () => {
    const weights = [];
    for (let i = 0; i < 5; i++) weights.push({ day: addDays('2026-10-22', i), kg: 100 });
    const r = buildDashboard(base({ weights }));
    assert.equal(r.weight.weekly_rate_kg, null);
  });

  test('range_change_kg null with fewer than 2 trend values in range', () => {
    const r = buildDashboard(base({ weights: [{ day: '2026-10-22', kg: 100 }] }));
    assert.equal(r.weight.range_change_kg, null);
  });
});

describe('projection', () => {
  test('plan_date = last weigh-in + ceil(16/0.75*7) days', () => {
    const r = buildDashboard(base({
      goals: [GOAL],
      weights: [{ day: '2026-10-20', kg: 116 }],
    }));
    assert.equal(r.weight.current_trend_kg, 116);
    assert.equal(Math.abs(r.weight.to_goal_kg), 16);
    assert.equal(r.weight.projection.plan_date, addDays('2026-10-20', 150));
    assert.equal(r.weight.projection.current_rate_date, null); // no rate yet
  });

  test('current_rate_date set only when losing, within 1095 days', () => {
    const weights = [];
    for (let i = 0; i < 20; i++) weights.push({ day: addDays('2026-10-07', i), kg: Number((120 - 0.3 * i).toFixed(2)) });
    const r = buildDashboard(base({ goals: [GOAL], weights }));
    assert.ok(r.weight.weekly_rate_kg < 0);
    const cur = r.weight.projection.current_rate_date;
    assert.match(cur, /^\d{4}-\d{2}-\d{2}$/);
    const expected = Math.ceil(((r.weight.current_trend_kg - 100) / -r.weight.weekly_rate_kg) * 7);
    assert.ok(Math.abs(diffDays(cur, '2026-10-26') - expected) <= 2);
    assert.ok(diffDays(cur, '2026-10-26') <= 1095);
  });

  test('current_rate_date null when gaining', () => {
    const weights = [];
    for (let i = 0; i < 20; i++) weights.push({ day: addDays('2026-10-07', i), kg: Number((110 + 0.3 * i).toFixed(2)) });
    const r = buildDashboard(base({ goals: [GOAL], weights }));
    assert.ok(r.weight.weekly_rate_kg > 0);
    assert.equal(r.weight.projection.current_rate_date, null);
  });

  test('both null when already at or below goal', () => {
    const r = buildDashboard(base({ goals: [GOAL], weights: [{ day: '2026-10-20', kg: 99 }] }));
    assert.equal(r.weight.projection.plan_date, null);
    assert.equal(r.weight.projection.current_rate_date, null);
  });
});

describe('weeks', () => {
  const r = buildDashboard(base({
    nutrition: [
      nut('2026-10-20'),
      nut('2026-10-25', { calories: 2100, protein_g: 190, goal_calories: 2000 }),
      nut('2026-10-26', { calories: 900 }),
    ],
  }));
  test('Monday-start weeks overlapping the range', () => {
    assert.deepEqual(r.nutrition.weeks.map((w) => w.week_start), ['2026-10-19', '2026-10-26']);
  });
  test('averages over logged days; null when none', () => {
    const w = r.nutrition.weeks[0];
    assert.equal(w.days_logged, 2);
    assert.equal(w.avg_calories, 2050);
    near(w.avg_protein_pct, 33.2, 0.051); // (600+760)/(2000+2100)
    assert.equal(w.avg_goal_calories, 2100);
    assert.ok(!('avg_goal_protein_g' in w) && !('avg_protein_g' in w), 'gram fields removed (D12)');
    const cur = r.nutrition.weeks[1]; // only partial today
    assert.equal(cur.days_logged, 0);
    assert.equal(cur.avg_calories, null);
    assert.equal(cur.avg_protein_pct, null);
    assert.equal(cur.avg_kcal_protein, null);
  });
});

describe('calendar', () => {
  const r = buildDashboard(base({
    nutrition: [
      nut('2026-10-25', { calories: 2300, protein_g: 200 }), // over, 40.0 % protein
      nut('2026-10-24', { calories: 2000, protein_g: 100 }), // under, 20.0 % protein
      nut('2026-10-23', { calories: 1500, logged_complete: false }), // none
      nut('2026-10-26', { calories: 500 }), // today
      nut('2026-08-27', { calories: 2000 }), // outside range, inside 182 days
    ],
  }));
  const c = Object.fromEntries(r.calendar.days.map((d) => [d.day, d]));
  test('182 days ending today', () => {
    assert.equal(r.calendar.end, TODAY);
    assert.equal(r.calendar.start, addDays(TODAY, -181));
    assert.equal(r.calendar.days.length, 182);
    assert.equal(r.calendar.days[0].day, r.calendar.start);
  });
  test('statuses and protein_in_range', () => {
    assert.equal(c['2026-10-25'].status, 'over');
    assert.equal(c['2026-10-25'].protein_in_range, true);
    assert.ok(!('protein_met' in c['2026-10-25']), 'protein_met removed (D12)');
    assert.equal(c['2026-10-24'].status, 'under');
    assert.equal(c['2026-10-24'].protein_in_range, false);
    assert.equal(c['2026-10-23'].status, 'none');
    assert.equal(c['2026-10-26'].status, 'today');
    assert.equal(c['2026-10-22'].status, 'none');
    assert.equal(c['2026-08-27'].status, 'under');
    assert.equal(typeof c['2026-10-22'].protein_in_range, 'boolean');
  });
});

describe('ftp', () => {
  const weights = [
    { day: '2025-12-15', kg: 125 }, // before first FTP
    { day: '2026-01-01', kg: 120 },
    { day: '2026-03-10', kg: 110 },
    { day: '2026-06-01', kg: 104 },
    { day: '2026-10-20', kg: 100 },
  ];
  const ftp = [{ day: '2026-01-01', ftp_w: 240 }, { day: '2026-06-01', ftp_w: 260 }];

  test('series: one row per weigh-in on/after first FTP, FTP carried forward', () => {
    const r = buildDashboard(base({ weights, ftp }));
    assert.deepEqual(r.ftp.tests, ftp);
    assert.deepEqual(r.ftp.series, [
      { day: '2026-01-01', ftp_w: 240, weight_kg: 120, wkg: 2.0 },
      { day: '2026-03-10', ftp_w: 240, weight_kg: 110, wkg: 2.18 },
      { day: '2026-06-01', ftp_w: 260, weight_kg: 104, wkg: 2.5 },
      { day: '2026-10-20', ftp_w: 260, weight_kg: 100, wkg: 2.6 },
    ]);
  });
  test('ignores rangeDays; current uses latest FTP / current trend', () => {
    const a = buildDashboard(base({ weights, ftp, rangeDays: 7 }));
    const b = buildDashboard(base({ weights, ftp, rangeDays: 365 }));
    assert.deepEqual(a.ftp, b.ftp);
    // gap > 30 days before 10-20 restarts the trend at exactly 100
    assert.deepEqual(a.ftp.current, { ftp_w: 260, wkg: 2.6 });
  });
  test('no FTP tests -> empty and current null', () => {
    const r = buildDashboard(base({ weights }));
    assert.deepEqual(r.ftp.tests, []);
    assert.deepEqual(r.ftp.series, []);
    assert.equal(r.ftp.current, null);
  });
});

describe('protein as % of calories (D12)', () => {
  const dayOf = (r, day) => r.nutrition.days.find((x) => x.day === day);
  const withP = (day, protein_g, calories = 2000, o = {}) => nut(day, { calories, protein_g, ...o });

  test('protein_pct = round(4*protein_g/calories*100, 1) for logged and partial; null for missing/incomplete', () => {
    const r = buildDashboard(base({
      nutrition: [
        withP('2026-10-20', 140), // 28.0
        withP('2026-10-21', 200), // 40.0
        withP('2026-10-22', 150.44, 2500), // 24.07 -> 24.1
        withP('2026-10-23', 150, 1800, { logged_complete: false }),
        withP('2026-10-26', 60, 900), // partial 26.7
      ],
    }));
    assert.equal(dayOf(r, '2026-10-20').protein_pct, 28.0);
    assert.equal(dayOf(r, '2026-10-21').protein_pct, 40.0);
    assert.equal(dayOf(r, '2026-10-22').protein_pct, 24.1);
    assert.equal(dayOf(r, '2026-10-23').status, 'incomplete');
    assert.equal(dayOf(r, '2026-10-23').protein_pct, null);
    assert.equal(dayOf(r, '2026-10-24').status, 'missing');
    assert.equal(dayOf(r, '2026-10-24').protein_pct, null);
    assert.equal(dayOf(r, '2026-10-26').status, 'partial');
    assert.equal(dayOf(r, '2026-10-26').protein_pct, 26.7);
  });

  test('protein_in_range is inclusive of 35.0 and 40.0; false at 34.9, 40.1 and null', () => {
    const r = buildDashboard(base({
      rangeDays: 10,
      nutrition: [
        withP('2026-10-19', 175), // 35.0
        withP('2026-10-20', 200), // 40.0
        withP('2026-10-21', 174.5), // 34.9
        withP('2026-10-22', 200.5), // 40.1
        withP('2026-10-23', 187.5), // 37.5
        withP('2026-10-24', 150, 1800, { logged_complete: false }), // null
      ],
    }));
    const inr = (d) => dayOf(r, d).protein_in_range;
    assert.equal(dayOf(r, '2026-10-19').protein_pct, 35.0);
    assert.equal(inr('2026-10-19'), true);
    assert.equal(inr('2026-10-20'), true);
    assert.equal(dayOf(r, '2026-10-21').protein_pct, 34.9);
    assert.equal(inr('2026-10-21'), false);
    assert.equal(dayOf(r, '2026-10-22').protein_pct, 40.1);
    assert.equal(inr('2026-10-22'), false);
    assert.equal(inr('2026-10-23'), true);
    assert.equal(inr('2026-10-24'), false);
    assert.equal(inr('2026-10-25'), false); // missing
  });

  test('the band comes from the inputs, not a constant', () => {
    const r = buildDashboard(base({
      proteinPctMin: 25,
      proteinPctMax: 30,
      nutrition: [withP('2026-10-20', 140), withP('2026-10-21', 200)], // 28.0, 40.0
    }));
    assert.equal(dayOf(r, '2026-10-20').protein_in_range, true);
    assert.equal(dayOf(r, '2026-10-21').protein_in_range, false);
    assert.equal(r.goals.protein_pct_min, 25);
    assert.equal(r.goals.protein_pct_max, 30);
  });

  test('summary: weighted avg_protein_pct and protein_days_in_range (logged days only)', () => {
    const r = buildDashboard(base({
      nutrition: [
        withP('2026-10-24', 140, 2000), // 28 %
        withP('2026-10-25', 300, 3000), // 40 %
        withP(TODAY, 400, 1000), // partial today: excluded
      ],
    }));
    const s = r.nutrition.summary;
    near(s.avg_protein_pct, 35.2, 0.051); // (560+1200)/(2000+3000)
    assert.equal(s.protein_days_in_range, 1);
    assert.ok(!('protein_days_met' in s));
  });

  test('weeks: weighted avg_protein_pct, null with 0 logged days; gram averages removed', () => {
    const r = buildDashboard(base({
      nutrition: [withP('2026-10-24', 140, 2000), withP('2026-10-25', 300, 3000)],
    }));
    const w = r.nutrition.weeks[0];
    near(w.avg_protein_pct, 35.2, 0.051);
    assert.ok(!('avg_protein_g' in w));
    assert.ok(!('avg_goal_protein_g' in w));
    assert.equal(r.nutrition.weeks[1].avg_protein_pct, null);
  });

  test('today_rings: protein_pct (0 when not logged); no gram fields', () => {
    const r = buildDashboard(base({ nutrition: [withP(TODAY, 100, 1000)] }));
    assert.equal(r.today_rings.protein_pct, 40);
    assert.ok(!('protein_g' in r.today_rings) && !('goal_protein_g' in r.today_rings));
    assert.equal(buildDashboard(base()).today_rings.protein_pct, 0);
  });

  test('goals echo has the band and no protein_g', () => {
    const r = buildDashboard(base({ goals: [GOAL] }));
    assert.equal(r.goals.protein_pct_min, 35);
    assert.equal(r.goals.protein_pct_max, 40);
    assert.ok(!('protein_g' in r.goals));
  });

  test('no protein-gram goal or "goal met" key anywhere in the output', () => {
    const r = buildDashboard(base({
      goals: [GOAL],
      rangeDays: 30,
      nutrition: [withP('2026-10-20', 140), withP('2026-10-25', 200), withP(TODAY, 60, 900)],
    }));
    const bad = [];
    const walk = (v, path) => {
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
      if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (/goal_protein_g|protein_days_met|protein_met/.test(k)) bad.push(`${path}.${k}`);
          walk(x, `${path}.${k}`);
        }
      }
    };
    walk(JSON.parse(JSON.stringify(r)), '$');
    assert.deepEqual(bad.slice(0, 5), []);
  });
});
