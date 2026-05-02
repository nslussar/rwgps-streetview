# Overlay position smoothness

## Problem

When the cursor moves over a route on ridewithgps.com, the Street View overlay window updates with visible lag. The RWGPS yellow tracking dot moves smoothly at native frame rate; our overlay updates at most ~6.7 times per second.

Image-fetch latency is intentional (dwell timer, throttling for billing reasons). This design does not change that. It only addresses the *window position* — where the overlay floats on screen.

## Root cause

The overlay's screen position only updates when a data event fires:

1. `handleTrackingPosition` runs at most every 150ms (bridge throttle, `page-bridge.js:64`).
2. `handleManualLatLng` runs after a postMessage round trip, also throttled to 150ms (`content.js:430`).

`onMouseMove` updates `cursorX/cursorY` but never calls `positionOverlay()`. In tracking mode the overlay is anchored to `markerScreenX/Y`, which is computed from the throttled bridge messages, adding further lag.

## Fix

Decouple overlay positioning from data fetching. The overlay window follows the cursor at native frame rate; data fetches stay on their current throttles.

### Changes (all in `content/content.js`)

1. **Frame-rate-batched position update.** Add `schedulePositionOverlay()` — coalesces multiple mousemoves per frame into one `positionOverlay()` call via `requestAnimationFrame`.

2. **Reposition on every mousemove.** Call `schedulePositionOverlay()` from `onMouseMove` whenever the overlay is visible. This is the load-bearing change.

3. **Anchor to cursor in tracking mode.** `positionOverlay()` currently uses `markerScreenX/Y` in tracking mode (lines 714-724). Switch to cursor anchoring (matches manual mode). The cursor is the user's natural reference point and avoids 150ms quantization on the anchor.

4. **Drop `markerScreenX/Y` and `containerPixel`.** No longer needed. Remove from `content.js` and from the bridge's TRACKING_POSITION payload (`page-bridge.js`).

### Unchanged

- 150ms bridge throttle on TRACKING_POSITION
- 150ms manual-mode pixel→latlng throttle
- Dwell timer, bucketing, skip threshold, all data-side
- `MANUAL_SNAP_MAX_PIXELS` snap-distance gate (route-validity check, not positioning)

### Edge cases

- Guard `schedulePositionOverlay()` to no-op when the overlay is hidden.
- Cancel the pending `requestAnimationFrame` in `hideOverlay()` so we do not paint after hide.
- `cachedMapRect` is invalidated on scroll/resize already, so `getMapRect()` inside `positionOverlay()` stays cheap.

## Non-goals

- Lowering the bridge throttle (option C in brainstorm) — separate change.
- Local pixel→latlng to remove the manual-mode round trip (option B) — separate change.
- Predictive snap on the cursor (option D) — only worth doing if A is insufficient.

## Testing

No unit tests — `content.js` is not unit-tested (DOM/`chrome.*`/Google Maps mocks would be required). Manual verification:

1. Load unpacked, open a route in the RWGPS editor with Google Maps.
2. Hover over the route, sweep the cursor along it. Confirm the overlay window glides with the cursor.
3. Confirm the image inside the overlay still updates on its existing throttle (not jittering with the cursor).
4. Confirm tracking → manual mode handoff (zoom in past 13, sweep beyond a waypoint) still works.
5. Confirm the overlay still hides on `mouseleave`, on tracking loss, and after the linger timer.
