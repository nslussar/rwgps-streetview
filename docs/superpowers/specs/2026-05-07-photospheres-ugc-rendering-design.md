# UGC Photosphere Rendering — Design

**Status:** draft — awaiting review
**Date:** 2026-05-07
**Background:** [`docs/design/photospheres/README.md`](../../design/photospheres/README.md) (research notes, may be moved here later for posterity)

## 1. Motivation

Free-tile mode (the default since 2026-04) filters Street View metadata lookups
to `source: StreetViewSource.GOOGLE`, which excludes user-contributed
photospheres (type-10 panoids prefixed with `CAoS...`). On bike paths, hiking
trails, and other off-pavement RWGPS routes, the Google SV-car capture is
typically tens of meters away on a parallel road and falls outside the
extension's small lookup radius. With UGC excluded, those route points return
`ZERO_RESULTS` and surface "No Street View coverage here" — even when a
photographer has uploaded a photosphere sitting directly on the route point.

The motivating empirical case (Olympic Discovery Trail, Sequim WA, verified
2026-05-06):

- Google SV-car capture at ~45 m on `W Sequim Bay Rd` (parallel road, fresh).
- UGC photosphere by Curt Sumner at ~1.2 m **on the trail itself**, fresh.
- Old extension (paid Static API): served the closest pano regardless of type
  → user saw the trail UGC.
- Current extension (free-tile mode): filters UGC at lookup time → user sees
  no coverage.

This regression is real and concentrated on the dominant RWGPS use case
(bike-path / off-pavement segments). The fix is to admit type-10 panoids back
into our lookup AND add a render path for them, since the existing free-tile
pipeline (`streetviewpixels-pa.googleapis.com/v1/tile`) does not serve them.

## 2. Decision log

### 2.1 URL extraction strategy: direct SingleImageSearch RPC

**Decision:** call SingleImageSearch ourselves (POST to
`https://maps.googleapis.com/$rpc/.../SingleImageSearch`) when `getPanorama`
returns a type-10 panoid, parse the response for the `gpms-cs-s` URL.

**Rejected alternatives:**

- **`getPanorama`-only path** (any of `OUTDOOR`/`DEFAULT` source filters
  without a render path): would shift the failure mode from `ZERO_RESULTS` to
  "broken image" because `streetviewpixels-pa` doesn't serve type-10. Half a
  fix, no coverage win.
- **`StreetViewTileData.getTileUrl()` (documented Maps JS method):** probed
  empirically — returns `undefined` on Google-served panoramas (both type-2
  and type-10). Maps JS docs imply a method exists but it's only present for
  custom-tile providers using `panoProvider`.
- **Internal Maps JS function call (e.g. `q3a` / `B1a` / `_.xr`):** probed
  via `Object.keys(google.maps.importLibrary('streetView'))` — `importLibrary`
  returns a curated wrapper exposing only the documented public classes
  (`StreetViewService`, `StreetViewSource`, etc.). The internal `XK`, `JM`,
  `vI` fields registered via `_.Pl("streetview", new G3a)` are not reachable.
  Confirmed by reading the Maps JS source pulled from a live RWGPS page.
- **`fetch` hook to intercept Maps JS's own SingleImageSearch:** dead because
  Maps JS only fires SingleImageSearch in response to pegman-drag interaction.
  When we call `getPanorama` from our extension code, Maps JS uses different
  RPCs (`GetMetadata` family) that don't carry the URL.
- **`StreetViewPanorama` widget for live UGC rendering:** documented and
  robust to all internal API churn, but a major restructure (would also
  affect type-2 path), defeats the lightweight overlay design. Worth keeping
  in mind as a fallback if direct RPC reverse-engineering becomes
  unmaintainable.
- **`/maps/photometa/v1` endpoint** (TheGreatRambler's reverse-engineered
  client uses this): different endpoint family, similar fragility, similar
  community discovery. Recorded as a fallback in case SingleImageSearch
  breaks.

The fragility we accept with direct SingleImageSearch is bounded:

- Request shape (positional protobuf-as-JSON, `Content-Type:
  application/json+protobuf` — i.e. **JSPB**, not binary protobuf).
- Response shape (also JSPB).
- Endpoint URL (`/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch`).

Mitigations layered into the design:

- Response parsing is a regex over the serialized response (`/https:\/\/lh3\.googleusercontent\.com\/gpms-cs-s\/[A-Za-z0-9_-]+/`)
  rather than a positional walk. Robust to Google moving the URL field
  within the structure.
- All three failure surfaces emit distinct error classes (G1 / G2 / G3) that
  surface to the user-visible UI and to the console, so a bug report
  identifies which layer broke.
- Test fixtures captured via a refresh script let us catch shape changes
  before they reach users.

### 2.2 Source filter: `OUTDOOR`

**Decision:** change `getPanorama` source from `GOOGLE` to `OUTDOOR`.

`OUTDOOR` excludes indoor type-2 panoramas (Google "Business View" — fixes
the Ballard `Sunset Tavern` indoor-bar issue noted in the research doc) and
admits type-10 (UGC) into the candidate set. At our small default radius
(10 m), the type-2-preferred ranking that `OUTDOOR` applies has no effect on
bike paths because no type-2 is in range — `OUTDOOR` falls through to
type-10 by elimination.

`DEFAULT` would also work for bike paths but doesn't fix the bar issue.

### 2.3 UGC quality filter: show all UGC for v1

**Decision:** show all UGC photospheres returned by `OUTDOOR`, regardless of
upload source tag.

The motivating case is "no coverage on bike paths," and most trail UGC is
exactly the lower-quality long-tail (Publish-API uploads via projects like
Adventure Cycling, individual riders, etc.). Filtering to
`photos:street_view_android` (the official Google Street View phone app)
would amputate the trail-mapping uploads we want.

We may need to revisit this decision later if quality complaints come in;
the relevant code path (`page-bridge.js` source filter logic) carries an
inline comment explaining the trade-off and pointing to the future-improvement
section of this spec.

### 2.4 UX posture: same as type-2, plus attribution

**Decision:** UGC renders into the same overlay container with the same
heading compass and hint label. A small `copyrightEl` shows the photographer
attribution (`d.copyright` from getPanorama, e.g. "© Curt Sumner"). No
"user photo" badge or differentiated border tint.

The `copyrightEl` is implemented but flagged as "may remove later" in code
comments. If attribution doesn't pull weight in real use, we delete the
element + its CSS in v1.1.

### 2.5 Render mechanism: server-cropped `gpms-cs-s` URLs

**Decision:** UGC renders as a single `<img>` element pointing at the
`lh3.googleusercontent.com/gpms-cs-s/<token>=w<W>-h<H>-k-no-pi<P>-ya<Y>-ro0-fo90`
URL pattern. Re-uses the existing `overlayImg` element (currently dormant
in free-tile mode — was the static-API render target).

**Render-spec parameters:**

- `w<viewportW>-h<viewportH>` — overlay's pixel dimensions (currently 400×250,
  configurable via popup tunables).
- `pi=0` baseline (horizon level). The function takes `originPitch` as a
  parameter for forward-compatibility, but the v1 body **hardcodes `pi=0`
  and ignores the param**. Post-probe, if the captured horizon is genuinely
  tilted, update the body to use `pi=originPitch` or `pi=-originPitch`
  (whichever levels the horizon — see section 6).
- `ya = (routeHeading - originHeading + 360) % 360` — heading relative to
  the photographer's reported direction. Sign verified by first-render
  probe.
- `ro=0` — no roll.
- `fo=90` — field of view. Initial value, may tune after visual review.
- `-k-no` flag preserves the requested size without further server crop.

URL substitution lives in `content/content.js` (renamed `buildUgcRenderUrl`
helper, promoted to `lib/photospheres.js` for unit testability). The bridge
sends `tokenBase` once per panorama; the content script re-derives the URL
when route heading changes.

### 2.6 Caching: none for v1

**Decision:** no bridge-side cache (`panoUrlCache`), no concurrent-dedup map
(`pendingUrlLookups`). Every LOOKUP_PANO that resolves to type-10 fires its
own `SingleImageSearch`. Browser HTTP cache absorbs `gpms-cs-s` image fetches
when URLs are identical.

Reasoning:

- The existing extension philosophy is "throttle at the content side, rely
  on browser cache." Adding bridge-side caching breaks that pattern.
- Empirical UGC density on the motivating trail (Curt Sumner / Olympic
  Discovery Trail) is ~10–12 m between consecutive uploads — matching
  `bucketMeters=10`. During a forward sweep, every bucketed cursor position
  resolves to a different panoid → cache hit rate is 0%.
