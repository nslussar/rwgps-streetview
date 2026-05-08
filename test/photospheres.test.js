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

test('buildSingleImageSearchBody: matches doc-recipe-2 positional shape', () => {
  const body = RwgpsPhotospheres.buildSingleImageSearchBody(47.6570, -122.4158, 30);
  // Snapshot-style structural assertions — these guard against accidental
  // shape changes that would break SingleImageSearch requests.
  assert.equal(Array.isArray(body), true);
  assert.equal(body.length, 4, 'body has 4 top-level segments');

  // Segment 0: client identifier
  assert.deepEqual(body[0][0], 'apiv3');
  assert.deepEqual(body[0][4], 'US');
  assert.deepEqual(body[0][10], [[0]]);

  // Segment 1: location + radius
  assert.deepEqual(body[1][0], [null, null, 47.6570, -122.4158]);
  assert.equal(body[1][1], 30);

  // Segment 2: type filter at [2][10] must include the [10,1,2] triple
  // so the response includes type-10 panoramas.
  assert.deepEqual(body[2][10], [[[2,1,2], [3,1,2], [10,1,2]]]);

  // Segment 3: response field selection + thumbnail size
  assert.deepEqual(body[3][0], [1,2,3,4,8,6,17]);
  assert.deepEqual(body[3][10], [null, null, [[[100, 100]]]]);
});
