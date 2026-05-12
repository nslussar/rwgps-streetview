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