- Cache only helps in re-sweep / cursor-pause / return-to-prior-spot flows.
  Real but secondary use case; defer until telemetry shows the benefit
  justifies the code.
- The endpoint is unkeyed and has no documented quota — request volume is
  not a billing concern.

The bridge code carries an inline comment explaining the trade-off and
pointing to the "future improvements" section below.

### 2.7 No protobuf library

**Decision:** parse SingleImageSearch responses as plain JSON. The
`Content-Type: application/json+protobuf` is JSPB (positional JSON arrays
where index = field number), not binary protobuf wire format. `JSON.parse()`
is sufficient. Type-10 panoids are detected by the `CAoS` prefix, never
decoded.

Saves the bundle weight of a protobuf library, avoids one more dependency
to keep updated.

### 2.8 No new `host_permissions`

**Decision:** no manifest changes. UGC requests fall outside the cases that
require host_permissions:

- `gpms-cs-s` images load via `<img src="…">` in the content script — same
  as how `streetviewpixels-pa` tile URLs work today without explicit
  permission.
- `SingleImageSearch` POST runs in the page MAIN world (the bridge), which
  uses page CORS (rwgps.com → maps.googleapis.com), not extension
  permissions.

The existing `https://maps.googleapis.com/*` permission exists for
`background.js`'s `chrome.webRequest.onCompleted` listener (legacy Static API
counter) and is not consumed by the new flow.

### 2.9 `openStreetViewTab` unchanged

**Decision:** keep current behavior — generic Maps URL with lat/lng/heading,
no panoid. Google Maps picks a nearby pano (may be type-2 or type-10).

For UGC the user might land on a *different* nearby panorama than the one
they hovered. Documented as a future improvement to include the explicit
panoid + pano type in the URL once we've verified Maps URL parsing accepts
either the wrapped (`CAoS...`) or inner panoid form.

## 3. Architecture

```
content/content.js (ISOLATED)               content/page-bridge.js (MAIN)
   │                                            │
   ├─ LOOKUP_PANO ────────────────────────►   getPanorama({ source: OUTDOOR })
   │                                            │
   │                                            ├─ pano starts with "CAoS"?
   │                                            │     │
   │                                            │     ├─ no (type-2):
   │                                            │     │     PANO_INFO { kind:'tile', panoid, originHeading,
   │                                            │     │                  originPitch, worldSize, snappedLat, snappedLng,
   │                                            │     │                  copyright? }
   │                                            │     │
   │                                            │     └─ yes (type-10):
   │                                            │         singleImageSearch(lat,lng,radius)
   │                                            │           ├─ ok → parseUgcUrlFromResponse → tokenBase
   │                                            │           │      PANO_INFO { kind:'ugc', panoid, originHeading,
   │                                            │           │                   originPitch, copyright, tokenBase }
   │                                            │           └─ err → PANO_INFO_ERROR { errorClass, error }
   │                                            │
   ◄── PANO_INFO ───────────────────────────────┘
   │
   ├─ kind === 'tile' ──► renderTilePanorama (existing 6-tile preload + grid)
   ├─ kind === 'ugc'  ──► renderUgcPanorama
   │       ├─ buildUgcRenderUrl(tokenBase, routeHeading, panoOriginHeading, originPitch, viewportW, viewportH)
   │       ├─ preload via new Image()
   │       ├─ on load: overlayImg.src = url; show overlayImg, hide tile grid;
   │       │           show copyrightEl with d.copyright
   │       └─ on error: showPanoError({errorClass:'UGC_IMAGE_LOAD_FAIL'})
   │
   └─ error ──► showPanoError({errorClass}) — overlay text picked by panoErrorMessage
```

Source filter changes from `GOOGLE` to `OUTDOOR` in the bridge. Everything
else in the type-2 path stays untouched; UGC is purely additive.

## 4. Component changes

### 4.1 New module: `lib/photospheres.js`

Pure helpers, no Chrome / DOM / Maps JS dependencies. Loaded into the bridge
the same way `lib/geo.js` is. Exports:

```js
isUgcPanoid(panoid)                       // true if startsWith('CAoS')
buildSingleImageSearchBody(lat, lng, radius)  // returns positional JSPB array
parseUgcUrlFromResponse(rawText)          // { ok, tokenBase? } | { ok:false, errorClass, message }
buildUgcRenderUrl(tokenBase, routeHeading, panoOriginHeading, originPitch, viewportW, viewportH)
```

`buildSingleImageSearchBody` shape (from research-doc recipe 2):

```js
[
  ['apiv3', null, null, null, 'US', null, null, null, null, null, [[0]]],
  [[null, null, lat, lng], radius],
  [null, ['en', 'US'], null, null, null, null, null, null, [2], null,
    [[[2,1,2], [3,1,2], [10,1,2]]]],
  [[1,2,3,4,8,6,17], null, null, null, null, null, null, null, null, null,
    [null, null, [[[100, 100]]]]]
]
```

The `[10,1,2]` triple at `[2][10]` admits type-10 panoramas. Removing it
restores type-2-only behavior — kept here so a future filter toggle can
switch with one edit.

`parseUgcUrlFromResponse` strategy:

1. Defensively strip leading `)]}'\n` (XSSI prefix; not observed on
   SingleImageSearch responses but free to defend against).
2. `JSON.parse` → `UGC_RPC_PARSE_FAIL` on throw.
3. Serialize parsed value, regex for `gpms-cs-s` URL, return base (everything
   before the first `=`). The token charset is base64url-style (no `=` or
   `/`), so the regex captures the full token without crossing into the
   render-spec separator.
4. If no match → `UGC_URL_NOT_FOUND`.

### 4.2 `content/page-bridge.js`

Module-scope additions (after `getStreetViewLib`, ~line 68):

```js
const SINGLE_IMAGE_SEARCH_URL =
  'https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch';

// No bridge-side cache for v1: each LOOKUP_PANO that resolves to type-10
// fires its own SingleImageSearch. Forward-sweep workflows get zero benefit
// from caching here (each bucketed cursor position resolves to a unique
// panoid on trails with ~10m UGC spacing — typical when one rider uploads
// via THETA X). Re-sweep / cursor-pause workflows would benefit, but adding
// the cache costs ~10 lines. Defer until telemetry shows re-sweep volume
// justifies it. See spec section 7.1 for the shape of a deferred panoid-keyed
// cache + concurrent-dedup map.
```

New helpers (network + cache logic, can't be in `lib/` due to fetch
dependency):

```js
async function singleImageSearch(lat, lng, radius)
  // POST, returns { ok, tokenBase? } | { ok:false, errorClass, message }
```

Modified `LOOKUP_PANO` handler (~line 559): source `GOOGLE` → `OUTDOOR`,
type-10 branch added inside the `getPanorama.then`:

```js
if (isUgcPanoid(panoid)) {
  const ugcResult = await singleImageSearch(msg.data.lat, msg.data.lng, radius);
  if (ugcResult.ok) {
    sendPanoInfo(reqId, { kind:'ugc', ...common, tokenBase: ugcResult.tokenBase });
  } else {
    sendPanoInfoError(reqId, ugcResult);
  }
  return;
}
// type-2 path: existing code, plus kind:'tile' field added to the message
```

Two small helpers (`sendPanoInfo`, `sendPanoInfoError`) wrap the
`window.postMessage` boilerplate. The existing `.catch(ZERO_RESULTS)` path
adds `errorClass:'NO_COVERAGE'` so the content script can switch on a single
classification field.

### 4.3 `content/content.js`

`handlePanoInfo` becomes a router:

```js
function handlePanoInfo(data, requestId) {
  if (requestId !== panoLookupCounter) return;
  if (data.error) return showPanoError(data);
  if (data.kind === 'ugc') return renderUgcPanorama(data, requestId);
  return renderTilePanorama(data, requestId);  // existing function body, renamed
}
```

New module-scope state (single-slot, NOT a multi-pano cache — overwritten
when the visible pano changes):

```js
let lastUgcTokenBase = null;
let lastUgcOriginHeading = null;
let lastUgcOriginPitch = null;
let lastUgcCopyright = null;
```

New `renderUgcPanorama` function: builds URL via `buildUgcRenderUrl`,
preloads via `new Image()`, on success sets `overlayImg.src` and shows it
(hiding `overlayTilesEl`), shows `copyrightEl` with `d.copyright`, on error
calls `showPanoError({errorClass:'UGC_IMAGE_LOAD_FAIL'})`.

