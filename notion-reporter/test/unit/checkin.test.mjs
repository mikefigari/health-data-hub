// T4 spec: Thursday check-in mode.
//
// Pinned contracts:
//   runCheckin({ today, fetchInputs, post }) in src/utils/buildCheckin.mjs
//     - today: 'YYYY-MM-DD' (LA date). Reads currentWeekMonWed(today).
//     - fetchInputs(startDay, endDay) -> Promise<{ nutrition, weighIns, goals }>, the same
//       shape as db.getNutritionWeekInputs. nutrition rows are FLAT DB rows:
//       { day, calories, goal_calories, logged_complete }.
//     - post({ title, markdown, mode: 'checkin', date }) -> Promise<any>; called at most once,
//       only when thursdayCheck says post. title is 'Check-in · Week <ISO week>'.
//     - resolves to the thursdayCheck result (with .on_track / .post), not asserted here.
//   buildCheckinMarkdown(result) exported from the same file (not asserted directly).
//   postReport.mjs exports buildPageProperties(context, analysis, mode) (existing function,
//     now exported). For mode 'checkin', context = { date, notionRefs: {}, days: [] } and
//     analysis = the check-in markdown: Name = 'Check-in · Week <ISO week>',
//     Report Type = select 'Check-in', and no relation properties.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Fixtures are sized for maintenance 2600; the production default is 2620 (see nutritionWeek.test.mjs (k)).
process.env.MAINTENANCE_KCAL = '2600';

const row = (day, calories, goal = 2600, complete = true) =>
  ({ day, calories, goal_calories: goal, logged_complete: complete });
const inputs = (nutrition) => ({ nutrition, weighIns: [], goals: null });
const mk = (nutrition) => {
  const calls = { fetch: [], post: [] };
  return {
    calls,
    fetchInputs: async (s, e) => { calls.fetch.push([s, e]); return inputs(nutrition); },
    post: async (p) => { calls.post.push(p); return 'https://notion.so/x'; },
  };
};
const load = () => import('../../src/utils/buildCheckin.mjs');

test('(a) on track: post is not called', async () => {
  const { runCheckin } = await load();
  const s = mk([row('2026-11-02', 1700), row('2026-11-03', 1700), row('2026-11-04', 1700)]); // deficit 900
  await runCheckin({ today: '2026-11-05', fetchInputs: s.fetchInputs, post: s.post });
  assert.equal(s.calls.post.length, 0);
});

test('(b) off track: posts once with shortfall and needed kcal/day', async () => {
  const { runCheckin } = await load();
  const s = mk([row('2026-11-02', 2200), row('2026-11-03', 2200), row('2026-11-04', 2200)]); // deficit 400
  await runCheckin({ today: '2026-11-05', fetchInputs: s.fetchInputs, post: s.post });
  assert.equal(s.calls.post.length, 1);
  const p = s.calls.post[0];
  assert.equal(p.mode, 'checkin');
  assert.equal(p.title, 'Check-in · Week 45');
  assert.match(p.markdown, /1,?275/);
  assert.match(p.markdown, /1,?144/);
});

test('(c) zero usable days: posts the nudge text', async () => {
  const { runCheckin } = await load();
  const s = mk([row('2026-11-02', 0), row('2026-11-03', 1500, 2600, false)]);
  await runCheckin({ today: '2026-11-05', fetchInputs: s.fetchInputs, post: s.post });
  assert.equal(s.calls.post.length, 1);
  assert.ok(
    s.calls.post[0].markdown.includes("No food logged since Monday — the week can't be judged yet."),
    s.calls.post[0].markdown,
  );
});

test('(d) today 2026-11-05 reads Mon-Wed only', async () => {
  const { runCheckin } = await load();
  const s = mk([]);
  await runCheckin({ today: '2026-11-05', fetchInputs: s.fetchInputs, post: s.post });
  assert.deepEqual(s.calls.fetch, [['2026-11-02', '2026-11-04']]);
});

test('(e) checkin path never imports the Anthropic SDK or analyzeHealth', async () => {
  const src = await readFile(new URL('../../src/utils/buildCheckin.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /analyzeHealth/);
  assert.doesNotMatch(src, /@anthropic-ai/);
  assert.doesNotMatch(src, /analyzeWithClaude|analyze\//);
});

test('(f) postReport builds checkin title and Report Type, no relations', async () => {
  const mod = await import('../../src/notion/postReport.mjs');
  assert.equal(typeof mod.buildPageProperties, 'function');
  const props = mod.buildPageProperties(
    { date: '2026-11-05', notionRefs: {}, days: [] }, '# Check-in\n\nbody', 'checkin');
  assert.equal(props['Name'].title[0].text.content, 'Check-in · Week 45');
  assert.equal(props['Report Type'].select.name, 'Check-in');
  assert.ok(!Object.values(props).some(v => v && v.relation !== undefined), 'no relation props');
});
