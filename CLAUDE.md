# CLAUDE.md

## Project overview

Chrome extension (Manifest V3) that shows a Google Street View static image overlay when hovering over routes on ridewithgps.com. Works when Google Maps is selected as the map type in the RWGPS route editor.

## Architecture

Two execution contexts communicate via `window.postMessage`:

- **Page bridge** (`content/page-bridge.js`) — Injected into the MAIN world. Hooks Google Maps constructors (`Map`, `Polyline`, `Marker.prototype.setPosition`) to capture map instances and detect RWGPS's route-tracking marker. Forwards tracking positions to the content script.
- **Content script** (`content/content.js`) — Runs in the ISOLATED world. Manages the overlay DOM, cursor tracking, and Street View image loading. Has two modes: tracking mode (piggybacks on RWGPS's hover marker) and manual fallback (own pixel-to-latlng + nearest-point calculation).

Supporting files:
- `lib/geo.js` — Pure geometry functions (nearest point on polyline, bearing, haversine distance)
- `popup/` — Settings UI for API key entry (auto-saves, no build step)
- `content/overlay.css` — Overlay styles (`pointer-events: none` is critical)

## Key technical details

- RWGPS uses **Google Maps JavaScript API** (not Leaflet) for its map rendering
- The bridge must handle a race condition: Google Maps Map/Polyline instances may be created before the bridge script loads. Fallback: `polyline.getMap()` captures the map from intercepted polylines.
- Street View images are preloaded offscreen (`new Image()`) to prevent in-flight load cancellation when the cursor moves rapidly
- The `&radius=100` parameter on Street View Static API requests searches within 100m for the nearest panorama

## Build and release

- No build tools or npm — plain JavaScript
- `make build` creates a zip in `build/` for Chrome Web Store upload
- Version comes from git tags: `git tag v1.0.x && git push --tags` triggers the GitHub Actions release workflow
- Release workflow verifies `manifest.json` version matches the git tag
- GitHub repo: https://github.com/nslussar/rwgps-streetview

## Testing

Manual testing only — load unpacked in `chrome://extensions`, test on ridewithgps.com route editor with Google Maps selected. Check browser console for `[RWGPS SV Bridge]` and `[RWGPS Street View]` log messages.