New DOM element `copyrightEl` (~line 425, near the other label elements):
small div, hidden by default, populated on UGC render.

`showPanoError` extended to log `data.errorClass` and pick user-facing
copy via:

```js
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

The G1/G2/G3 suffixes give bug reporters a specific token to type into a
GitHub issue without leaking implementation details.

`hideOverlay` clears UGC state on hide so a re-show doesn't briefly flash
stale attribution:

```js
lastShownPoint = null;
lastUgcTokenBase = null;
copyrightEl.style.display = 'none';
// (other existing clears)
```

### 4.4 `content/overlay.css`

Adds `.sv-copyright` rule: positioned bottom-right of overlay, ~10px sans
font, white text, semi-transparent black background, padding `1px 4px`,
border-radius `2px`. Hidden by default (`display: none`); JS toggles
visibility per render. Comment marks it as "may remove if attribution
proves unnecessary — see spec 7.3."

### 4.5 No `manifest.json` changes

Existing permissions cover the new flow (see 2.8).

## 5. Testing

### 5.1 Test fixtures

`test/fixtures/photospheres/` — raw HTTP response bodies captured via curl:

| Fixture | Captured from | Exercises |
|---|---|---|
| `ugc_discovery_park.json` | 47.6570, -122.4158 (Brian Ferris) | Happy path: URL extraction, panoid, copyright |
| `ugc_olympic_trail.json`  | 48.0680667, -123.8254309 (Curt Sumner Sept 2025) | Different photographer, different worldSize / originPitch — guards against parser overfitting |
| `no_results.json`         | 0,0 radius 10 (mid-ocean) | `UGC_URL_NOT_FOUND` path |

Each fixture file: `# captured YYYY-MM-DD via scripts/refresh-photosphere-fixtures.sh`,
followed by raw response body, byte-for-byte.

### 5.2 Refresh script

`scripts/refresh-photosphere-fixtures.sh` — runs the SingleImageSearch curl
from research-doc recipe 2 against each test location, writes results to
`test/fixtures/photospheres/`. Run manually when:

- The parser breaks in the wild (response shape changed).
- Before each release as a smoke test.
- A release-blocking GitHub issue mentions G1/G2/G3 errors.

The script's output is the raw response body. Diff against prior fixture
before committing — a structural shift is what we want to catch.

### 5.3 Unit tests (`test/photospheres.test.js`)

Following the existing `test/geo.test.js` pattern (`node --test`, no deps):

- `parseUgcUrlFromResponse(ugc_discovery_park.json)` → `ok:true`, `tokenBase`
  starts with expected prefix.
- `parseUgcUrlFromResponse(ugc_olympic_trail.json)` → `ok:true`, asserts
  parser isn't accidentally tied to the first capture's structure.
- `parseUgcUrlFromResponse(no_results.json)` → `ok:false`,
  `errorClass:'UGC_URL_NOT_FOUND'`.
- `parseUgcUrlFromResponse("not json")` → `ok:false`,
  `errorClass:'UGC_RPC_PARSE_FAIL'`.
- `parseUgcUrlFromResponse(")]}'\n[]")` → exercises XSSI strip, then
  `UGC_URL_NOT_FOUND` (empty array has no URL).
- `buildUgcRenderUrl(tokenBase, 90, 0, 0, 400, 250)` → asserts exact output:
  `<base>=w400-h250-k-no-pi0.0-ya90.0-ro0-fo90`.
- `buildSingleImageSearchBody(47.6570, -122.4158, 30)` → asserts the
  positional structure matches the doc recipe (snapshot-style).
- `isUgcPanoid('CAoS...')` → true; `isUgcPanoid('KMFb0s0_a3j8RgH5Zd2ryg')`
  → false; `isUgcPanoid('')` → false; `isUgcPanoid(null)` → false.

CI: `.github/workflows/test.yml` already runs `node --test`, so adding the
file is enough.

### 5.4 Manual testing on first build

Three things need empirical verification — see section 6.

## 6. First-render empirical TODOs

Verify on the very first run of the implemented extension. Use the Curt
Sumner panoid at `48.0680667, -123.8254309` as the canonical test panorama;
side-by-side with `https://www.google.com/maps/@48.0680667,-123.8254309,3a,...`
for visual comparison.

