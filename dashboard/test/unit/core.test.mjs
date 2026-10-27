// T5 spec: browser-side pure helpers (public/js/core.mjs).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseParams, tokenFromPath, fmtInt, fmtKg, fmtSigned, fmtDay, TOKENS } from '../../public/js/core.mjs';

describe('parseParams', () => {
  test('reads theme, view, range and demo', () => {
    assert.deepEqual(parseParams('?theme=dark&view=weight&range=90&demo=1'), {
      theme: 'dark',
      view: 'weight',
      range: 90,
      demo: true,
    });
  });

  test('unknown or missing values fall back to defaults', () => {
    const defaults = { theme: null, view: 'all', range: 30, demo: false };
    assert.deepEqual(parseParams(''), defaults);
    assert.deepEqual(parseParams('?theme=purple&view=nope&range=45&demo=yes'), defaults);
  });

  test('every documented view is accepted', () => {
    for (const view of ['all', 'today', 'weight', 'calories', 'protein', 'calendar', 'ftp']) {
      assert.equal(parseParams(`?view=${view}`).view, view);
    }
  });

  test('themes and ranges accepted', () => {
    assert.equal(parseParams('?theme=light').theme, 'light');
    for (const r of [7, 30, 90, 365]) assert.equal(parseParams(`?range=${r}`).range, r);
  });
});

describe('tokenFromPath', () => {
  test('extracts the token with or without trailing slash', () => {
    assert.equal(tokenFromPath('/d/abc123/'), 'abc123');
    assert.equal(tokenFromPath('/d/abc123'), 'abc123');
  });
});

describe('formatters', () => {
  test('fmtInt', () => assert.equal(fmtInt(2620), '2,620'));
  test('fmtKg', () => assert.equal(fmtKg(116.234), '116.2'));
  test('fmtSigned uses U+2212 for negatives', () => {
    assert.equal(fmtSigned(-0.94, 'kg'), '\u22120.9 kg');
  });
  test('fmtDay', () => assert.equal(fmtDay('2026-10-26'), 'Oct 26'));
});

describe('TOKENS', () => {
  const KEYS = ['bg', 'card', 'ink', 'ink2', 'ink3', 'grid', 'track', 'weight', 'calories', 'protein', 'carbs', 'fat', 'ftp', 'over'];
  const ACCENTS = ['weight', 'calories', 'protein', 'carbs', 'fat', 'ftp', 'over'];
  const HEX = /^#[0-9A-Fa-f]{6}$/;

  test('both themes define every key as hex', () => {
    for (const theme of ['light', 'dark']) {
      assert.ok(TOKENS[theme], `TOKENS.${theme}`);
      for (const k of KEYS) assert.match(String(TOKENS[theme][k]), HEX, `${theme}.${k}`);
    }
  });

  test('exact palette values', () => {
    const up = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toUpperCase()]));
    const pick = (t, keys) => up(Object.fromEntries(keys.map((k) => [k, TOKENS[t][k]])));
    assert.deepEqual(pick('light', ['bg', 'card', 'ink', 'ink2', 'grid']), {
      bg: '#F2F2F7', card: '#FFFFFF', ink: '#1C1C1E', ink2: '#6E6E73', grid: '#E5E5EA',
    });
    assert.deepEqual(pick('dark', ['bg', 'card', 'ink', 'ink2', 'grid']), {
      bg: '#191919', card: '#232325', ink: '#F2F2F7', ink2: '#98989D', grid: '#2C2C2E',
    });
    assert.deepEqual(pick('light', ACCENTS), {
      weight: '#5E5CE6', calories: '#1E9E3C', protein: '#0A84FF', carbs: '#B86E00',
      fat: '#FF4F79', ftp: '#14A3B8', over: '#E06100',
    });
    assert.deepEqual(pick('dark', ACCENTS), {
      weight: '#7D7AFF', calories: '#30D158', protein: '#409CFF', carbs: '#FFB340',
      fat: '#FF6482', ftp: '#40C8E0', over: '#FF9F0A',
    });
  });

  function luminance(hex) {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  test('every accent has contrast >= 3:1 on its own card', () => {
    for (const theme of ['light', 'dark']) {
      for (const k of ACCENTS) {
        const ratio = contrast(TOKENS[theme][k], TOKENS[theme].card);
        assert.ok(ratio >= 3, `${theme}.${k} contrast ${ratio.toFixed(2)} < 3`);
      }
    }
  });
});
