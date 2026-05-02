# Overlay Position Smoothness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Street View overlay window track the cursor at native frame rate by decoupling overlay positioning from the throttled bridge data flow.

**Architecture:** Add a `requestAnimationFrame`-coalesced position update that runs on every mousemove. Drop the marker-pixel anchor in tracking mode and always anchor the overlay to the cursor (matches manual mode). Image, heading, geocode, and snap-distance logic stay on their existing throttles, untouched.

**Tech Stack:** Plain JavaScript, Chrome extension (Manifest V3), no build tools, no test framework for `content/`.

**Testing note:** Per `CLAUDE.md`, `content/content.js` and `content/page-bridge.js` are not unit-tested — they need DOM/`chrome.*`/Google Maps mocks. Verification is manual (load unpacked, browser console, ridewithgps.com route editor). Each task ends with `node --check` as a syntax gate and a manual verification step where applicable.

**Spec:** `docs/superpowers/specs/2026-05-02-overlay-position-smoothness-design.md`

---

## File Structure

**Modify:**
- `content/content.js` — add scheduler, call from mousemove, switch tracking-mode anchor to cursor, drop `markerScreenX/Y` plumbing.
- `content/page-bridge.js` — drop now-unused `containerPixel` field and `markerContainerPixel()` helper.

No new files. No interface boundary changes between scripts (the bridge will simply stop including a field the content script no longer reads).

---

### Task 1: Add `requestAnimationFrame`-batched position scheduler

**Files:**
- Modify: `content/content.js` (declarations near line 75; new function near `positionOverlay`)

- [ ] **Step 1: Add scheduler state next to other overlay state**

In `content/content.js`, find the block ending around line 78 (`let lingerTimer = null;`). Add two lines after it:

```javascript
  let lingerTimer = null; // delays overlay hide so user can click it
  let positionScheduled = false;
  let positionRafId = null;
```

- [ ] **Step 2: Add `schedulePositionOverlay()` function**

Insert a new function immediately above the existing `function positionOverlay()` (currently around line 701):

```javascript
  // Coalesce mousemove-driven repositions to one paint per frame.
  // The data path (image, heading, geocode) stays on its 150ms throttle;
  // only the overlay window position runs at native frame rate.
  function schedulePositionOverlay() {
    if (positionScheduled) return;
    if (!overlayEl || overlayEl.style.display === 'none') return;
    positionScheduled = true;
    positionRafId = requestAnimationFrame(function () {
      positionScheduled = false;
      positionRafId = null;
      positionOverlay();
    });
  }
```

- [ ] **Step 3: Syntax check**