| What to verify | Probe | Action if wrong |
|---|---|---|
| Yaw direction | Hover trail point. Is the rendered view forward-along-route or sideways/backwards? | If sideways: derive correct relationship empirically (likely sign flip on `routeHeading - originHeading`). Document the resolution inline. |
| Pitch baseline | Is the horizon level at `pi=0`, or visibly tilted? | If tilted: try `pi=originPitch` and `pi=-originPitch`; whichever levels horizon, document the choice and update `buildUgcRenderUrl`. |
| XSSI prefix | Is the SingleImageSearch response body prefixed with `)]}'\n`? | Defensive strip already handles either case; just record observed behavior in spec for future maintainers. |

The spec gets a "Verified on YYYY-MM-DD: yaw=X, pi=Y, XSSI=Z" stamp once
these are pinned.

### Empirical results (verified 2026-05-07)

Probed **out-of-browser** by fetching `gpms-cs-s` URLs directly with the
captured Curt Sumner panorama token from `test/fixtures/photospheres/ugc_olympic_trail.json`
and viewing the rendered images. Side-by-side visual comparison with the
expected forward-along-trail view (route is approximately east-bound at this
lat/lng).

- **Yaw direction:** **formula correct as designed**, no code change needed.
  Empirical sweep at fixed lat/lng showed:
  - `ya=0` → looks ~True North (sideways into forest).
  - `ya=90` → looks ~True East along the trail (forward — what we want for
    east-going route).
  - `ya=180` → looks ~True South (sideways at hillside).
  - `ya=270` → looks ~True West along the trail (backward).
  Conclusion: this UGC pano's `ya=0` is approximately True North, meaning
  Maps JS's normalization gives `originHeading ≈ 0` for renderable UGC
  panoramas. Our formula `ya = (routeHeading - originHeading + 360) % 360`
  reduces to `ya = routeHeading` for these panoramas, which produces the
  desired forward-along-route view.
- **Pitch baseline `pi=0`:** **correct as designed**, no code change needed.
  At `pi=0, ya=90` (forward-east), the horizon was visibly level and the
  trail vanishing point landed at the vertical center. `pi=-10` rotated the
  view upward (more sky), `pi=10` rotated it downward (more foreground trail);
  neither was preferable. THETA-X-on-recumbent-bike rigs apparently produce
  pre-leveled output by the time it reaches `gpms-cs-s`, so passing
  `originPitch` through is unnecessary at this resolution. The
  `buildUgcRenderUrl` v1 hardcoded `pi=0` stays.
- **XSSI prefix:** **not present** on SingleImageSearch responses. Both
  fixture captures (`ugc_discovery_park.json`, `ugc_olympic_trail.json`) and
  the no-results capture begin with `[[0`. The defensive `)]}'\n` strip in
  `parseUgcUrlFromResponse` is harmless but never triggers in production.
  Keeping it as cheap defense-in-depth; covers TheGreatRambler-style
  `photometa` fallback if we ever need it (spec section 7.5).

