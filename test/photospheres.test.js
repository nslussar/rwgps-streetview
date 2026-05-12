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
  assert.equal(body[0].length, 11, 'segment 0 length');
  assert.equal(body[1].length, 2,  'segment 1 length');
  assert.equal(body[2].length, 11, 'segment 2 length');
  assert.equal(body[3].length, 11, 'segment 3 length');

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

const fs = require('node:fs');
const path = require('node:path');

const fixturePath = (name) =>
  path.join(__dirname, 'fixtures', 'photospheres', name);

test('parseUgcUrlFromResponse: extracts gpms-cs-s URL from happy-path UGC', () => {
  const raw = fs.readFileSync(fixturePath('ugc_discovery_park.json'), 'utf8');
  const result = RwgpsPhotospheres.parseUgcUrlFromResponse(raw);
  assert.equal(result.ok, true);
  assert.match(result.tokenBase, /^https:\/\/lh3\.googleusercontent\.com\/gpms-cs-s\/[A-Za-z0-9_-]+$/);
});

test('parseUgcUrlFromResponse: extracts URL from second UGC fixture (parser not overfitted)', () => {
  const raw = fs.readFileSync(fixturePath('ugc_olympic_trail.json'), 'utf8');
  const result = RwgpsPhotospheres.parseUgcUrlFromResponse(raw);
  assert.equal(result.ok, true);
  assert.match(result.tokenBase, /^https:\/\/lh3\.googleusercontent\.com\/gpms-cs-s\/[A-Za-z0-9_-]+$/);
});

test('parseUgcUrlFromResponse: returns UGC_URL_NOT_FOUND on no-results fixture', () => {
  const raw = fs.readFileSync(fixturePath('no_results.json'), 'utf8');
  const result = RwgpsPhotospheres.parseUgcUrlFromResponse(raw);
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'UGC_URL_NOT_FOUND');
});

test('parseUgcUrlFromResponse: returns UGC_RPC_PARSE_FAIL on malformed JSON', () => {
  const result = RwgpsPhotospheres.parseUgcUrlFromResponse('not valid json');
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'UGC_RPC_PARSE_FAIL');
});

test('parseUgcUrlFromResponse: strips )]}\\\' XSSI prefix defensively', () => {
  // Synthesize a body with the XSSI prefix that the Maps API doesn't
  // actually use, but TheGreatRambler's photometa does. Free to defend.
  const fakeBody = ")]}'\n[[\"https://lh3.googleusercontent.com/gpms-cs-s/abc123-test\"]]";
  const result = RwgpsPhotospheres.parseUgcUrlFromResponse(fakeBody);
  assert.equal(result.ok, true);
  assert.equal(result.tokenBase, 'https://lh3.googleusercontent.com/gpms-cs-s/abc123-test');
});

test('parseUgcUrlFromResponse: tokenBase ends BEFORE the render-spec separator', () => {
  // Real responses have URLs like .../gpms-cs-s/<token>=w150-h75-k-no
  // We need the token base WITHOUT =w...; the regex must stop at the first =.
  const fakeBody = '[[["https://lh3.googleusercontent.com/gpms-cs-s/SOMETOKEN=w150-h75-k-no"]]]';
  const result = RwgpsPhotospheres.parseUgcUrlFromResponse(fakeBody);
  assert.equal(result.ok, true);
  assert.equal(result.tokenBase, 'https://lh3.googleusercontent.com/gpms-cs-s/SOMETOKEN');
});

test('parseUgcUrlFromResponse: extracts panoid, lat/lng, headings, pitch, copyright from olympic-trail fixture', () => {
  const raw = fs.readFileSync(fixturePath('ugc_olympic_trail.json'), 'utf8');
  const result = RwgpsPhotospheres.parseUgcUrlFromResponse(raw);
  assert.equal(result.ok, true);
  assert.equal(result.panoType, 10);
  assert.equal(result.panoid, 'CIABIhDoSxg21CJnhOxEDl_5I7PN');
  // Snapped lat/lng for the Curt Sumner trail pano at ~48.0681,-123.8254.
  assert.ok(Math.abs(result.snappedLat - 48.068066) < 0.001);
  assert.ok(Math.abs(result.snappedLng - (-123.82543)) < 0.001);
  // Heading and pitch are positional extractions — check they're plausible
  // angles (0-360 range, finite numbers) rather than exact values, so a
  // fixture refresh doesn't break the test on minor drift.
  assert.equal(typeof result.originHeading, 'number');
  assert.ok(result.originHeading >= 0 && result.originHeading < 360);
  assert.equal(typeof result.originHeadingAlt, 'number');
  assert.equal(typeof result.originPitch, 'number');
  // THETA-X-on-bike captures: pitch should be small magnitude (within +/-30°).
  assert.ok(Math.abs(result.originPitch) < 30,
    'expected small-magnitude pitch, got ' + result.originPitch);
  assert.equal(result.copyright, '© Curt Sumner');
});

