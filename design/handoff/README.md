# Street View Preview · Popup UX Refresh — Handoff

This folder is everything you need to refresh the popup UI in **rwgps-streetview**. Architecture, content scripts, background worker, and storage layer all stay as-is — only the popup changes.

## What's in here

| File | What it is |
|---|---|
| `SPEC.md` | The actual handoff. Read this first. |
| `popup-reference.html` | Standalone, runnable mockup. Open it in any browser to see the target UI in all 4 states. Click around — buttons toggle. |
| `icons/` | New extension icon at 16/32/48/128 px. Replace the existing `icons/` folder. |
| `manifest-icons-snippet.json` | The `icons` and `action.default_icon` blocks from manifest.json — paste-ready. |
| `screenshots/` | PNG of each state for design review / store listing. |

## How to use this with Claude Code

1. Drop this whole `handoff/` folder into the root of your `rwgps-streetview` repo.
2. In Claude Code, prompt:

   > Read `handoff/SPEC.md` and `handoff/popup-reference.html`. Refresh the popup UI in `popup/` to match the reference exactly. Don't change `background.js`, `content/`, or `lib/` — only the popup. Keep all existing storage keys, message types, and behavior. Replace `icons/` with `handoff/icons/` and update `manifest.json` per `handoff/manifest-icons-snippet.json`.

3. Review the diff. Test via `chrome://extensions` → reload unpacked.

## What's changed vs. the existing popup

Three things, in priority order:

1. **Information hierarchy.** Quota usage is now the hero — big number + bar at top. API key is demoted to a small footer line ("API key configured ✓") that expands when needed.
2. **Cache framing.** The bar shows *only* billable usage. Cache hits and geocoding sit below as plain stat rows (they don't count toward the cap, so they don't belong in the cap meter).
3. **Error states.** Inline errors near the relevant context, not a generic banner. Invalid key replaces the hero. Over-quota and rate-limit show under the meter. Near-quota shows nothing extra — the amber number + bar is enough.

Plus: new icon (lens-halo pin), tightened typography (Inter Tight throughout, no monospace), 12px floor on body copy.

## Functional contract — what stays the same

The refresh is UX-only. All of the following must keep working unchanged:

- Storage: API key, monthly cap value, advanced settings, monthly counters, cache hit counter
- Cap enforcement (default 10,000)
- Monthly reset behavior
- The 4 advanced settings (pano radius, position rounding, min cursor move, settle delay) — same defaults, same units, same effect
- "Active on this page" indicator + per-page counters
- All message-passing between popup ↔ background ↔ content
- The Street View Static API call path

## Questions or pushback

If anything in the spec conflicts with how the extension actually works, the extension wins — flag it and we'll adjust the spec. The mockup is design-source-of-truth for *layout and copy*, not for backend behavior.
