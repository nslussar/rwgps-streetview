# UGC Photosphere Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render user-contributed (type-10) Street View photospheres in the RWGPS hover overlay so bike-path / off-pavement route segments show coverage instead of "No Street View coverage here."

**Architecture:** When `getPanorama({source: OUTDOOR})` returns a type-10 (`CAoS`-prefixed) panoid, the bridge fires its own `SingleImageSearch` POST to extract a `gpms-cs-s` URL, sends it to the content script, which renders into a single `<img>` (re-using the existing dormant `overlayImg` element). Type-2 path is unchanged.

**Tech Stack:** vanilla JavaScript (no build step, no npm), Chrome Extension Manifest V3, `node --test` for unit tests, `jj` (jujutsu) for version control.

**Source-of-truth design doc:** [`docs/superpowers/specs/2026-05-07-photospheres-ugc-rendering-design.md`](../specs/2026-05-07-photospheres-ugc-rendering-design.md). Read it before starting.

---

## File map

**Create:**
- `lib/photospheres.js` — pure helpers (`isUgcPanoid`, `buildSingleImageSearchBody`, `parseUgcUrlFromResponse`, `buildUgcRenderUrl`).
- `test/photospheres.test.js` — unit tests using `node:test`.
- `test/fixtures/photospheres/ugc_discovery_park.json` — captured SingleImageSearch response, happy path UGC.
- `test/fixtures/photospheres/ugc_olympic_trail.json` — second UGC capture (Curt Sumner Sept 2025), guards against parser overfitting.
- `test/fixtures/photospheres/no_results.json` — captured no-results response.
- `scripts/refresh-photosphere-fixtures.sh` — regenerates fixtures via curl.

**Modify:**
- `manifest.json` — add `lib/photospheres.js` to `content_scripts.js` array; add to `web_accessible_resources`.
- `content/page-bridge.js` — source filter `GOOGLE` → `OUTDOOR`; new `singleImageSearch` helper; type-10 branch in `LOOKUP_PANO`; `sendPanoInfo` / `sendPanoInfoError` helpers.
- `content/content.js` — `injectBridge` loads lib first; `handlePanoInfo` becomes router; new `renderUgcPanorama`; new `copyrightEl`; new `panoErrorMessage` with G1/G2/G3; `hideOverlay` clears UGC state.
- `content/overlay.css` — `.sv-copyright` rule.
- `docs/design/photospheres/README.md` — STATUS line at top linking forward to spec.

---

## Phase 1: pure helpers in `lib/photospheres.js`

Each helper landed via TDD. CI runs `node --test` on push, so green tests = ready to ship.

### Task 1: Set up `lib/photospheres.js` skeleton + `isUgcPanoid`

**Files:**
- Create: `lib/photospheres.js`
- Create: `test/photospheres.test.js`

- [ ] **Step 1.1: Write the failing test**

Create `test/photospheres.test.js`:

```javascript
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
```

- [ ] **Step 1.2: Run test and confirm it fails**

Run: `make test`
Expected: error along the lines of `Cannot find module '../lib/photospheres.js'`.

- [ ] **Step 1.3: Implement minimal lib skeleton**

Create `lib/photospheres.js`:

```javascript
/**
 * UGC photosphere helpers — pure functions, no DOM / Chrome / Maps JS deps.
 *
 * Loaded by:
 *   - content scripts via the manifest content_scripts.js array
 *   - the page bridge via injection from content.js (see injectBridge())
 *
 * Exposes RwgpsPhotospheres on the global. Also exports for Node tests.
 *
 * See docs/superpowers/specs/2026-05-07-photospheres-ugc-rendering-design.md
 * for the design rationale and decision log.
 */
const RwgpsPhotospheres = (() => {
  'use strict';

  // Type-10 panoids are base64-encoded protobuf wrappers — they always begin
  // with the 4-char prefix `CAoS` (which encodes field1=10). Type-2 panoids
  // are 22-char alphanumerics with no wrapper. See spec section 2.1.
  function isUgcPanoid(panoid) {
    return typeof panoid === 'string' && panoid.startsWith('CAoS');
  }

  return {
    isUgcPanoid: isUgcPanoid
  };
})();

if (typeof self !== 'undefined') self.RwgpsPhotospheres = RwgpsPhotospheres;
if (typeof window !== 'undefined') window.RwgpsPhotospheres = RwgpsPhotospheres;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RwgpsPhotospheres };
}
```

- [ ] **Step 1.4: Run test and confirm it passes**

Run: `make test`
Expected: 4 passing tests, no failures.

- [ ] **Step 1.5: Commit**

```bash
jj commit -m "Add lib/photospheres.js skeleton with isUgcPanoid"
```

---

### Task 2: `buildSingleImageSearchBody`

**Files:**
- Modify: `lib/photospheres.js`
- Modify: `test/photospheres.test.js`

- [ ] **Step 2.1: Append failing tests**

Append to `test/photospheres.test.js`:

```javascript
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
```

- [ ] **Step 2.2: Run tests and confirm new ones fail**

Run: `make test`
Expected: existing tests pass, new test errors with `buildSingleImageSearchBody is not a function`.

- [ ] **Step 2.3: Add `buildSingleImageSearchBody` to lib**

In `lib/photospheres.js`, inside the IIFE, add the function and include it in the return object:

```javascript
  // SingleImageSearch request body — positional protobuf-as-JSON (JSPB), not
  // binary protobuf. Shape from the design-doc recipe 2 curl. The [10,1,2]
  // triple at [2][10] admits type-10 (UGC) panoramas; remove that triple to
  // restore type-2-only behavior. Thumbnail size [100,100] is small because
  // we ignore the response's render-spec — we extract the token base and
  // build our own URL with viewport-sized render params.
  function buildSingleImageSearchBody(lat, lng, radius) {
    return [
      ['apiv3', null, null, null, 'US', null, null, null, null, null, [[0]]],
      [[null, null, lat, lng], radius],
      [null, ['en', 'US'], null, null, null, null, null, null, [2], null,
        [[[2,1,2], [3,1,2], [10,1,2]]]],
      [[1,2,3,4,8,6,17], null, null, null, null, null, null, null, null, null,
        [null, null, [[[100, 100]]]]]
    ];
  }
```

