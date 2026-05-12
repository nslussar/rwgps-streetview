# Title (75 char limit)

Hover Street View for RideWithGPS — preview cycling routes

# Summary (132 char limit)

Hover over a RideWithGPS route to preview Google Street View. Scout entire cycling routes without dragging the pegman.

# Detailed description

Hover anywhere on a RideWithGPS route and see a Google Street View preview of that exact spot — oriented in the direction the route is heading. Sweep your cursor along the route to scout the entire ride in seconds.

The map alone doesn't show road conditions: surface type, shoulder width, traffic. RideWithGPS has Google's pegman built in, but you have to drag it, drop it, peek, back out, and re-drag for every point you want to check.

This extension adds a continuous street view hover over the route & elevation map.

Features:
- Hover near any part of a route to see a Google Street View image
- Shows street name and city, plus a compass and heading
- Click the preview to open full Google Maps Street View
- Works in both the route editor and route viewer, on any public route

Requirements:
* Google Maps must be selected as the map type in RideWithGPS
* Google Maps API key with Street View Static API enabled (10k requests/month are free).

The extension uses Google's Street View Static API, which requires an API key. RideWithGPS's own Street View integration uses Google's "embed" map, which is free but can't support hover functionality like this. To keep usage under the 10k/month free tier, this extension buckets nearby points for a better cache hit ratio, skips redundant requests, and throttles requests as the cursor moves. The popup shows current monthly usage.

Fully open source under MIT license: https://github.com/nslussar/rwgps-streetview

Recent changes:
* ...

# Permission justification (webstore)

## Storage justification

Used to persist the user's Google Maps API key, overlay enabled/disabled toggle, and user preferences (Street View search radius, dwell delay, request bucketing/skip thresholds, monthly request cap) across sessions via chrome.storage.sync, and to maintain monthly Street View API usage counters and per-tab session counters via chrome.storage.local and chrome.storage.session for the in-popup usage meter and cap enforcement. 

No browsing history, page contents, or personal data are stored.

## webRequest justification

Used to observe completed Street View Static API requests to maps.googleapis.com so the extension can accurately count monthly API usage and distinguish browser-cache hits (not billed) from network requests (billed). This powers the in-popup usage meter and the user-configurable monthly cap that prevents unexpected API charges. The extension only reads request metadata (URL and fromCache flag) via webRequest.onCompleted. 

The extension does not block, redirect, or modify any requests, and does not read response bodies.

## Host permissions justification

* ridewithgps.com: content scripts read route polyline coordinates and show a Street View overlay on hover. 

* maps.googleapis.com: fetch Street View Static images using the user's Google Maps API key and observe completed requests to count monthly usage. 

Both are required because webRequest only fires when the extension has host permissions for both the initiator page and the destination.
