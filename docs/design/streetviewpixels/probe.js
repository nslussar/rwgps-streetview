/**
 * DevTools verification snippet for the streetviewpixels-pa tile pipeline.
 *
 * Paste into the console on:
 *   1. https://www.google.com/maps  (sanity baseline)
 *   2. https://ridewithgps.com/routes/<id>  (with our extension DISABLED)
 *
 * What it does:
 *   - Tries google.maps.StreetViewService.getPanorama() to resolve a known
 *     lat/lng to a panoid + centerHeading. Falls back to a hardcoded panoid
 *     if the SDK isn't available.
 *   - Renders a row of x=0..15 tiles at y=4, zoom=4 in a floating panel so
 *     we can eyeball coverage, wrap point (i.e. x granularity), and CORS.
 *   - Renders a column of y=0..7 at x=0 so we can see pitch behavior.
 *   - Logs everything to console.
 *
 * Edit TEST_LOC if your current page doesn't have SV coverage near it.
 */
(async () => {
  // Magnuson Park / Sand Point area, Seattle (from the demo route)
  const TEST_LOC = { lat: 47.6817, lng: -122.2548 };
  const FALLBACK_PANOID = '-rtGmfCGx3hrKvBgFXcstQ'; // known good
  const TILE_BASE = 'https://streetviewpixels-pa.googleapis.com/v1/tile';

  let panoid, snappedLat, snappedLng, centerHeading, source;

  if (window.google?.maps?.StreetViewService) {
    try {
      const svc = new google.maps.StreetViewService();
      const { data } = await svc.getPanorama({
        location: TEST_LOC,
        radius: 50,
      });
      panoid = data.location.pano;
      snappedLat = data.location.latLng.lat();
      snappedLng = data.location.latLng.lng();
      centerHeading = data.tiles?.centerHeading;
      source = 'StreetViewService.getPanorama';
      console.log('[SVPixels probe] getPanorama →', {
        panoid,
        snappedLat,
        snappedLng,
        centerHeading,
        copyright: data.copyright,
        links: data.links?.length,
        worldSize: data.tiles?.worldSize,
        tileSize: data.tiles?.tileSize,
        originHeading: data.tiles?.originHeading,
        originPitch: data.tiles?.originPitch,
      });
    } catch (e) {
      console.warn('[SVPixels probe] getPanorama failed', e);
    }
  } else {
    console.warn('[SVPixels probe] google.maps.StreetViewService not available on this page');
  }

  if (!panoid) {
    panoid = FALLBACK_PANOID;
    source = 'FALLBACK_PANOID';
  }

  console.log('[SVPixels probe] using panoid', panoid, 'source=' + source);

  // Build floating panel
  const oldPanel = document.getElementById('svpixels-probe');
  if (oldPanel) oldPanel.remove();
  const panel = document.createElement('div');
  panel.id = 'svpixels-probe';
  panel.style.cssText = [
    'position:fixed', 'top:10px', 'right:10px', 'z-index:2147483647',
    'background:#000', 'color:#fff', 'font:12px ui-monospace,monospace',
    'padding:8px', 'border:2px solid #f0f', 'max-width:96vw', 'max-height:96vh',
    'overflow:auto', 'box-shadow:0 4px 24px rgba(0,0,0,.6)'
  ].join(';');
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:8px">
      <div>
        <div><b>panoid</b>: ${panoid}</div>
        <div><b>source</b>: ${source}</div>
        <div><b>centerHeading</b>: ${centerHeading?.toFixed?.(1) ?? '?'}°</div>
        <div><b>page origin</b>: ${location.origin}</div>
      </div>
      <button id="svpixels-probe-close" style="background:#222;color:#fff;border:1px solid #555;padding:2px 8px;cursor:pointer">close</button>
    </div>
  `;
  panel.querySelector('#svpixels-probe-close').onclick = () => panel.remove();

  // Row sweep: x=0..15 at y=4 (horizon), to see granularity / wrap
  const xRow = document.createElement('div');
  xRow.innerHTML = '<div style="margin:8px 0 4px"><b>x sweep</b> (y=4, zoom=4)</div>';
  const xGrid = document.createElement('div');
  xGrid.style.cssText = 'display:grid;grid-template-columns:repeat(8,140px);gap:4px';
  xRow.appendChild(xGrid);
  panel.appendChild(xRow);

  for (let x = 0; x < 16; x++) {
    const url = `${TILE_BASE}?cb_client=maps_sv.tactile&panoid=${encodeURIComponent(panoid)}&x=${x}&y=4&zoom=4&nbt=1&fover=2`;
    const cell = document.createElement('div');
    cell.style.cssText = 'border:1px solid #333;background:#111';
    const label = document.createElement('div');
    label.style.cssText = 'padding:2px 4px;font-size:11px';
    label.textContent = `x=${x}`;
    cell.appendChild(label);
    const img = new Image();
    img.style.cssText = 'width:140px;height:140px;display:block;background:#222';
    img.referrerPolicy = 'no-referrer-when-downgrade';
    img.src = url;
    img.onload = () => { label.textContent = `x=${x} ✓ ${img.naturalWidth}×${img.naturalHeight}`; };
    img.onerror = () => { label.textContent = `x=${x} ❌`; cell.style.borderColor = 'red'; };
    cell.appendChild(img);
    xGrid.appendChild(cell);
  }

  // Column sweep: y=0..7 at x=0
  const yCol = document.createElement('div');
  yCol.innerHTML = '<div style="margin:12px 0 4px"><b>y sweep</b> (x=0, zoom=4)</div>';
  const yGrid = document.createElement('div');
  yGrid.style.cssText = 'display:grid;grid-template-columns:repeat(8,140px);gap:4px';
  yCol.appendChild(yGrid);
  panel.appendChild(yCol);

  for (let y = 0; y < 8; y++) {
    const url = `${TILE_BASE}?cb_client=maps_sv.tactile&panoid=${encodeURIComponent(panoid)}&x=0&y=${y}&zoom=4&nbt=1&fover=2`;
    const cell = document.createElement('div');
    cell.style.cssText = 'border:1px solid #333;background:#111';
    const label = document.createElement('div');
    label.style.cssText = 'padding:2px 4px;font-size:11px';
    label.textContent = `y=${y}`;
    cell.appendChild(label);
    const img = new Image();
    img.style.cssText = 'width:140px;height:140px;display:block;background:#222';
    img.referrerPolicy = 'no-referrer-when-downgrade';
    img.src = url;
    img.onload = () => { label.textContent = `y=${y} ✓ ${img.naturalWidth}×${img.naturalHeight}`; };
    img.onerror = () => { label.textContent = `y=${y} ❌`; cell.style.borderColor = 'red'; };
    cell.appendChild(img);
    yGrid.appendChild(cell);
  }

  document.body.appendChild(panel);
  console.log('[SVPixels probe] panel mounted; also watch the Network tab for tile responses');
})();