Update return object:

```javascript
  return {
    isUgcPanoid: isUgcPanoid,
    buildSingleImageSearchBody: buildSingleImageSearchBody
  };
```

- [ ] **Step 2.4: Run tests and confirm all pass**

Run: `make test`
Expected: all tests pass.

- [ ] **Step 2.5: Commit**

```bash
jj commit -m "Add buildSingleImageSearchBody to lib/photospheres"
```

---

### Task 3: Capture SingleImageSearch fixtures

Real captured response bodies are needed before we can write parser tests.

**Files:**
- Create: `scripts/refresh-photosphere-fixtures.sh`
- Create: `test/fixtures/photospheres/ugc_discovery_park.json`
- Create: `test/fixtures/photospheres/ugc_olympic_trail.json`
- Create: `test/fixtures/photospheres/no_results.json`

- [ ] **Step 3.1: Write the refresh script**

Create `scripts/refresh-photosphere-fixtures.sh`:

```bash
#!/usr/bin/env bash
# Refresh SingleImageSearch fixtures used by test/photospheres.test.js.
# Run manually when:
#   - The parser breaks in the wild (response shape changed).
#   - Before each release as a smoke test.
#   - A bug report mentions G1/G2/G3 errors.
#
# After running, diff the fixtures against the prior versions and commit if
# the changes look intentional. A structural shift is exactly what we want
# this script to surface.
#
# Coordinates chosen for stability:
#   - Discovery Park trail (Brian Ferris) — known UGC, used in spec recipe 2
#   - Olympic Discovery Trail (Curt Sumner Sept 2025) — different photographer
#   - 0,0 mid-ocean — guaranteed no-results
set -euo pipefail

OUT=test/fixtures/photospheres
mkdir -p "$OUT"

curl_sis() {  # lat lng radius outfile
  local lat="$1" lng="$2" radius="$3" outfile="$4"
  curl -s 'https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch' \
    -H 'content-type: application/json+protobuf' \
    -H 'x-user-agent: grpc-web-javascript/0.1' \
    -H 'origin: https://ridewithgps.com' \
    -H 'referer: https://ridewithgps.com/' \
    --data-raw "[[\"apiv3\",null,null,null,\"US\",null,null,null,null,null,[[0]]],[[null,null,${lat},${lng}],${radius}],[null,[\"en\",\"US\"],null,null,null,null,null,null,[2],null,[[[2,1,2],[3,1,2],[10,1,2]]]],[[1,2,3,4,8,6,17],null,null,null,null,null,null,null,null,null,[null,null,[[[100,100]]]]]]" \
    > "$OUT/$outfile"
  echo "  → $OUT/$outfile ($(wc -c < "$OUT/$outfile") bytes)"
}

echo "Capturing SingleImageSearch fixtures..."
curl_sis 47.6570 -122.4158 30 ugc_discovery_park.json
curl_sis 48.0680667 -123.8254309 30 ugc_olympic_trail.json
curl_sis 0 0 10 no_results.json
echo "Done. Diff the fixtures and commit if changes look intentional."
```

Make it executable:

```bash
chmod +x scripts/refresh-photosphere-fixtures.sh
```

- [ ] **Step 3.2: Run the refresh script to capture initial fixtures**

Run: `./scripts/refresh-photosphere-fixtures.sh`

Expected output:

```
Capturing SingleImageSearch fixtures...
  → test/fixtures/photospheres/ugc_discovery_park.json (... bytes)
  → test/fixtures/photospheres/ugc_olympic_trail.json (... bytes)
  → test/fixtures/photospheres/no_results.json (... bytes)
Done. Diff the fixtures and commit if changes look intentional.
```

- [ ] **Step 3.3: Sanity-check the captured fixtures**

```bash
ls -la test/fixtures/photospheres/
grep -c 'gpms-cs-s' test/fixtures/photospheres/ugc_discovery_park.json
grep -c 'gpms-cs-s' test/fixtures/photospheres/ugc_olympic_trail.json
grep -c 'gpms-cs-s' test/fixtures/photospheres/no_results.json
```

Expected:
- All three files non-empty.
- `ugc_discovery_park.json` and `ugc_olympic_trail.json` each contain `>=1` `gpms-cs-s` match.
- `no_results.json` contains `0` matches.

If a UGC fixture doesn't contain `gpms-cs-s`, the lat/lng may have lost coverage — pick a different known UGC location and update the script. The Olympic Discovery Trail location should be stable (uploaded Sept 2025).

- [ ] **Step 3.4: Commit fixtures + script**

```bash
jj commit -m "Add SingleImageSearch fixture refresh script + initial fixtures"
```

---

### Task 4: `parseUgcUrlFromResponse`

**Files:**
- Modify: `lib/photospheres.js`
- Modify: `test/photospheres.test.js`

- [ ] **Step 4.1: Append failing tests**

Append to `test/photospheres.test.js`:

```javascript
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
```

- [ ] **Step 4.2: Run tests and confirm new ones fail**

Run: `make test`
Expected: existing tests pass, new tests error with `parseUgcUrlFromResponse is not a function`.

- [ ] **Step 4.3: Implement `parseUgcUrlFromResponse`**

In `lib/photospheres.js`, inside the IIFE:

```javascript
  // Parses a SingleImageSearch response body. Pattern-matches the
  // gpms-cs-s URL out of the serialized JSON instead of walking positional
  // indices — robust to Google moving the URL field within the response.
  // Returns:
  //   { ok: true,  tokenBase: 'https://lh3.googleusercontent.com/gpms-cs-s/<token>' }
  //   { ok: false, errorClass: 'UGC_RPC_PARSE_FAIL' | 'UGC_URL_NOT_FOUND', message: string }
  function parseUgcUrlFromResponse(rawText) {
    // Defensive XSSI prefix strip — Maps API doesn't appear to use it for
    // SingleImageSearch responses, but TheGreatRambler's photometa endpoint
    // does. Free to defend against either family ever using it.
    let body = rawText;
    if (body.length >= 4 && body.slice(0, 4) === ")]}'") {
      body = body.replace(/^\)\]\}'\n?/, '');
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      return {
        ok: false,
        errorClass: 'UGC_RPC_PARSE_FAIL',
        message: e.message
      };
    }

    // Token charset is base64url-style (no '=' or '/'), so the regex
    // captures the full token without crossing into the render-spec
    // separator '=w...' / '=x...'.
    const serialized = JSON.stringify(parsed);
    const match = serialized.match(
      /https:\/\/lh3\.googleusercontent\.com\/gpms-cs-s\/[A-Za-z0-9_-]+/);
    if (!match) {
      return {
        ok: false,
        errorClass: 'UGC_URL_NOT_FOUND',
        message: 'response missing gpms-cs-s URL (snippet: ' + body.slice(0, 200) + ')'
      };
    }
    return { ok: true, tokenBase: match[0] };
  }
```

