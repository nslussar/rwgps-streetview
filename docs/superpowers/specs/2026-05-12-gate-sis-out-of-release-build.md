# Gate SingleImageSearch out of the release build — Design

**Status:** draft — awaiting decisions, then implementation
**Date:** 2026-05-12
**Background:**
- [`2026-05-07-photospheres-ugc-rendering-design.md`](2026-05-07-photospheres-ugc-rendering-design.md) — original SIS introduction (UGC render path)
- Commits `ba2aecb` (3-attempt retry + SIS fallback), `ab3e2885` (CWS prep: rename + soften comments), `5d74c49e` (log-gating tightening)

## 1. Motivation

The experimental preview pipeline calls `SingleImageSearch` (SIS), an internal Maps JS RPC, in two places:

1. **UGC render path** — when `getPanorama` succeeds and returns a type-10 (user-contributed photosphere) panoid, SIS fetches the `gpms-cs-s` render URL because `streetviewpixels-pa` doesn't serve type-10 captures.
2. **SIS rescue path** — when `getPanorama` exhausts retries on `ZERO_RESULTS`, SIS is the alternate metadata source. Recovers ~12% of UGC-heavy bike-trail lookups.

SIS is the riskier surface in the Chrome Web Store review:

- URL path literally contains the string `internal` (`/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch`).
- Request spoofs `x-user-agent: grpc-web-javascript/0.1`.
- Request body is hand-built JSPB (positional protobuf-as-JSON), visibly reverse-engineered in `lib/photospheres.js` (per-photographer "Format A / Format B" comments, fixture references).
- Calls a different family of endpoints than the rest of the extension.

The tile path (`streetviewpixels-pa`) is much more defensible: it's what Maps JS itself loads when pegman drags, an `<img src>` cross-origin load (no `fetch`, no spoofed headers), and the URL pattern is publicly visible in Maps JS sources.

Strategy (agreed earlier in conversation): two-update CWS rollout.
- **Update A** (this work): experimental preview ships as tile-only. SIS code absent from the release zip. Type-2 SV-car panoramas only; no UGC.
- **Update B** (later, only after A is approved and stable): re-add SIS for UGC photosphere coverage.

## 2. Goal & non-goals

**Goal:** the release zip produced by `make build` contains zero SIS-related code (no `singleImageSearch` function, no `SINGLE_IMAGE_SEARCH_URL` constant, no JSPB body builder, no `gpms-cs-s` parser, no Format-A/Format-B reverse-engineering comments). Source tree retains everything so loading unpacked from source preserves full functionality including UGC and SIS rescue.

**Non-goals:**
- Adding a runtime feature flag in storage. The toggle is build-time, not user-toggleable.
- Removing the experimental preview itself from release. The tile path stays; SIS does not.
- Removing tests for SIS helpers. `test/photospheres.test.js` stays — it covers pure helpers in dev. Release just excludes the file under test; the tests never ran against the release zip anyway.
- Refactoring the file layout beyond what gating requires.

## 3. Approach

The release/dev distinction is purely a `make build` concern — source tree is the dev configuration; `make build` produces the release configuration. So gating works as:

1. **Consolidation.** All SIS-related code currently in `content/page-bridge.js` (the `singleImageSearch` function + `SINGLE_IMAGE_SEARCH_URL` constant) moves into `lib/photospheres.js`. Result: `lib/photospheres.js` is the entire SIS surface.
2. **Guards.** Every callsite that uses `RwgpsPhotospheres` checks `typeof RwgpsPhotospheres !== 'undefined'` (or feature-detects the specific method) and short-circuits to a no-coverage / unsupported error when absent.
3. **Build strip.** `make build` excludes `lib/photospheres.js` from the zip and produces a `manifest.json` variant that removes the two references to it (one in `content_scripts[0].js`, one in `web_accessible_resources[0].resources`).
4. **Loader tolerance.** `content.js`'s `injectBridge()` already injects `lib/photospheres.js` via `<script src=chrome.runtime.getURL(...)>`; the `onerror` handler must fall through to bridge load so a missing file doesn't deadlock the pipeline.

## 4. File-by-file changes

### 4.1 `lib/photospheres.js` (gains SIS fetch)

Add (moved from `page-bridge.js`):
- Constant: `SINGLE_IMAGE_SEARCH_URL = 'https://maps.googleapis.com/$rpc/.../SingleImageSearch'`
- Function: `async function singleImageSearch(lat, lng, radius)` — the fetch + response-parse logic; returns the same shape as today (`{ok, tokenBase, panoid, ...} | {ok:false, errorClass, message}`).

Re-export both via `RwgpsPhotospheres.singleImageSearch` and `RwgpsPhotospheres.SINGLE_IMAGE_SEARCH_URL` (the latter for symmetry / future use; not strictly needed by callers).

