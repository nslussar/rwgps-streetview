# Street View Preview · Popup UX Refresh — Handoff (v5 / handoff_v2)

> **2026-05-14 sync.** `SPEC.md` and `popup-reference.html` were replaced wholesale from the canonical `handoff_v2/` bundle (Claude Design re-export). The v5e/v5f changelog entries that used to live in this folder have been folded into the SPEC's own §11 "What changed vs. the v1 handoff" table. Mode-card copy in the new spec already matches the shipped CWS-anodyne wording verbatim, so no divergence note is needed against this spec version — but `memory/feedback_cws_wording.md` still applies for any future design pulls that re-introduce the old phrasing.

This folder is everything needed to keep the popup UI in **rwgps-streetview** in sync with the design. Architecture, content scripts, background worker, and storage layer all stay as-is — only the popup changes.

## What's in here

| File | What it is |
|---|---|
| `SPEC.md` | The handoff spec. Read this first. (Canonical v5 / handoff_v2.) |
| `popup-reference.html` | Standalone, runnable mockup. Open it in any browser to see the target UI in all six frames. Mode cards, switch, and disclosures all toggle live. |
| `popup-explorations-v5.html` | The original Claude Design canvas with the v5 exploration. Renders with `design-canvas.jsx`, `popup-primitives.jsx`, `v-final3.jsx`, `popup-styles.css`. Kept for reference; superseded for spec/reference purposes by the two files above. |
| `v-final3.jsx` | The pre-v2 canonical popup component (used by `popup-explorations-v5.html`). Inline copy in `popup-reference.html` is authoritative now. |
| `advanced-reset-options.jsx` / `advanced-reset-options.html` | Four exploration variants for the "Reset all" pattern. The shipped implementation uses the **bottom-link** variant. |
| `mode-picker-options.jsx` / `mode-picker-options.html` | Four exploration variants for the mode picker (segmented w/ blue, two horizontal cards, vertical detail cards, segmented chip). The shipped implementation uses the **vertical detail cards** variant. |
| `popup-primitives.jsx` / `popup-styles.css` / `design-canvas.jsx` | Supporting design-canvas files. |
| `icons/` | Extension icon at 16/32/48/128 px. |
| `manifest-icons-snippet.json` | The `icons` and `action.default_icon` blocks from `manifest.json` — paste-ready. |
| `screenshots/` | PNG of states for design review / store listing (last refreshed for v4 — re-snap when convenient). |

## How to use this

1. The folder lives at the root of the repo.
2. Prompt for an update:

   > Read `design/handoff/SPEC.md` and open `design/handoff/popup-reference.html`. Reconcile `popup/popup.html`, `popup/popup.css`, and `popup/popup.js` with the reference. Don't change `background.js`, `content/`, or `lib/`. Keep all existing storage keys, message types, and behavior.

3. Review the diff. Test via `chrome://extensions` → reload unpacked.

## What changed in v5f vs v5e