Update return object:

```javascript
  return {
    isUgcPanoid: isUgcPanoid,
    buildSingleImageSearchBody: buildSingleImageSearchBody,
    parseUgcUrlFromResponse: parseUgcUrlFromResponse
  };
```

- [ ] **Step 4.4: Run tests and confirm all pass**

Run: `make test`
Expected: all tests pass.

- [ ] **Step 4.5: Commit**

```bash
jj commit -m "Add parseUgcUrlFromResponse with XSSI-defensive JSON parsing"
```

---

### Task 5: `buildUgcRenderUrl`

**Files:**
- Modify: `lib/photospheres.js`
- Modify: `test/photospheres.test.js`

- [ ] **Step 5.1: Append failing tests**

Append to `test/photospheres.test.js`:

```javascript
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
```

- [ ] **Step 5.2: Run tests and confirm new ones fail**

Run: `make test`
Expected: existing tests pass, new tests error with `buildUgcRenderUrl is not a function`.

- [ ] **Step 5.3: Implement `buildUgcRenderUrl`**

In `lib/photospheres.js`, inside the IIFE:

```javascript
  // Build the gpms-cs-s render URL for a UGC photosphere. The token base
  // (everything before the '=') is provided by parseUgcUrlFromResponse;
  // we control everything after.
  //
  // Render-spec params:
  //   w<W>-h<H>     viewport pixel dimensions
  //   k-no          flag: keep size as-is, no further server crop
  //   pi<P>         pitch in degrees (0 = horizon level)
  //   ya<Y>         yaw in degrees (0 = panorama's originHeading direction)
  //   ro0           roll = 0
  //   fo<FOV>       field of view in degrees
  //
  // V1 NOTE: the body hardcodes pi=0 and ignores the originPitch param.
  // Post-probe (see spec section 6), if the captured horizon is genuinely
  // tilted on THETA-X-on-bicycle captures, replace the `0.0` literal below
  // with `originPitch` (or `-originPitch` per probe result).
  function buildUgcRenderUrl(tokenBase, routeHeading, panoOriginHeading, originPitch, viewportW, viewportH) {
    const yaw = (((routeHeading - panoOriginHeading) % 360) + 360) % 360;
    const pitch = 0;  // v1 hardcoded; see spec section 2.5
    const fov = 90;
    return tokenBase
      + '=w' + viewportW + '-h' + viewportH + '-k-no'
      + '-pi' + pitch.toFixed(1)
      + '-ya' + yaw.toFixed(1)
      + '-ro0-fo' + fov;
  }
```

Update return object:

```javascript
  return {
    isUgcPanoid: isUgcPanoid,
    buildSingleImageSearchBody: buildSingleImageSearchBody,
    parseUgcUrlFromResponse: parseUgcUrlFromResponse,
    buildUgcRenderUrl: buildUgcRenderUrl
  };
```

- [ ] **Step 5.4: Run tests and confirm all pass**

Run: `make test`
Expected: all tests pass (10+ tests now).

- [ ] **Step 5.5: Commit**

```bash
jj commit -m "Add buildUgcRenderUrl with v1 pi=0 hardcoding"
```

---

## Phase 2: wire up lib in manifest + bridge injection

### Task 6: Add `lib/photospheres.js` to manifest and inject before bridge

**Files:**
- Modify: `manifest.json`
- Modify: `content/content.js:361-366` (injectBridge function)

- [ ] **Step 6.1: Update manifest**

Edit `manifest.json`. Two changes:

1. Add `lib/photospheres.js` to the content_scripts.js array (after `lib/geo.js`, before `content/content.js`):

```diff
   "content_scripts": [
     {
       "matches": ["https://ridewithgps.com/routes/*"],
-      "js": ["lib/usage.js", "content/api-budget.js", "lib/geo.js", "content/content.js"],
+      "js": ["lib/usage.js", "content/api-budget.js", "lib/geo.js", "lib/photospheres.js", "content/content.js"],
       "css": ["content/overlay.css"],
       "run_at": "document_idle"
     }
   ],
```

2. Add `lib/photospheres.js` to web_accessible_resources so the bridge can load it:

```diff
   "web_accessible_resources": [
     {
-      "resources": ["content/page-bridge.js", "icons/heading-arrow.svg"],
+      "resources": ["content/page-bridge.js", "lib/photospheres.js", "icons/heading-arrow.svg"],
       "matches": ["https://ridewithgps.com/*"]
     }
   ],
```

- [ ] **Step 6.2: Update `injectBridge` to load lib first**

In `content/content.js`, replace the `injectBridge` function (currently at lines 361-366):

```javascript
  function injectBridge() {
    // Inject the photospheres lib first so the bridge can call its helpers.
    // Both go into MAIN world (the bridge's execution context). Top-level
    // const declarations in the lib become available to the bridge via
    // shared global lexical scope; the lib also attaches to window for
    // belt-and-suspenders.
    const lib = document.createElement('script');
    lib.src = chrome.runtime.getURL('lib/photospheres.js');
    document.documentElement.appendChild(lib);
    lib.onload = function () {
      lib.remove();
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('content/page-bridge.js');
      document.documentElement.appendChild(script);
      script.onload = function () { script.remove(); };
    };
  }
```

- [ ] **Step 6.3: Manual smoke test — load extension, verify nothing broke**

