# Privacy Policy

**Street View Preview for RideWithGPS** does not collect, store, or transmit any personal data.

## What this extension accesses

- **ridewithgps.com**: The extension runs only on RideWithGPS route pages to read route coordinates and detect mouse position near the route.
- **Google Street View Static API**: The extension requests street view images from Google's API based on route coordinates. These requests are made directly from your browser to Google using your own API key.
- **Chrome storage**: Your API key and enabled/disabled preference are saved locally in Chrome's sync storage. This data is not sent to us or any third party.

## Data we collect

None. This extension has no backend, no analytics, and no tracking.

## Verbose console logging (opt-in)

The extension's popup has an optional "Verbose console logging" toggle, off by default. When enabled, the extension writes additional diagnostic information — including the coordinates you hover over the route — to your browser's DevTools console. These logs stay local to your browser and are not transmitted anywhere by the extension. They only reach the developer if you choose to copy and share them (for example, when reporting a bug).

## Third-party services

Google's Street View Static API is subject to [Google's Privacy Policy](https://policies.google.com/privacy). Requests to this API include the route coordinates you hover over and your API key.

## Contact

For questions, open an issue at https://github.com/nslussar/rwgps-streetview/issues
