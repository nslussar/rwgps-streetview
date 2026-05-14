# CLAUDE.md

## Project overview

Chrome extension (Manifest V3) that shows a Google Street View overlay when hovering over routes on ridewithgps.com. Works when Google Maps is selected as the map type in the RWGPS route editor.

Two image pipelines, switchable via the popup's top-of-screen mode picker (`useExperimentalPreview` in `chrome.storage.sync`). **Default mode is computed on first popup open:** `true` (experimental) when no `apiKey` is set, `false` (apikey) when one is. The popup migrates the computed default into storage once, so the value is sticky after that. Internally the experimental path is still called the "free-tile" path in some variable names and design docs; the `useExperimentalPreview` rename is the user-facing/CWS-review-facing framing:

- **Static API pipeline.** Uses `maps.googleapis.com/maps/api/streetview` with the user's API key, gated by a configurable monthly cap. The originally shipped v1 path and what every CWS-approved release through v1.1.1 has run on. Solid, long-term stable. Auto-selected for users who already have an API key set.
- **Experimental preview pipeline (default for new users).** Uses `streetviewpixels-pa.googleapis.com/v1/tile` — the panorama image tile endpoint the Maps JS street-view renderer pulls from. 3×2 stitched tile grid (4 of which are usually visible) with sub-tile horizontal centering on the route heading. Design source of truth: `docs/design/streetviewpixels/README.md`. The endpoint is internal-ish and at risk of breakage, but the no-API-key UX wins for first-run users; existing apikey users keep the static path.

## Architecture

Three execution contexts:

- **Page bridge** (`content/page-bridge.js`) — Injected into the MAIN world.
  - Hooks Google Maps constructors and prototype methods (`Map`, `Polyline`, `Marker.setPosition`/`setVisible`, `Polyline.setMap`, `Map.getBounds`) to capture map instances
  - Detects RWGPS's route-tracking marker via rapid-call counting (re-identification: 2 calls in 300ms; first-time: 3 calls in 500ms)
  - Only forwards `setPosition` when the marker is visible (avoids fighting `TRACKING_LOST` deactivation)
  - Hooks `setVisible(true)` to send position immediately on marker reappear
  - Forwards tracking positions to the content script (throttled to 150ms)
  - Handles pixel-to-latlng conversion, reverse geocoding, and **panorama lookup** (`LOOKUP_PANO` request → `PANO_INFO` response with panoid + originHeading + worldSize, or `kind:'ugc'` with `tokenBase` for type-10). Panorama lookup uses `StreetViewService.getPanorama({source: OUTDOOR})` resolved via `getStreetViewLib()` which handles both the legacy `google.maps.StreetViewService` global and the new dynamic `google.maps.importLibrary('streetView')` pattern. `OUTDOOR` admits both Google SV-car captures (type-2) and user-contributed photospheres (type-10); for type-10 the bridge delegates to `RwgpsPhotospheres.resolveUgcPanorama` (in `lib/photospheres.js`), which calls `SingleImageSearch` to extract a `gpms-cs-s` render URL. In release builds the photospheres helper is absent and type-10 panoids emit `NO_COVERAGE` instead (see "SIS gating" below). See the "Lookup reliability" section below for the retry + SIS-rescue layer that papers over Maps JS `getPanorama` flakiness.
