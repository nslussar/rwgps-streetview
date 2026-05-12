# Polyline-Distance Filter for Street View Lookups — Design

**Status:** draft — **deferred, lower-priority than originally framed**.
Captures decisions and trade-offs surfaced during the 2026-05-12
UGC-coverage debugging session on Olympic Discovery Trail (Sequim, WA).

**⚠️ Diagnosis update (later in the same 2026-05-12 session):** the framing
below assumes UGC photosphere density vs. radius is the dominant cause of
coverage gaps. **That diagnosis turned out wrong.** Maps JS
`StreetViewService.getPanorama()` has a coord-specific stale-cache bug
that produces `ZERO_RESULTS` even when coverage exists. Bumping the radius
to 50 m papered over the symptom for most gaps; the residual hard
failures we attributed to "geometric coverage gaps" were actually Maps JS
flakiness. Verified by comparing against Static API and direct
`SingleImageSearch` calls at the same coords — both find the panoramas
that `getPanorama` misses.

The actual fix that shipped is **retry + SIS rescue** (see
[`docs/superpowers/specs/2026-05-07-photospheres-ugc-rendering-design.md`
§10](2026-05-07-photospheres-ugc-rendering-design.md)). With that in
place, the no-coverage rate dropped to 0% on the test routes.

**What this doc remains useful for:** the *parallel-road-bleed* case
(spec §2.1 — a wider radius pulls in a pano on a nearby road rather than
the trail the user is hovering). That case is real but rare; a polyline
filter could still address it. Treat the rest of this doc as the design
that would apply *if and when* parallel-road bleed becomes a priority,
not as the next thing to build.

**Date:** 2026-05-12

**Background:** [`docs/superpowers/specs/2026-05-07-photospheres-ugc-rendering-design.md`](2026-05-07-photospheres-ugc-rendering-design.md) (the UGC work that surfaced both issues — gap and bleed — though only the bleed remains relevant for this filter).

## 1. Motivation

The default Street View lookup radius is 10 m (`content.js:22`). On the
Olympic Discovery Trail, where UGC photospheres are spaced 10–30 m apart,
this produces frequent `ZERO_RESULTS`: bucketed cursor positions land just
outside 10 m of the nearest photosphere. Empirical sweep (see § 2.1) showed
two of every seven queries succeeding, with the successful `qDist` values
right at the 10 m ceiling (8.8 m, 9.3 m).

Bumping radius to 50 m almost eliminated the gaps but introduced a different
failure mode: occasional **parallel-road bleed**. The Olympic Discovery
Trail runs within 30–45 m of W Sequim Bay Rd / US-101 in places, and the
same photographer (Curt Sumner) has uploaded photospheres from both. At
r=50 m, when no on-trail photosphere is within 10–15 m of the query but a
parallel-road photosphere is within 50 m, `getPanorama` returns the
parallel-road pano. Result: hover label correctly says "Olympic Discovery
Trail" (from the geocoder) but the image is of W Sequim Bay Rd.

The fundamental issue: `getPanorama`'s `radius` is a one-dimensional
filter — distance from query point — but the user's intent is
two-dimensional: "find imagery on the polyline I drew, not just imagery
near my cursor."

### 2.1 Empirical data

Sweep of ~7 consecutive route points along the trail (req 9–15, 2026-05-12):

| req | bucketed query | r=10m result | qDist |
|-----|----------------|--------------|-------|
| 9 | 48.055766,-123.048244 | UGC pano | 8.8 m |
| 10 | 48.055315,-123.047572 | UGC pano | 9.3 m |
| 11 | 48.054955,-123.046980 | ZERO_RESULTS | — |
| 12 | 48.054595,-123.046523 | ZERO_RESULTS | — |
| 13 | 48.054414,-123.045688 | ZERO_RESULTS | — |
| 14 | 48.054234,-123.044854 | ZERO_RESULTS | — |
| 15 | 48.054054,-123.044019 | ZERO_RESULTS | — |

At r=50 m the same sweep gets near-100% hit rate but ~5–15% wrong-pano
rate (eyeballed, not measured) on stretches where the trail parallels a
road within 30–50 m.

## 2. Decision log

### 2.1 Filter signal: distance from snapped pano to route polyline

**Decision:** after `getPanorama` returns, compute the perpendicular
distance from the snapped pano's lat/lng to the **user's route polyline**.
If greater than a threshold, treat as no-coverage.

**Why this beats alternative signals:**

- **`qDist` threshold (distance from query to snapped pano).** Doesn't
  work: when the off-route pano IS the closest pano to the query, qDist
  is small. The filter wouldn't distinguish "closest pano on the route"
  from "closest pano on a parallel road." Equivalent in practice to just
  picking a smaller radius.
- **`originHeading` vs route bearing.** Could in principle reject panos
  whose capture direction doesn't align with the route. Trails and the
  roads parallel to them have similar bearings, so this signal is
  near-zero in exactly the case where we need it.
- **Place ID match against polyline segments.** Would require querying
  the Places API for each pano + a Place ID for the route polyline.
  Costly and not a primitive RWGPS exposes.

