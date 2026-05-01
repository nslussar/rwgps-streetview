# CLAUDE.md

## Project overview

Chrome extension (Manifest V3) that shows a Google Street View static image overlay when hovering over routes on ridewithgps.com. Works when Google Maps is selected as the map type in the RWGPS route editor.

## Architecture

Three execution contexts:

- **Page bridge** (`content/page-bridge.js`) — Injected into the MAIN world.
  - Hooks Google Maps constructors and prototype methods (`Map`, `Polyline`, `Marker.setPosition`/`setVisible`, `Polyline.setMap`, `Map.getBounds`) to capture map instances
  - Detects RWGPS's route-tracking marker via rapid-call counting (re-identification: 2 calls in 300ms; first-time: 3 calls in 500ms)
  - Only forwards `setPosition` when the marker is visible (avoids fighting `TRACKING_LOST` deactivation)
  - Hooks `setVisible(true)` to send position immediately on marker reappear
  - Forwards tracking positions to the content script (throttled to 150ms)
  - Handles pixel-to-latlng conversion and reverse geocoding
- **Content script** (`content/content.js`) — Runs in the ISOLATED world.
  - Manages overlay DOM (Street View image, street name label, heading display, no-coverage indicator)
  - Two modes switch dynamically: **tracking mode** (piggybacks on RWGPS's hover marker) and **manual mode** (own pixel-to-latlng + nearest-point calculation)
  - RWGPS destroys and recreates the tracking marker when cursor leaves/returns to the route
  - Zoom-aware deactivation: 500ms at high zoom (quick handoff to manual mode), 2s at low zoom (safety net for destroyed markers)
  - Linger timer starts at moment of tracking loss so total hide time is predictable
  - Manual mode activates at zoom >= 13
  - Clicking the overlay opens Google Maps Street View in a new tab
- **Service worker** (`background.js`) — Sole writer for all API counter state.
  - `chrome.webRequest.onCompleted` observes Street View Static requests; `details.fromCache` splits network (billed) vs cached.
  - Receives `GEOCODE_MSG`/`PAGE_LOAD_MSG`/`RESET_MSG` from content + popup. Coalesces writes to a 1s flush.
  - Per-tab toolbar badge via `chrome.action.setBadgeText({tabId, text})`. `sessionByTab` lives in `chrome.storage.session`.

Supporting files:
- `lib/geo.js` — Pure geometry functions (nearest point on polyline, bearing, haversine distance, compass direction)
- `lib/usage.js` — Shared helpers/constants for the request-counter feature; loaded by SW (importScripts), popup, and content scripts
- `content/api-budget.js` — Cap-check helper in ISOLATED world; sends geocode + page-load messages to SW (does NOT write counters)
- `icons/heading-arrow.svg` — Arrow icon used in the heading compass indicator
- `popup/` — Settings UI for API key entry (auto-saves, no build step)
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
- **Billing nuances**: NOT_FOUND / ZERO_RESULTS / DATA_NOT_AVAILABLE responses from Street View Static ARE billable (per Google's reporting docs). `&return_error_code=true` only changes response format, not billing. Browser HTTP cache hits do NOT bill (no request reaches Google) — detected via `chrome.webRequest`'s `details.fromCache`.
- **`chrome.webRequest` permissions gotcha**: webRequest events fire only when the extension has `host_permissions` for BOTH the destination URL AND the initiator page. Manifest declares both `https://maps.googleapis.com/*` and `https://ridewithgps.com/*` for this reason — `content_scripts.matches` is NOT a substitute despite chrome://extensions UI conflating them under "Site access".

## Build and release

- No build tools or npm — plain JavaScript
- `make build` creates a zip in `build/` for Chrome Web Store upload
- `make release` auto-bumps the patch version from the latest tag, creates the git tag, and pushes it to trigger the GitHub Actions release workflow
- Release workflow sets `manifest.json` version from the git tag (manifest stores `0.0.0` as placeholder)
- GitHub repo: https://github.com/nslussar/rwgps-streetview

## Testing

Manual testing only — load unpacked in `chrome://extensions`, test on ridewithgps.com route editor with Google Maps selected. Check browser console for `[RWGPS SV Bridge]` and `[RWGPS Street View]` log messages.
