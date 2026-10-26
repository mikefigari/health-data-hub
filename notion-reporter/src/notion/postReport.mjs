/**
 * postReport.mjs
 *
 * Creates a new page in the Health Intelligence Notion database.
 *
 * Actual DB property schema (as provided):
 *   Title                  title
 *   Report Type            select        ("Daily" | "Weekly" | "Check-in")
 *   Created Date           date
 *   Key Insight            rich_text     ← synthesis section from analysis
 *   Anomalies/Flags        rich_text     ← flags section from analysis
 *   Action Items           rich_text     ← left blank; no action-item section in prompts
 *   Raw Prompt             rich_text     ← context summary sent to Claude
 *   PZ                     relation      ← NOTION_POWERZONE_DB_ID
 *   Daily Physical...      relation      ← NOTION_DAILY_STATE_DB_ID (daily only)
 *                                           ⚠ Full property name assumed:
 *                                           "Daily Physical State" — verify in Notion
 *   Daily Fitness...       relation      ← NOTION_WORKOUT_DB_ID (daily only)
 *                                           ⚠ Full property name assumed:
 *                                           "Daily Fitness Log" — verify in Notion
 *
 * On Notion API failure: saves raw analysis to ./failed_reports/[date]-[mode].md
 */

import { Client as NotionClient } from '@notionhq/client';
import { mkdir, writeFile }       from 'fs/promises';
import { join, dirname }          from 'path';
import { fileURLToPath }          from 'url';
import { parseMarkdownToBlocks }  from './parseMarkdown.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAILED_REPORTS_DIR = join(__dirname, '..', '..', '..', 'failed_reports');

// ── Title helpers ─────────────────────────────────────────────────────────

function formatDailyTitle(isoDate) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  const monthDay = d.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', timeZone: 'UTC',
  });
  return `Daily · ${monthDay}`;
}

function getISOWeekNumber(isoDate) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function formatWeeklyTitle(isoDate, powerZoneName) {
  return `Week ${getISOWeekNumber(isoDate)} · ${powerZoneName ?? 'Current Block'}`;
}

export function checkinTitle(isoDate) {
  return `Check-in · Week ${getISOWeekNumber(isoDate)}`;
}

// ── Property value builders ───────────────────────────────────────────────

function titleProp(text) {
  return { title: [{ type: 'text', text: { content: text } }] };
}

function selectProp(name) {
  return { select: { name } };
}

function dateProp(isoDate) {
  return { date: { start: isoDate } };
}

function relationProp(ids) {
  return { relation: (ids ?? []).filter(Boolean).map(id => ({ id })) };
}

/**
 * Build a rich_text property value, chunking at 2000 chars per segment.
 * Notion database rich_text properties accept multiple text objects.
 */
function richTextProp(text) {
  if (!text) return { rich_text: [] };
  const chunks = [];
  let remaining = String(text);
  while (remaining.length > 0) {
    chunks.push({ type: 'text', text: { content: remaining.slice(0, 2000) } });
    remaining = remaining.slice(2000);
  }
  return { rich_text: chunks };
}

// ── Analysis text extraction ──────────────────────────────────────────────

/**
 * Extract the body text under a `## Header` section.
 * Stops at the next `##` heading or end of string.
 */
function extractSection(markdown, headerName) {
  const lines     = markdown.split('\n');
  let   inSection = false;
  const body      = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (inSection) break;
      if (line.slice(3).trim().toLowerCase() === headerName.toLowerCase()) {
        inSection = true;
      }
      continue;
    }
    if (inSection) body.push(line);
  }

  return body.join('\n').trim();
}

/**
 * Pick the most meaningful single-section summary for the Key Insight property.
 * Daily  → "Body state this morning"
 * Weekly → "What the data is saying"
 */
function extractKeyInsight(analysis, mode) {
  const header = mode === 'weekly'
    ? 'What the data is saying'
    : 'Body state this morning';
  return extractSection(analysis, header);
}

/**
 * Extract the flags/anomalies section.
 * Daily  → "Fatigue flags"
 * Weekly → "Recovery and fatigue"
 */
function extractAnomalies(analysis, mode) {
  const header = mode === 'weekly'
    ? 'Recovery and fatigue'
    : 'Fatigue flags';
  return extractSection(analysis, header);
}

/**
 * Build a compact summary of the context to store in Raw Prompt.
 * Captures the key data dimensions without the full JSON payload.
 */