1. Load the unpacked extension at `chrome://extensions` (or reload if already loaded).
2. Navigate to a RWGPS route page with Google Maps selected, e.g. https://ridewithgps.com/routes/<any-id>.
3. Open DevTools → Console.
4. Verify no errors from `[RWGPS Street View]`, `[RWGPS SV Bridge]`, or generic JS errors related to `lib/photospheres.js`.
5. Hover over a known type-2 (SV-car) road — verify the existing tile-grid Street View overlay still works as before.
6. In the console, run: `console.log(window.RwgpsPhotospheres);` — this is the ISOLATED world's lib reference. Should NOT log (content scripts have a separate window). Skip if this confuses you; it's not a real check.

- [ ] **Step 6.4: Commit**

```bash
jj commit -m "Wire lib/photospheres into content scripts and bridge injection"
```

---

## Phase 3: bridge changes

### Task 7: Source filter `GOOGLE` → `OUTDOOR`

**Files:**
- Modify: `content/page-bridge.js:580-581` (LOOKUP_PANO source filter)

- [ ] **Step 7.1: Apply the filter change**

Edit `content/page-bridge.js`, in the `LOOKUP_PANO` case (around line 580):

```diff
-          // Filter out user-contributed photospheres — the streetviewpixels-pa
-          // tile endpoint doesn't serve them, so we'd get a panoid we can't
-          // render. GOOGLE source = Google-captured SV only.
-          var sourceVal = (lib.StreetViewSource && lib.StreetViewSource.GOOGLE) || 'google';
+          // OUTDOOR excludes indoor type-2 ("Business View") panoramas AND
+          // admits user-contributed photospheres (type-10) into the candidate
+          // set. At the extension's small radius, type-2 ranking is effectively
+          // moot on bike paths (no type-2 in range) and OUTDOOR falls through
+          // to type-10 by elimination — recovering bike-path coverage.
+          // See spec section 2.2.
+          //
+          // FUTURE: filter UGC by source tag (photos:street_view_android only)
+          // if quality complaints come in — see spec section 7.2.
+          var sourceVal = (lib.StreetViewSource && lib.StreetViewSource.OUTDOOR) || 'outdoor';
           opts.source = sourceVal;
```

- [ ] **Step 7.2: Manual test — UGC panoid now returned**

1. Reload the unpacked extension.
2. Open the route editor for any route on Olympic Discovery Trail or other UGC-only segment. If you don't have one, create a route point at `48.0680667, -123.8254309` and use that.
3. Open DevTools → Console.
4. Hover the cursor over the trail point. Expected console output:
   - `[RWGPS Street View]` log mentioning a panoid that **starts with `CAoS`** (e.g. `CAoSF...`).
   - The overlay shows "No Street View coverage here" or a broken-image error — that's expected at this stage; we haven't added the type-10 render path yet. We're verifying the filter change admits UGC at all.

- [ ] **Step 7.3: Commit**

```bash
jj commit -m "Bridge: switch getPanorama source from GOOGLE to OUTDOOR"
```

---

### Task 8: Bridge — `singleImageSearch` helper, type-10 LOOKUP_PANO branch, error-class plumbing

This is the meat of the bridge change. Three additions go together because the type-10 branch can't be tested without the helper, and the helper has nowhere to be called from without the branch.

**Files:**
- Modify: `content/page-bridge.js` — add module-scope constant + helpers near top (after getStreetViewLib, ~line 68); rewrite LOOKUP_PANO handler

- [ ] **Step 8.1: Add module-scope constant + `singleImageSearch` + sendPanoInfo helpers**

In `content/page-bridge.js`, after the `getStreetViewLib` function (currently ends around line 68), add:

```javascript
  // SingleImageSearch RPC — used to extract the gpms-cs-s URL for type-10
  // (UGC) panoramas. The endpoint is keyless; CORS-permissive from
  // ridewithgps.com origin. See design spec section 4.2 for the request
  // shape rationale.
  var SINGLE_IMAGE_SEARCH_URL =
    'https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch';

  // No bridge-side cache for v1: each LOOKUP_PANO that resolves to type-10
  // fires its own SingleImageSearch. Forward-sweep workflows get zero
  // benefit from caching here (each bucketed cursor position resolves to a
  // unique panoid on trails with ~10m UGC spacing — typical when one rider
  // uploads via a 360 camera at fixed intervals). Re-sweep / cursor-pause
  // workflows would benefit, but the cache costs ~10 lines.
  // FUTURE: see spec section 7.1 for a panoid-keyed cache + concurrent-dedup
  // map design when telemetry justifies it.

  // POST a SingleImageSearch request and parse the response for the
  // gpms-cs-s URL. Returns:
  //   { ok: true,  tokenBase: '...' }
  //   { ok: false, errorClass: 'UGC_RPC_HTTP_ERROR' | 'UGC_RPC_PARSE_FAIL' | 'UGC_URL_NOT_FOUND', message: string }
  async function singleImageSearch(lat, lng, radius) {
    var body;
    try {
      body = JSON.stringify(
        RwgpsPhotospheres.buildSingleImageSearchBody(lat, lng, radius));
    } catch (e) {
      return {
        ok: false,
        errorClass: 'UGC_RPC_PARSE_FAIL',
        message: 'body build failed: ' + e.message
      };
    }

    var resp;
    try {
      resp = await fetch(SINGLE_IMAGE_SEARCH_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json+protobuf',
          'x-user-agent': 'grpc-web-javascript/0.1'
        },
        body: body
      });
    } catch (e) {
      return {
        ok: false,
        errorClass: 'UGC_RPC_HTTP_ERROR',
        message: 'network: ' + e.message
      };
    }

    if (!resp.ok) {
      return {
        ok: false,
        errorClass: 'UGC_RPC_HTTP_ERROR',
        message: 'HTTP ' + resp.status
      };
    }

    var rawText = await resp.text();
    return RwgpsPhotospheres.parseUgcUrlFromResponse(rawText);
  }

  // Wrap window.postMessage boilerplate for PANO_INFO responses.
  function sendPanoInfo(reqId, data) {
    window.postMessage({
      type: PREFIX + 'RESPONSE',
      action: 'PANO_INFO',
      data: data,
      requestId: reqId
    }, '*');
  }
  function sendPanoInfoError(reqId, errResult) {
    window.postMessage({
      type: PREFIX + 'RESPONSE',
      action: 'PANO_INFO',
      data: {
        error: errResult.message || 'unknown',
        noCoverage: errResult.errorClass === 'NO_COVERAGE',
        errorClass: errResult.errorClass
      },
      requestId: reqId
    }, '*');
  }
```