Run: `node --check /Users/nslu/code/ridewithgps-streetview/content/content.js`
Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add content/content.js
git commit -m "Add rAF (requestAnimationFrame)-batched overlay position scheduler"
```

---

### Task 2: Reposition overlay on every mousemove

**Files:**
- Modify: `content/content.js` (`onMouseMove`, around line 399)

- [ ] **Step 1: Call scheduler after cursor coordinates are updated**

Find `onMouseMove` in `content/content.js`. Currently it begins:

```javascript
  function onMouseMove(event) {
    if (!enabled || !apiKey) return;

    var prevX = cursorX;
    var prevY = cursorY;
    cursorX = event.clientX;
    cursorY = event.clientY;
```

Add one line after `cursorY = event.clientY;`:

```javascript
  function onMouseMove(event) {
    if (!enabled || !apiKey) return;

    var prevX = cursorX;
    var prevY = cursorY;
    cursorX = event.clientX;
    cursorY = event.clientY;
    schedulePositionOverlay();
```

The scheduler self-guards against running when the overlay is hidden, so no extra check is needed here.

- [ ] **Step 2: Syntax check**

Run: `node --check /Users/nslu/code/ridewithgps-streetview/content/content.js`
Expected: no output.

- [ ] **Step 3: Manual verification (intermediate state)**

Reload the extension in `chrome://extensions`, open a route in the RWGPS editor with Google Maps. Hover the route. The overlay window should now glide with the cursor at native rate **in manual mode** (zoom ≥ 13 over a sparse region). In tracking mode it will still feel chunky because the anchor is still `markerScreenX/Y` — Task 3 fixes that.

- [ ] **Step 4: Commit**

```bash
git add content/content.js
git commit -m "Reposition overlay on every mousemove via rAF (requestAnimationFrame)"
```

---

### Task 3: Anchor overlay to cursor in tracking mode

**Files:**
- Modify: `content/content.js` (`positionOverlay`, around lines 701-738; `handleTrackingPosition`, around lines 465-469; `hideOverlay`, around lines 744-758; module-level declarations around line 75)

- [ ] **Step 1: Simplify `positionOverlay()` to always use the cursor anchor**

Find the current `positionOverlay()`:

```javascript
  function positionOverlay() {
    var ow = 404; // 400 + 2*2 border
    var oh = 254;
    var gap = 20;

    var vw = window.innerWidth;
    var vh = window.innerHeight;

    // In tracking mode, anchor to marker position on the map;
    // in manual mode, anchor to cursor position.
    var anchorX = cursorX;
    var anchorY = cursorY;

    if (trackingActive && markerScreenX !== null && markerScreenY !== null) {
      if (markerScreenX >= 0 && markerScreenX <= vw &&
          markerScreenY >= 0 && markerScreenY <= vh) {
        anchorX = markerScreenX;
        anchorY = markerScreenY;
      } else {
        // Marker is off-screen — center the overlay
        anchorX = vw / 2;
        anchorY = vh / 2 + oh / 2 + gap;
      }
    }

    var left = anchorX + gap;
    var top = anchorY - oh - gap;

    if (left + ow > vw) {
      left = anchorX - ow - gap;
    }
    if (top < 0) {
      top = anchorY + gap;
    }

    overlayEl.style.left = left + 'px';
    overlayEl.style.top = top + 'px';
  }
```

Replace with:

```javascript
  function positionOverlay() {
    var ow = 404; // 400 + 2*2 border
    var oh = 254;
    var gap = 20;

    var vw = window.innerWidth;
    var vh = window.innerHeight;

    var anchorX = cursorX;
    var anchorY = cursorY;

    var left = anchorX + gap;
    var top = anchorY - oh - gap;

    if (left + ow > vw) {
      left = anchorX - ow - gap;
    }
    if (top < 0) {
      top = anchorY + gap;
    }

    overlayEl.style.left = left + 'px';
    overlayEl.style.top = top + 'px';
  }
```

- [ ] **Step 2: Drop `markerScreenX/Y` writes in `handleTrackingPosition`**

Find this block in `handleTrackingPosition` (around lines 465-469):

```javascript
    if (data.containerPixel && mapContainer) {
      var rect = getMapRect();
      markerScreenX = rect.left + data.containerPixel.x;
      markerScreenY = rect.top + data.containerPixel.y;
    }
```

Delete the entire block. The content script no longer reads `containerPixel`.

- [ ] **Step 3: Drop `markerScreenX/Y` declarations**

Find these declarations near line 75:

```javascript
  let markerScreenX = null;
  let markerScreenY = null;
```

Delete both lines.

- [ ] **Step 4: Drop `markerScreenX/Y` resets in `hideOverlay`**

Find `hideOverlay` (around line 744). Locate these two lines inside it:

```javascript
    markerScreenX = null;
    markerScreenY = null;
```

Delete both lines.

- [ ] **Step 5: Cancel pending `requestAnimationFrame` in `hideOverlay`**

Still in `hideOverlay`, after the existing `cancelLingerTimer();` call, add:

```javascript
    if (positionRafId !== null) {
      cancelAnimationFrame(positionRafId);
      positionRafId = null;
      positionScheduled = false;
    }
```

- [ ] **Step 6: Syntax check**

Run: `node --check /Users/nslu/code/ridewithgps-streetview/content/content.js`
Expected: no output.

- [ ] **Step 7: Confirm no remaining references**

Run: `grep -n "markerScreen" /Users/nslu/code/ridewithgps-streetview/content/content.js`
Expected: no matches.

- [ ] **Step 8: Manual verification**

Reload extension. Open a route, hover. Tracking mode (low zoom) and manual mode (zoom ≥ 13) should both have the overlay window gliding with the cursor at native rate. The image inside still updates on its existing dwell-throttled cadence — that is correct, not a regression.

Confirm:
1. Overlay window follows cursor smoothly in both modes.
2. Image inside overlay still updates on dwell cadence (not jittering with cursor).
3. Tracking → manual handoff still works (zoom past 13, sweep beyond a waypoint).
4. Overlay still hides on `mouseleave`, on tracking loss, and after the linger timer.
5. Click on overlay still opens Google Maps Street View in a new tab.

- [ ] **Step 9: Commit**

```bash
git add content/content.js
git commit -m "Anchor overlay to cursor in tracking mode for smooth positioning"
```

---

### Task 4: Drop unused `containerPixel` plumbing in the bridge

**Files:**
- Modify: `content/page-bridge.js` (`throttledTrackingUpdate`, `markerContainerPixel`)

This task is cleanup — no behavior change. The content script in Task 3 stopped reading `containerPixel`, so the bridge can stop sending it.

- [ ] **Step 1: Remove `containerPixel` from `throttledTrackingUpdate`**

In `content/page-bridge.js`, find `throttledTrackingUpdate` (around line 56). Currently:

```javascript
  function throttledTrackingUpdate(latlng) {
    var lat = typeof latlng.lat === 'function' ? latlng.lat() : latlng.lat;
    var lng = typeof latlng.lng === 'function' ? latlng.lng() : latlng.lng;
    var data = { lat: lat, lng: lng };
    var px = markerContainerPixel(lat, lng);
    if (px) data.containerPixel = px;

    var now = Date.now();
```

Replace the body up to `var now = Date.now();` with:

```javascript
  function throttledTrackingUpdate(latlng) {
    var lat = typeof latlng.lat === 'function' ? latlng.lat() : latlng.lat;
    var lng = typeof latlng.lng === 'function' ? latlng.lng() : latlng.lng;
    var data = { lat: lat, lng: lng };

    var now = Date.now();
```

- [ ] **Step 2: Remove the `markerContainerPixel()` helper**

Find this function (around lines 46-54):

```javascript
  function markerContainerPixel(lat, lng) {
    if (!overlayProjection) return null;
    try {
      var latlng = new google.maps.LatLng(lat, lng);
      var px = overlayProjection.fromLatLngToContainerPixel(latlng);
      if (px) return { x: px.x, y: px.y };
    } catch (e) { /* ignore */ }
    return null;
  }
```

Delete the entire function.

Note: `overlayProjection` is still used elsewhere (it's set by `setupProjectionHelper` and might still be useful for `pixelToLatLng`). Leave that alone.

- [ ] **Step 3: Confirm `markerContainerPixel` is fully gone**

Run: `grep -n "markerContainerPixel\|containerPixel" /Users/nslu/code/ridewithgps-streetview/content/page-bridge.js /Users/nslu/code/ridewithgps-streetview/content/content.js`
Expected: no matches.

- [ ] **Step 4: Syntax check**

Run: `node --check /Users/nslu/code/ridewithgps-streetview/content/page-bridge.js`
Expected: no output.

- [ ] **Step 5: Manual verification**

Reload extension. Repeat the Task 3 manual checks (cursor-tracked overlay in both modes, image throttle preserved, hide/click behavior intact). No behavior change is expected — this is a payload-shrink cleanup.

- [ ] **Step 6: Commit**

```bash
git add content/page-bridge.js
git commit -m "Drop unused containerPixel from TRACKING_POSITION payload"
```

---

## Self-review notes

- Spec coverage: scheduler (Task 1), mousemove call (Task 2), cursor anchor in tracking mode (Task 3), bridge cleanup (Task 4). All four spec changes covered.
- Placeholder scan: no TBDs, no "add appropriate X", every code step shows the actual code.
- Type/name consistency: `positionScheduled`, `positionRafId`, `schedulePositionOverlay`, `cancelAnimationFrame` used consistently across tasks.
- Edge cases from the spec: scheduler no-ops when overlay hidden (Task 1, Step 2); pending `requestAnimationFrame` cancelled in `hideOverlay` (Task 3, Step 5); `cachedMapRect` left untouched (it is no longer read by `positionOverlay`, but is still used by `attachMouseListeners` and `handleTrackingPosition` — leaving it alone is correct).