### 4.2 `content/page-bridge.js` (becomes SIS-free)

Remove:
- `SINGLE_IMAGE_SEARCH_URL` constant and surrounding comments.
- `singleImageSearch(lat, lng, radius)` function body and its preceding comment block.

Replace SIS callsites with guarded calls:

**Site 1 — UGC branch after successful `getPanorama`** (currently `LOOKUP_PANO` handler, the `isUgcPanoid(panoid)` block):

```js
if (RwgpsPhotospheres.isUgcPanoid(panoid)) {
  if (typeof RwgpsPhotospheres.singleImageSearch !== 'function') {
    sendPanoInfoError(reqId, { errorClass: 'UGC_UNSUPPORTED', message: 'release build' });
    return;
  }
  var ugcResult = await RwgpsPhotospheres.singleImageSearch(common.snappedLat, common.snappedLng, radius);
  // ... existing handling
}
```

`isUgcPanoid` itself is a pure synchronous check and is in the same file — in release this branch is unreachable because `RwgpsPhotospheres` is undefined, so the entire `if (RwgpsPhotospheres.isUgcPanoid(...))` would throw. So wrap the outer check too:

```js
if (typeof RwgpsPhotospheres !== 'undefined' && RwgpsPhotospheres.isUgcPanoid(panoid)) {
  // ... SIS path
}
// else fall through to type-2 tile path
```

If we fall through to the type-2 path with a type-10 panoid, `streetviewpixels-pa` will 4xx — that's the natural "no coverage" result. Acceptable: in release, type-10 panoids appear identical to no-coverage from the user's POV. **Open decision 6.2** below.

**Site 2 — SIS rescue after `getPanorama` retry exhaustion:**

```js
if (noCoverage) {
  if (typeof RwgpsPhotospheres === 'undefined' || typeof RwgpsPhotospheres.singleImageSearch !== 'function') {
    sendPanoInfoError(reqId, { errorClass: 'NO_COVERAGE', message: emsg + ' [release build, no SIS rescue]' });
    return;
  }
  RwgpsPhotospheres.singleImageSearch(msg.data.lat, msg.data.lng, radius).then(function (sis) {
    // ... existing rescue handling
  });
  return;
}
```

### 4.3 `content/content.js` (tolerates absent photospheres lib)

Two changes:

**`injectBridge()`** — make photospheres lib injection optional. Current code chains bridge load on `lib.onload`. Add `lib.onerror = ` doing the same.

```js
function injectBridge() {
  function loadBridge() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/page-bridge.js');
    document.documentElement.appendChild(script);
    script.onload = function () { script.remove(); };
  }
  const lib = document.createElement('script');
  lib.src = chrome.runtime.getURL('lib/photospheres.js');
  lib.onload = function () { lib.remove(); loadBridge(); };
  lib.onerror = function () { lib.remove(); loadBridge(); }; // release build: file absent
  document.documentElement.appendChild(lib);
}
```

**`handlePanoInfo` dispatch** — gate the `kind === 'ugc'` branch:

```js
if (data.kind === 'ugc') {
  if (typeof RwgpsPhotospheres === 'undefined') {
    return showPanoError({ errorClass: 'UGC_UNSUPPORTED', noCoverage: true });
  }
  return renderUgcPanorama(data, requestId);
}
```

In practice the bridge in release won't send `kind:'ugc'`, but the guard makes the dead code explicitly dead — clearer to a reviewer than dangling references.

### 4.4 `Makefile`

Replace the current single-step `build` target with a staging-based flow:

```makefile
build:
	mkdir -p build/staging
	rm -rf build/staging/*
	cp -R manifest.json background.js content lib popup icons build/staging/
	rm build/staging/lib/photospheres.js
	jq 'del(.content_scripts[0].js[] | select(. == "lib/photospheres.js")) | del(.web_accessible_resources[0].resources[] | select(. == "lib/photospheres.js"))' manifest.json > build/staging/manifest.json
	rm -f build/rwgps-streetview-$(VERSION).zip
	cd build/staging && zip -r ../rwgps-streetview-$(VERSION).zip .
	rm -rf build/staging
	@echo "Created build/rwgps-streetview-$(VERSION).zip (release: SIS excluded)"
```

Validation step worth adding: after the zip is built, `unzip -l` and assert that `lib/photospheres.js` is absent.

### 4.5 `CLAUDE.md`

Add a short section describing the build-time gating mechanism so future-Claude doesn't try to "fix" the apparently-dead UGC code paths or wonder why `RwgpsPhotospheres` is feature-detected before use. Suggested placement: under "Build and release" or as a new subsection under "Experimental preview pipeline".

