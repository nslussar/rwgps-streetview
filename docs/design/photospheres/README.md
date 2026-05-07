# UGC Photospheres — research notes

**Status (2026-05-06):** investigated; implementation required to fix
confirmed bike-path coverage regression. See "Decision" below.

## What this doc is

We explored two related concerns in the same investigation:

1. **Indoor business panoramas** sometimes appear in our overlay (e.g. a
   bar interior in Ballard) when `getPanorama` returns a Google-published
   "Business View" pano on a busy street.
2. **User-contributed (UGC) photospheres** are currently filtered out
   entirely (`source: StreetViewSource.GOOGLE` excludes them) — but they're
   the only Street View coverage on bike trails / off-pavement / hiking
   paths, exactly where RWGPS users plan rides.

This doc captures the API surface, working repro recipes, and design
options we worked through. If we revisit, this should let you skip the
3-hour recon session.

For background on the existing free-tile pipeline that this would extend,
see [`../streetviewpixels/README.md`](../streetviewpixels/README.md).

## Coverage regression on bike paths

The motivating case. Verified 2026-05-06 at `48.049215, -123.037430`
(Olympic Discovery Trail, Sequim WA):

- Google SV-car capture at `48.04942, -123.03691` — **~45 m away**, on
  the parallel road `W Sequim Bay Rd`. Fresh imagery from 2025-08.
- UGC photosphere by Curt Sumner at `48.04921, -123.03741` — **~1.2 m
  from the route point**, fresh from 2025-09, sitting on the trail
  itself.

`getPanorama` returns:

| `source`  | radius 50 (lab probe) | radius 10 (extension default) |
|---|---|---|
| `GOOGLE`  | SV-car at 45 m  | `ZERO_RESULTS` |
| `OUTDOOR` | SV-car at 45 m (UGC dropped despite being 37× closer) | UGC at 1.2 m |
| `DEFAULT` | UGC at 1.2 m   | UGC at 1.2 m |

The paid Static Street View API (used by the v1 extension pipeline)
served the closest panorama as a flat image, regardless of type — so
users saw the trail UGC. Our current free pipeline filters UGC at
lookup time, leaving trail-centered points with `ZERO_RESULTS` →
"no coverage" UI.

**Where this hurts most:** segregated bike paths, hiking trails, park
interiors, summits, and any off-pavement segment of an RWGPS route —
exactly where users care about seeing what's ahead. Roads they're
avoiding by being on a trail in the first place.

### Note on `OUTDOOR` semantics

`OUTDOOR` is **not** a "Google-only" filter, contrary to my earlier
read of the docs. Verified at Discovery Park trail
(`47.65701542602452, -122.41581947655352`), where no SV-car exists
within radius 30: `OUTDOOR` and `DEFAULT` both returned the same UGC
photosphere. So `OUTDOOR` includes UGC in the candidate set; it just
applies a "prefer type-2 over type-10" ranking that wins regardless of
distance whenever a type-2 is in range.

At the extension's small lookup radius, type-2 captures on parallel
roads fall outside the radius and `OUTDOOR` falls through to UGC. For
practical purposes, **at extension defaults `OUTDOOR` and `DEFAULT`
behave identically on bike-path geometry.**

## Decision

**Need to implement Option 2 below.** Initial assessment was that the
UGC coverage gain would be narrow because type-2 panos coexist within
meters of UGC. That's true in *urban* areas. It is NOT true on bike
paths and trails — the dominant RWGPS use case — where the closest
type-2 capture is often on a parallel road well outside the extension's
~10 m lookup radius. The regression-evidence section above documents
this empirically.

The cheap fix (just switching `source: GOOGLE` → `OUTDOOR`, no UGC
rendering) does NOT address this regression. At small radius `OUTDOOR`
returns type-10 panoids whenever no type-2 is in range — and our
existing tile pipeline can't render them. Option 1 alone shifts the
failure mode from `ZERO_RESULTS` to "broken image", not better.

The path that works is **Option 2**: switch source to allow UGC, **plus**
add a render path for type-10 panoramas via direct `SingleImageSearch`
+ `gpms-cs-s` server-cropped images. Effort is real but tractable
(roughly half the surface area of the existing free-tile pipeline).

Not a small change, but the regression is real and the use case is
core. Bike paths are why RWGPS users exist.

## Background: panorama source types

The Maps JS API encodes a panorama type byte at the head of every panoid:

| Type | Source                                      | Wrapped panoid prefix      |
|------|---------------------------------------------|----------------------------|
| 2    | Standard Google SV-car capture              | raw 22-char alphanum (no wrapper) |
| 10   | UGC photosphere (Street View Publish API)   | `CAoS...` (base64 protobuf wrap) |

Type-10 panoids decode to `{field 1 = 10, field 2 = inner_id}`. Examples:

- Wrapped: `CAoSF0NJSE0wb2dLRUlDQWdJRGF2ZkM5d0FF`
- Inner: `CIHM0ogKEICAgIDavfC9wAE`

The existing free-tile pipeline (`streetviewpixels-pa.googleapis.com/v1/tile`)
serves type-2 only. Type-10 imagery lives on a different content tier.

## `StreetViewSource` enum (one-of-three)

`StreetViewService.getPanorama({source: ...})` accepts a single value:

| Value     | UGC type-10 | Indoor Business View (type-2) | Ranking when multiple match |
|-----------|-------------|-------------------------------|-----------------------------|
| `DEFAULT` | included    | included                      | closest first, type-agnostic |
| `GOOGLE`  | excluded    | included                      | (UGC excluded entirely)     |
| `OUTDOOR` | included    | excluded                      | type-2 preferred over type-10 even when type-10 is closer |

Notes:

- Not a bitmask — you cannot "exclude both indoor and UGC" via the source
  param alone. To exclude both, use `OUTDOOR` and post-filter type-10
  panoids by panoid prefix (`CAoS`).
- The `OUTDOOR` ranking matters in practice: at large radius, `OUTDOOR`
  behaves like `GOOGLE` (preferring distant SV-car over close UGC); at
  small radius (extension default), it behaves like `DEFAULT` (closest
  wins by elimination of out-of-range type-2). See "Coverage regression
  on bike paths" above for the verifying experiment.

## Where to find each piece in source

| Piece | File | Lines |
|---|---|---|
| Existing source filter (currently `GOOGLE`) | `content/page-bridge.js` | ~580 |
| `getStreetViewLib()` (resolves library) | `content/page-bridge.js` | ~41–73 |
| `LOOKUP_PANO` request handler | `content/page-bridge.js` | ~558–610 |
| `handlePanoInfo` (tile grid render) | `content/content.js` | (search for it) |

## UGC photosphere imagery URL pattern

UGC photospheres are served from `lh3.googleusercontent.com` under two
known prefixes:

| Prefix | Used by | Render-spec format |
|--------|---------|--------------------|
| `gpms-cs-s` | Maps JS API tier (third-party sites) | server-side cropped (`pi/ya/ro/fo`) and tiled (`x/y/z`) |
| `grass-cs`  | google.com pegman drag-preview tier | server-side cropped and tiled |

URL shape:

```
https://lh3.googleusercontent.com/<prefix>/<opaque_token>=<render_spec>
```

`<render_spec>` accepts two formats:

- **Server-side crop:** `=w<W>-h<H>-k-no-pi<pitch>-ya<yaw>-ro<roll>-fo<fov>`
  (where `-pi`, `-ya`, `-ro`, `-fo` are optional; defaults apply if omitted)
- **Tile coords:** `=x<X>-y<Y>-z<Z>` (zoom-4 tiles are 512×512)

`<opaque_token>` is per-photosphere and binds only to the photosphere
identity — render-spec params are NOT signed. We can substitute freely.

### Verified by direct fetch (2026-05-06)

Fetching the same token with four different render specs returned four
distinct JPEGs at the requested dimensions:

| URL render-spec | HTTP | Size | Dimensions | MD5 |
|---|---|---|---|---|
| `=w150-h75-k-no` | 200 | 6,259 b | 150×75 | `2ee08c07d6af7fd5a4ee59f62afc9c1a` |
| `=w400-h250-k-no-pi0-ya0-ro0-fo90` | 200 | 19,215 b | 400×250 | `fa1345f8fab0ed5a44cdcb5bfe9a9358` |
| `=w400-h250-k-no-pi0-ya180-ro0-fo90` | 200 | 25,468 b | 400×250 | `3f9b0d5bcd9bce7aa3a05295ce910ab0` |
| `=w400-h250-k-no-pi0-ya90-ro0-fo60` | 200 | 37,439 b | 400×250 | `099df558c4db0d2a3ac5535c4897eb62` |

