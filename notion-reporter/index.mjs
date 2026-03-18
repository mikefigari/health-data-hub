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
 *   # Daily briefing at 7:00 AM
 *   0 7 * * * cd /path/to/health_data_hub/notion-reporter && REPORT_MODE=daily node index.mjs >> /var/log/health-reporter.log 2>&1
 *
 *   # Weekly review every Sunday at 8:00 PM
 *   0 20 * * 0 cd /path/to/health_data_hub/notion-reporter && REPORT_MODE=weekly node index.mjs >> /var/log/health-reporter.log 2>&1
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

async function run() {
  if (!['daily', 'weekly', 'dry'].includes(mode)) {
    throw new Error(`Unknown REPORT_MODE: "${mode}". Expected daily | weekly | dry`);
  }

  console.log(`\n[${new Date().toISOString()}] Running ${mode} health intelligence report...`);

  // ── Context assembly ─────────────────────────────────────────────────
  const context = mode === 'weekly'
    ? await buildWeeklyContext()
    : await buildDailyContext();  // also used for dry run

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
  const mod = await import('./src/anthropic/analyzeHealth.mjs');
  // Expose internal builders for dry-run inspection
  return {
    buildDailyUserMessage:  ctx => JSON.stringify({
      today:       ctx.todayRow,
      last3Nights: ctx.last3Nights,
      calCtx:      ctx.calorieContext,
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
