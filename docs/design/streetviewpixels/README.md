# Free Street View via `streetviewpixels-pa` tile endpoint

## Why this exists

The extension currently requires the user to set up their own Google Cloud
project and provide a Street View Static API key. That's a real adoption
barrier. This doc tracks an investigation into a path that removes the API-key
requirement entirely by piggy-backing on the same free imagery pipeline that
the Google Maps JS API itself uses for the pegman drag-preview thumbnail.

## Key facts (established, not theoretical)

- **The pegman drag-preview is free.** It's an intrinsic feature of the Google
  Maps JavaScript API — same behavior on consumer maps.google.com and on
  third-party embeds (including RWGPS's iframe embedding). Not separately
  billed beyond the Map Load fee the embedder already pays.
- **All "normal" interactions with the loaded Maps JS API are free** for our
  purposes. The billable thing we've been avoiding (Street View Static API)
  is a different product that goes through `maps.googleapis.com/maps/api/streetview`
  with an API key in the URL. The free path doesn't.
- **The free path goes through `streetviewpixels-pa.googleapis.com/v1/tile`.**
  Captured request:
  ```
  https://streetviewpixels-pa.googleapis.com/v1/tile
    ?cb_client=maps_sv.tactile
    &panoid=-rtGmfCGx3hrKvBgFXcstQ
    &x=10&y=2&zoom=4
    &nbt=1&fover=2
  ```
  No API key in URL. CORS-enabled (`mode: cors`, `credentials: omit`).
  Returns a 512×512 panorama tile.

## Endpoint shape (empirical, from poking)

| Param       | Behavior                                                                 |
|-------------|--------------------------------------------------------------------------|
| `panoid`    | Panorama identifier. Required. (How to obtain: see below.)               |
| `zoom`      | Only accepts `4`. Other values → invalid argument.                        |
| `x`         | Tile column. Rotates the camera horizontally around the panorama.        |
| `y`         | Tile row. Vertical. `y=4` is roughly horizon-level on this panorama.     |
| `nbt`       | "No black tiles" flag, `0` or `1`.                                        |
| `fover`     | Range unclear, no visible effect in current testing.                     |
| `cb_client` | Client identifier (`maps_sv.tactile`). Probably routing/telemetry.       |

Note: `zoom=4` here is a tile-grid level on this endpoint, **not** a user-zoom
notion. The tile is always 512×512. Granularity of `x` (i.e., how many tiles
make up a full 360°) is one of the things still to pin down empirically.

## The missing piece: lat/lng → panoid

The tile endpoint requires a `panoid`, but we have lat/lng (the cursor
position on the route). The bridge between them is the Maps JS API's
`StreetViewService` — already loaded on RWGPS pages because RWGPS itself uses
it for the pegman.

```js
const svc = new google.maps.StreetViewService();
const { data } = await svc.getPanorama({
  location: { lat, lng },
  radius: 50,            // search radius in meters
  source: google.maps.StreetViewSource.OUTDOOR  // optional
});
data.location.pano        // ← the panoid we need
data.location.latLng      // ← snapped panorama position
data.tiles.centerHeading  // ← orientation of x=0 on this panorama (varies!)
```

`tiles.centerHeading` is critical. The `x` tile index is **not** world-heading
— it's an offset around the panorama's own zero direction (roughly where the
SV car was pointing). To render a "looking forward along the route" view we
have to convert:

```
relative   = (routeHeading - centerHeading + 360) % 360
x          = round(relative / 360 * NUM_X_TILES_AT_ZOOM_4)
```

`NUM_X_TILES_AT_ZOOM_4` is empirical — the canonical Street View panorama
geometry is 26×13 tiles at full zoom-5, but this endpoint's "zoom=4"
addressing might be coarser (likely 16×8 or similar). Confirm by counting
distinct `x` values fired across a full pegman rotation on a known panorama.

## Proposed pipeline

```
hovered route point (lat, lng, routeHeading)
        │
        ▼
google.maps.StreetViewService.getPanorama({location})    [page-bridge MAIN world, free]
        │
        ▼
{ panoid, snappedLatLng, centerHeading }
        │
        ▼
x = tileIndexFor(routeHeading - centerHeading)
url = `https://streetviewpixels-pa.googleapis.com/v1/tile
       ?cb_client=maps_sv.tactile
       &panoid={panoid}&x={x}&y=4&zoom=4&nbt=1`
        │
        ▼
<img src=url> in overlay   [content.js ISOLATED world]
```

## Verified facts (DevTools probe, 2026-05-05)

Probe run on `https://ridewithgps.com/routes/52960875` with the extension
disabled. `google.maps.StreetViewService.getPanorama()` returned for a
Magnuson-area coord:

```json
{
  "panoid": "yCBtzlEYAYIS97DUhgPTbQ",
  "snappedLat": 47.680239933851915,
  "snappedLng": -122.27796219700947,
  "centerHeading": 203.52719,
  "originHeading": 203.52719,
  "originPitch": -1.241659999999996,
  "worldSize": { "width": 16384, "height": 8192 },
  "tileSize":  { "width": 512,   "height": 512 },
  "links": [
    { "heading": 55.59481,  "pano": "48IpBXt8w0erKO7UWFKNBA" },
    { "heading": 195.71826, "pano": "iO6HoFLSMwg3yDKdRs1SDg" }
  ]
}
```

What this confirms:

- **`StreetViewService` is available on RWGPS** (top frame, no iframe gymnastics).
- **`worldSize: 16384 × 8192` ÷ `tileSize: 512` = 32 × 16 tiles** at full zoom (level 5). Our zoom=4 is exactly half = **16 × 8 tiles**, matching the empirical x/y sweeps.
- **`originHeading` = world heading where the tile grid's x=0 lives.** This is the per-panorama anchor we feed into the heading→x math.
- **`originPitch` ≈ -1.24°** — within rounding, the panorama's vertical zero is at the true horizon. That makes y indexing well-behaved and consistent across panoramas.
- **`links`** gives us adjacent panoramas (heading + panoid). Not needed for the current overlay, but a free affordance if we ever want a "follow the route through SV" feature.
- **Cross-origin tile fetches from `ridewithgps.com` work** (the earlier x/y sweeps loaded fine when re-run on RWGPS).

## Final tile addressing math (zoom=4)

```js
const TILE_BASE = 'https://streetviewpixels-pa.googleapis.com/v1/tile';
const ZOOM = 4;
const X_TILES_AT_ZOOM_4 = 16;   // 360° / 22.5° per tile
const Y_TILES_AT_ZOOM_4 = 8;    // 180° / 22.5° per tile
const DEG_PER_TILE = 360 / X_TILES_AT_ZOOM_4;  // 22.5

function tileXForHeading(routeHeading, originHeading) {
  const rel = (((routeHeading - originHeading) % 360) + 360) % 360;
  return Math.floor(rel / DEG_PER_TILE);
}

function tileUrl(panoid, x, y) {
  return `${TILE_BASE}?cb_client=maps_sv.tactile`
       + `&panoid=${encodeURIComponent(panoid)}`
       + `&x=${x}&y=${y}&zoom=${ZOOM}&nbt=1&fover=2`;
}
```

For "looking forward along the route at street level": **y=4** (top of row at
horizon, bottom at -22.5° pitch). y=3 sits above horizon — usable but more
sky than road. Stitching y=3 + y=4 gives a horizon-centered 45°-tall view.

FOV per # of stitched x-tiles:
- 1 tile → 22.5° (zoomed in, "telephoto" feel)
- 2 tiles → 45°
- 3 tiles → 67.5°
- 4 tiles → 90° (matches the current Static API `fov=90` default)

Recommendation: **2 tiles wide × 1 tile tall** (1024 × 512 px, 45° × 22.5° FOV)
as the default. Reasonable preview feel, only 2 requests per render, browser
cache hides repeat hovers.

## Resolved open questions

- ~~Does `streetviewpixels-pa` serve cross-origin from `ridewithgps.com`?~~ **Yes.**
- ~~`x` granularity at zoom=4?~~ **16 tiles × 22.5° each.**
- ~~Does `getPanorama` flicker billable metadata calls?~~ Not visible in the
  probe; no out-of-band Static-API requests fired.
- ~~`y` reference shift per panorama?~~ **No** — `originPitch` was effectively
  zero on the test panorama; assume the same is true broadly until we see
  otherwise.

## Panorama source types

The Maps JS API returns panoramas from multiple sources, encoded as a leading
type byte in the panoid:

| Type | Source                                        | Tile-endpoint support |
|------|-----------------------------------------------|------------------------|
| 2    | Standard Google SV-car capture                | ✅ raw 22-char panoid |
| 10   | User-contributed photosphere (Publish API)    | ❌ wrapped panoid 4xxs |

For type-10 panoramas, `getPanorama` returns a panoid like
`CAoSFkNJSE0wb2dLRUlDQWdJRHEzWW5QRWc.` which decodes to a protobuf
`{ field 1 = 10, field 2 = raw 22-char ID }`. The format is correct but
`streetviewpixels-pa.googleapis.com/v1/tile` does not serve UGC content —
those panoramas live in a different image tier (`lh3.googleusercontent.com` /
`geo*.ggpht.com`).

**Fix:** pass `source: StreetViewSource.GOOGLE` to `getPanorama` so UGC is
filtered at lookup time. Type-10 panoramas → ZERO_RESULTS instead of an
unfetchable panoid, which routes into the existing no-coverage UI.

## Remaining open questions

1. **Request rate / abuse signaling.** The reference capture had odd Chrome-
   internal headers (`x-browser-validation`, `x-client-data`). Likely not
   enforced (the endpoint serves un-keyed, cross-origin), but watch for
   throttling once we exercise it at hover-rate.
2. **Behavior at no-coverage points.** `getPanorama` returns
   `STREETVIEW_GET_PANORAMA: ZERO_RESULTS` (not a thrown exception with weird
   shape — it does throw, with a parseable message). Existing overlay already
   has a "no-coverage" branch from the Static API path; we can route this
   error into the same UI.
3. **Lat/lng → panoid latency.** `getPanorama` is async and may take 50-200ms
   on cold lookups. Today's Static-API path is one round-trip total; the
   tile path is `getPanorama` + N tile fetches. Caching `getPanorama` results
   per snapped lat/lng (with a small radius/grid bucket) is straightforward.

## Implementation surface (when we're ready)

- **`content/page-bridge.js`** (MAIN world) — already hooks `google.maps.Map`
  and forwards positions. Add a new request/response message type:
  `LOOKUP_PANO {lat, lng}` → `PANO_INFO {panoid, snappedLat, snappedLng,
  centerHeading}`. Implement via `StreetViewService.getPanorama()`. Cache
  recent results to avoid re-fetching on adjacent hovers.
- **`content/content.js`** (ISOLATED world) — current builder of Static-API
  URLs. Replace (or branch) with a tile-URL builder using the panoid +
  computed `x`. The existing overlay `<img>` can render either URL family
  unchanged.
- **Popup / settings** — make the API-key path optional. The free tile path
  becomes the default; the user's own Static API key becomes an opt-in for
  cases where the free path isn't enough (e.g., wider FOV, custom params).
  Or, depending on parity, the API key feature can be removed entirely.
- **Counter / cap** — currently gates against billable Static API calls.
  Free-path requests don't need this gate; the `bucketMeters` /
  `skipThresholdMeters` / `dwellMs` levers can stay (still nice for browser
  cache hits and request-rate hygiene), but the monthly-cap UI loses its
  meaning.

## Verification step before code

A copy-pasteable DevTools snippet (run on a real RWGPS route page) that:

1. Spins up a `StreetViewService` and calls `getPanorama` for a known coord.
2. Logs panoid, snappedLatLng, centerHeading.
3. Builds a tile URL from those + a chosen heading.
4. Appends a 512×512 `<img>` of that URL to the page so we can eyeball the
   result.

This confirms #1 (cross-origin works), #2 (x granularity once we sweep), and
#3 (no extra network fires) in one shot.

## Status

- [x] Endpoint identified, params mapped
- [x] panoid lookup mechanism identified (`StreetViewService.getPanorama`)
- [x] Pipeline sketched
- [x] DevTools verification snippet
- [x] Tile-x granularity at zoom=4 measured (16 × 8 for standard SV)
- [x] Cross-origin behavior confirmed from `ridewithgps.com`
- [x] `StreetViewService` confirmed available on RWGPS top frame
- [x] Implementation in `page-bridge.js` + `content.js`
- [x] Kill-switch toggle added to popup (`useFreeTilePipeline`, default true)
- [x] In-browser dogfood test on a real route
- [x] Per-panorama `worldSize` handling (non-standard captures with non-16×8 grid)
- [x] +180° offset for tile-x convention (x=0 looks "backward" from originHeading)
- [x] 3×2 stitch with sub-tile horizontal centering (heading lands at viewport center)
- [x] `source: StreetViewSource.GOOGLE` filter (excludes UGC photospheres that 4xx the tile endpoint)
- [ ] Strip debug black tile borders from `overlay.css`
- [ ] Popup polish: hide the API-key / cap UI when free pipeline is active
- [ ] Remove the API-key / Static API code path entirely once dogfood proves out

## Where to find each piece in the source

| Concern | File | Line | What lives there |
|---|---|---:|---|
| Tile endpoint constant | `content/content.js` | 39 | `TILE_BASE`, `DEFAULT_X_TILES`, `DEFAULT_Y_TILES` |
| Kill-switch state | `content/content.js` | 44 | `let useFreeTilePipeline = true;` |
| Kill-switch storage read + late-init | `content/content.js` | 101–151 | `init()` reads `useFreeTilePipeline`, gates init, late-runs setup when toggled on |
| `isOperational()` gate | `content/content.js` | 171–173 | Replaces the old `enabled && apiKey` checks throughout |
| `PANO_INFO` response handler | `content/content.js` | 306–308 | Routes to `handlePanoInfo` |
| Critical-path branch | `content/content.js` | 679–681 | `updateStreetViewImage()` → `updateStreetViewImageViaFreeTile()` if free pipeline on |
| Free-tile path entry | `content/content.js` | 754–780 | Buckets, sends `LOOKUP_PANO`, queues spinner |
| Tile URL builder | `content/content.js` | 782–788 | `buildTileUrl(panoid, x, y)` — produces a `streetviewpixels-pa` URL |
| Heading→tile + 6-tile preload + sub-tile shift | `content/content.js` | 790–875 | `handlePanoInfo()`. ZERO_RESULTS branch, `worldSize` → `xTiles/yTiles`, +180° rel calc, `T/leftX/midX/rightX`, `frac`, atomic 6-tile swap with `transform: translateX(-200 * frac)` |
| `getStreetViewLib()` (importLibrary) | `content/page-bridge.js` | 48–73 | Resolves `StreetViewService`+`StreetViewSource` via legacy global or dynamic loader |
| `LOOKUP_PANO` request handler | `content/page-bridge.js` | 559–626 | Calls `getPanorama` with `source: GOOGLE`, passes `panoid + originHeading + worldSize` back |
| Overlay tile grid CSS | `content/overlay.css` | 30–54 | `.sv-tiles` (600×400 inner, `top:-75px`) and `.sv-tile-{tl,tm,tr,bl,bm,br}` positions. Debug border on `.sv-tile`. |
| Popup toggle markup | `popup/popup.html` | 23–26 | Plain checkbox between header and bodies |
| Popup toggle wire-up | `popup/popup.js` | 57, 195, 209, 214–216 | Read on init, write on change |

(Line numbers are approximate — they drift with edits. Treat them as starting points and grep the symbol if the line moved.)

## Implementation notes

### `StreetViewService` resolution
RWGPS uses the new dynamic Maps JS loader, so `google.maps.StreetViewService`
may not exist synchronously even when `google.maps` is populated.
`page-bridge.js:getStreetViewLib()` first tries the legacy global, then falls
back to `await google.maps.importLibrary('streetView')`. Returns the whole
library object so `StreetViewSource` is also accessible. Result is cached.

### Kill switch
`useFreeTilePipeline` in `chrome.storage.sync` (default `true`). Plain
checkbox at the top of the popup, visible in both firstrun and active states.
When OFF, the extension reverts to the Static API path (which still requires
an API key).

### No-key bootstrap
When `useFreeTilePipeline` is true, the content script initializes without an
API key. `validateApiKey()` is only called if a key is set AND the kill
switch is off. The popup's FIRSTRUN UI is still shown when no key is set
(state machine intentionally left alone) — users can ignore it because the
toggle is above it.

### Tile geometry per panorama
At zoom=4, the tile grid is `(worldSize.width / 1024) × (worldSize.height / 1024)`.
For standard Google SV-car captures: 16 × 8 (22.5° per tile both axes).
For trekker / photo-path captures: non-standard (e.g. 13 × 7). Out-of-range
x or y returns INVALID_ARGUMENT. We read `worldSize` from the `getPanorama`
response and clamp accordingly. Fallback to 16 × 8 if `worldSize` is absent.

### Heading → tile-x math
```
rel  = ((routeHeading - originHeading + 180) + 360) % 360
T    = floor(rel / degPerXTile) % xTiles
frac = (rel / degPerXTile) - floor(rel / degPerXTile)   ∈ [0, 1)
```
The +180° offset accounts for the tile-x convention being opposite of the
world heading: x=0 looks "backward" from originHeading. Render tiles
`T-1, T, T+1` × `yTop, yBot`. The two rows flank the panorama's pitch
midpoint: `yTop = max(0, floor(yTiles/2) - 1)`, `yBot = min(yTiles-1, floor(yTiles/2))`.

### Sub-tile horizontal centering
Inner `.sv-tiles` div is 600 wide × 400 tall (3 tiles × 2 tiles, each 200 px).
Default position centers the middle column in the viewport with `top: -75px`
(crops top/bottom for horizon centering). JS sets `transform: translateX(-200 * frac)`
in `handlePanoInfo` so the heading lands at the horizontal center of the
400-wide viewport regardless of where in tile T it falls. Pan range is
`-200..0 px`, mapping `frac` of `0..1` to "heading at left seam" through
"heading at right seam".

### Panorama source filtering
`getPanorama` is called with `source: StreetViewSource.GOOGLE` so it returns
only Google's own SV-car captures (panorama type 2). User-contributed
photospheres (type 10) get filtered at lookup time — they would otherwise
return panoids like `CAoSFk...` (base64-wrapped protobuf with type byte 10)
that the `streetviewpixels-pa` endpoint doesn't serve.

### Counter / cap UI
Unchanged. With the free pipeline active, the `streetviewNetwork` counter
sits at zero — the cap is effectively meaningless. Cleanup is a follow-up.

### Debug tile borders (still on)
`overlay.css` has `border: 1px solid #000` on `.sv-tile` so seams are visible
during dogfooding. Strip it once geometry is locked in.
