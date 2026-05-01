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
  for (const key of ['GEOCODE_MSG', 'RESET_MSG', 'PAGE_LOAD_MSG']) {
    const v = RwgpsUsage[key];
    assert.equal(typeof v, 'string');
    assert.ok(v.length > 0, key + ' is empty');
  }
});