1. **Mode picker compressed to "option B" (selected expanded, unselected collapsed).** The unselected card now renders as a single row: `radio + label (500 weight) + short tag right-aligned`. The selected card keeps the prior two-line layout (label/600/accent + description). Padding shrinks (selected 10/12, unselected 8/12 vs v5e's 12/14 for both). Trims ~60–80px from popup height.
2. **Short tags added** to each card for the collapsed state. Shipped: Experimental → "no API key"; API key → "better coverage". These mirror the description framing (no-key vs better-coverage trade-off) and remain CWS-anodyne.
3. **HTML default** for `aria-checked` flips to `#modeApiKey="true"` so the initial paint matches the default mode and avoids a layout-shift flash on most popup opens. Experimental users still see a one-frame shift; non-transitioning properties (padding, align-items) can't be suppressed via `popup-loading`.

No other behavior or copy changes.

## What changed in v5e vs v5d

1. **API key disclosure folded into Usage** — which is **renamed to "Google Maps API"**. Single panel now contains the usage meter, cache/geo rows, Active-on-page pill, cap row, and API key field. The accordion goes from 3 sections (Usage / Advanced / API key) → 2 sections (Google Maps API / Advanced).
2. **Cap-row label** simplifies from "Enforce monthly API request cap of" → "Enforce monthly cap of" (the section title carries the "API request" context).
3. **Standalone "delete key" trash-can button removed.** Users edit the key in place, or use "Replace key" from the invalid-key block. Clearing the field saves an empty string which routes the popup back to firstrun on the next open.
4. Persisted `popupOpenSection: 'apikey'` from v5d migrates to `'usage'`.

## What changed in v5d vs v5c

1. **Font swap** from `Inter Tight` (narrower editorial cut) to plain **`Inter`**. `font-feature-settings: 'ss01'` opts into Inter's single-storey 'a' / 'l' stylistic set for a slightly cleaner display feel.
2. **Mode-card description** font 12.5 → 13.
3. **Advanced verbose-debug row** font 13.5 → 14.

No layout, behavior, or copy changes.

## What changed in v5c vs v5b

1. **Mode picker rebuilt as vertical radio cards.** Each card has a label + a full sentence of descriptive copy ("Uses the Maps JS panorama endpoint directly…" / "Street View Static API. Full coverage…"). Active card shows accent border + light-blue tint + accent label color + filled accent radio dot. Replaces the v5b segmented control.
2. **First-run hint and experimental-coverage note removed.** Their content moved into the mode cards.
3. **Header bumped:** padding 12/14/12/16 → 16/16/16/18, gap 10 → 12, icon 24 → 26, brand internal gap 6 → 7.
4. **Advanced loses its "5 settings" meta** when collapsed (cleaner header). In experimental mode the Advanced section uses `margin-top: 0` so it sits flush against the body padding (no content above it).

## What changed in v5b vs v5

1. **Width bumped 360 → 380**, base font 13 → 14, with proportional bumps to titles (14→15), version/kbd (11→12), headings (17→18), debug-row (12.5→13.5), etc.
2. **Header switch grew** 32×18 → 36×20 (16px thumb).
3. **Advanced input height** 30 → 32 (font 13→14). Cap-row input 28 → 30.
4. **New "Reset all to defaults" link** at the bottom of the Advanced panel. Visible only when ≥1 of the four tunables differs from default. Clicking removes those storage keys; the existing `storage.onChanged` mirroring resets the inputs and the link auto-hides.

## What changed in v5 vs v4

1. **Mode picker.** Segmented control at the top of the body: **Experimental** (no API key) vs **API key** (full coverage). Writes `useExperimentalPreview` in `chrome.storage.sync`. API-key-mode UI (Usage / Cap / key disclosure) only renders when "API key" is selected.
2. **Header switch.** Replaces the giant red on/off button with a small switch + `S` kbd badge inline with the icon and title in the header. Toggling it dims the body to 40% (with `pointer-events: none`). `S` keyboard shortcut still works.
3. **Verbose logging moved into Advanced.** Used to be its own row near the top; now it's the first item inside the Advanced panel, separated from the four tunables by a dashed divider.
4. **Usage is a collapsible disclosure.** No more permanent hero quota — Usage now matches Advanced / API key as a mutex'd accordion item. Default-open in apikey-active state.
5. **Removed:** the header status dot (the switch state carries that signal now).

Everything else from v4 (icon, palette, typography, onboarding card, Cap row, API-key disclosure, error states) is preserved.

## Functional contract — what stays the same

The refresh is UX-only. All of the following must keep working unchanged:

- Storage keys: `apiKey`, `apiCap`, `apiCapEnabled`, `useExperimentalPreview`, `verboseDebug`, `previewEnabledViewer`, `radius`, `bucketMeters`, `skipThresholdMeters`, `dwellMs`, monthly counters, cache hit counter, session-by-tab counters
- `popupOpenSection` (new in v5) replaces `popupAdvancedExpanded` (v4); v4 key still reads as a fallback
- Cap enforcement (default 10,000)
- Monthly reset behavior
- The 4 advanced settings — same defaults, same units, same effect
- "Active on this page" indicator + per-page counters
- All message-passing between popup ↔ background ↔ content
- The Street View Static API call path
- `s` keyboard shortcut behavior

## Questions or pushback

If anything in the spec conflicts with how the extension actually works, the extension wins — flag it and we'll adjust the spec. The reference is design-source-of-truth for *layout and copy*, not for backend behavior.
