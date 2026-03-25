/**
 * notion-reporter — Health Intelligence Report
 *
 * Assembles health context from PostgreSQL, calls Claude for analysis,
 * and posts the result as a structured Notion page.
 *
 * ── SCHEDULING ────────────────────────────────────────────────────────────
 *
 * Add these entries to your crontab (`crontab -e`):
 *
 *   # Daily briefing at 10:00 AM (moved from 8am — Oura syncs by 05:00, Notion by 08:30)
 *   0 10 * * * cd /path/to/health_data_hub/notion-reporter && node index.mjs >> /home/mike/logs/notion-reporter-daily.log 2>&1
 *
 *   # Weekly review every Sunday at 8:00 PM
 *   0 20 * * 0 cd /path/to/health_data_hub/notion-reporter && REPORT_MODE=weekly node index.mjs >> /home/mike/logs/notion-reporter-weekly.log 2>&1
 *
 * On Windows with Task Scheduler, create two tasks that run:
 *   node "C:\path\to\health_data_hub\notion-reporter\index.mjs"
 * with the env var REPORT_MODE=daily (or weekly) set in the task environment.
 *
 * ── MODES ─────────────────────────────────────────────────────────────────
 *   REPORT_MODE=daily   → morning briefing (default)
 *   REPORT_MODE=weekly  → Sunday weekly review
 *   REPORT_MODE=dry     → assemble context + print prompt, no API calls
 *
 * ── SETUP ─────────────────────────────────────────────────────────────────
 *   cp .env.example .env          # fill in your credentials
 *   npm install
 *   node index.mjs                # or: npm run daily / weekly / dry
 */

import 'dotenv/config';
import { buildDailyContext }  from './src/utils/buildDailyContext.mjs';
import { buildWeeklyContext } from './src/utils/buildWeeklyContext.mjs';
import { analyzeHealth }      from './src/anthropic/analyzeHealth.mjs';
import { postReport }         from './src/notion/postReport.mjs';
import { closePool }          from './src/utils/db.mjs';

const mode = process.env.REPORT_MODE || 'daily';
const DAILY_RETRY_INTERVAL_MIN = Number(process.env.DAILY_RETRY_INTERVAL_MIN || '30');
const DAILY_RETRY_ENABLED = String(process.env.DAILY_RETRY_ENABLED || 'true').toLowerCase() !== 'false';
const DAILY_REQUIRED_SOURCES = (process.env.DAILY_REQUIRED_SOURCES || 'oura_sleep,oura_readiness,nutrition,pmc,physical_state')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getMissingRequiredSources(dataGate) {
  const missing = dataGate?.missing_sources ?? [];
  return DAILY_REQUIRED_SOURCES.filter(source => missing.includes(source));
}

function isDailyContextComplete(context) {
  const dataGate = context?.dataGate ?? {};
  const missingRequired = getMissingRequiredSources(dataGate);
  const stravaSyncOk = dataGate.strava_sync_ok === true;
  return {
    complete: missingRequired.length === 0 && stravaSyncOk,
    missingRequired,
    stravaSyncOk,
  };
}

async function buildDailyContextWithGate() {
  let attempt = 1;

  while (true) {
    const context = await buildDailyContext();
    const { complete, missingRequired, stravaSyncOk } = isDailyContextComplete(context);

    if (complete) {
      if (attempt > 1) {
        console.log(`[data_gate] All required sources present on retry ${attempt}`);
      }
      return context;
    }

    const missingText = missingRequired.length ? missingRequired.join(', ') : 'none';
    console.warn(
      `[data_gate] Incomplete daily data (attempt ${attempt}) — missing required: ${missingText}; strava_sync_ok: ${stravaSyncOk}`,
    );

    if (!DAILY_RETRY_ENABLED) {
      const err = new Error(
        `Daily report skipped: missing required sources (${missingText}) or unhealthy Strava sync.`,
      );
      err.code = 'INCOMPLETE_DAILY_DATA';
      throw err;
    }

    console.log(`[retry] Waiting ${DAILY_RETRY_INTERVAL_MIN} minutes before retrying daily context...`);
    await sleep(DAILY_RETRY_INTERVAL_MIN * 60 * 1000);
    attempt += 1;
  }
}

async function run() {
  if (!['daily', 'weekly', 'dry'].includes(mode)) {
    throw new Error(`Unknown REPORT_MODE: "${mode}". Expected daily | weekly | dry`);
  }

  console.log(`\n[${new Date().toISOString()}] Running ${mode} health intelligence report...`);

  // ── Context assembly ─────────────────────────────────────────────────
  const context = mode === 'weekly'
    ? await buildWeeklyContext()
    : mode === 'daily'
      ? await buildDailyContextWithGate()
      : await buildDailyContext();  // dry run prints raw payload without retry loop

  console.log(`[context] Date: ${context.date} | Days fetched: ${context.days.length}`);
  if (context.notionRefs.powerZone) {
    console.log(`[context] PowerZone block: "${context.notionRefs.powerZone.name}"`);
  }
  if (context.notionRefs.dpsPageId) {
    console.log(`[context] DPS page linked: ${context.notionRefs.dpsPageId}`);
  }
  if (context.notionRefs.workoutPageIds?.length) {
    console.log(`[context] Workout pages: ${context.notionRefs.workoutPageIds.length}`);
  }

  // ── Dry run: print prompt and stop ───────────────────────────────────
  if (mode === 'dry') {
    const { buildDailyUserMessage, buildWeeklyUserMessage } = await importPromptBuilders();
    const userMsg = context.mode === 'weekly'
      ? buildWeeklyUserMessage(context)
      : buildDailyUserMessage(context);

    console.log('\n' + '═'.repeat(72));
    console.log('DRY RUN — Prompt that would be sent to Claude:');
    console.log('═'.repeat(72));
    console.log(userMsg);
    console.log('═'.repeat(72));
    console.log('\n[dry] No API calls made. Exiting.');
    return;
  }

  // ── Claude analysis ──────────────────────────────────────────────────
  console.log('Context assembled. Calling Claude...');
  const analysis = await analyzeHealth(context, mode);

  console.log('\n' + '─'.repeat(72));
  console.log(analysis);
  console.log('─'.repeat(72) + '\n');

  // ── Post to Notion ───────────────────────────────────────────────────
  console.log('Analysis complete. Posting to Notion...');
  const pageUrl = await postReport(context, analysis, mode);

  console.log(`\n✓ Report posted: ${pageUrl}`);
}

// Lazy-import prompt builders (avoids loading Anthropic SDK in dry-run path)
async function importPromptBuilders() {
  // Expose internal builders for dry-run inspection
  return {
    buildDailyUserMessage: ctx => JSON.stringify({
      data_gate:           ctx.dataGate,
      today:               ctx.todayRow,
      last_night_oura:     ctx.lastNightOura,
      yesterday_nutrition: ctx.yesterdayRow?.nutrition ?? null,
      last3Nights:         ctx.last3Nights,
      calorie_context:     ctx.calorieContext,
    }, null, 2),
    buildWeeklyUserMessage: ctx => JSON.stringify({
      last14Days:       ctx.days,
      quarterSummary:   ctx.windowSummary,
      deficitAdherence: ctx.deficitAdherenceStr,
      plannedNextWeek:  ctx.plannedNextWeek,
    }, null, 2),
  };
}

// ── Top-level error handling ──────────────────────────────────────────────

run()
  .catch(err => {
    console.error(`\n[fatal] ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(() => closePool());
