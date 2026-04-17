# CLAUDE.md

## Project overview

Chrome extension (Manifest V3) that shows a Google Street View static image overlay when hovering over routes on ridewithgps.com. Works when Google Maps is selected as the map type in the RWGPS route editor.

## Architecture

Two execution contexts communicate via `window.postMessage`:

- **Page bridge** (`content/page-bridge.js`) — Injected into the MAIN world. Hooks Google Maps constructors and prototype methods (`Map`, `Polyline`, `Marker.setPosition`/`setVisible`, `Polyline.setMap`, `Map.getBounds`) to capture map instances and detect RWGPS's route-tracking marker. Also handles pixel-to-latlng conversion and reverse geocoding. Forwards tracking positions to the content script.
- **Content script** (`content/content.js`) — Runs in the ISOLATED world. Manages the overlay DOM (Street View image, street name label, heading display, no-coverage indicator), cursor tracking, API key validation, and Street View image loading. Has two modes that switch dynamically: tracking mode (piggybacks on RWGPS's hover marker) and manual mode (own pixel-to-latlng + nearest-point calculation). At high zoom RWGPS only snaps the tracking marker to discrete waypoints, so tracking is deactivated (200ms debounce) and manual mode fills the gaps. Clicking the overlay opens Google Maps Street View in a new tab.

Supporting files:
- `lib/geo.js` — Pure geometry functions (nearest point on polyline, bearing, haversine distance, compass direction)
- `icons/heading-arrow.svg` — Arrow icon used in the heading compass indicator
- `popup/` — Settings UI for API key entry (auto-saves, no build step)
- `content/overlay.css` — Overlay styles (`pointer-events: none` is critical)

## Key technical details

- RWGPS uses **Google Maps JavaScript API** (not Leaflet) for its map rendering
- The bridge must handle a race condition: Google Maps instances may be created before the bridge script loads. Multiple fallbacks: `Polyline.setMap` hook, `Map.getBounds` hook, `polyline.getMap()`, and DOM scanning for `.gm-style` elements with `__gm` properties.
- **RWGPS defers polyline creation** via React Query's `refetchOnWindowFocus`. Polyline objects may not exist until the user switches tabs. The bridge works around this by fetching route coordinates directly from `/routes/{id}.json` (same-origin API) as a fallback. API-fetched coords are cleared once real polylines appear.
- Street View images are preloaded offscreen (`new Image()`) to prevent in-flight load cancellation when the cursor moves rapidly. Uses `navigator.onLine` in the error handler to distinguish no-coverage from network failures.
- The overlay displays a **heading compass** (text label + rotatable arrow) showing the route direction at the hovered point. Heading is computed from the nearest polyline segment via `computeSegmentHeading()`. The arrow SVG is loaded from `icons/heading-arrow.svg` via `chrome.runtime.getURL`.
- The `&radius=25` parameter on Street View Static API requests searches within 25m for the nearest panorama
- Street View Static API has a minimum image size (between 10x10 and 100x100). Use at least 100x100 for validation/test requests.

## Build and release

- No build tools or npm — plain JavaScript
- `make build` creates a zip in `build/` for Chrome Web Store upload
- `make release` auto-bumps the patch version from the latest tag, creates the git tag, and pushes it to trigger the GitHub Actions release workflow
- Release workflow sets `manifest.json` version from the git tag (manifest stores `0.0.0` as placeholder)
- GitHub repo: https://github.com/nslussar/rwgps-streetview

## Testing

Manual testing only — load unpacked in `chrome://extensions`, test on ridewithgps.com route editor with Google Maps selected. Check browser console for `[RWGPS SV Bridge]` and `[RWGPS Street View]` log messages.
