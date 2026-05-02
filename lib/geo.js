/**
 * Geometry utilities for nearest-point-on-polyline and bearing calculation.
 * Loaded before content.js via manifest js array ordering.
 */

const RwgpsGeo = (() => {
  const DEG2RAD = Math.PI / 180;
  const RAD2DEG = 180 / Math.PI;
  const METERS_PER_DEGREE = 111000; // approx meters per degree of latitude
  const MERCATOR_METERS_PER_PX_Z0 = 156543; // meters/pixel at zoom 0, equator (Earth circumference / 256)

  /**
   * Find the closest point on a polyline to a given cursor position.
   * Uses equirectangular approximation (accurate enough for short distances).
   *
   * @param {{lat: number, lng: number}} cursor
   * @param {{lat: number, lng: number}[]} coords - polyline vertices
   * @returns {{lat: number, lng: number, segmentIndex: number, distanceDeg: number} | null}
   */
  function nearestPointOnPolyline(cursor, coords) {
    if (!coords || coords.length < 2) return null;

    let bestDist = Infinity;
    let bestPoint = null;
    let bestSegment = 0;

    // Scale longitude by cos(latitude) for equirectangular projection
    const cosLat = Math.cos(cursor.lat * DEG2RAD);

    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i];
      const b = coords[i + 1];

      // Project cursor onto segment a->b in scaled coordinates
      const ax = (a.lng - cursor.lng) * cosLat;
      const ay = a.lat - cursor.lat;
      const bx = (b.lng - cursor.lng) * cosLat;
      const by = b.lat - cursor.lat;

      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;

      let t;
      if (lenSq === 0) {
        t = 0;
      } else {
        t = -(ax * dx + ay * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
      }

      const px = ax + t * dx;
      const py = ay + t * dy;
      const dist = px * px + py * py;

      if (dist < bestDist) {
        bestDist = dist;
        bestSegment = i;
        // Convert back to lat/lng
        bestPoint = {
          lat: cursor.lat + (ay + t * dy),
          lng: cursor.lng + (ax + t * dx) / cosLat
        };
      }
    }

    return {
      lat: bestPoint.lat,
      lng: bestPoint.lng,
      segmentIndex: bestSegment,
      distanceDeg: Math.sqrt(bestDist)
    };
  }

  /**
   * Compute initial compass bearing from point A to point B.
   * @returns {number} bearing in degrees [0, 360)
   */
  function computeBearing(from, to) {
    const lat1 = from.lat * DEG2RAD;
    const lat2 = to.lat * DEG2RAD;
    const dLng = (to.lng - from.lng) * DEG2RAD;

    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
              Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

    return (Math.atan2(y, x) * RAD2DEG + 360) % 360;
  }

  /**
   * Haversine distance in meters between two points.
   */
  function distanceMeters(a, b) {
    const R = 6371000;
    const dLat = (b.lat - a.lat) * DEG2RAD;
    const dLng = (b.lng - a.lng) * DEG2RAD;
    const sinLat = Math.sin(dLat / 2);
    const sinLng = Math.sin(dLng / 2);
    const h = sinLat * sinLat +
              Math.cos(a.lat * DEG2RAD) * Math.cos(b.lat * DEG2RAD) * sinLng * sinLng;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  /**
   * Convert a bearing in degrees to a 16-point compass direction.
   * @param {number} deg - bearing [0, 360)
   * @returns {string} e.g. 'N', 'NNE', 'SW'
   */
  function bearingToCompass(deg) {
    var dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE',
                'S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
  }

  /**
   * Snap lat/lng to a grid of approximately `meters` size. Grid cells are
   * ~square in meters at any latitude (longitude step scales by cos(lat)).
   * Used to dedupe Street View URLs so identical buckets hit the browser cache.
   * @returns {{lat: number, lng: number}}
   */
  function bucketLatLng(lat, lng, meters) {
    if (!meters || meters <= 0) return { lat: lat, lng: lng };
    const latStep = meters / METERS_PER_DEGREE;
    // Snap lat first, then derive cosLat from the snapped value so every
    // point in the same lat-cell shares one lngStep. Otherwise tiny cosLat
    // drift across raw input lats can flip lng across a bucket boundary.
    const snappedLat = Math.round(lat / latStep) * latStep;
    const cosLat = Math.cos(snappedLat * DEG2RAD);
    const lngStep = latStep / Math.max(cosLat, 1e-6);
    return {
      lat: snappedLat,
      lng: Math.round(lng / lngStep) * lngStep
    };
  }

  /**
   * Round a heading to the nearest `bucketDeg` and normalize to [0, 360).
   */
  function bucketHeading(deg, bucketDeg) {
    if (!bucketDeg || bucketDeg <= 0) return deg;
    const r = Math.round(deg / bucketDeg) * bucketDeg;
    return ((r % 360) + 360) % 360;
  }

  /**
   * Web-Mercator meters per screen pixel at the given latitude and zoom level.
   * One pixel covers more meters at low zoom; longitude is foreshortened by
   * cos(lat) so pixels also cover more meters at higher latitudes.
   */
  function metersPerPixelAtZoom(lat, zoom) {
    return MERCATOR_METERS_PER_PX_Z0 * Math.cos(lat * DEG2RAD) / Math.pow(2, zoom);
  }

  return { nearestPointOnPolyline, computeBearing, distanceMeters, bearingToCompass, bucketLatLng, bucketHeading, metersPerPixelAtZoom };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { RwgpsGeo };
