import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPageProperties } from '../../src/notion/postReport.mjs';

test('weekly title uses the reviewed week (weekEnd), not the Monday run date', () => {
  const ctx = {
    date: '2026-11-02', weekStart: '2026-10-26', weekEnd: '2026-11-01',
    days: [], notionRefs: { powerZone: { name: 'Base' } },
  };
  const props = buildPageProperties(ctx, '', 'weekly');
  assert.equal(props.Name.title[0].text.content, 'Week 44 · Base');
});