**Caveat:** these probes use the captured response token as a stable test
fixture, NOT a live `getPanorama` call. The yaw assertion ("Maps JS
normalizes `originHeading ≈ 0`") is inferred, not directly observed —
it'll be verified-or-falsified once the extension hovers a real route in
Chrome and the bridge logs `originHeading=` for the same panoid. If a real
hover shows `originHeading != ~0`, the `routeHeading - originHeading`
formula is still correct — it's just that `originHeading` would not be
zero. Either way, the math is right.

## 7. Future improvements (deferred)

Recorded here so they're not lost. Each is a v1.1+ candidate driven by
real-use signal, not pre-emptive pre-optimization.

### 7.1 Bridge-side URL cache + concurrent dedup

`panoUrlCache` (Map: panoid → tokenBase + metadata) and `pendingUrlLookups`
(Map: panoid → in-flight Promise). Adds re-sweep / cursor-pause optimization
(zero `SingleImageSearch` calls on previously-seen panoids).

When to add: telemetry shows users frequently re-sweep UGC trails or pause
cursor on UGC points (e.g. via cumulative SingleImageSearch count per
session vs. unique-panoid count).

Shape: ~10 lines in the bridge, single-page-lifetime in-memory Map. Add a
500-entry LRU cap if telemetry shows >1000-entry session sizes.

### 7.2 UGC quality filter

Switch from "show all UGC" to filtering by `photos:street_view_android`
source tag (drops Publish-API uploads).

When to add: visible quality complaints — tilted horizons, motion blur,
indoor-tagged-outdoor uploads, etc.

Shape: post-filter in `parseUgcUrlFromResponse` (the source tag is in the
response). Or pass through the source tag as an additional field in
`PANO_INFO` and let the user toggle in the popup.

### 7.3 Attribution display removal

If the `copyrightEl` doesn't pull weight in real use, delete the element +
its CSS.

When to add: post-launch review confirms users don't notice / don't care.

Shape: 5-line removal — element creation, append, populate-on-render, hide,
CSS rule.

### 7.4 Explicit panoid in `openStreetViewTab` URL

Include the panoid + type in the Google Maps URL so the new tab lands on
the same panorama instead of the nearest-by-coordinates pano (which may
differ for UGC).

When to add: user reports of "v shortcut opens wrong panorama for trail
photos."

Shape: probe `?api=1&map_action=pano&pano=<wrapped>` — does it accept the
`CAoS...` form, or do we need the inner ID? If wrapped works, ~5 lines. If
inner needed, add a small `unwrapUgcPanoid` helper to `lib/photospheres.js`
(base64 decode + skip protobuf header + read varint length + return inner
slice).

### 7.5 `photometa` fallback path

If SingleImageSearch breaks or its endpoint is renamed, switch to
`https://www.google.com/maps/photometa/v1?pb=...` (TheGreatRambler's
endpoint family). Different endpoint, different request encoding (URL `pb=`
arg with `!`-delimited protobuf-text), but well-explored by the
reverse-engineering community.

When to add: `UGC_RPC_HTTP_ERROR` rate spikes in logs and the simple
endpoint update doesn't restore service.

Shape: parallel `lib/photometa.js` module. Bridge tries SingleImageSearch
first, falls back to photometa on G1/G2 errors. Adds another
fixture-and-refresh-script to the test suite.

### 7.6 FOV tuning

`fo=90` is initial. After visual review on a variety of UGC panoramas
(narrow trails, open roads, summits), may want to tune up or down.

### 7.7 StreetViewPanorama widget as ultimate fallback

If direct RPC reverse-engineering becomes unmaintainable (Google
significantly changes the protocol or starts requiring auth), the documented
`StreetViewPanorama` widget renders both panorama types correctly. Heavier,
but fully supported. Recorded as the architectural escape hatch.

## 8. References

- [`docs/design/photospheres/README.md`](../../design/photospheres/README.md) — research notes (2026-05-06 investigation, doc author's recipes, endpoint table).
- [`docs/design/streetviewpixels/README.md`](../../design/streetviewpixels/README.md) — existing free-tile pipeline (type-2 path).
- [`CLAUDE.md`](../../../CLAUDE.md) — project overview, free-tile vs static API pipeline split.
- [TheGreatRambler/streetview_client](https://github.com/TheGreatRambler/streetview_client) — prior art for direct RPC access (uses `photometa` instead of SingleImageSearch).
- [Reverse Engineering Google Streetview](https://tgrcode.com/posts/reverse_engineering_google_streetview) — accompanying blog post.

## 9. Implementation order

For the writing-plans step:

1. `lib/photospheres.js` (pure, testable) + unit tests + fixtures + refresh
   script. Land first — gives green CI signal before touching extension
   surfaces.
2. Bridge: `OUTDOOR` source filter, `singleImageSearch()` helper, type-10
   branch in `LOOKUP_PANO`, error-class plumbing, `sendPanoInfo` /
   `sendPanoInfoError` helpers.
3. Content script: `handlePanoInfo` router, `renderUgcPanorama`,
   `copyrightEl`, `panoErrorMessage`, `showPanoError` extension,
   `hideOverlay` cleanup.
4. CSS for `.sv-copyright`.
5. First-render empirical probes (yaw, pitch, XSSI). Update spec with
   results, adjust `buildUgcRenderUrl` if needed.
6. Update `docs/design/photospheres/README.md` — "STATUS: implemented YYYY-MM-DD"
   stamp at top, link forward to this spec.

Each step is independently verifiable: lib has unit tests; bridge changes
are testable by manual hover; content script is visual.
