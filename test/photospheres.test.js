'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RwgpsPhotospheres } = require('../lib/photospheres.js');

test('isUgcPanoid: detects CAoS-prefixed wrapped panoid', () => {
  assert.equal(
    RwgpsPhotospheres.isUgcPanoid('CAoSF0NJSE0wb2dLRUlDQWdJRGF2ZkM5d0FF'),
    true
  );
});

test('isUgcPanoid: rejects 22-char type-2 panoid', () => {
  assert.equal(
    RwgpsPhotospheres.isUgcPanoid('KMFb0s0_a3j8RgH5Zd2ryg'),
    false
  );
});

test('isUgcPanoid: rejects empty string', () => {
  assert.equal(RwgpsPhotospheres.isUgcPanoid(''), false);
});

test('isUgcPanoid: rejects null / undefined / non-string', () => {
  assert.equal(RwgpsPhotospheres.isUgcPanoid(null), false);
  assert.equal(RwgpsPhotospheres.isUgcPanoid(undefined), false);
  assert.equal(RwgpsPhotospheres.isUgcPanoid(42), false);
});

test('isUgcPanoid: bare prefix without payload returns true (accepted current behavior — downstream code is responsible for handling malformed payloads)', () => {
  assert.equal(RwgpsPhotospheres.isUgcPanoid('CAoS'), true);
});
