#!/usr/bin/env bash
# Refresh SingleImageSearch fixtures used by test/photospheres.test.js.
# Run manually when:
#   - The parser breaks in the wild (response shape changed).
#   - Before each release as a smoke test.
#   - A bug report mentions G1/G2/G3 errors.
#
# After running, diff the fixtures against the prior versions and commit if
# the changes look intentional. A structural shift is exactly what we want
# this script to surface.
#
# Coordinates chosen for stability:
#   - Discovery Park trail (Brian Ferris) — known UGC, used in spec recipe 2
#   - Olympic Discovery Trail (Curt Sumner Sept 2025) — different photographer
#   - 0,0 mid-ocean — guaranteed no-results
set -euo pipefail

OUT=test/fixtures/photospheres
mkdir -p "$OUT"

curl_sis() {  # lat lng radius outfile
  local lat="$1" lng="$2" radius="$3" outfile="$4"
  curl -s 'https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch' \
    -H 'content-type: application/json+protobuf' \
    -H 'x-user-agent: grpc-web-javascript/0.1' \
    -H 'origin: https://ridewithgps.com' \
    -H 'referer: https://ridewithgps.com/' \
    --data-raw "[[\"apiv3\",null,null,null,\"US\",null,null,null,null,null,[[0]]],[[null,null,${lat},${lng}],${radius}],[null,[\"en\",\"US\"],null,null,null,null,null,null,[2],null,[[[2,1,2],[3,1,2],[10,1,2]]]],[[1,2,3,4,8,6,17],null,null,null,null,null,null,null,null,null,[null,null,[[[100,100]]]]]]" \
    > "$OUT/$outfile"
  echo "  → $OUT/$outfile ($(wc -c < "$OUT/$outfile") bytes)"
}

echo "Capturing SingleImageSearch fixtures..."
curl_sis 47.6570 -122.4158 30 ugc_discovery_park.json
curl_sis 48.0680667 -123.8254309 30 ugc_olympic_trail.json
curl_sis 0 0 10 no_results.json
echo "Done. Diff the fixtures and commit if changes look intentional."