- [ ] **Step 8.2: Rewrite LOOKUP_PANO `getPanorama.then` handler with type-10 branch**

In `content/page-bridge.js`, find the LOOKUP_PANO case (around line 559). Replace the `svc.getPanorama(opts).then(...).catch(...)` block. Currently:

```javascript
          svc.getPanorama(opts)
            .then(function (res) {
              var d = res && res.data;
              if (!d || !d.location) {
                window.postMessage({
                  type: PREFIX + 'RESPONSE',
                  action: 'PANO_INFO',
                  data: { error: 'no data' },
                  requestId: reqId
                }, '*');
                return;
              }
              var ws = d.tiles && d.tiles.worldSize;
              window.postMessage({
                type: PREFIX + 'RESPONSE',
                action: 'PANO_INFO',
                data: {
                  panoid: d.location.pano,
                  snappedLat: d.location.latLng.lat(),
                  snappedLng: d.location.latLng.lng(),
                  originHeading: d.tiles && d.tiles.originHeading,
                  originPitch: d.tiles && d.tiles.originPitch,
                  worldSize: ws ? { width: ws.width, height: ws.height } : null
                },
                requestId: reqId
              }, '*');
            })
            .catch(function (e) {
              var emsg = String(e && e.message || e);
              var noCoverage = emsg.indexOf('ZERO_RESULTS') !== -1;
              window.postMessage({
                type: PREFIX + 'RESPONSE',
                action: 'PANO_INFO',
                data: { error: emsg, noCoverage: noCoverage },
                requestId: reqId
              }, '*');
            });
```

Replace with:

```javascript
          svc.getPanorama(opts)
            .then(async function (res) {
              var d = res && res.data;
              if (!d || !d.location) {
                sendPanoInfoError(reqId, { errorClass: 'NO_COVERAGE', message: 'no data' });
                return;
              }

              var panoid = d.location.pano;
              var common = {
                panoid: panoid,
                snappedLat: d.location.latLng.lat(),
                snappedLng: d.location.latLng.lng(),
                originHeading: d.tiles && d.tiles.originHeading,
                originPitch: d.tiles && d.tiles.originPitch,
                copyright: d.copyright || ''
              };

              // Type-10 (UGC) branch — fire SingleImageSearch to extract the
              // gpms-cs-s URL. streetviewpixels-pa doesn't serve type-10, so
              // we have to render via a different content tier.
              if (RwgpsPhotospheres.isUgcPanoid(panoid)) {
                var ugcResult = await singleImageSearch(msg.data.lat, msg.data.lng, radius);
                if (ugcResult.ok) {
                  sendPanoInfo(reqId, Object.assign({}, common, {
                    kind: 'ugc',
                    tokenBase: ugcResult.tokenBase
                  }));
                } else {
                  sendPanoInfoError(reqId, ugcResult);
                }
                return;
              }

              // Type-2 path — existing tile-grid render.
              var ws = d.tiles && d.tiles.worldSize;
              sendPanoInfo(reqId, Object.assign({}, common, {
                kind: 'tile',
                worldSize: ws ? { width: ws.width, height: ws.height } : null
              }));
            })
            .catch(function (e) {
              var emsg = String(e && e.message || e);
              var noCoverage = emsg.indexOf('ZERO_RESULTS') !== -1;
              sendPanoInfoError(reqId, {
                errorClass: noCoverage ? 'NO_COVERAGE' : 'UGC_RPC_HTTP_ERROR',
                message: emsg
              });
            });
```

- [ ] **Step 8.3: Manual smoke test — bridge produces UGC PANO_INFO**

1. Reload extension.
2. Hover over a UGC trail point (Olympic Discovery Trail, Curt Sumner pano area).
3. Open DevTools console. Look for messages.
4. Expected:
   - `[RWGPS SV Bridge]` log mentioning a `CAoS...` panoid.
   - Network tab shows a POST to `maps.googleapis.com/$rpc/.../SingleImageSearch` returning 200.
   - Content-side handlePanoInfo will fail to render properly (no UGC path yet) — overlay will show "No Street View coverage here" or similar. This is expected at this stage.
