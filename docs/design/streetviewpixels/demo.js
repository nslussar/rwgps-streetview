/**
 * In-page demo of the streetviewpixels-pa pipeline.
 *
 * Paste into DevTools console on a RWGPS route page (extension can be
 * enabled or disabled, doesn't matter — this demo creates its own overlay
 * and doesn't talk to the extension at all).
 *
 * What it does:
 *   - Finds the existing Google Maps `Map` instance.
 *   - Listens for cursor `mousemove` events on the map.
 *   - On move (debounced), calls `StreetViewService.getPanorama` to find
 *     the nearest panorama, then loads N stitched tiles at y=4 starting
 *     at x=0 (i.e., looking in the panorama's originHeading direction).
 *   - Renders the result in a floating panel, alongside live counters for
 *     `getPanorama` calls, tile fetches, errors, and the last latency.
 *
 * Tweakables (top of IIFE): NUM_X_TILES, Y_INDEX, DEBOUNCE_MS, RADIUS_M.
 *
 * Tear down: click "close" in the panel, or run
 *   document.getElementById('svpx-demo')?.remove()
 *   window.__svpxDemoCleanup?.();
 */
(async () => {
  // ── tweakables ───────────────────────────────────────────────────────────
  const NUM_X_TILES = 2;     // stitched tile count horizontally (1=22.5° FOV, 4=90°)
  const Y_INDEX = 4;         // y row to render (4 = just below horizon)
  const DEBOUNCE_MS = 120;   // debounce mousemove → getPanorama
  const RADIUS_M = 50;       // getPanorama search radius
  const TILE_BASE = 'https://streetviewpixels-pa.googleapis.com/v1/tile';

  // ── teardown previous instance ───────────────────────────────────────────
  document.getElementById('svpx-demo')?.remove();
  window.__svpxDemoCleanup?.();

  // ── wait for & resolve StreetViewService (handles both legacy + dynamic SDK loading) ──
  let StreetViewService;
  {
    const t0 = performance.now();
    while (!window.google?.maps) {
      if (performance.now() - t0 > 15000) {
        console.error('[svpx demo] timed out waiting for google.maps to exist', {
          'typeof window.google': typeof window.google,
          'has .gm-style': !!document.querySelector('.gm-style'),
        });
        return;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (typeof google.maps.importLibrary === 'function') {
      // New dynamic-loading pattern: pull in the streetView library.
      try {
        const sv = await google.maps.importLibrary('streetView');
        StreetViewService = sv.StreetViewService;
        console.log('[svpx demo] StreetViewService obtained via importLibrary');
      } catch (e) {
        console.error('[svpx demo] importLibrary("streetView") failed', e);
        return;
      }
    } else if (google.maps.StreetViewService) {
      // Legacy: it's already there.
      StreetViewService = google.maps.StreetViewService;
      console.log('[svpx demo] StreetViewService obtained from legacy global');
    }

    if (!StreetViewService) {
      console.error('[svpx demo] StreetViewService unavailable', {
        'google.maps keys': Object.keys(google.maps).slice(0, 30),
        'has importLibrary': typeof google.maps.importLibrary,
      });
      return;
    }
    console.log('[svpx demo] SDK ready after', Math.round(performance.now() - t0), 'ms');
  }
  // ── find the map instance ────────────────────────────────────────────────
  function findMap() {
    const gmStyle = document.querySelector('.gm-style');
    if (!gmStyle) return null;
    const mapDiv = gmStyle.parentElement;
    if (!mapDiv) return null;
    if (mapDiv.__gm && typeof mapDiv.__gm === 'object') {
      for (const k of Object.keys(mapDiv.__gm)) {
        const v = mapDiv.__gm[k];
        if (v && typeof v.getZoom === 'function' && typeof v.getBounds === 'function') return v;
      }
    }
    for (const k of Object.getOwnPropertyNames(mapDiv)) {
      try {
        const v = mapDiv[k];
        if (v && typeof v === 'object'
            && typeof v.getZoom === 'function'
            && typeof v.getBounds === 'function'
            && typeof v.getDiv === 'function') return v;
      } catch (_) {}
    }
    return null;
  }
  const map = findMap();
  if (!map) {
    console.error('[svpx demo] no Map instance found — open the route in the editor');
    return;
  }
  console.log('[svpx demo] map found, zoom=' + map.getZoom());

  // ── stats ────────────────────────────────────────────────────────────────
  const stats = {
    panoCalls: 0, panoOk: 0, panoErr: 0, panoZeroResults: 0,
    tileLoads: 0, tileErrs: 0,
    lastPanoMs: null, lastErrAt: null, lastErrMsg: null,
  };

  // ── floating panel ───────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'svpx-demo';
  panel.style.cssText = [
    'position:fixed','bottom:16px','right:16px','z-index:2147483647',
    'background:#000','color:#fff','font:12px ui-monospace,monospace',
    'padding:8px','border:2px solid #f0f','border-radius:6px',
    'box-shadow:0 4px 24px rgba(0,0,0,.6)','user-select:text'
  ].join(';');
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <b>svpixels demo</b>
      <button id="svpx-close" style="background:#222;color:#fff;border:1px solid #555;padding:1px 8px;cursor:pointer">close</button>
    </div>
    <div id="svpx-tiles" style="display:flex;gap:0;background:#222;width:${NUM_X_TILES * 256}px;height:256px"></div>
    <pre id="svpx-meta" style="margin:6px 0 0;white-space:pre-wrap;font:11px ui-monospace,monospace;color:#ccc"></pre>
    <pre id="svpx-stats" style="margin:6px 0 0;white-space:pre-wrap;font:11px ui-monospace,monospace;color:#9f9"></pre>
  `;
  document.body.appendChild(panel);
  panel.querySelector('#svpx-close').onclick = () => { window.__svpxDemoCleanup?.(); panel.remove(); };
  const tilesEl = panel.querySelector('#svpx-tiles');
  const metaEl  = panel.querySelector('#svpx-meta');
  const statsEl = panel.querySelector('#svpx-stats');

  function renderStats() {
    statsEl.textContent =
      `getPanorama  calls=${stats.panoCalls}  ok=${stats.panoOk}  err=${stats.panoErr}  zero=${stats.panoZeroResults}\n` +
      `tile fetches loads=${stats.tileLoads}  errs=${stats.tileErrs}\n` +
      `last pano    ${stats.lastPanoMs != null ? stats.lastPanoMs + 'ms' : '—'}\n` +
      (stats.lastErrAt ? `last err     ${new Date(stats.lastErrAt).toLocaleTimeString()} ${stats.lastErrMsg}` : '');
  }
  renderStats();

  // ── streetview lookup + tile render ──────────────────────────────────────
  const svc = new StreetViewService();
  let lookupSeq = 0;
  let lastSnappedKey = null;

  async function update(latLng) {
    const seq = ++lookupSeq;
    const t0 = performance.now();
    stats.panoCalls++;
    renderStats();
    let data;
    try {
      const res = await svc.getPanorama({ location: latLng, radius: RADIUS_M });
      data = res.data;
      stats.panoOk++;
    } catch (e) {
      stats.panoErr++;
      stats.lastErrAt = Date.now();
      stats.lastErrMsg = String(e?.message || e).slice(0, 80);
      if (String(e?.message || e).includes('ZERO_RESULTS')) stats.panoZeroResults++;
      stats.lastPanoMs = Math.round(performance.now() - t0);
      metaEl.textContent = `(no panorama within ${RADIUS_M}m of ${latLng.lat().toFixed(5)}, ${latLng.lng().toFixed(5)})`;
      renderStats();
      return;
    }
    if (seq !== lookupSeq) return; // stale
    stats.lastPanoMs = Math.round(performance.now() - t0);

    const panoid = data.location.pano;
    const snapKey = panoid;
    metaEl.textContent =
      `panoid: ${panoid}\n` +
      `snapped: ${data.location.latLng.lat().toFixed(5)}, ${data.location.latLng.lng().toFixed(5)}\n` +
      `originHeading: ${data.tiles?.originHeading?.toFixed(1)}°  originPitch: ${data.tiles?.originPitch?.toFixed(1)}°\n` +
      `links: ${(data.links || []).map(l => Math.round(l.heading) + '°').join(', ')}`;

    if (snapKey === lastSnappedKey) {
      renderStats();
      return; // no need to re-render same panorama
    }
    lastSnappedKey = snapKey;

    // Build tiles at x=0..NUM_X_TILES-1 (i.e., looking in originHeading direction)
    tilesEl.innerHTML = '';
    for (let i = 0; i < NUM_X_TILES; i++) {
      const url = `${TILE_BASE}?cb_client=maps_sv.tactile&panoid=${encodeURIComponent(panoid)}&x=${i}&y=${Y_INDEX}&zoom=4&nbt=1&fover=2`;
      const img = new Image();
      img.style.cssText = `width:256px;height:256px;display:block;background:#222`;
      img.referrerPolicy = 'no-referrer-when-downgrade';
      img.onload = () => { stats.tileLoads++; renderStats(); };
      img.onerror = () => {
        stats.tileErrs++;
        stats.lastErrAt = Date.now();
        stats.lastErrMsg = `tile ${i} failed`;
        renderStats();
      };
      img.src = url;
      tilesEl.appendChild(img);
    }
    renderStats();
  }

  // ── debounce + mousemove wiring ──────────────────────────────────────────
  let debounceTimer = null;
  let lastLatLng = null;
  function onMouseMove(e) {
    lastLatLng = e.latLng;
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (lastLatLng) update(lastLatLng);
    }, DEBOUNCE_MS);
  }
  const mmListener = map.addListener('mousemove', onMouseMove);

  window.__svpxDemoCleanup = () => {
    google.maps.event.removeListener(mmListener);
    delete window.__svpxDemoCleanup;
  };
  console.log('[svpx demo] ready — hover over the map');
})();
