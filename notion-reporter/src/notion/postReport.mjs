/**
 * postReport.mjs
 *
 * Creates a new page in the Health Intelligence Notion database containing:
 *   - Structured properties (Title, Report Type, Date, Status, relations)
 *   - The full Claude analysis rendered as Notion blocks (heading_2, paragraph,
 *     bulleted_list_item) via parseMarkdownToBlocks()
 *
 * On Notion API failure: saves the raw analysis to ./failed_reports/[date]-[mode].md
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
  const d = new Date(`${isoDate}T12:00:00Z`);  // noon UTC avoids timezone edge cases
  const monthDay = d.toLocaleDateString('en-US', {
    month: 'long',
    day:   'numeric',
    timeZone: 'UTC',
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
  const week      = getISOWeekNumber(isoDate);
  const blockName = powerZoneName ?? 'Current Block';
  return `Week ${week} · ${blockName}`;
}

// ── Notion property builders ──────────────────────────────────────────────

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
  const validIds = (ids ?? []).filter(Boolean);
  return { relation: validIds.map(id => ({ id })) };
}

// ── Notion page creation ──────────────────────────────────────────────────

/**
 * Build the page properties object for the Notion create call.
 *
 * ASSUMPTIONS about the Health Intelligence DB schema:
 *   - "Title"                : title
 *   - "Report Type"          : select  ("Daily" | "Weekly")
 *   - "Date"                 : date
 *   - "Status"               : select  ("Final")
 *   - "PowerZone Block"      : relation → NOTION_POWERZONE_DB_ID
 *   - "Daily Physical State" : relation → NOTION_DAILY_STATE_DB_ID  (daily only)
 *   - "Workouts"             : relation → NOTION_WORKOUT_DB_ID       (daily only)
 *
 * If any relation IDs are null/empty the relation property is still included
 * but with an empty array — Notion accepts this without error.
 */
function buildPageProperties(context, analysis, mode) {
  const { date, notionRefs } = context;
  const { powerZone, dpsPageId, workoutPageIds } = notionRefs;

  const title = mode === 'weekly'
    ? formatWeeklyTitle(date, powerZone?.name)
    : formatDailyTitle(date);

  const props = {
    'Title':       titleProp(title),
    'Report Type': selectProp(mode === 'weekly' ? 'Weekly' : 'Daily'),
    'Date':        dateProp(date),
    'Status':      selectProp('Final'),
    'PowerZone Block': relationProp(powerZone ? [powerZone.id] : []),
  };

  if (mode === 'daily') {
    props['Daily Physical State'] = relationProp(dpsPageId ? [dpsPageId] : []);
    props['Workouts']             = relationProp(workoutPageIds ?? []);
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

/**
 * Post the analysis to Notion and return the created page URL.
 *
 * @param {object} context  - from buildDailyContext / buildWeeklyContext
 * @param {string} analysis - raw Claude response text
 * @param {string} mode     - 'daily' | 'weekly'
 * @returns {string}        - URL of the created Notion page
 */
export async function postReport(context, analysis, mode) {
  const dbId = process.env.NOTION_HEALTH_INTELLIGENCE_DB_ID;
  if (!dbId) throw new Error('NOTION_HEALTH_INTELLIGENCE_DB_ID is not set');

  const notion     = new NotionClient({ auth: process.env.NOTION_TOKEN });
  const properties = buildPageProperties(context, analysis, mode);
  const blocks     = parseMarkdownToBlocks(analysis);

  // Notion API allows up to 100 blocks per create call; chunk if needed
  const firstBatch  = blocks.slice(0, 100);
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

  // Append any remaining blocks
  for (const batch of extraBatches) {
    await notion.blocks.children.append({
      block_id: page.id,
      children: batch,
    });
  }

  // Notion page URL format
  const pageIdClean = page.id.replace(/-/g, '');
  return `https://notion.so/${pageIdClean}`;
}
