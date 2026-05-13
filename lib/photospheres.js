/**
 * UGC photosphere helpers — pure functions, no DOM / Chrome / Maps JS deps.
 *
 * Loaded by:
 *   - content scripts via the manifest content_scripts.js array
 *   - the page bridge via injection from content.js (see injectBridge())
 *
 * Exposes RwgpsPhotospheres on the global. Also exports for Node tests.
 *
 * See docs/superpowers/specs/2026-05-07-photospheres-ugc-rendering-design.md
 * for the design rationale and decision log.
 */
const RwgpsPhotospheres = (() => {
  'use strict';

  // Type-10 panoids are base64-encoded protobuf wrappers — they always begin
  // with the 4-char prefix `CAoS` (which encodes field1=10). Type-2 panoids
  // are 22-char alphanumerics with no wrapper. See spec section 2.1.
  function isUgcPanoid(panoid) {
    return typeof panoid === 'string' && panoid.startsWith('CAoS');
  }

  // SingleImageSearch request body — positional protobuf-as-JSON (JSPB), not
  // binary protobuf. Shape from the design-doc recipe 2 curl. The [10,1,2]
  // triple at [2][10] admits type-10 (UGC) panoramas; remove that triple to
  // restore type-2-only behavior. Thumbnail size [100,100] is small because
  // we ignore the response's render-spec — we extract the token base and
  // build our own URL with viewport-sized render params.
  function buildSingleImageSearchBody(lat, lng, radius) {
    return [
      ['apiv3', null, null, null, 'US', null, null, null, null, null, [[0]]],
      [[null, null, lat, lng], radius],
      [null, ['en', 'US'], null, null, null, null, null, null, [2], null,
        [[[2,1,2], [3,1,2], [10,1,2]]]],
      [[1,2,3,4,8,6,17], null, null, null, null, null, null, null, null, null,
        [null, null, [[[100, 100]]]]]
    ];
  }

  // Parses a SingleImageSearch response body. Returns the gpms-cs-s URL plus
  // enough metadata to render the panorama without a separate getPanorama
  // call (panoid, snapped lat/lng, originHeading, originPitch, copyright).
  // Used as the rescue path when Maps JS getPanorama fails after retries —
  // see the bridge's retry/SIS-rescue logic for context.
  //
  // The URL is regex-extracted (robust to field-position shifts). All other
  // fields are positionally accessed against the documented JSPB shape — see
  // the per-field comments below for the position rationale and the
  // test/fixtures/photospheres/ files for sample responses.
  //
  // Returns:
  //   { ok: true,  tokenBase, panoid, panoType, snappedLat, snappedLng,
  //                originHeading, originHeadingAlt, originPitch, copyright }
  //   { ok: false, errorClass: 'UGC_RPC_PARSE_FAIL' | 'UGC_URL_NOT_FOUND', message }
  function parseUgcUrlFromResponse(rawText) {
    // Defensive XSSI prefix strip — Maps API doesn't appear to use it for
    // SingleImageSearch responses, but TheGreatRambler's photometa endpoint
    // does. Free to defend against either family ever using it.
    let body = rawText;
    if (body.length >= 4 && body.slice(0, 4) === ")]}'") {
      body = body.replace(/^\)\]\}'\n?/, '');
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      return {
        ok: false,
        errorClass: 'UGC_RPC_PARSE_FAIL',
        message: e.message
      };
    }

    // Token charset is base64url-style (no '=' or '/'), so the regex
    // captures the full token without crossing into the render-spec
    // separator '=w...' / '=x...'.
    const serialized = JSON.stringify(parsed);
    const match = serialized.match(
      /https:\/\/lh3\.googleusercontent\.com\/gpms-cs-s\/[A-Za-z0-9_-]+/);
    if (!match) {
      return {
        ok: false,
        errorClass: 'UGC_URL_NOT_FOUND',
        message: 'response missing gpms-cs-s URL (snippet: ' + body.slice(0, 200) + ')'
      };
    }

    // Defensive accessor — returns undefined if any path step is nullish.
    function get(obj, path) {
      let cur = obj;
      for (const k of path) {
        if (cur == null) return undefined;
        cur = cur[k];
      }
      return cur;
    }

    // Positional extraction. Outer shape:
    //   parsed[0] = [status]
    //   parsed[1] = main result object
    //   parsed[2] = [number]
    //
    // Within parsed[1]:
    //   [1]             = [typeByte, panoidInner]        // 10=UGC, 2=SV-car
    //   [4][1][0][0][0] = author name string
    //
    // Within parsed[1][5][0][1] there are TWO observed shapes — apparently
    // varies by photographer / capture tool. See the per-format fixtures:
    //
    //   FORMAT A (Curt Sumner, Brian Ferris — 5-element location array):
    //     [0] = [null, null, lat, lng]
    //     [1] = [headingA, null, headingB]                // dedicated heading
    //     [2] = [pitchA, pitchB, pitchC]                  // pitchC mod 360
    //     [3] = null
    //     [4] = "US"
    //
    //   FORMAT B (Yogy Namara — 3-element location array):
    //     [0] = [null, null, lat, lng]
    //     [1] = null                                      // no dedicated heading
    //     [2] = [heading, ?, pitch]                       // heading+pitch packed
    //
    // pitch is always extracted from [2][2]; heading falls through based on
    // format detection: [1][0] when [1] is an array, else [2][0].
    const panoType = get(parsed, [1, 1, 0]);
    const panoid = get(parsed, [1, 1, 1]);
    const snappedLat = get(parsed, [1, 5, 0, 1, 0, 2]);
    const snappedLng = get(parsed, [1, 5, 0, 1, 0, 3]);

    const headingArr = get(parsed, [1, 5, 0, 1, 1]);
    const altArr = get(parsed, [1, 5, 0, 1, 2]);
    let rawHeadingA;
    let rawHeadingB;
    if (Array.isArray(headingArr) && typeof headingArr[0] === 'number') {
      // Format A — dedicated heading array.
      rawHeadingA = headingArr[0];
      rawHeadingB = headingArr[2];
    } else if (Array.isArray(altArr) && typeof altArr[0] === 'number') {
      // Format B — heading packed alongside pitch at [2].
      rawHeadingA = altArr[0];
      rawHeadingB = undefined;
    }
    const originHeading = (typeof rawHeadingA === 'number')
      ? ((rawHeadingA % 360) + 360) % 360
      : undefined;
    const originHeadingAlt = (typeof rawHeadingB === 'number')
      ? ((rawHeadingB % 360) + 360) % 360
      : undefined;

    // Pitch: third element at [2][2], normalized to (-180, 180]. In Format A
    // the host array is dedicated pitch; in Format B it's heading+pitch
    // packed. Same index in both cases.
    const rawPitch = get(parsed, [1, 5, 0, 1, 2, 2]);
    const originPitch = (typeof rawPitch === 'number')
      ? (rawPitch > 180 ? rawPitch - 360 : rawPitch)
      : undefined;

    const author = get(parsed, [1, 4, 1, 0, 0, 0]);
    const copyright = author ? '© ' + author : '';

    return {
      ok: true,
      tokenBase: match[0],
      panoid: panoid,
      panoType: panoType,
      snappedLat: snappedLat,
      snappedLng: snappedLng,
      originHeading: originHeading,
      originHeadingAlt: originHeadingAlt,
      originPitch: originPitch,
      copyright: copyright
    };
  }

  // SingleImageSearch — the metadata search RPC used by the Maps JS
  // streetView library when locating user-contributed (type-10) photospheres.
  // Called directly here because the panorama tile endpoint doesn't serve
  // type-10 captures, so we need the render URL from this response to draw
  // them. See design spec section 4.2 for the request shape.
  const SINGLE_IMAGE_SEARCH_URL =
    'https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch';

  // No bridge-side cache for v1: each LOOKUP_PANO that resolves to type-10
  // fires its own SingleImageSearch. Forward-sweep workflows get zero
  // benefit from caching here (each bucketed cursor position resolves to a
  // unique panoid on trails with ~10m UGC spacing — typical when one rider
  // uploads via a 360 camera at fixed intervals). Re-sweep / cursor-pause
  // workflows would benefit, but the cache costs ~10 lines.
  // FUTURE: see spec section 7.1 for a panoid-keyed cache + concurrent-dedup
  // map design when telemetry justifies it.

  // POST a SingleImageSearch request and parse the response. Returns the
  // same shape as parseUgcUrlFromResponse on success, plus an error result
  // shape on transport / parse failure:
  //   { ok: true,  tokenBase, panoid, panoType, snappedLat, snappedLng,
  //                originHeading, originHeadingAlt, originPitch, copyright }
  //   { ok: false, errorClass: 'UGC_RPC_HTTP_ERROR' | 'UGC_RPC_PARSE_FAIL'
  //                          | 'UGC_URL_NOT_FOUND', message: string }
  async function singleImageSearch(lat, lng, radius) {
    let body;
    try {
      body = JSON.stringify(buildSingleImageSearchBody(lat, lng, radius));
    } catch (e) {
      return {
        ok: false,
        errorClass: 'UGC_RPC_PARSE_FAIL',
        message: 'body build failed: ' + e.message
      };
    }

    let resp;
    try {
      resp = await fetch(SINGLE_IMAGE_SEARCH_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json+protobuf',
          'x-user-agent': 'grpc-web-javascript/0.1'
        },
        body: body
      });
    } catch (e) {
      return {
        ok: false,
        errorClass: 'UGC_RPC_HTTP_ERROR',
        message: 'network: ' + e.message
      };
    }

    if (!resp.ok) {
      return {
        ok: false,
        errorClass: 'UGC_RPC_HTTP_ERROR',
        message: 'HTTP ' + resp.status
      };
    }

    const rawText = await resp.text();
    return parseUgcUrlFromResponse(rawText);
  }

  // Build the gpms-cs-s render URL for a UGC photosphere. The token base
  // (everything before the '=') is provided by parseUgcUrlFromResponse;
  // we control everything after.
  //
  // Render-spec params:
  //   w<W>-h<H>     viewport pixel dimensions
  //   k-no          flag: keep size as-is, no further server crop
  //   pi<P>         pitch in degrees (0 = horizon level)
  //   ya<Y>         yaw in degrees (0 = panorama's originHeading direction)
  //   ro0           roll = 0
  //   fo<FOV>       field of view in degrees
  //
  // V1 NOTE: the body hardcodes pi=0 and ignores the originPitch param.
  // Post-probe (see spec section 6), if the captured horizon is genuinely
  // tilted on THETA-X-on-bicycle captures, replace the `0.0` literal below
  // with `originPitch` (or `-originPitch` per probe result).
  function buildUgcRenderUrl(tokenBase, routeHeading, panoOriginHeading, originPitch, viewportW, viewportH) {
    const yaw = (((routeHeading - panoOriginHeading) % 360) + 360) % 360;
    const pitch = 0;  // v1 hardcoded; see spec section 2.5
    const fov = 90;
    return tokenBase
      + '=w' + viewportW + '-h' + viewportH + '-k-no'
      + '-pi' + pitch.toFixed(1)
      + '-ya' + yaw.toFixed(1)
      + '-ro0-fo' + fov;
  }

  // Higher-level helper for the bridge's Site 1 (UGC panorama branch).
  // Encapsulates the SIS call + result-envelope construction so the bridge
  // can stay agnostic of the SIS response shape. Use the SNAPPED pano coords
  // (from getPanorama) instead of the raw cursor lat/lng — SingleImageSearch
  // ranks results by proximity to the query point, so snapped coords
  // guarantee we match the same pano getPanorama just confirmed exists,
  // not a different nearby UGC pano.
  //
  // Returns:
  //   { ok: true,  panoInfo: <merged PANO_INFO with kind:'ugc'> }
  //   { ok: false, error: <errResult from singleImageSearch> }
  async function resolveUgcPanorama(common, radius) {
    const sis = await singleImageSearch(common.snappedLat, common.snappedLng, radius);
    if (sis.ok) {
      return {
        ok: true,
        panoInfo: Object.assign({}, common, { kind: 'ugc', tokenBase: sis.tokenBase })
      };
    }
    return { ok: false, error: sis };
  }

  // Higher-level helper for the bridge's Site 2 (rescue path after
  // getPanorama exhausts retries). Hits SIS as an alternate metadata
  // source; if SIS returns a type-10 pano, builds a synthetic PANO_INFO so
  // the existing UGC render path can handle it. Other outcomes return a
  // NO_COVERAGE error envelope with the original getPanorama error tagged.
  //
  // `log` is an optional vlog-style callback (passed in by the bridge so
  // verbose log gating stays unified).
  //
  // Returns:
  //   { ok: true,  panoInfo: <synthetic PANO_INFO with kind:'ugc'> }
  //   { ok: false, error: <NO_COVERAGE errResult> }
  async function tryRescueLookup(lat, lng, radius, reqId, attemptCount, originalEmsg, log) {
    const vlog = (typeof log === 'function') ? log : function () {};
    const sis = await singleImageSearch(lat, lng, radius);
    if (sis.ok && sis.panoType === 10) {
      vlog('[RWGPS SV Bridge] rescue: rendering UGC from rescue data',
        'req=' + reqId,
        'q=(' + lat.toFixed(6) + ',' + lng.toFixed(6) + ')',
        'panoid=' + sis.panoid,
        'snapped=(' + (sis.snappedLat != null ? sis.snappedLat.toFixed(6) : '?')
          + ',' + (sis.snappedLng != null ? sis.snappedLng.toFixed(6) : '?') + ')',
        'originHeading=' + (sis.originHeading != null ? sis.originHeading.toFixed(2) : '?'),
        'originHeadingAlt=' + (sis.originHeadingAlt != null ? sis.originHeadingAlt.toFixed(2) : '?'),
        'originPitch=' + (sis.originPitch != null ? sis.originPitch.toFixed(2) : '?'),
        'copyright=' + sis.copyright);
      return {
        ok: true,
        panoInfo: {
          kind: 'ugc',
          // Inner panoid (no CAoS wrapper). Downstream code uses this only
          // for logging — the UGC render path builds URLs from tokenBase.
          panoid: sis.panoid,
          snappedLat: sis.snappedLat,
          snappedLng: sis.snappedLng,
          originHeading: sis.originHeading,
          originPitch: sis.originPitch,
          copyright: sis.copyright,
          tokenBase: sis.tokenBase,
          queryLat: lat,
          queryLng: lng,
          queryRadius: radius
        }
      };
    }
    if (sis.ok) {
      vlog('[RWGPS SV Bridge] rescue: unhandled type',
        'req=' + reqId, 'type=' + sis.panoType);
    } else {
      vlog('[RWGPS SV Bridge] rescue: empty',
        'req=' + reqId,
        'q=(' + lat.toFixed(6) + ',' + lng.toFixed(6) + ')',
        'errorClass=' + sis.errorClass);
    }
    return {
      ok: false,
      error: {
        errorClass: 'NO_COVERAGE',
        message: originalEmsg
          + ' [q=' + lat.toFixed(6) + ',' + lng.toFixed(6)
          + ' r=' + radius + 'm'
          + ' attempts=' + attemptCount
          + ' rescue=' + (sis.ok ? 'type-' + sis.panoType : (sis.errorClass || 'empty'))
          + ']'
      }
    };
  }

  return {
    isUgcPanoid: isUgcPanoid,
    buildSingleImageSearchBody: buildSingleImageSearchBody,
    parseUgcUrlFromResponse: parseUgcUrlFromResponse,
    singleImageSearch: singleImageSearch,
    buildUgcRenderUrl: buildUgcRenderUrl,
    resolveUgcPanorama: resolveUgcPanorama,
    tryRescueLookup: tryRescueLookup
  };
})();

if (typeof self !== 'undefined') self.RwgpsPhotospheres = RwgpsPhotospheres;
if (typeof window !== 'undefined') window.RwgpsPhotospheres = RwgpsPhotospheres;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RwgpsPhotospheres };
}