Polyline distance is the only locally-available signal that distinguishes
"on the route I drew" from "near my cursor."

### 2.2 Tunable threshold via popup

**Decision:** threshold (default ~20 m) is a popup-configurable knob
alongside the existing search-radius knob, not a hardcoded constant.

The threshold is in tension with route polyline **drift** — see § 2.3. A
single hardcoded value can't serve both clean modern routes (drift < 5 m,
tight threshold preferable) and older imported routes (drift up to 20 m,
loose threshold required). User-tunable lets each user dial it for their
typical route quality.

### 2.3 Drift trade-off (open issue, not solved)

Some older or low-resolution RWGPS routes have polylines drifting up to
~20 m from the actual road or trail surface they should follow. This
affects both ends of the radius/filter trade-off:

- **At r=10 m without filter:** drift moves the query off the trail →
  `getPanorama` fails with ZERO_RESULTS even though coverage exists.
- **At r=50 m with polyline filter:** drift moves the polyline away from
  the actual trail where coverage exists → an on-trail pano can fail the
  polyline-distance check even though it IS on the same trail.

The fundamental geometric ambiguity has no fix from this signal alone:

- If route drifts in direction X by 15 m, AND a parallel road is in the
  same direction X within 25 m of the polyline, AND the threshold is
  25 m, then a parallel-road pano passes the filter (false accept).
- If route drifts perpendicular to the trail by 20 m, AND threshold is
  15 m, then an on-trail pano fails the filter (false reject).

Mitigations layered:

- Tunable threshold (per § 2.2).
- Diagnostic `polyDist` logging in both success and reject paths so users
  can pick a threshold empirically.
- Wider default than feels comfortable (~20 m vs the gut-feel 10–15 m)
  because user complaints in v1 were predominantly "no coverage," not
  "wrong pano."

Accept the residual cases as known edge effects.

### 2.4 Bump default radius from 10 m to 50 m

**Decision:** raise `DEFAULT_RADIUS` in `content.js:22` from 10 to 50.

Without the radius bump, the polyline-distance filter has nothing to
filter — coverage gaps would still dominate. The two changes ship
together as a single conceptual unit: "ask Google more permissively,
then filter for on-route relevance ourselves."

### 2.5 Reject mode: same UX as ZERO_RESULTS

**Decision:** when a returned pano fails the polyline-distance check, show
the existing "No Street View coverage here" message — same as if
`getPanorama` had returned ZERO_RESULTS.

Alternatives considered:

