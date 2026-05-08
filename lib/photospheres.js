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

  // Parses a SingleImageSearch response body. Pattern-matches the
  // gpms-cs-s URL out of the serialized JSON instead of walking positional
  // indices — robust to Google moving the URL field within the response.
  // Returns:
  //   { ok: true,  tokenBase: 'https://lh3.googleusercontent.com/gpms-cs-s/<token>' }
  //   { ok: false, errorClass: 'UGC_RPC_PARSE_FAIL' | 'UGC_URL_NOT_FOUND', message: string }
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
    return { ok: true, tokenBase: match[0] };
  }

  return {
    isUgcPanoid: isUgcPanoid,
    buildSingleImageSearchBody: buildSingleImageSearchBody,
    parseUgcUrlFromResponse: parseUgcUrlFromResponse
  };
})();

if (typeof self !== 'undefined') self.RwgpsPhotospheres = RwgpsPhotospheres;
if (typeof window !== 'undefined') window.RwgpsPhotospheres = RwgpsPhotospheres;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RwgpsPhotospheres };
}
