'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RwgpsUsage = require('../lib/usage.js');

test('currentMonth: returns YYYY-MM format', () => {
  const m = RwgpsUsage.currentMonth();
  assert.match(m, /^\d{4}-\d{2}$/, 'got ' + m);
});

test('currentMonth: month component is 01-12', () => {
  const [, mm] = RwgpsUsage.currentMonth().split('-');
  const month = parseInt(mm, 10);
  assert.ok(month >= 1 && month <= 12, 'got month ' + month);
});

test('emptyUsage: shape and zero counters', () => {
  const u = RwgpsUsage.emptyUsage();
  assert.equal(u.month, RwgpsUsage.currentMonth());
  assert.equal(u.streetviewNetwork, 0);
  assert.equal(u.streetviewCached, 0);
  assert.equal(u.geocode, 0);
});

test('emptySession: shape and zero counters', () => {
  const s = RwgpsUsage.emptySession();
  assert.equal(s.streetviewNetwork, 0);
  assert.equal(s.streetviewCached, 0);
  assert.equal(s.geocode, 0);
});

test('emptyTabSession: shape and zero counters', () => {
  const t = RwgpsUsage.emptyTabSession();
  assert.equal(t.network, 0);
  assert.equal(t.cached, 0);
  assert.equal(t.geocode, 0);
});

test('readNetwork: undefined input returns 0', () => {
  assert.equal(RwgpsUsage.readNetwork(undefined), 0);
  assert.equal(RwgpsUsage.readNetwork(null), 0);
});

test('readNetwork: current-format streetviewNetwork field', () => {
  assert.equal(RwgpsUsage.readNetwork({ streetviewNetwork: 42 }), 42);
});

test('readNetwork: legacy `streetview` field falls through', () => {
  // Pre-migration shape — readNetwork should still surface the count.
  assert.equal(RwgpsUsage.readNetwork({ streetview: 17 }), 17);
});

test('readNetwork: streetviewNetwork takes precedence over legacy', () => {
  assert.equal(RwgpsUsage.readNetwork({ streetviewNetwork: 5, streetview: 99 }), 5);
});

test('readNetwork: streetviewNetwork=0 is preserved (not coerced to legacy)', () => {
  assert.equal(RwgpsUsage.readNetwork({ streetviewNetwork: 0, streetview: 99 }), 0);
});

test('DEFAULT_CAP: matches Google free tier of 10000', () => {
  assert.equal(RwgpsUsage.DEFAULT_CAP, 10000);
});

test('message-type constants are non-empty strings', () => {
  for (const key of ['GEOCODE_MSG', 'RESET_MSG', 'SET_MSG', 'PAGE_LOAD_MSG']) {
    const v = RwgpsUsage[key];
    assert.equal(typeof v, 'string');
    assert.ok(v.length > 0, key + ' is empty');
  }
});

test('message-type constants are mutually distinct', () => {
  const keys = ['GEOCODE_MSG', 'RESET_MSG', 'SET_MSG', 'PAGE_LOAD_MSG'];
  const seen = new Set();
  for (const key of keys) {
    const v = RwgpsUsage[key];
    assert.ok(!seen.has(v), 'duplicate value: ' + v);
    seen.add(v);
  }
});

test('normalizeStoredUsage: undefined input → emptyUsage, no write', () => {
  const { usage, changed } = RwgpsUsage.normalizeStoredUsage(undefined);
  assert.equal(usage.streetviewNetwork, 0);
  assert.equal(usage.streetviewCached, 0);
  assert.equal(usage.geocode, 0);
  assert.equal(usage.month, RwgpsUsage.currentMonth());
  assert.equal(changed, false);
});

test('normalizeStoredUsage: current-format object passes through unchanged', () => {
  const input = { month: '2026-05', streetviewNetwork: 500, streetviewCached: 200, geocode: 10 };
  const { usage, changed } = RwgpsUsage.normalizeStoredUsage(input);
  assert.equal(usage.streetviewNetwork, 500);
  assert.equal(usage.streetviewCached, 200);
  assert.equal(usage.geocode, 10);
  assert.equal(usage.month, '2026-05');
  assert.equal(changed, false);
});

test('normalizeStoredUsage: legacy `streetview` migrates to `streetviewNetwork`', () => {
  const input = { month: '2026-05', streetview: 500, geocode: 10 };
  const { usage, changed } = RwgpsUsage.normalizeStoredUsage(input);
  assert.equal(usage.streetviewNetwork, 500, 'counter must not be reset');
  assert.equal(usage.streetview, undefined);
  assert.equal(usage.geocode, 10);
  assert.equal(usage.streetviewCached, 0);
  assert.equal(changed, true);
});

test('normalizeStoredUsage: legacy migration does not mutate caller object', () => {
  const input = { month: '2026-05', streetview: 500 };
  RwgpsUsage.normalizeStoredUsage(input);
  assert.equal(input.streetview, 500, 'caller object preserved');
  assert.equal(input.streetviewNetwork, undefined);
});

test('normalizeStoredUsage: missing counter fields fill with 0 (NaN guard)', () => {
  // A stored object missing streetviewNetwork would yield NaN on += in flush().
  const input = { month: '2026-05', geocode: 7 };
  const { usage, changed } = RwgpsUsage.normalizeStoredUsage(input);
  assert.equal(usage.streetviewNetwork, 0);
  assert.equal(usage.streetviewCached, 0);
  assert.equal(usage.geocode, 7);
  assert.equal(changed, true);
});

test('normalizeStoredUsage: both legacy and new fields → keep new, drop legacy', () => {
  const input = { month: '2026-05', streetview: 99, streetviewNetwork: 500 };
  const { usage, changed } = RwgpsUsage.normalizeStoredUsage(input);
  assert.equal(usage.streetviewNetwork, 500);
  assert.equal(usage.streetview, undefined);
  assert.equal(changed, true);
});

test('normalizeStoredUsage: missing month falls back to current month', () => {
  const input = { streetviewNetwork: 500 };
  const { usage, changed } = RwgpsUsage.normalizeStoredUsage(input);
  assert.equal(usage.month, RwgpsUsage.currentMonth());
  assert.equal(usage.streetviewNetwork, 500, 'counter preserved');
  assert.equal(changed, true);
});