- **Hide the overlay entirely.** Loses information ("did the cursor leave
  the route, or is there no coverage?"). Reject.
- **New distinct error class** ("Coverage available but off-route").
  Honest but adds UI complexity for a transient edge case. Defer to a
  future iteration if reports come in.

## 3. Architecture

The polyline is already accessible to `content/content.js` — manual mode
uses `RwgpsGeo.nearestPointOnPolyline` against the route points captured
from RWGPS's Google Maps polyline objects (or fetched from the
`/routes/{id}.json` fallback when the polylines aren't yet created).

Flow with the filter:

```
content.js (ISOLATED)                    page-bridge.js (MAIN)
  │                                          │
  ├─ LOOKUP_PANO {lat, lng, r=50} ──────►  getPanorama({source: OUTDOOR, radius: 50})
  │                                          │
  ◄── PANO_INFO {snappedLat, snappedLng, ...}┘
  │
  ├─ polyDist = nearestPointOnPolyline(
  │              {snappedLat, snappedLng}, routePoints).distance
  │
  ├─ polyDist > threshold? ──► showPanoError({noCoverage: true})
  │                              (+log "off-route reject: polyDist=Xm")
  │
  └─ polyDist ≤ threshold ──► existing render path (renderTilePanorama / renderUgcPanorama)
```

The filter runs unconditionally for both UGC (type-10) and tile (type-2)
results. Both can suffer parallel-road bleed at large radii — UGC because
trail photographers also ride roads, tile because SV-cars cover roads
near trails.

## 4. Component changes

### 4.1 `content/content.js`

Add a module-scope tunable (loaded from `chrome.storage.sync`, same
pattern as `radius` / `bucketMeters`):

```js
const DEFAULT_POLYLINE_DISTANCE_THRESHOLD_M = 20;
let polylineDistanceThresholdM = DEFAULT_POLYLINE_DISTANCE_THRESHOLD_M;
```

In `handlePanoInfo` (the router from the photospheres spec), before
dispatching to `renderUgcPanorama` / `renderTilePanorama`, run the filter:

```js
function handlePanoInfo(data, requestId) {
  if (requestId !== panoLookupCounter) return;
  if (data.error) return showPanoError(data);

  // Polyline-distance filter — reject panos whose snapped location is
  // too far from the user's drawn route. Filters out parallel-road
  // bleed at high getPanorama radii. See
  // docs/superpowers/specs/2026-05-12-streetview-polyline-distance-filter-design.md
  if (routePoints && routePoints.length > 1 && data.snappedLat != null) {
    const np = RwgpsGeo.nearestPointOnPolyline(
      { lat: data.snappedLat, lng: data.snappedLng }, routePoints);
    const polyDist = np.distance;
    if (polyDist > polylineDistanceThresholdM) {
      console.log('[RWGPS Street View] off-route reject',
        'polyDist=' + polyDist.toFixed(1) + 'm',
        'threshold=' + polylineDistanceThresholdM + 'm',
        'panoid=' + data.panoid);
      return showPanoError({
        noCoverage: true,
        error: 'pano off-route (polyDist=' + polyDist.toFixed(1) + 'm)',
        errorClass: 'OFF_ROUTE'
      });
    }
  }

  if (data.kind === 'ugc') return renderUgcPanorama(data, requestId);
  return renderTilePanorama(data, requestId);
}
```

Bump default radius:

```js
const DEFAULT_RADIUS = 50;  // was 10
```

Also: store the computed `polyDist` for inclusion in the success log lines
so post-hoc tuning is visible.

### 4.2 `popup/popup.{html,js}`

Add a numeric input alongside the existing search-radius knob:

- Label: "Route-match tolerance (m)"
- Help text: "Reject panoramas farther than this from your route line.
  Higher = more permissive but more chance of seeing a nearby road.
  Lower = stricter but older routes with GPS drift may show no coverage."
- Default: 20
- Range: 5–60

Persist to `chrome.storage.sync` under key `polylineDistanceThresholdM`.

### 4.3 `lib/geo.js`

No changes — `nearestPointOnPolyline` already returns `.distance`.

### 4.4 `content/page-bridge.js`

No changes for the filter itself. The bridge already returns
`snappedLat`/`snappedLng` for both UGC and tile panos.

## 5. Testing

### 5.1 Unit tests

Filter logic lives in `handlePanoInfo` (DOM-coupled, not unit-testable
without a Chrome mock). No new tests in `test/`.

`nearestPointOnPolyline` already has coverage in `test/geo.test.js`.

### 5.2 Manual scenarios

- **On-trail success.** Hover a route on the Olympic Discovery Trail
  between two known UGC photospheres. Expect: pano renders, polyDist
  small (single-digit meters).
- **Parallel-road bleed rejected.** Hover the trail where it runs parallel
  to W Sequim Bay Rd within ~50 m. Expect: "No Street View coverage here"
  + console "off-route reject" log when the snapped pano lands on the
  road. Without the filter (revert to old behavior) the road pano would
  render.
- **Drift on an older route.** Pick a route known to have drift. Hover.
  Expect: most points succeed at default threshold; if many false rejects,
  user bumps threshold via popup.
- **Edge of route.** Hover near the start or end of the polyline. Expect:
  same behavior as middle — `nearestPointOnPolyline` handles endpoints.

### 5.3 Diagnostic logging

Keep `polyDist` in both success and reject log lines for at least one
release post-launch so users can self-tune. Also useful for the project
maintainer to spot-check whether the default threshold is set correctly
from real-use data.

## 6. Future improvements (deferred)

### 6.1 Snapped-foot-to-query distance check

Add a second axis: project the snapped pano onto the polyline, then
require the foot to be near the query point along the polyline. Catches
the case where a pano is "on my polyline but way down the trail" — useful
if real-use shows the simple perpendicular distance lets through far-along
panos.

### 6.2 Drift-aware threshold

Estimate per-route drift from polyline density / source metadata. Apply
a per-route adjusted threshold. Complex; only worth it if popup tuning
proves insufficient.

### 6.3 Confidence indicator in UI

When polyDist is between (threshold − 5) and threshold, show the pano but
with a subtle UI signal ("nearby coverage, possibly off-route"). Lets the
user make the call. Adds visual complexity; defer.

### 6.4 Per-route override

Some users may want a stricter threshold on clean modern routes and a
looser one on older trips. Per-route override storage. Defer until
volume of complaints warrants.

## 7. Open questions for the next pickup

- **Default threshold value.** The 20 m default is a guess based on a few
  hours of debugging. Real-use telemetry (or the project maintainer's own
  experience across the route library) should refine it.
- **Whether to keep the diagnostic console logging permanent or gate it
  behind a debug flag.** Decisions made by then.
- **Whether the filter belongs in the bridge instead of content.js.** The
  filter needs the route polyline; the bridge doesn't currently carry it.
  Moving the polyline into the bridge has architectural cost (the bridge
  is currently stateless about RWGPS routes — RWGPS internals stay in
  ISOLATED-world content.js). Default: keep filter in content.js. Revisit
  only if there's a reason to.

## 8. References

- [`docs/superpowers/specs/2026-05-07-photospheres-ugc-rendering-design.md`](2026-05-07-photospheres-ugc-rendering-design.md) — UGC work that surfaced this issue.
- [`CLAUDE.md`](../../../CLAUDE.md) — request-cost levers (bucketMeters, skipThresholdMeters, dwellMs) and zoom-aware auto-scale, which interact with this filter.
- Working-copy debug logging (uncommitted as of 2026-05-12, change
  `tsqxkunn fbe75d0b`): `lookup-pano req=...` and `qDist=...m` log lines
  in `content.js`, reverse-geocode dump and query coords in
  `page-bridge.js`. Should be revisited and either gated or removed when
  the filter ships.
