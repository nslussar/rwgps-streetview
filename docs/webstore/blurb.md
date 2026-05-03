# Title (75 char limit)

Hover Street View for RideWithGPS — preview cycling routes

# Summary (132 char limit)

Hover over a RideWithGPS route to preview Google Street View. Scout entire cycling routes without dragging the pegman.

# Detailed description

Hover anywhere on a RideWithGPS route and see a Google Street View preview of that exact spot — oriented in the direction the route is heading. Sweep your cursor along the route to scout the entire ride in seconds.

The map alone doesn't show road conditions: surface type, shoulder width, traffic, blind corners. RideWithGPS has Google's pegman built in, but you have to drag it, drop it, peek, back out, and re-drag for every point you want to check. On a long route that adds up — cyclists in route-planning forums describe spending an hour clicking through Street View for an 80-mile ride.

This extension replaces that workflow with a continuous hover preview.

Features:
- Hover near any part of a route to see a Google Street View image
- Shows street name and city, plus a compass and heading
- Click the preview to open full Google Maps Street View
- Works in both the route editor and route viewer, on any public route

Requirements:
* Google Maps must be selected as the map type in RideWithGPS
* Google Maps API key with Street View Static API enabled (10k requests/month are free).

Why a key? RideWithGPS's built-in Street View uses Google's free embed (iframe), which only supports discrete clicks, not continuous hover. To fetch a fresh image as your cursor moves, this extension uses Google's Street View Static API, which is keyed per user. The extension caches aggressively and skips redundant requests; the popup shows your monthly usage so you always know where you stand.

Fully open source under MIT license: https://github.com/nslussar/rwgps-streetview

Recent changes:
* ...