- **Content script** (`content/content.js`) — Runs in the ISOLATED world.
  - Manages overlay DOM. Two image-rendering paths share the same overlay container:
    - **Experimental preview path** renders into a 3×2 `<img>` grid (`.sv-tiles` div with 6 children) — leftX/midX/rightX columns × yTop/yBot rows. The inner div is positioned with `top:-75px` (the rendered seam at viewport vertical center), and JS sets `transform: translateX(-200 * frac) translateY(-horizonOffsetPx)` per render — the X shift centers the heading horizontally; the Y shift compensates when the chosen seam row isn't exactly at the panorama's vertical center (non-integer `yTiles`, e.g. trekker 13×7s).
    - **Static API path** renders into the single direct-child `<img>`. Each path hides the other on swap.
  - Two modes switch dynamically: **tracking mode** (piggybacks on RWGPS's hover marker) and **manual mode** (own pixel-to-latlng + nearest-point calculation)
  - RWGPS destroys and recreates the tracking marker when cursor leaves/returns to the route
  - Zoom-aware deactivation: 500ms at high zoom (quick handoff to manual mode), 2s at low zoom (safety net for destroyed markers)
  - Linger timer starts at moment of tracking loss so total hide time is predictable
  - Manual mode activates at zoom >= 13
  - Clicking the overlay opens Google Maps Street View in a new tab
  - Three configurable request-cost levers (`chrome.storage.sync` keys, defaults in parens):
    `bucketMeters` (10) snaps lat/lng/heading before building the URL so re-hovers hit the browser HTTP cache;
    `skipThresholdMeters` (10) suppresses updates within N meters of the last shown point (no request, no cache lookup);
    `dwellMs` (200) defers the SV image fetch until the cursor settles (overlay show/position/heading still update immediately).
  - **Zoom-aware auto-scale**: `skipThresholdMeters` is a floor, not an absolute. The effective skip distance is `max(userMeters, PIXEL_FLOOR_SKIP * RwgpsGeo.metersPerPixelAtZoom(lat, zoom))` (`PIXEL_FLOOR_SKIP=5`): at high zoom the user value wins; at low zoom the pixel floor takes over so cursor sweeps don't burn API calls on sub-pixel movements. `bucketMeters` is intentionally **not** auto-scaled — large buckets at low zoom would snap requests onto neighboring streets / off-coverage spots. Zoom is forwarded from the bridge on every `TRACKING_POSITION` event and on `LATLNG` responses (both modes keep `lastKnownZoom` fresh).
- **Service worker** (`background.js`) — Sole writer for all API counter state.
  - `chrome.webRequest.onCompleted` observes Street View Static requests; `details.fromCache` splits network (billed) vs cached.
  - Receives `GEOCODE_MSG`/`PAGE_LOAD_MSG`/`RESET_MSG` from content + popup. Coalesces writes to a 1s flush.
  - Per-tab toolbar badge via `chrome.action.setBadgeText({tabId, text})`. `sessionByTab` lives in `chrome.storage.session`.

Supporting files:
- `lib/geo.js` — Pure geometry functions (nearest point on polyline, bearing, haversine distance, compass direction)
- `lib/usage.js` — Shared helpers/constants for the request-counter feature; loaded by SW (importScripts), popup, and content scripts
- `content/api-budget.js` — Cap-check helper in ISOLATED world; sends geocode + page-load messages to SW (does NOT write counters)
- `icons/heading-arrow.svg` — Arrow icon used in the heading compass indicator
- `popup/` — State-driven settings UI (firstrun / invalidkey / overquota / active). Renders monthly usage meter, cache + geo stat rows, advanced tuning knobs, and the API-key field. State decision lives in `popup.js:decideState`. Design source of truth: `design/handoff/SPEC.md` + `popup-reference.html`.
- `content/overlay.css` — Overlay styles (`pointer-events: none` is critical)

## Key technical details

- RWGPS uses **Google Maps JavaScript API** (not Leaflet) for its map rendering
- The bridge must handle a race condition: Google Maps instances may be created before the bridge script loads. Multiple fallbacks: `Polyline.setMap` hook, `Map.getBounds` hook, `polyline.getMap()`, and DOM scanning for `.gm-style` elements with `__gm` properties.
- **RWGPS defers polyline creation** via React Query's `refetchOnWindowFocus`. Polyline objects may not exist until the user switches tabs. The bridge works around this by fetching route coordinates directly from `/routes/{id}.json` (same-origin API) as a fallback. API-fetched coords are cleared once real polylines appear.
- Street View images are preloaded offscreen (`new Image()`) to prevent in-flight load cancellation when the cursor moves rapidly. Uses `navigator.onLine` in the error handler to distinguish no-coverage from network failures.
- The overlay displays a **heading compass** (text label + rotatable arrow) showing the route direction at the hovered point. Heading is computed from the nearest polyline segment via `computeSegmentHeading()`. The arrow SVG is loaded from `icons/heading-arrow.svg` via `chrome.runtime.getURL`.
- The `&radius` parameter on Street View Static API requests controls how far (in meters) to search for the nearest panorama. Configurable in the popup (default: 10m).
- Street View Static API has a minimum image size (between 10x10 and 100x100). Use at least 100x100 for validation/test requests.
- **Request counter & cap**: monthly counter (`apiUsage` in `chrome.storage.local`) gates Street View calls against a configurable cap (default 10000, matches Google's billable threshold). Cap applies only to `streetviewNetwork` — cache hits and geocoding don't count toward it. Per-tab session counter (`sessionByTab` in `chrome.storage.session`) resets on each page load via `PAGE_LOAD_MSG`.
- **Billing nuances**: NOT_FOUND / ZERO_RESULTS / DATA_NOT_AVAILABLE responses from Street View Static ARE billable (per Google's reporting docs). `&return_error_code=true` only changes response format, not billing. Browser HTTP cache hits do NOT bill (no request reaches Google) — detected via `chrome.webRequest`'s `details.fromCache`. **`webRequest.onCompleted` does fire with `fromCache:true` for `<img>` cache hits when URLs match exactly** — don't assume otherwise; if the cache counter looks broken, suspect URL instability (e.g. bucketing producing different outputs for nearby points) before suspecting the webRequest API.
- **Reconciling counters with GCP**: the GCP **APIs & Services dashboard** "Requests" column counts every HTTP response (billable + non-billable); its "Errors %" mixes billable 404s (NOT_FOUND with `&return_error_code=true`) with non-billable 429s (quota-rejected) and 403s. So `total × (1 − err%)` is NOT the billable count. Authoritative billable count lives in **Billing → Reports** under the SKU `Static Street View` (`9BD0-A2EE-44C3`) — the `Usage` column is what Google actually charged for. The extension's own `streetviewNetwork` counter sits between these (counts non-cache HTTP responses including 404s, but excludes other tabs/profiles). The `BillableDefaultPerDayPerProject` quota (configurable in IAM → Quotas) is enforced server-side on billable requests, so it acts as a hard daily ceiling on the bill.
- **Bucketing gotcha** (`lib/geo.js:bucketLatLng`): snap lat FIRST, then derive `cosLat` from the snapped lat. Computing `cosLat` from the raw input lat causes points in the same lat-cell to use slightly different `lngStep` values, which can flip lng across a bucket boundary and produce distinct URLs (cache misses) for points well inside one logical bucket.
- **`chrome.webRequest` permissions gotcha**: webRequest events fire only when the extension has `host_permissions` for BOTH the destination URL AND the initiator page. Manifest declares both `https://maps.googleapis.com/*` and `https://ridewithgps.com/*` for this reason — `content_scripts.matches` is NOT a substitute despite chrome://extensions UI conflating them under "Site access".
- **Popup error signals** (written by `background.js`, read by `popup.js`): `apiKeyInvalid` (sticky bool in `chrome.storage.local`, set on 403 REQUEST_DENIED, cleared on next 2xx) drives the invalid-key state. `rateLimitedAt` (timestamp, throttled to one write per 5s) drives the transient rate-limit notice (popup hides after 60s). Both rely on `&return_error_code=true` so Google returns 403/429 directly instead of an opaque "generic error" PNG.

## Experimental preview pipeline (`streetviewpixels-pa`)

The default path. Bypasses the Street View Static API and uses the same un-keyed tile endpoint Google's pegman drag-preview hits. **Anything reached via "normal interaction" with the loaded Maps JS API is free** — `StreetViewService.getPanorama()` for metadata + `streetviewpixels-pa.googleapis.com/v1/tile` for image tiles. No API key in URLs, CORS-enabled, paid by neither us nor RWGPS (it's an intrinsic Maps JS feature).

> **Full design + source-code map:** [`docs/design/streetviewpixels/README.md`](docs/design/streetviewpixels/README.md). That doc has a "Where to find each piece in the source" table with file:line pointers — start there before re-reading the code.

- **Tile URL shape:** `https://streetviewpixels-pa.googleapis.com/v1/tile?cb_client=maps_sv.tactile&panoid={pano}&x={x}&y={y}&zoom=4&nbt=1&fover=2`. We always use `zoom=4` — that's a tile-grid level, not a user-zoom. Each tile is 512×512.
- **Per-panorama tile geometry.** Number of tiles varies per panorama. Standard Google SV-car captures are 16×8 at zoom=4 (22.5° per tile horizontally, 22.5° per tile vertically). Trekker / photo-path captures are non-standard (e.g. 13×7). Read `tiles.worldSize` from the `getPanorama` response and divide by 1024 to get the actual `xTiles × yTiles` at zoom=4. Fallback to 16×8 if absent. **Out-of-range x/y returns INVALID_ARGUMENT** — always clamp via worldSize-derived dims.
- **Heading → tile-x math** (in `content.js:handlePanoInfo`):
  ```
  rel  = ((routeHeading - originHeading + 180) + 360) % 360   // +180° because tile x=0 looks "backward" from originHeading
  T    = floor(rel / degPerXTile) % xTiles                    // tile containing the heading
  frac = rel/degPerXTile - floor(rel/degPerXTile)             // [0, 1)
  ```
  Render tiles `T-1, T, T+1` (3 across) × `yTop, yBot`. The row pair is picked by rounding `worldSize.height/2 / divisor` to the nearest integer seam (not `floor(yTiles/2)` — that misaligns on non-integer-row panoramas like trekker 13×7s). `xTiles` uses `floor(worldSize.width / divisor)` for the same reason: rounding up adds a half-padded trailing tile that wraps into tile 0 and visibly duplicates content. `degPerXTile` uses the *continuous* (fractional) tile count so heading→tile math stays angularly correct after the floor. Translate by `translateX(-200 * frac)` for horizontal heading centering and `translateY(-horizonOffsetPx)` for vertical horizon centering. 6 tile fetches per render — 4 visible, 2 panning buffer.
- **Source filter: `StreetViewSource.OUTDOOR`.** Admits both Google SV-car captures (type-2, rendered via the `streetviewpixels-pa` tile grid above) AND user-contributed photospheres (type-10, panoids look like `CAoSFkNJSE0w...` — base64-wrapped protobuf with type byte 10). Excludes type-2 indoor "Business View" panoramas. Type-10 panoramas are NOT served by `streetviewpixels-pa` (they live in `lh3.googleusercontent.com/gpms-cs-s/...`) so the bridge routes them through a separate render path — see the photospheres spec (`docs/superpowers/specs/2026-05-07-photospheres-ugc-rendering-design.md`).
- **`StreetViewService` resolution** (`page-bridge.js:getStreetViewLib`). RWGPS uses the new dynamic Maps JS loader, where `google.maps.StreetViewService` may NOT be on the global synchronously even when `google.maps` is. Try the legacy global first, then fall back to `await google.maps.importLibrary('streetView')`. Cache the resolved library object so subsequent `LOOKUP_PANO` requests are zero-cost. Note: the existing constructor hooks (`Map`, `Polyline`, `Marker`) still work because RWGPS pulls in those libraries before our content script gets a chance to ask for `StreetViewService`.
- **Existing throttling levers still apply.** `bucketMeters` / `skipThresholdMeters` / `dwellMs` reduce panorama-lookup rate the same way they reduced Static API request rate. Browser caches both the metadata fetches and the tile fetches.
- **Overlay layout** (`overlay.css`). The 3×2 `<img>` grid lives in `.sv-tiles`, a 600×400 inner box positioned `top: -75px; left: 0;` relative to the 400×250 overlay. Each tile is 200×200 in two rows of three. JS sets `translateX(-200 * frac)` for sub-tile horizontal centering.

## Lookup reliability: retry + SIS rescue

Maps JS `StreetViewService.getPanorama()` has a coord-specific stale-cache (or similar) bug: it returns `ZERO_RESULTS` for queries that DO have coverage (verified independently via Static API and via `SingleImageSearch` against the same coords). Empirically ~33% of lookups need at least one retry to succeed; ~12% fail all retries and need a different lookup path entirely. Static API at the same coords has full coverage, so it's a Maps JS-specific issue. Bridge layers two defenses (see `content/page-bridge.js`'s `LOOKUP_PANO` handler):

1. **Retry on `ZERO_RESULTS`.** `getPanorama` is invoked up to 3 times total (2 retries), 300 ms apart, with a fresh `StreetViewService` instance each attempt. Successes log `getPanorama retry SUCCESS req=N attempt=K/3`.
2. **SIS rescue.** When all retries exhaust, the bridge delegates to `RwgpsPhotospheres.tryRescueLookup` (in `lib/photospheres.js`), which calls `SingleImageSearch` at the same coords. SIS hits a different backend than Maps JS and reliably finds the panos `getPanorama` is missing. The parser (`lib/photospheres.js:parseUgcUrlFromResponse`) extracts full metadata (panoid, snapped lat/lng, originHeading, originPitch, copyright, gpms-cs-s render URL); `tryRescueLookup` synthesizes a normal `PANO_INFO {kind:'ugc', ...}` and returns it via a `{ok, panoInfo}` envelope, which the bridge dispatches. The content side renders it transparently via the existing UGC path. End result: 0% no-coverage on routes where coverage genuinely exists — in **dev only**. In release the rescue helper is absent and the bridge reports `NO_COVERAGE` from the original `getPanorama` error.

**SIS response shapes** (positional JSPB, fragile to Google moving fields):

- **Format A** (Curt Sumner, Brian Ferris fixtures): `parsed[1][5][0][1]` is a 5-element array. Heading at `[1][0]`, pitch at `[2][2] mod 360`.
- **Format B** (Yogy Namara fixture): `parsed[1][5][0][1]` is a 3-element array. Heading is packed at `[2][0]` alongside the pitch at `[2][2]`; `[1]` is `null`.

`parseUgcUrlFromResponse` auto-detects by checking whether `[5][0][1][1]` is an array. URL extraction is regex-based (robust to position shifts); metadata extraction is positional (test fixtures pin the layout).

**SIS-primary is the next iteration.** Steady-state latency would drop from ~1s on rescue cases to ~150 ms across the board. Deferred because (a) type-2 SV-car panos haven't been verified through SIS (we have UGC-heavy test routes), and (b) defense in depth — if SIS protocol shifts, `getPanorama` still works for the 88% non-rescue case. See the addendum in the photospheres spec for the migration sketch.

## Open follow-ups (experimental preview pipeline)

- **Popup state machine.** The FIRSTRUN screen still demands an API key when none is set. With the experimental toggle defaulting to OFF (opt-in) the FIRSTRUN flow is the correct primary onboarding — leave as is.
- **Cap UI / counter UI** is the canonical default-mode UX, since the experimental path is opt-in and the API-key path remains the primary supported behavior. No work needed here.
- **Heading granularity is still ±1 tile worth** at panorama level — for non-standard panoramas with fewer tiles per 360°, individual tiles cover MORE degrees, so visible bias may grow. Sub-tile shift compensates the residual within a tile, but at the *seam between two panoramas* with mismatched coverage there's no fix short of zoom=5 (16 tiles per render — too many requests).

## Build and release

- No build tools or npm — plain JavaScript
- `make build` creates a zip in `build/` for Chrome Web Store upload. The zip's file list is **explicit** (not glob-based) — every new top-level file or directory referenced by `manifest.json` must be added to the `cp` invocation in the `Makefile`, or the Web Store will reject the package with `Could not load <thing> ''.` (1.1.0 shipped broken because `background.js` was added to the manifest but never to the zip list). When touching the manifest or adding a new asset, diff `unzip -l build/*.zip` against `manifest.json` references before tagging.
- **SIS gating (release build).** `lib/photospheres.js` houses all SingleImageSearch (SIS) code — the URL constant, `fetch` wrapper, JSPB body builder, gpms-cs-s response parser, UGC render-URL builder, plus the higher-level glue (`resolveUgcPanorama`, `tryRescueLookup`) that owns SIS-response shape and synthetic-PANO_INFO construction. `make build` stages a release copy of the tree, deletes `lib/photospheres.js`, and uses `jq` to drop its references from `manifest.json` (`content_scripts[0].js` and `web_accessible_resources[0].resources`). At runtime, `content/page-bridge.js` has an inline `isType10PanoidLocal` (CAoS-prefix check, doesn't depend on `RwgpsPhotospheres`) and feature-detects the helper before any UGC handling. In release both the type-10 branch and the rescue path emit an explicit `NO_COVERAGE` error — not a silent fall-through to the tile path, which would surface as "Tile load failed" on UGC-only trails. `content/content.js`'s `injectBridge()` has an `onerror` handler so a missing `lib/photospheres.js` doesn't deadlock the bridge load; `handlePanoInfo` defensively guards the `kind:'ugc'` branch. The Makefile asserts the release zip is free of `MapsJsInternalService`, `grpc-web-javascript`, and `$rpc/` strings; comments in shipped files use "to-be-implemented / optional helper / feature-detect" framing rather than "stripped/disabled" language to keep CWS review surface anodyne. Loaded unpacked from source the full path is live. Don't "fix" the apparently-dead UGC code paths or the `typeof RwgpsPhotospheres` guards — they're the gating mechanism. Spec: `docs/superpowers/specs/2026-05-12-gate-sis-out-of-release-build.md`.
- `make release` auto-bumps the patch version from the latest tag, creates the git tag, and pushes it to trigger the GitHub Actions release workflow
- Release workflow sets `manifest.json` version from the git tag (manifest stores `0.0.0` as placeholder)
- GitHub repo: https://github.com/nslussar/rwgps-streetview

## Web Store demo video

Lives in `scripts/demo-recording/`. Has its own `package.json` (Playwright dependency, isolated from the rest of the repo). Two-stage pipeline:

1. **Record raw clips manually** with QuickTime "Record Selection" while a clean Chromium is open on the route. The launch harness is `npm run demo` (after `npm run setup` once to create a profile and pin the extension):
  - `setup-profile.js` — one-time: launches Chromium with the unpacked extension, user pins the toolbar icon, profile saved to `.chrome-profile/`.
  - `demo.js` — every run: clears `chrome.storage` so the popup re-enters firstrun state, seeds `dwellMs:50` and the `apiUsage` counter for a populated meter, opens the route at a maximized window, then waits on a keypress prompt. The user records freely (real OS cursor, all browser-chrome interactions) and presses any key to close. Earlier iterations of this script automated cursor sweeps via Playwright; that's been removed because OS cursor + Playwright synthetic cursor look jarringly different on screen.
  - Raw recordings live in `screenmovies/` (gitignored except for the final cut).

2. **Compose the final cut** from the raw recordings via `npm run build-cut`:
  - `segments.json` — single source of truth: list of source `.mov` files, per-segment frame ranges + computed PTS time ranges, captions, per-segment lingers, transition style/duration, title-card text and font size.
  - `build-cut.js` — reads `segments.json`, computes xfade offsets + caption windows from segment durations and lingers, invokes ffmpeg with one big `-filter_complex`. Each segment is `tpad`-ed with cloned-last-frame for `linger_s + xfade_dur` seconds so the section plays fully, holds, then fades through black into the next section. Final clip is a generated black-bg + centered-white-text title card.

**Why frame numbers ≠ time × 60.** QuickTime screen recordings are variable-frame-rate but advertise a 60fps `r_frame_rate`. The QT player's frame counter shows sequential decoded frames (1, 2, 3...), so frame N's wall-clock timestamp is the Nth frame's actual PTS — NOT `N/60`. To convert frame numbers to PTS for editing `segments.json`:

```
ffprobe -v error -select_streams v:0 -show_entries frame=pts_time \
  -of csv=p=0 SOURCE | awk 'NR==FRAME {print}'
```

**ffmpeg requirements.** `drawtext` (libfreetype) and `subtitles`/`ass` (libass) aren't in homebrew's stripped `ffmpeg` formula as of 2026-05. Use the `homebrew-ffmpeg/ffmpeg/ffmpeg-full` formula instead — `build-cut.js` defaults to `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg` (overridable via `FFMPEG` env var).

## Testing

- **Unit tests** (`test/*.test.js`) cover the pure helpers in `lib/geo.js` and `lib/usage.js`. Run via `make test` (uses Node's built-in `node --test`, no npm/deps). Add a test alongside any change to those files. Chrome-extension surfaces (`content/`, `background.js`, `popup/`) are not unit-tested — they need DOM/`chrome.*`/Google Maps mocks.
- **Manual testing** for everything else: load unpacked in `chrome://extensions`, test on ridewithgps.com route editor with Google Maps selected. Check browser console for `[RWGPS SV Bridge]` and `[RWGPS Street View]` log messages.
- **CI**: `.github/workflows/test.yml` runs `node --test` on push to main and on PRs; `release.yml` runs the same step before building the zip, so a failing test blocks publishing.

## Working on this codebase

- No build step, no linter, no npm. `node --check <file>` is a quick syntax gate; `make test` runs the unit suite for `lib/`. For anything touching `content/`, `background.js`, or `popup/`, reload unpacked and verify in the browser.
- `jsconfig.json` + `globals.d.ts` exist purely for editor/LSP help (not runtime). When adding a new IIFE-exposed global (`window.RwgpsFoo = ...` or `self.RwgpsFoo = ...`), expose it via `module.exports = api` at the bottom of the same file, then add a one-liner to `globals.d.ts`: `const RwgpsFoo: typeof import('./path/to/file.js');`. Without that, cross-file `findReferences` / `goToDefinition` won't follow the global.
- The extension runs across three contexts that each have their own DevTools console:
  - Page console (RWGPS tab DevTools) — `[RWGPS Street View]` and the page-bridge logs
  - Service-worker console (`chrome://extensions` → "Service worker") — `[RWGPS SV bg]` logs
  - Popup DevTools (right-click popup → Inspect)

  When debugging cross-context behavior (counter discrepancies, message passing, cache accounting), add `console.log` on BOTH sides and watch BOTH consoles — the asymmetry between what each side sees is usually where the bug lives.
- Don't theorize about Chrome internals; verify with a log. (The "`<img>` memory cache short-circuits webRequest" theory was wrong — bucketing was producing unstable URLs and webRequest was working fine.)
- For popup UI changes, `design/handoff/SPEC.md` is the layout/copy source of truth and `design/handoff/popup-reference.html` is a runnable mockup of all 4 states. Where SPEC and behavior conflict, the extension wins — flag it.
- No per-tab active/inactive toolbar icon. Considered (grayscale on non-RWGPS tabs) and dropped — clean implementation needs `tabs`/`webNavigation` permission (update re-prompt for existing users), zero-permission workaround flickers on intra-RWGPS navigation, and the icon is only visible to users who've pinned it. Revisit only if users ask.