test('parseUgcUrlFromResponse: same extraction works on discovery-park fixture (different photographer)', () => {
  const raw = fs.readFileSync(fixturePath('ugc_discovery_park.json'), 'utf8');
  const result = RwgpsPhotospheres.parseUgcUrlFromResponse(raw);
  assert.equal(result.ok, true);
  assert.equal(result.panoType, 10);
  assert.equal(result.panoid, 'CIHM0ogKEICAgIDavdiU2AE');
  // Discovery Park, Seattle: ~47.657, -122.416.
  assert.ok(Math.abs(result.snappedLat - 47.6570) < 0.001);
  assert.ok(Math.abs(result.snappedLng - (-122.4158)) < 0.001);
  assert.equal(typeof result.originHeading, 'number');
  assert.equal(result.copyright, '© Brian Ferris');
});

test('parseUgcUrlFromResponse: handles Yogy Namara fixture (format with packed heading+pitch)', () => {
  // The Yogy Namara fixture uses a shorter location-block shape where the
  // dedicated heading array at [1][5][0][1][1] is null and the heading+pitch
  // are packed together at [1][5][0][1][2] as [heading, ?, pitch]. The
  // parser must fall through to that position; otherwise originHeading
  // comes back undefined and the rescued render uses yaw=routeHeading
  // (often wrong direction). See SIS-rescue log analysis on 2026-05-12.
  const raw = fs.readFileSync(fixturePath('ugc_yogy_namara.json'), 'utf8');
  const result = RwgpsPhotospheres.parseUgcUrlFromResponse(raw);
  assert.equal(result.ok, true);
  assert.equal(result.panoType, 10);
  assert.equal(result.panoid, 'CIHM0ogKEICAgIC4q9vTOA');
  // Snoqualmie Valley Trail, near Carnation WA: ~47.587, -121.894.
  assert.ok(Math.abs(result.snappedLat - 47.5874) < 0.001);
  assert.ok(Math.abs(result.snappedLng - (-121.8940)) < 0.001);
  assert.equal(result.originHeading, 205.125,
    'expected heading from packed [heading,?,pitch] array at [2][0]');
  // No alternate heading available in this format.
  assert.equal(result.originHeadingAlt, undefined);
  assert.equal(result.originPitch, 10.8);
  assert.equal(result.copyright, '© Yogy Namara');
});

test('parseUgcUrlFromResponse: gracefully tolerates missing positional fields', () => {
  // Synthesize a minimal response that has the URL but no other structure.
  // parseUgcUrlFromResponse should still succeed on the URL extraction;
  // the metadata fields come back undefined rather than throwing.
  const fakeBody = '[[["https://lh3.googleusercontent.com/gpms-cs-s/TINY=w1-h1-k-no"]]]';
  const result = RwgpsPhotospheres.parseUgcUrlFromResponse(fakeBody);
  assert.equal(result.ok, true);
  assert.equal(result.tokenBase, 'https://lh3.googleusercontent.com/gpms-cs-s/TINY');
  // Missing metadata is undefined, not a throw.
  assert.equal(result.panoid, undefined);
  assert.equal(result.snappedLat, undefined);
  assert.equal(result.originHeading, undefined);
  assert.equal(result.copyright, '');
});

test('buildUgcRenderUrl: produces correct render-spec for forward-aligned heading', () => {
  const tokenBase = 'https://lh3.googleusercontent.com/gpms-cs-s/SOMETOKEN';
  // routeHeading 90, panoOriginHeading 90 → yaw 0 (forward).
  const url = RwgpsPhotospheres.buildUgcRenderUrl(tokenBase, 90, 90, 0, 400, 250);
  assert.equal(url, 'https://lh3.googleusercontent.com/gpms-cs-s/SOMETOKEN=w400-h250-k-no-pi0.0-ya0.0-ro0-fo90');
});

test('buildUgcRenderUrl: yaw is positive modulo 360', () => {
  const tokenBase = 'https://lh3.googleusercontent.com/gpms-cs-s/SOMETOKEN';
  // routeHeading 10, panoOriginHeading 350 → naive diff -340, normalized to 20.
  const url = RwgpsPhotospheres.buildUgcRenderUrl(tokenBase, 10, 350, 0, 400, 250);
  assert.equal(url, 'https://lh3.googleusercontent.com/gpms-cs-s/SOMETOKEN=w400-h250-k-no-pi0.0-ya20.0-ro0-fo90');
});

test('buildUgcRenderUrl: hardcodes pi=0 in v1 regardless of originPitch', () => {
  // Per spec section 2.5: function takes originPitch as a forward-compat
  // parameter but the v1 body hardcodes pi=0 and ignores it. Post-probe,
  // if the captured horizon is genuinely tilted, this test will be updated
  // to assert pi reflects originPitch.
  const tokenBase = 'https://lh3.googleusercontent.com/gpms-cs-s/SOMETOKEN';
  const url = RwgpsPhotospheres.buildUgcRenderUrl(tokenBase, 0, 0, /* originPitch */ 5.5, 400, 250);
  assert.match(url, /pi0\.0/);
});

test('buildUgcRenderUrl: uses requested viewport dimensions', () => {
  const tokenBase = 'https://lh3.googleusercontent.com/gpms-cs-s/SOMETOKEN';
  const url = RwgpsPhotospheres.buildUgcRenderUrl(tokenBase, 0, 0, 0, 800, 500);
  assert.match(url, /=w800-h500-/);
});