### 4.6 Tests

No changes required. `test/photospheres.test.js` tests pure helpers in dev (`lib/photospheres.js` is on disk and importable via `require`). The release zip excluding the file has no bearing on tests, which run against the source tree.

If we want a guard test, we could add a smoke test that `make build` produces a zip without `lib/photospheres.js`. Worth doing but not in scope here.

## 5. Build mechanism: `jq` dependency

The Makefile transform uses `jq` to strip the two `lib/photospheres.js` references from the release manifest. `jq` is:

- Preinstalled on most macOS dev environments (via Homebrew).
- Preinstalled on common CI runners (GitHub Actions ubuntu-latest, macos-latest both have it).

Alternative: a tiny Python script (`python3` is similarly ubiquitous) doing the same `json.load` / `del` / `json.dump`. Slightly more script noise but no new dependency assumption.

**Decision needed (6.3 below).**

## 6. Open decisions

### 6.1 Test coverage for `singleImageSearch` after the move

Currently `singleImageSearch` is in `page-bridge.js` and has no unit tests (it does a `fetch`, hard to mock cleanly). Moving it to `lib/photospheres.js` doesn't change that — the pure helpers `buildSingleImageSearchBody` and `parseUgcUrlFromResponse` (the ones with tests) stay in the same file and continue to be tested. No regression.

**Resolution: no action needed.** Noted for completeness.

### 6.2 Type-10 panoid handling when SIS is absent

When `getPanorama` returns a type-10 panoid and SIS is unavailable, two options:

- **(a) Send a `UGC_UNSUPPORTED` error** with the "No Street View coverage here" user-visible message. Explicit but introduces a new error class.
- **(b) Fall through silently to the type-2 tile render path**, which will 4xx from `streetviewpixels-pa` and naturally surface as "No Street View coverage here" via the existing tile-load error handler.

**Recommendation: (a).** Cleaner — avoids relying on a server 4xx to drive the error, makes the code path explicit, easier to debug if needed. The error class is internal-only; users see the same "No Street View coverage here" message.

### 6.3 Manifest-strip tool: `jq` or `python3`

**Recommendation: `jq`.** Smaller invocation, more readable Makefile line, common enough that absence is unlikely in any reasonable dev/CI environment. Add a manual `jq --version` check at the top of the Makefile if we want a friendly error on missing.

### 6.4 Where to document the gating

Two options:

- **(a) In `CLAUDE.md`** as a paragraph alongside the Build / Release section.
- **(b) As a separate `docs/build/README.md`** describing the release-strip mechanism in full.

**Recommendation: (a)** for now. The mechanism is small enough to fit in a paragraph; a separate doc is overhead. Promote to (b) if the build grows more conditional logic later.

## 7. Verification plan

After implementing:

1. `make test` — all existing tests pass.
2. `node --check` on edited JS files — syntax clean.
3. Load unpacked from source — UGC panoramas render via SIS (full behavior).
4. `make build` — produces a zip. Spot-check:
   - `unzip -l build/rwgps-streetview-*.zip | grep photospheres` → no output.
   - `unzip -p build/rwgps-streetview-*.zip manifest.json | grep photospheres` → no output.
   - `unzip -p build/rwgps-streetview-*.zip content/page-bridge.js | grep -i 'SingleImageSearch\|MapsJsInternalService\|grpc-web'` → no output.
5. Load the unzipped release contents — `chrome://extensions` → "Load unpacked" on the unzipped directory. Hover a route with known UGC coverage on a bike trail. Expectation: "No Street View coverage here" (UGC unsupported). Hover a route with type-2 coverage. Expectation: tiles render normally. Verify DevTools Network panel shows zero `$rpc/.../SingleImageSearch` requests.
6. Repeat (5) on a route segment where `getPanorama` is known to flake (Olympic Discovery Trail test fixture). Expectation: 3 retries, then no-coverage error (no SIS rescue attempted).

## 8. Future considerations

- **Update B re-adds SIS** by reverting the Makefile strip (or guarding it behind an env var like `RELEASE_GATES=sis_off make build`). The runtime guards stay in place — they cost nothing in dev and they're the mechanism that makes Update A/B switchable without code churn.
- **If CWS pushback specifically targets `streetviewpixels-pa`** (less likely than SIS), the same Makefile pattern can strip the experimental preview entirely: zip a `manifest.json` with `useExperimentalPreview` and the popup checkbox removed, and the tile-render code in `content.js` becomes dead via a build-time JS strip. Bigger change, but the precedent is set by this work.
- **Smoke test** for `make build` would be a nice CI addition: after build, run `unzip -l` and grep-assertions in a workflow step. Worth adding when iterating becomes painful.
