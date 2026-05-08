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

  return {
    isUgcPanoid: isUgcPanoid,
    buildSingleImageSearchBody: buildSingleImageSearchBody
  };
})();

if (typeof self !== 'undefined') self.RwgpsPhotospheres = RwgpsPhotospheres;
if (typeof window !== 'undefined') window.RwgpsPhotospheres = RwgpsPhotospheres;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RwgpsPhotospheres };
}