function buildRawPromptSummary(context, mode) {
  const { date, days, windowSummary } = context;
  const today = days.find(d => d.day === date) ?? days[0] ?? {};
  const pmc   = today.performance_management ?? {};

  const lines = [
    `Mode: ${mode} | Date: ${date} | Days in context: ${days.length}`,
    `PMC: CTL=${pmc.ctl ?? 'n/a'} ATL=${pmc.atl ?? 'n/a'} TSB=${pmc.tsb ?? 'n/a'}`,
  ];

  if (windowSummary) {
    lines.push(
      `90-day window: CTL ${windowSummary.ctl_start}→${windowSummary.ctl_end} (${windowSummary.ctl_change > 0 ? '+' : ''}${windowSummary.ctl_change}), TSB range ${windowSummary.tsb_min}–${windowSummary.tsb_max}`
    );
  }

  if (mode === 'daily') {
    const sleep  = today.sleep ?? {};
    const nutr   = today.nutrition ?? {};
    const ready  = today.readiness ?? {};
    lines.push(`Readiness: ${ready.score ?? 'n/a'} | Sleep: ${sleep.total_sleep_sec != null ? Math.round(sleep.total_sleep_sec / 3600 * 10) / 10 + 'h' : 'n/a'}`);
    lines.push(`Nutrition: ${nutr.calories ?? 'n/a'} kcal | Protein: ${nutr.protein_g ?? 'n/a'}g`);
    lines.push(`Physical state: ${today.physical_state?.overall_state ?? 'n/a'}`);
  } else {
    const { nutritionWeek: nw, plannedNextWeek } = context;
    lines.push(`Week: ${context.weekStart ?? 'n/a'}..${context.weekEnd ?? 'n/a'} | Avg deficit: ${nw?.avg_deficit ?? 'n/a'} kcal (${nw?.n_usable ?? 0}/7 usable, ${nw?.maintenance_method ?? 'n/a'})`);
    lines.push(`Planned next week: ${(plannedNextWeek ?? []).length} sessions`);
  }

  if (context.notionRefs.powerZone) {
    lines.push(`PowerZone block: ${context.notionRefs.powerZone.name}`);
  }

  return lines.join('\n');
}

// ── Page properties builder ───────────────────────────────────────────────

export function buildPageProperties(context, analysis, mode) {
  const { date } = context;
  if (mode === 'checkin') {
    return {
      'Name':        titleProp(checkinTitle(date)),
      'Report Type': selectProp('Check-in'),
      'Action Items': richTextProp(''),
    };
  }
  const notionRefs = context.notionRefs ?? {};
  const { powerZone, dpsPageId, workoutPageIds } = notionRefs;

  const title = mode === 'weekly'
    ? formatWeeklyTitle(context.weekEnd ?? date, powerZone?.name)
    : formatDailyTitle(date);

  const props = {
    // ── Core ──
    'Name':         titleProp(title),
    'Report Type':  selectProp(mode === 'weekly' ? 'Weekly' : 'Daily'),

    // ── Text summaries extracted from Claude response ──
    'Key Insight':      richTextProp(extractKeyInsight(analysis, mode)),
    'Anomalies/Flags':  richTextProp(extractAnomalies(analysis, mode)),
    'Action Items':     richTextProp(''),        // prompts are observational-only; fill manually
    'Raw Prompt':       richTextProp(buildRawPromptSummary(context, mode)),

    // ── Relations ──
  };

  if (mode === 'daily') {
    // ⚠ Verify these exact property names match your Notion DB
    props["📸 Daily Physical State[DB]"] = relationProp(dpsPageId ? [dpsPageId] : []);
    props["🚴🏻‍♂️ Daily Fitness[DB]"] = relationProp(workoutPageIds ?? []);
  }

  return props;
}

// ── Fallback save ─────────────────────────────────────────────────────────

async function saveFailedReport(date, mode, analysis) {
  await mkdir(FAILED_REPORTS_DIR, { recursive: true });
  const filename = join(FAILED_REPORTS_DIR, `${date}-${mode}.md`);
  await writeFile(filename, analysis, 'utf8');
  console.error(`[error] Claude analysis saved to: ${filename}`);
}

// ── Main export ───────────────────────────────────────────────────────────

export async function postReport(context, analysis, mode) {
  const dbId = process.env.NOTION_HEALTH_INTELLIGENCE_DB_ID;
  if (!dbId) throw new Error('NOTION_HEALTH_INTELLIGENCE_DB_ID is not set');

  const notion     = new NotionClient({ auth: process.env.NOTION_TOKEN });
  const properties = buildPageProperties(context, analysis, mode);
  const blocks     = parseMarkdownToBlocks(analysis);

  const firstBatch   = blocks.slice(0, 100);
  const extraBatches = [];
  for (let i = 100; i < blocks.length; i += 100) {
    extraBatches.push(blocks.slice(i, i + 100));
  }

  let page;
  try {
    page = await notion.pages.create({
      parent:     { database_id: dbId },
      properties,
      children:   firstBatch,
    });
  } catch (err) {
    await saveFailedReport(context.date, mode, analysis);
    throw new Error(`Notion page creation failed: ${err.message}`);
  }

  for (const batch of extraBatches) {
    await notion.blocks.children.append({ block_id: page.id, children: batch });
  }

  return `https://notion.so/${page.id.replace(/-/g, '')}`;
}
