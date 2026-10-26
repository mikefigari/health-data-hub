// Thursday check-in: numbers only, no Claude call. Posts only when off track
// (or when nothing usable was logged Mon-Wed).
import { currentWeekMonWed, thursdayCheck } from './nutritionWeek.mjs';
import { checkinTitle } from '../notion/postReport.mjs';

const fmt = (n) => Number(n).toLocaleString('en-US');

export function buildCheckinMarkdown(r) {
  if (r.status === 'no_data') {
    return [
      '# Check-in',
      '',
      "No food logged since Monday — the week can't be judged yet.",
    ].join('\n');
  }
  return [
    '# Check-in',
    '',
    `Mon–Wed average deficit: ${fmt(r.avg_deficit)} kcal/day (${r.n_usable} usable day${r.n_usable === 1 ? '' : 's'}).`,
    '',
    `- Mon–Wed total deficit: ${fmt(r.actual_3day)} kcal vs pace ${fmt(r.pace)} kcal`,
    `- Shortfall: ${fmt(r.shortfall)} kcal`,
    `- Weekly target: ${fmt(r.target_total)} kcal`,
    `- Needed Thu–Sun to still reach target: ${fmt(r.needed_per_day_thu_sun)} kcal/day deficit`,
  ].join('\n');
}

export async function runCheckin({ today, fetchInputs, post }) {
  const { start, end } = currentWeekMonWed(today);
  const { nutrition } = await fetchInputs(start, end);
  const days = (nutrition ?? []).map(r => ({
    day: r.day,
    nutrition: {
      calories: r.calories,
      goal_calories: r.goal_calories,
      logged_complete: r.logged_complete,
    },
  }));
  const result = thursdayCheck(days);
  if (!result.post) {
    console.log('[checkin] on track');
    return result;
  }
  const url = await post({
    title: checkinTitle(today),
    markdown: buildCheckinMarkdown(result),
    mode: 'checkin',
    date: today,
  });
  console.log(`[checkin] posted: ${url}`);
  return result;
}
