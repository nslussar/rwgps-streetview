'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RwgpsGeo } = require('../lib/geo.js');

test('bucketLatLng: meters=0 returns input unchanged', () => {
  const out = RwgpsGeo.bucketLatLng(47.86027, -122.62522, 0);
  assert.equal(out.lat, 47.86027);
  assert.equal(out.lng, -122.62522);
});

test('bucketLatLng: regression for 17d5410 — same lat-cell inputs produce identical lng buckets', () => {
  // All these lats round to the same lat-cell at meters=10 (latStep ≈ 9.009e-5).
  // Bucket centered near 47.86027 covers roughly [47.86023, 47.86032].
  // Pre-fix, computing cosLat from the raw input lat caused tiny lngStep drift
  // that flipped lng across a bucket boundary, producing distinct outputs for
  // points well inside one logical cell.
  const lats = [47.86024, 47.86025, 47.86026, 47.86027, 47.86028, 47.86029, 47.86030, 47.86031];
  const lng = -122.62522;
  const buckets = lats.map(lat => RwgpsGeo.bucketLatLng(lat, lng, 10));
  const firstLat = buckets[0].lat;
  const firstLng = buckets[0].lng;
  for (const b of buckets) {
    assert.equal(b.lat, firstLat, 'lat buckets should be identical');
    assert.equal(b.lng, firstLng, 'lng buckets should be identical');
  }
});

test('bucketLatLng: two points <bucket apart bucket together', () => {
  // ~2m apart at this latitude.
  const a = RwgpsGeo.bucketLatLng(47.86027, -122.62522, 10);
  const b = RwgpsGeo.bucketLatLng(47.86028, -122.62524, 10);
  assert.equal(a.lat, b.lat);
  assert.equal(a.lng, b.lng);
});

test('bucketLatLng: two points clearly >bucket apart bucket separately', () => {
  // ~50m apart in lat.
  const a = RwgpsGeo.bucketLatLng(47.86027, -122.62522, 10);
  const b = RwgpsGeo.bucketLatLng(47.86072, -122.62522, 10);
  assert.notEqual(a.lat, b.lat);
});

test('bucketLatLng: lng cell width scales with cos(lat)', () => {
  // At ~60° lat, cosLat ≈ 0.5, so each degree of lng covers ~half the
  // east-west distance it does at the equator. A given lng offset in degrees
  // therefore covers fewer meters at 60° lat than at 0° lat.
  // At 0° lat: lngStep ≈ 9.009e-5 deg (≈ 10 m); half-bucket boundary ≈ ±5m east.
  // At 60° lat: lngStep ≈ 1.802e-4 deg (still ≈ 10 m east-west); half-bucket ≈ ±5m.
  // 0.000135 deg of lng covers ~15m at the equator (crosses a bucket) but only
  // ~7.5m at 60° lat (still crosses, since half-bucket ≈ 5m).
  const meters = 10;
  const eq1 = RwgpsGeo.bucketLatLng(0, 0, meters);
  const eq2 = RwgpsGeo.bucketLatLng(0, 0.000135, meters);
  assert.notEqual(eq1.lng, eq2.lng, 'at 0° lat, 15m east should cross a lng bucket');

  // 0.00007 deg at 60° lat ≈ 3.9m east — well inside half-bucket.
  const hi1 = RwgpsGeo.bucketLatLng(60, 0, meters);
  const hi2 = RwgpsGeo.bucketLatLng(60, 0.00007, meters);
  assert.equal(hi1.lng, hi2.lng, 'at 60° lat, ~3.9m east should stay in same lng bucket');

  // At 0° lat, the same 0.00007 deg offset ≈ 7.8m east — crosses the half-bucket.
  const eq3 = RwgpsGeo.bucketLatLng(0, 0, meters);
  const eq4 = RwgpsGeo.bucketLatLng(0, 0.00007, meters);
  assert.notEqual(eq3.lng, eq4.lng, 'at 0° lat, 7.8m east should cross a lng bucket');
});

test('bucketHeading: rounds to nearest multiple', () => {
  assert.equal(RwgpsGeo.bucketHeading(0, 15), 0);
  assert.equal(RwgpsGeo.bucketHeading(7, 15), 0);
  assert.equal(RwgpsGeo.bucketHeading(8, 15), 15);
  assert.equal(RwgpsGeo.bucketHeading(22, 15), 15);
  assert.equal(RwgpsGeo.bucketHeading(23, 15), 30);
  assert.equal(RwgpsGeo.bucketHeading(135, 15), 135);
});

test('bucketHeading: normalizes to [0, 360)', () => {
  assert.equal(RwgpsGeo.bucketHeading(360, 15), 0);
  assert.equal(RwgpsGeo.bucketHeading(375, 15), 15);
  assert.equal(RwgpsGeo.bucketHeading(-5, 15), 0); // -5 rounds to 0 → 0
  assert.equal(RwgpsGeo.bucketHeading(-8, 15), 345); // -8 rounds to -15 → 345
});

test('bucketHeading: bucketDeg=0 returns input unchanged', () => {
  assert.equal(RwgpsGeo.bucketHeading(137.4, 0), 137.4);
});

test('distanceMeters: 1° at equator ≈ 111319 m', () => {
  const d = RwgpsGeo.distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
  assert.ok(Math.abs(d - 111319) < 200, 'expected ~111319 m, got ' + d);
});