(Smaller `fo` = narrower FOV = more zoomed-in detail = more JPEG bits.
File 4 with `fo=60` is largest.)

**Implication:** server-side cropping is preferred over fetching the full
equirectangular sphere. Per-render images are tiny (6–37 KB) and we don't
need client-side projection math.

## Where the URL comes from

**It does NOT come from `StreetViewService.getPanorama()`.** Maps JS parses
the underlying `SingleImageSearch` response and exposes only documented
fields on the returned `StreetViewPanoramaData` object. The URL is silently
discarded.

Top-level fields actually exposed by `getPanorama()`:
`copyright`, `imageDate`, `location`, `links`, `tiles`, `disabled`,
`takeDownUrl`, `time`, plus minified internal fields (`SA`, `nM`, `BK`,
`JG`) that change between Maps JS versions and can't be relied on.

`tiles` exposes only: `centerHeading`, `originHeading`, `originPitch`,
`tileSize`, `worldSize`. **No `getTileUrl` method on Google-served
panoramas** (despite docs implying one exists — that's only for
custom-tile providers building their own panorama).

**To get the URL, we have to call `SingleImageSearch` ourselves.** It's
the same endpoint Maps JS uses internally — keyless, cross-origin from
`ridewithgps.com`, no XSRF token. See repro recipe below.

## Endpoints summary

| Endpoint | Purpose | Auth | Cross-origin from rwgps.com? |
|---|---|---|---|
| `streetviewpixels-pa.googleapis.com/v1/tile` | Type-2 tile imagery | none | ✅ |
| `maps.googleapis.com/$rpc/.../SingleImageSearch` | Pano metadata + URL for type-10 | none | ✅ |
| `lh3.googleusercontent.com/gpms-cs-s/...` | Type-10 imagery (server-cropped) | none (signed token in path) | ✅ |
| `www.google.com/maps/_/MapsWizUi/data/batchexecute` (`MapsPhotoService.ListEntityPhotos`) | Pegman photo list | XSRF `at=` token from `google.com` JS state | ❌ (not workable) |

The first three are the piggyback path. `batchexecute` looked promising
during recon but turned out to need a Google.com XSRF token; ruled out.

## Reproduction recipes

### Test subject: known UGC photosphere

- Wrapped panoid: `CAoSF0NJSE0wb2dLRUlDQWdJRGF2ZkM5d0FF`
- Inner id: `CIHM0ogKEICAgIDavfC9wAE`
- Lat/lng: `47.65701542602452, -122.41581947655352`
- Author: Brian Ferris
- Captured: 2021-03
- Location: Discovery Park trail (Seattle)
- World size at zoom=4: 5376 × 2688 (2:1 equirectangular)
- `originPitch: -1.58°` (slight phone tilt — common for UGC)

> **Token caveat:** the `gpms-cs-s` opaque tokens may have lifetimes. If
> the example URL below 4xxs by the time you read this, fetch a fresh
> token by re-running `SingleImageSearch` for the lat/lng above.

### Recipe 1: DevTools probe — confirm `getPanorama()` doesn't expose the URL

