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

  return {
    isUgcPanoid: isUgcPanoid
  };
})();

if (typeof self !== 'undefined') self.RwgpsPhotospheres = RwgpsPhotospheres;
if (typeof window !== 'undefined') window.RwgpsPhotospheres = RwgpsPhotospheres;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RwgpsPhotospheres };
}