5. Hover over a known type-2 road. Verify:
   - Existing tile-grid render still works.
   - No SingleImageSearch POST in network tab (type-2 doesn't go through the new branch).

- [ ] **Step 8.4: Commit**

```bash
jj commit -m "Bridge: type-10 branch with SingleImageSearch, error-class plumbing"
```

---

## Phase 4: content script + CSS

### Task 9: Add `copyrightEl` element + `.sv-copyright` CSS

**Files:**
- Modify: `content/content.js` — add element creation in `createOverlay`, add module-scope reference
- Modify: `content/overlay.css` — add `.sv-copyright` rule

- [ ] **Step 9.1: Add `.sv-copyright` CSS rule**

Append to `content/overlay.css`:

```css
/* Photographer attribution for UGC photospheres. Hidden by default; JS
   toggles visibility per render. May remove if attribution proves
   unnecessary — see spec section 7.3. */
#rwgps-sv-overlay .sv-copyright {
  position: absolute;
  bottom: 4px;
  right: 4px;
  font-size: 10px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: rgba(255, 255, 255, 0.85);
  background: rgba(0, 0, 0, 0.5);
  padding: 1px 4px;
  border-radius: 2px;
  pointer-events: none;
  z-index: 5;
}
```

- [ ] **Step 9.2: Add `copyrightEl` to overlay**

In `content/content.js`, find the module-scope DOM-element variable declarations (search for `streetLabelEl`, `headingLabelEl`, etc. — likely near top of the IIFE). Add a new variable:

```javascript
  var copyrightEl;
```

In the `createOverlay` function (around line 368), find where `headingLabelEl`, `hintLabelEl`, etc. are created and appended. Add `copyrightEl` creation after `hintLabelEl` creation (around line 424) and before the `appendChild` calls:

```javascript
    copyrightEl = document.createElement('div');
    copyrightEl.className = 'sv-copyright';
    copyrightEl.style.display = 'none';
```

Add to the `appendChild` sequence (after `headingArrowEl`, before `document.body.appendChild`):

```javascript
    overlayEl.appendChild(copyrightEl);
```

Final block in createOverlay should look like:

```javascript
    overlayEl.appendChild(overlayImg);
    overlayEl.appendChild(overlayTilesEl);
    overlayEl.appendChild(loadingEl);
    overlayEl.appendChild(noCoverageEl);
    overlayEl.appendChild(streetLabelEl);
    overlayEl.appendChild(headingLabelEl);
    overlayEl.appendChild(hintLabelEl);
    overlayEl.appendChild(headingArrowEl);
    overlayEl.appendChild(copyrightEl);
    document.body.appendChild(overlayEl);
    applyOverlayCssVars();
```

- [ ] **Step 9.3: Manual smoke test — element exists, hidden**

1. Reload extension.
2. Hover over any route point to trigger overlay creation.
3. In DevTools, inspect `#rwgps-sv-overlay`. Confirm a child `<div class="sv-copyright" style="display: none;">` exists.

- [ ] **Step 9.4: Commit**

```bash
jj commit -m "Add copyrightEl element + sv-copyright CSS"
```

---

### Task 10: Split `handlePanoInfo` into router + `renderTilePanorama` (pure refactor)

This is a no-behavior-change refactor. It extracts the entire existing tile-rendering body into a renamed function so we can plug in a parallel UGC renderer in the next task.

**Files:**
- Modify: `content/content.js:975-1103` (handlePanoInfo function)

- [ ] **Step 10.1: Extract body into `renderTilePanorama`**

In `content/content.js`, find `function handlePanoInfo(data, requestId) {` (around line 975). The function currently runs everything from the stale-check through the 6-tile preload.

Refactor it to a router that delegates to `renderTilePanorama`. Replace the entire function with two functions:

```javascript
  function handlePanoInfo(data, requestId) {
    if (requestId !== panoLookupCounter) return; // stale

    if (data.error) {
      return showPanoError(data);
    }

    if (data.kind === 'ugc') {
      return renderUgcPanorama(data, requestId);
    }
    // Defaults to tile path (also handles legacy responses without `kind`).
    return renderTilePanorama(data, requestId);
  }

  function renderTilePanorama(data, requestId) {
    // [body of the OLD handlePanoInfo, starting from `var divisor = ...`
    // through the end of the urls.forEach() block]
  }
```

The `renderTilePanorama` body is everything that was previously between the stale-check + error-check and the closing brace of the old `handlePanoInfo`. Concretely: copy the existing code block starting at `var divisor = worldDivisorForZoom(TILE_ZOOM);` and ending at the closing `});` of `urls.forEach(...)`. Place that code inside the new `renderTilePanorama(data, requestId)` body, unchanged.

Stub `renderUgcPanorama` and `showPanoError` so the file parses; we'll fill them in during Tasks 11 + 12. Add these stubs above `handlePanoInfo`:

```javascript
  function renderUgcPanorama(data, requestId) {
    // Implemented in Task 11.
    showPanoError({ error: 'ugc render not implemented yet', noCoverage: false });
  }

  function showPanoError(data) {
    // Existing error UI inlined here as a stub. Fully refactored in Task 12.
    clearTimeout(loadingSpinnerTimer);
    overlayImg.style.display = 'none';
    overlayTilesEl.style.display = 'none';
    loadingEl.style.display = 'none';
    noCoverageEl.textContent = data.noCoverage
      ? 'No Street View coverage here'
      : (navigator.onLine ? 'Street View lookup failed' : 'Could not load — check your connection');
    noCoverageEl.style.display = 'flex';
  }
```

Also: where the OLD code path inside `handlePanoInfo` handled `data.error` directly (the early-return branch at the start of the original function), remove that — it's now handled by the router calling `showPanoError`. The OLD error path was:

```javascript
    if (data.error) {
      clearTimeout(loadingSpinnerTimer);
      overlayImg.style.display = 'none';
      overlayTilesEl.style.display = 'none';
      loadingEl.style.display = 'none';
      noCoverageEl.textContent = data.noCoverage
        ? 'No Street View coverage here'
        : (navigator.onLine ? 'Street View lookup failed' : 'Could not load — check your connection');
      noCoverageEl.style.display = 'flex';
      return;
    }
```

This logic now lives in the `showPanoError` stub — don't duplicate it in `renderTilePanorama`.

- [ ] **Step 10.2: Manual smoke test — type-2 still works**

1. Reload extension.
2. Hover over a known type-2 road. Verify:
   - The tile-grid Street View overlay appears as before.
   - Heading compass works.
   - No new console errors.
3. Hover off the route. Verify overlay hides cleanly.

- [ ] **Step 10.3: Commit**

```bash
jj commit -m "Refactor handlePanoInfo into router + renderTilePanorama stub"
```

---

### Task 11: Implement `renderUgcPanorama`

**Files:**
- Modify: `content/content.js` — add module-scope UGC state, replace `renderUgcPanorama` stub

- [ ] **Step 11.1: Add module-scope UGC state**

In `content/content.js`, near the other module-scope state variables (search for `lastShownPoint` or `pendingPanoHeading` for context), add:

```javascript
  // UGC photosphere state — single-slot, NOT a multi-pano cache. Overwritten
  // when the visible pano changes. Held so heading-update flows can rebuild
  // the URL without re-fetching panorama metadata.
  var lastUgcTokenBase = null;
  var lastUgcOriginHeading = null;
  var lastUgcOriginPitch = null;
  var lastUgcCopyright = null;
```

- [ ] **Step 11.2: Replace `renderUgcPanorama` stub with full implementation**

Replace the stub from Task 10 with:

```javascript
  function renderUgcPanorama(data, requestId) {
    lastUgcTokenBase = data.tokenBase;
    lastUgcOriginHeading = data.originHeading || 0;
    lastUgcOriginPitch = data.originPitch || 0;
    lastUgcCopyright = data.copyright || '';

    var url = RwgpsPhotospheres.buildUgcRenderUrl(
      data.tokenBase,
      pendingPanoHeading,
      lastUgcOriginHeading,
      lastUgcOriginPitch,
      viewportW,
      viewportH);

    console.log('[RWGPS Street View] ugc pano',
      data.panoid,
      'originHeading=' + lastUgcOriginHeading.toFixed(1),
      'originPitch=' + lastUgcOriginPitch.toFixed(2),
      'yaw=' + (((pendingPanoHeading - lastUgcOriginHeading) % 360 + 360) % 360).toFixed(1),
      'url=' + url);

    var pid = ++preloadCounter;
    var pre = new Image();
    pre.onload = function () {
      if (pid !== preloadCounter) return;     // stale (newer pano arrived)
      clearTimeout(loadingSpinnerTimer);
      hasLoadedImage = true;
      overlayImg.src = url;
      overlayImg.style.display = 'block';
      overlayTilesEl.style.display = 'none';
      loadingEl.style.display = 'none';
      noCoverageEl.style.display = 'none';
      if (lastUgcCopyright) {
        copyrightEl.textContent = lastUgcCopyright;
        copyrightEl.style.display = 'block';
      } else {
        copyrightEl.style.display = 'none';
      }
    };
    pre.onerror = function () {
      if (pid !== preloadCounter) return;
      showPanoError({
        error: 'gpms-cs-s image load failed',
        errorClass: 'UGC_IMAGE_LOAD_FAIL',
        noCoverage: false
      });
    };
    pre.src = url;
  }
```

- [ ] **Step 11.3: Manual smoke test — UGC renders**

1. Reload extension.
2. Hover over a UGC trail point (e.g. Olympic Discovery Trail at `48.0680667, -123.8254309`).
3. Expected:
   - Console: `[RWGPS Street View] ugc pano CAoS...`.
   - Overlay shows a single image (the cropped photosphere view).
   - Photographer copyright (e.g. "© Curt Sumner") visible in bottom-right.
   - Heading compass + label still work.
4. Move cursor along the trail. Each new point:
   - May show a different image (different panoid).
   - May show same image if same panoid (browser caches).
   - Heading-aware yaw: image rotates to follow trail direction.

**If the rendered view is sideways or backwards** at this stage, that's the empirical TODO from spec section 6 — record the observation but do NOT change anything yet. We'll fix in Task 14.

**If the rendered image fails to load entirely** (broken image / "Could not load image"), the URL pattern may be wrong. Open DevTools → Network. Find the `lh3.googleusercontent.com/gpms-cs-s/...` request. Inspect the URL and the response. Adjust `buildUgcRenderUrl` if needed. The most likely culprit is the render-spec separator (`-k-no-pi...`).

- [ ] **Step 11.4: Hover over a known type-2 road, verify type-2 still works**

Same as before — tile-grid render appears for SV-car captures. UGC state from the previous hover is harmless since renderTilePanorama doesn't read it.

- [ ] **Step 11.5: Commit**

```bash
jj commit -m "Implement renderUgcPanorama with attribution and heading-aware yaw"
```

---

### Task 12: Refactor `showPanoError` with `panoErrorMessage` (G1/G2/G3 codes)

**Files:**
- Modify: `content/content.js` — replace stub from Task 10

- [ ] **Step 12.1: Replace the `showPanoError` stub**

Replace the stub `showPanoError` (from Task 10) with the full version, plus a new `panoErrorMessage` helper:

```javascript
  function showPanoError(data) {
    clearTimeout(loadingSpinnerTimer);
    overlayImg.style.display = 'none';
    overlayTilesEl.style.display = 'none';
    copyrightEl.style.display = 'none';     // ensure attribution clears across renders
    loadingEl.style.display = 'none';
    if (data.errorClass) {
      console.log('[RWGPS Street View] error',
        data.errorClass + ':', data.error || '(no detail)');
    }
    noCoverageEl.textContent = panoErrorMessage(data);
    noCoverageEl.style.display = 'flex';
  }

  // The G1/G2/G3 suffixes give a user something specific to type into a bug
  // report without leaking implementation details into the UI. See spec
  // section 4.3.
  function panoErrorMessage(data) {
    if (data.noCoverage) return 'No Street View coverage here';
    if (!navigator.onLine) return 'Could not load — check your connection';
    switch (data.errorClass) {
      case 'UGC_RPC_HTTP_ERROR':  return 'Street View lookup failed (G1)';
      case 'UGC_RPC_PARSE_FAIL':  return 'Street View lookup failed (G2)';
      case 'UGC_URL_NOT_FOUND':   return 'Street View lookup failed (G3)';
      case 'UGC_IMAGE_LOAD_FAIL': return 'Could not load image';
      default:                    return 'Street View lookup failed';
    }
  }
```

- [ ] **Step 12.2: Manual smoke test — error paths still surface**

1. Reload extension.
2. Hover over a route point with no Street View coverage at all (e.g. middle of nowhere). Expected: "No Street View coverage here".
3. Open `chrome://settings` → enable offline mode (or pull network), hover. Expected: "Could not load — check your connection".
4. Re-enable network.
5. Hover a UGC point — verify the success path still works (regression check).

- [ ] **Step 12.3: Commit**

```bash
jj commit -m "Refactor showPanoError with panoErrorMessage + G1/G2/G3 codes"
```

---

### Task 13: `hideOverlay` UGC cleanup

**Files:**
- Modify: `content/content.js:1156` (hideOverlay function)

- [ ] **Step 13.1: Add UGC state cleanup to hideOverlay**

In `content/content.js`, find `function hideOverlay()`. Add the new clears:

```diff
   function hideOverlay() {
     overlayEl.style.display = 'none';
     lastShownPoint = null;
+    lastUgcTokenBase = null;
+    lastUgcOriginHeading = null;
+    lastUgcOriginPitch = null;
+    lastUgcCopyright = null;
+    if (copyrightEl) copyrightEl.style.display = 'none';
     lastGeocodedPoint = null;
     cancelLingerTimer();
     ...
```

- [ ] **Step 13.2: Manual smoke test — no stale attribution flash**

1. Reload extension.
2. Hover UGC trail (attribution shows).
3. Move cursor off-route until overlay hides.
4. Hover a different UGC point. Expected: attribution updates immediately to new photographer's name (no flash of the previous one).
5. Hover a type-2 road. Expected: attribution stays hidden (overlay reverts to tile-grid render with no copyright label).

- [ ] **Step 13.3: Commit**

```bash
jj commit -m "hideOverlay: clear UGC state to prevent stale attribution flash"
```

---

## Phase 5: empirical probes + cleanup

### Task 14: First-render empirical TODOs — verify yaw, pitch, XSSI

This task fills in the unknowns documented in spec section 6. After this, the spec gets a "Verified on YYYY-MM-DD" stamp.

**Files:**
- Modify: `lib/photospheres.js` — adjust `buildUgcRenderUrl` based on probe results
- Modify: `test/photospheres.test.js` — update tests for any sign change
- Modify: `docs/superpowers/specs/2026-05-07-photospheres-ugc-rendering-design.md` — record findings

- [ ] **Step 14.1: Yaw direction probe**

1. Reload extension.
2. Open https://www.google.com/maps/@48.0680667,-123.8254309,3a,75y,90h,90t/ in another tab — that's the canonical "looking East along the trail" view of Curt Sumner's panorama.
3. In RWGPS, hover over a route point at exactly `48.0680667, -123.8254309` heading East along the trail.
4. **Compare side-by-side:**
   - Google Maps view: looking East, trail recedes ahead.
   - RWGPS overlay: should look the same.
5. **If our overlay looks sideways or backwards:** the yaw math is inverted. Open `lib/photospheres.js` and try negating yaw inside `buildUgcRenderUrl`:

   ```javascript
   const yaw = (((-(routeHeading - panoOriginHeading)) % 360) + 360) % 360;
   ```

   Or try `(panoOriginHeading - routeHeading)` instead. Iterate until our render matches Google's view.

6. **Update the matching unit test** at the top of `test/photospheres.test.js` (the "forward-aligned" one) to reflect the corrected math. Run `make test` to verify.

- [ ] **Step 14.2: Pitch baseline probe**

1. Hover the same UGC point. Inspect the rendered image.
2. **If the horizon is level** (trees vertical, ground perpendicular): `pi=0` is correct. Move on.
3. **If the horizon is tilted**: this is THETA-X-on-bicycle frame motion. Try:
   - Edit `buildUgcRenderUrl` to use `pitch = originPitch` instead of `pitch = 0`. Test.
   - If horizon is now MORE tilted: revert and try `pitch = -originPitch`. Test.
4. **Update the test** that asserts `pi0.0` regardless of `originPitch` — change it to assert the empirical relationship (probably `pi=originPitch` formatted to 1 decimal).

- [ ] **Step 14.3: XSSI prefix observation**

1. Open DevTools → Network. Hover a UGC point.
2. Click the `SingleImageSearch` POST. Go to the **Response** tab.
3. Check whether the response body starts with `)]}'\n`.
4. Record the observation in the spec — note "Observed: yes" or "Observed: no".

- [ ] **Step 14.4: Update the spec**

Edit `docs/superpowers/specs/2026-05-07-photospheres-ugc-rendering-design.md`. At the bottom of section 6, add:

```markdown
### Empirical results (verified YYYY-MM-DD)

- Yaw direction: `<the formula that worked>`. Original spec: `(routeHeading - panoOriginHeading + 360) % 360`. Adjustment: <none / negated / swapped>.
- Pitch baseline: `pi=<formula>`. Original spec hardcoded `pi=0`; <empirical note>.
- XSSI prefix: <observed / not observed> on SingleImageSearch responses.
```

Replace `YYYY-MM-DD` with today's date and fill in the actual results.

- [ ] **Step 14.5: Commit any code changes from probes**

If `buildUgcRenderUrl` was changed:

```bash
jj commit -m "Empirical-probe adjustments to UGC render math"
```

If only the spec was updated:

```bash
jj commit -m "Spec: record empirical-probe results"
```

---

### Task 15: Update the research doc with implementation status

**Files:**
- Modify: `docs/design/photospheres/README.md`

- [ ] **Step 15.1: Add implementation status header**

Open `docs/design/photospheres/README.md`. At the top, change the existing status line:

```markdown
**Status (2026-05-06):** investigated; implementation required to fix
confirmed bike-path coverage regression. See "Decision" below.
```

To:

```markdown
**Status:** Implemented YYYY-MM-DD via [`docs/superpowers/specs/2026-05-07-photospheres-ugc-rendering-design.md`](../../superpowers/specs/2026-05-07-photospheres-ugc-rendering-design.md) and [`docs/superpowers/plans/2026-05-07-photospheres-ugc-rendering.md`](../../superpowers/plans/2026-05-07-photospheres-ugc-rendering.md). This research doc remains for historical context.

**Original status (2026-05-06):** investigated; implementation required to fix
confirmed bike-path coverage regression. See "Decision" below.
```

Replace `YYYY-MM-DD` with today's date.

- [ ] **Step 15.2: Final manual end-to-end test**

1. Reload extension.
2. Open a route that includes BOTH bike-path (UGC) and road (SV-car) segments.
3. Hover the road portion → tile-grid type-2 render with heading compass.
4. Hover the bike-path portion → single-img UGC render with attribution.
5. Move cursor across the boundary → overlays swap cleanly, no flash of stale attribution or stale tiles.
6. Press `v` keyboard shortcut → opens Google Maps in new tab (current behavior; lands on nearest pano per spec section 2.9).
7. Press `s` keyboard shortcut → toggles preview.
8. Open the popup → all settings/UI work as before.

- [ ] **Step 15.3: Commit**

```bash
jj commit -m "Mark photospheres research doc as implemented"
```

---

## Done

If all tasks completed and the manual end-to-end test passes:
- `make test` is green.
- Type-2 tile rendering works (regression-free).
- UGC type-10 photospheres render in the overlay on bike paths and trails.
- Bug-reportable error codes (G1/G2/G3) appear when SingleImageSearch breaks.
- Photographer attribution shows for UGC renders.

The bike-path coverage regression is fixed.