Paste in the **page console** on a RWGPS route page (Maps JS already loaded;
hover the map first if it isn't):

```js
const lib = await google.maps.importLibrary('streetView');
const svc = new lib.StreetViewService();
const res = await svc.getPanorama({
  location: { lat: 47.657023647577873, lng: -122.41582313787025 },
  radius: 30,
  source: lib.StreetViewSource.DEFAULT
});
console.log('top-level keys:', Object.keys(res.data));
console.log('JSON dump:', JSON.stringify(res.data, null, 2));
console.log('tiles keys:', Object.keys(res.data.tiles));
```

Expected: top-level keys are `['copyright', 'imageDate', 'location',
'links', 'tiles', 'disabled', 'SA', 'nM', 'BK', 'takeDownUrl', 'time']`.
Cmd-F for `gpms-cs-s` in the JSON dump returns nothing.

### Recipe 2: SingleImageSearch direct call

This is the request that actually returns the URL we need. Pulled from
DevTools while pegman was hovered on a UGC dot.

**Request:**

```bash
curl 'https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch' \
  -H 'content-type: application/json+protobuf' \
  -H 'origin: https://ridewithgps.com' \
  -H 'referer: https://ridewithgps.com/' \
  -H 'x-user-agent: grpc-web-javascript/0.1' \
  --data-raw '[
    ["apiv3",null,null,null,"US",null,null,null,null,null,[[0]]],
    [[null,null,47.6570527815485,-122.4157031952075],70],
    [null,["en","US"],null,null,null,null,null,null,[2],null,
      [[[2,1,2],[3,1,2],[10,1,2]]]],
    [[1,2,3,4,8,6,17],null,null,null,null,null,null,null,null,null,
      [null,null,[[[75,96]]]]]
  ]'
```

**Notable header omissions:** `x-browser-validation`, `x-client-data`,
`x-browser-channel` etc. that appear in the live curl are Chrome internals
and are NOT enforced. The endpoint accepts the request without them.

**Request payload structure** (positional protobuf-as-JSON):

| Position | Field | Notes |
|---|---|---|
| `[0]` | client identifier | `["apiv3", ...]` — third-party Maps JS tier |
| `[1]` | search location + radius | `[[null, null, lat, lng], radius_meters]` |
| `[2][10]` | type filter | `[[[2,1,2],[3,1,2],[10,1,2]]]` includes type 10 — drop the `[10,1,2]` triple to exclude UGC |
| `[3]` | response field selection + thumbnail size | `[fields, ..., [null,null,[[[width,height]]]]]` |

**Response (excerpt):** the full response is positional and ~30 fields
deep in places. The relevant URL slot:

```js
[[
  "https://lh3.googleusercontent.com/gpms-cs-s/<token>=w150-h75-k-no",
  [75, 150],   // size
  null,
  2
]]
```

That entry is at a deeply-nested positional index near the end of the
response (~7 levels down). Find it by string-searching for `gpms-cs-s` in
the parsed response.

Other useful fields in the response:
- Top-level `[1][1][1]` → panoid (e.g. `[10, "CIHM0ogKEICAgIDavZLc7AE"]`)
- Top-level `[1][2][2]` → world size `[height, width]` at zoom=4
- Top-level `[1][2][3]` → image pyramid `[[[h0,w0]], [[h1,w1]], ...]`
- Top-level `[1][5][0]` → copyright + attribution
- Top-level `[1][6][...]` → location + neighbors

### Recipe 3: URL substitution test

Verify `pi/ya/ro/fo` substitution still works for any fresh token. From
the response above, take the URL and substitute:

```bash
TOKEN='<the_long_opaque_token_from_response>'
curl -s -o /tmp/a.jpg "https://lh3.googleusercontent.com/gpms-cs-s/$TOKEN=w400-h250-k-no-pi0-ya0-ro0-fo90"
curl -s -o /tmp/b.jpg "https://lh3.googleusercontent.com/gpms-cs-s/$TOKEN=w400-h250-k-no-pi0-ya180-ro0-fo90"
md5 /tmp/a.jpg /tmp/b.jpg
file /tmp/a.jpg /tmp/b.jpg
```

Expected: distinct MD5s, both 400×250. If MD5s match, the token has
become render-param-bound (would invalidate Option 2/3 below).

### Recipe 4: pegman `MapsPhotoService.ListEntityPhotos` (NOT viable for us)

Documented for completeness — this is what google.com's Maps frontend
uses, and is what we'd hit if we were running on a Google domain. Not
workable from a `ridewithgps.com` content script because:

- Endpoint origin is `https://www.google.com/maps/_/...` (cross-origin)
- Requires `at=` XSRF token scraped from `window.WIZ_global_data` on a
  google.com page (we have no such token)
- Returns batchexecute-format envelope (different parser)

```bash
curl 'https://www.google.com/maps/_/MapsWizUi/data/batchexecute?rpcids=hspqX&...&at=ABY2F5OYs2OrCo1csTG6QI0PJ73v%3A1778122161791' \
  -H 'origin: https://www.google.com' \
  -H 'referer: https://www.google.com/' \
  --data-raw 'f.req=%5B%5B%5B%22%2FMapsPhotoService.ListEntityPhotos%22%2C...%5D%5D%5D&at=...'
```

Response includes both regular phone photos (4032×3024, aspect 4:3,
category `"Photo"`) and photospheres (5376×2688, aspect 2:1, category
`"Street View"`). The Maps JS `SingleImageSearch` path (recipe 2) returns
the same photosphere URLs without the XSRF complication, so this endpoint
isn't useful to us.

### Recipe 5: multi-source comparison probe (diagnose a no-coverage spot)

The most-useful day-to-day diagnostic. When the extension shows "no
coverage" on a stretch where you'd expect imagery, paste this on a
RWGPS route page (or any page with Maps JS loaded), substitute the
lat/lng, and see what each source filter returns:

```js
const lib = await google.maps.importLibrary('streetView');
const svc = new lib.StreetViewService();
const loc = { lat: <LAT>, lng: <LNG> };

const probe = async (source) => {
  try {
    const r = await svc.getPanorama({ location: loc, radius: 50, source });
    return {
      type: r.data.location.pano.startsWith('CAoS') ? 10 : 2,
      pano: r.data.location.pano,
      latLng: r.data.location.latLng,
      data: r.data
    };
  } catch (e) {
    return { error: e.code || e.message };
  }
};

console.log({
  loc,
  GOOGLE: await probe(lib.StreetViewSource.GOOGLE),
  DEFAULT: await probe(lib.StreetViewSource.DEFAULT),
  OUTDOOR: await probe(lib.StreetViewSource.OUTDOOR)
});
```

Right-click the logged object → "Copy object" to capture for sharing.

Decoding the result:

- **All three return `ZERO_RESULTS`** → real coverage gap. Not a
  regression we caused.
- **`GOOGLE: type 2`, others same** → SV-car coverage in range. Working
  as intended; no UGC involvement.
- **`GOOGLE: ZERO_RESULTS`, `DEFAULT: type 10`** → UGC-only spot. The
  bike-path regression case. Compare distance in `latLng` to the route
  point — if it's close (<10 m), this is a clear regression.
- **`GOOGLE: type 2 at X m`, `DEFAULT: type 10 at Y m << X`** → type-2
  exists but UGC is much closer. Sequim geometry. At extension defaults
  (radius 10), behaves like the previous case.
- **`OUTDOOR` matches `GOOGLE`** with type-2 result → confirms the
  type-2-preferred ranking; UGC was in the candidate set but lost.
- **`OUTDOOR` matches `DEFAULT`** with type-10 result → no type-2 in
  range; OUTDOOR fell through to UGC (Discovery Park geometry).

## Strategic finding: type-2 vs type-10 distribution depends on terrain

In **dense urban areas**, type-2 (Google SV-car) and type-10 (UGC)
panoramas tend to coexist within meters. The Ballard `Sunset Tavern`
indoor case had several outdoor type-2 panos within ~10 m on the same
street; switching `source` from `GOOGLE` to `OUTDOOR` would route to
those, fixing the indoor problem without losing coverage.

In **trail / off-pavement areas**, type-2 and type-10 are spatially
separated — type-2 captures stay on the nearest road (often 30–100 m
away from a parallel trail), and type-10 photospheres sit on the trail
itself. At the extension's ~10 m lookup radius, the road type-2 is
out of reach and only the trail type-10 is relevant.

This distribution shape is exactly why Option 1 (`OUTDOOR` switch only)
is sufficient for the bar fix but **not** for the bike-path coverage
regression: the bar's type-2 fallback exists nearby; the trail's
doesn't.

## UGC characteristics worth knowing

- **2:1 equirectangular** at full size (e.g. 5376×2688 at zoom=4).
- **`originPitch` is often non-zero** (phone tilt during capture). Our
  existing tile pipeline assumes `originPitch ≈ 0`; for UGC we'd need to
  pass it into the pitch (`pi`) param of the gpms-cs-s URL to keep the
  horizon level.
- **Heading reference is unreliable.** `originHeading` is the photographer's
  reported direction at upload time; calibration varies by phone and
  photographer technique. Setting `ya = route_heading - originHeading` is
  the cleanest approach but the result may be off by tens of degrees.
- **Quality variance is high** (motion blur, stitching seams, occasional
  ceiling-of-tent uploads tagged as outdoor, etc.).
- **Source tags** in the response: `photos:street_view_publish_api`,
  `photos:street_view_android`, `photos:gmm_android`, etc. Could be used
  to filter to "android Street View app" captures specifically (those are
  generally calibrated better than Publish-API uploads), at the cost of
  dropping coverage.

## Possible directions

### Option 0: status quo (current)

Filter UGC at lookup time via `source: GOOGLE`. Indoor type-2 panos
(Business View) still come through occasionally.

**Trade-off:** simple, no maintenance, occasional bar-interior previews.

### Option 1: switch source to `OUTDOOR` (one-line fix)

Change `source: StreetViewSource.GOOGLE` to `OUTDOOR` in
`content/page-bridge.js`.

**Pros:**
- Cuts off Google indoor type-2 panos (bar fix).
- In dense areas, lets `getPanorama` fall through to nearby outdoor
  type-2 neighbors when the closest hit was indoor.

**Cons:**
- Introduces type-10 (UGC) panos back into `getPanorama` results, which
  will then 4xx on `streetviewpixels-pa`. Without mitigation, this
  shifts the failure mode from "no coverage" to "broken image" on
  bike-path lookups.
- Mitigation: post-filter type-10 panoids by checking for `CAoS` prefix
  in the response, treating them as no-coverage.
- After mitigation, this fixes the bar interior issue but **does not
  recover bike-path coverage** — the regression that motivated the
  whole investigation. Type-10 panos still treated as no-coverage.

**Net effort:** one line + a one-line panoid prefix check. Solves the
bar fix only. Not sufficient for the bike-path regression.

### Option 2: hybrid — render UGC via `SingleImageSearch`

Same as Option 1, but additionally render type-10 panos:

1. `getPanorama` for primary metadata (existing).
2. If returned panoid is type-10, bridge fires a parallel
   `SingleImageSearch` POST to extract the `gpms-cs-s` URL.
3. Bridge sends URL + `originHeading` + `originPitch` to content script.
4. Content script renders a single `<img>` (re-using the static-API
   render path's structure) with `pi`/`ya`/`ro` substituted from the
   route heading.

**Pros:**
- Adds genuine coverage on bike trails / off-pavement.
- Re-uses the existing single-image render path; no tile-grid logic.

**Cons:**
- Two metadata calls per UGC hover (`getPanorama` + `SingleImageSearch`).
- New code path in bridge (positional response parser, `gpms-cs-s` URL
  builder).
- UGC quality variance may produce occasional bad renders (tilted
  horizons, weird crops).

### Option 3: unified — replace `getPanorama` with direct `SingleImageSearch`

Bridge calls `SingleImageSearch` for all lookups (no `getPanorama`).
Parses the positional response directly.

- Type-2 → existing `streetviewpixels-pa` tile pipeline.
- Type-10 → server-cropped `gpms-cs-s` render.

**Pros:**
- Single metadata call regardless of pano type.
- No `google.maps.importLibrary('streetView')` dependency.
- Cleaner long-term.

**Cons:**
- Wider blast radius — the SV-car path also moves off `getPanorama`.
- Brittle to Google response-shape changes (positional encoding, no
  schema, opaque indices). Maps JS shields us from these today.

### UX posture for Options 2/3

If we render UGC, we have a choice:

- **Same treatment as SV-car** — same overlay, same heading compass,
  same border. Simpler. Some UGC will look weird.
- **Differentiate** — small "user photo" badge / different border tint
  / suppressed heading compass. Clearer signal but more UI work.

Default if not decided: same treatment.

## Open questions (for if we revisit)

- **Do `pi/ya` accept floats outside `[-180, 180]` / `[-90, 90]`?**
  Implied yes — the URL-bar example we saw had `ya=265.59`. Worth
  verifying with the substitution recipe before relying on it.
- **`gpms-cs-s` token lifetime.** Tokens look like signed blobs; do they
  have an expiry? Are they cached by URL forever? If they expire, we'd
  need to re-fetch from `SingleImageSearch` periodically.
- **Should `originPitch` correction be passed through to the render?**
  Likely yes for UGC (phone tilt). Verify by toggling `pi=originPitch`
  vs `pi=0` on a known-tilted pano.
- **How well does `ya = route_heading - originHeading` work in practice?**
  UGC `originHeading` calibration is questionable. May need a heuristic
  (e.g. snap to compass quadrant, or just always show the photographer's
  preferred orientation by setting `pi/ya/ro` to the values returned by
  `ListEntityPhotos`).
- **Should we filter UGC by source tag?** `photos:street_view_android`
  captures are often better calibrated than `photos:street_view_publish_api`
  uploads. Filtering trades coverage for quality.
- **Cache strategy for SingleImageSearch.** Today, `streetviewpixels-pa`
  is browser-HTTP-cached by URL. SingleImageSearch is a POST and not
  HTTP-cacheable; we'd want an in-memory cache in the bridge keyed by
  bucketed lat/lng.