test('distanceMeters: P to P is zero', () => {
  const p = { lat: 47.86, lng: -122.62 };
  assert.equal(RwgpsGeo.distanceMeters(p, p), 0);
});

test('distanceMeters: symmetric', () => {
  const a = { lat: 47.86, lng: -122.62 };
  const b = { lat: 47.87, lng: -122.61 };
  assert.equal(RwgpsGeo.distanceMeters(a, b), RwgpsGeo.distanceMeters(b, a));
});

test('computeBearing: cardinal directions', () => {
  const origin = { lat: 0, lng: 0 };
  const tol = 0.5;
  assert.ok(Math.abs(RwgpsGeo.computeBearing(origin, { lat: 1, lng: 0 }) - 0) < tol, 'N');
  assert.ok(Math.abs(RwgpsGeo.computeBearing(origin, { lat: 0, lng: 1 }) - 90) < tol, 'E');
  assert.ok(Math.abs(RwgpsGeo.computeBearing(origin, { lat: -1, lng: 0 }) - 180) < tol, 'S');
  assert.ok(Math.abs(RwgpsGeo.computeBearing(origin, { lat: 0, lng: -1 }) - 270) < tol, 'W');
});

test('bearingToCompass: spot checks', () => {
  assert.equal(RwgpsGeo.bearingToCompass(0), 'N');
  assert.equal(RwgpsGeo.bearingToCompass(90), 'E');
  assert.equal(RwgpsGeo.bearingToCompass(180), 'S');
  assert.equal(RwgpsGeo.bearingToCompass(270), 'W');
  assert.equal(RwgpsGeo.bearingToCompass(45), 'NE');
  assert.equal(RwgpsGeo.bearingToCompass(22.5), 'NNE');
  assert.equal(RwgpsGeo.bearingToCompass(360), 'N');
});

test('metersPerPixelAtZoom: equator zoom 0 ≈ 156543 m/px', () => {
  const v = RwgpsGeo.metersPerPixelAtZoom(0, 0);
  assert.ok(Math.abs(v - 156543) < 1, 'expected ~156543, got ' + v);
});

test('metersPerPixelAtZoom: halves with each zoom level', () => {
  // At equator, each zoom step doubles resolution -> halves m/px.
  for (let z = 0; z < 20; z++) {
    const a = RwgpsGeo.metersPerPixelAtZoom(0, z);
    const b = RwgpsGeo.metersPerPixelAtZoom(0, z + 1);
    assert.ok(Math.abs(a / b - 2) < 1e-9, 'z=' + z + ' ratio ' + (a / b));
  }
});

test('metersPerPixelAtZoom: scales by cos(lat)', () => {
  // At 60° lat, cos(60°) = 0.5, so m/px should be half of the equator value
  // at the same zoom.
  const eq = RwgpsGeo.metersPerPixelAtZoom(0, 13);
  const hi = RwgpsGeo.metersPerPixelAtZoom(60, 13);
  assert.ok(Math.abs(hi / eq - 0.5) < 1e-9, 'expected ~0.5, got ' + (hi / eq));
});

test('metersPerPixelAtZoom: characteristic values at typical zooms', () => {
  // Sanity-check magnitudes at the equator.
  // z=18 (street level): ~0.6 m/px. z=13: ~19 m/px. z=10: ~153 m/px.
  assert.ok(Math.abs(RwgpsGeo.metersPerPixelAtZoom(0, 18) - 0.597) < 0.01);
  assert.ok(Math.abs(RwgpsGeo.metersPerPixelAtZoom(0, 13) - 19.11) < 0.05);
  assert.ok(Math.abs(RwgpsGeo.metersPerPixelAtZoom(0, 10) - 152.88) < 0.5);
});

test('nearestPointOnPolyline: empty / single-point input returns null', () => {
  assert.equal(RwgpsGeo.nearestPointOnPolyline({ lat: 0, lng: 0 }, []), null);
  assert.equal(RwgpsGeo.nearestPointOnPolyline({ lat: 0, lng: 0 }, [{ lat: 0, lng: 0 }]), null);
});

test('nearestPointOnPolyline: cursor on a vertex returns that vertex', () => {
  const coords = [{ lat: 0, lng: 0 }, { lat: 1, lng: 0 }, { lat: 1, lng: 1 }];
  const out = RwgpsGeo.nearestPointOnPolyline({ lat: 1, lng: 0 }, coords);
  assert.ok(Math.abs(out.lat - 1) < 1e-9);
  assert.ok(Math.abs(out.lng - 0) < 1e-9);
});

test('nearestPointOnPolyline: cursor beside a segment returns foot of perpendicular', () => {
  // Segment from (0,0) to (0,1) — runs north along the prime meridian.
  // Cursor at (0.5, 0.1) should snap to (0.5, 0).
  const coords = [{ lat: 0, lng: 0 }, { lat: 1, lng: 0 }];
  const out = RwgpsGeo.nearestPointOnPolyline({ lat: 0.5, lng: 0.1 }, coords);
  assert.ok(Math.abs(out.lat - 0.5) < 1e-6, 'lat ' + out.lat);
  assert.ok(Math.abs(out.lng - 0) < 1e-6, 'lng ' + out.lng);
  assert.equal(out.segmentIndex, 0);
});
