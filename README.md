# Street View Preview for RideWithGPS

Chrome extension that shows a Google Street View preview when hovering over a route in the [RideWithGPS](https://ridewithgps.com) route planner.

Works when **Google Maps** is selected as the map type in the route editor.

![Street View preview overlay](https://maps.googleapis.com/maps/api/streetview?size=400x250&location=47.8,-122.7&heading=180&pitch=-5&fov=90&key=DEMO)

## Install

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the repository folder
5. Click the extension icon and enter a Google Maps API key (see below)

## API Key Setup

You need a Google Maps API key with the **Street View Static API** enabled:

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis)
2. Create a project (or select an existing one)
3. Enable the **Street View Static API**
4. Go to **Credentials** > **Create Credentials** > **API Key**
5. Recommended: restrict the key to **Street View Static API** only

The Street View Static API includes $200/month of free usage (~28,500 requests).

## Usage

1. Open a route in the RideWithGPS route planner
2. Select **Google Maps** as the map type
3. Hover near the route line -- a Street View preview appears showing the road ahead
