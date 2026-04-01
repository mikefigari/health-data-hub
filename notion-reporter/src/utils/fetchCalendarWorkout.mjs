/**
 * fetchCalendarWorkout.mjs
 *
 * Fetches today's planned workout from a Google Calendar ICS feed.
 * Returns the event title (SUMMARY) for the given date, or null if
 * no event is found or the feed is unavailable.
 *
 * Set ICS_CALENDAR_URL in .env to enable. If unset, returns null silently.
 *
 * To get your ICS URL:
 *   Google Calendar → Settings → [your calendar] → Integrate calendar
 *   → "Secret address in iCal format"
 */

import ical from 'node-ical';

/**
 * @param {string} icsUrl  - URL to the ICS calendar feed
 * @param {string} date    - ISO date string (YYYY-MM-DD)
 * @returns {Promise<{ title: string } | null>}
 */
export async function fetchTodayWorkout(icsUrl, date) {
  if (!icsUrl) return null;

  let events;
  try {
    events = await ical.async.fromURL(icsUrl);
  } catch (err) {
    console.warn(`[calendar] Failed to fetch ICS feed: ${err.message}`);
    return null;
  }

  for (const event of Object.values(events)) {
    if (event.type !== 'VEVENT') continue;

    const eventDate = toIsoDate(event.start);
    if (eventDate === date) {
      const title = event.summary?.trim() ?? '(no title)';
      console.log(`[calendar] Found workout for ${date}: "${title}"`);
      return { title };
    }
  }

  console.log(`[calendar] No workout event found for ${date}`);
  return null;
}

/**
 * Converts a Date or date-only ical value to an ISO date string (YYYY-MM-DD).
 */
function toIsoDate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  // ical date-only events have .dateOnly = true and are Date objects at midnight UTC
  if (value instanceof Date) {
    // Use UTC date to avoid timezone shifting date-only events
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}
