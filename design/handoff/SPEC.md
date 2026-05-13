# Popup UX Refresh — Spec v5

Source of truth: `popup-reference.html` in this folder. Open it, click around. Where this doc and the reference disagree, **the reference wins** for layout/copy. This doc covers the *why* and the *behavior contract*.

This is v5 of the refresh — it supersedes the previous handoff. Five things changed from the prior spec; see §11 if you implemented v1 already.

---

## 1. Scope

- **In scope:** `popup/popup.html`, `popup/popup.css` (or equivalent), `popup/popup.js`, `manifest.json` icons, `icons/` folder.
- **Out of scope:** `background.js`, `content/`, `lib/`, storage layer, message types, the Street View API call itself, the content-script overlay UX. Don't touch these — UX-only refresh.

---

## 2. Design tokens

```
Font:         "Inter", system-ui, sans-serif      (everything — no mono)
Numerals:     font-variant-numeric: tabular-nums         (any number that updates)
Min size:     12px for body / hint copy. Never smaller.

Colors:
  ink         #131418   primary text
  dim         #6a6f7a   secondary text, hints
  line        #eef0f3   borders, dividers, bar track
  field bd    #d6d9de   input borders
  field bg    #fafbfc   API-key readout background
  surface alt #f7f9fc   "Active on this page" pill bg, help-list bg
  accent      #1f6feb   primary blue (links, primary button, focus, switch on)
  accent tint #f3f7fe   active mode card background
  ok          #22c55e   green dot only
  warn        #d97706   near-quota number color (>90%)
  warn bg     #fffbeb / border #fde68a / text #854d0e   rate-limit notice
  danger      #dc2626   over-quota number, invalid-key block
  danger bg   #fef2f2 / border #fecaca / text #991b1b   invalid-key / over-quota notice
  switch-off  #c9cdd5

Radii:        6 (inputs/buttons), 8 (mode cards, notices, surfaces), 10 (invalid-key block), 12 (onboarding card)
Popup width:  380px      (NOTE: bumped from 360 → 380 to fit the mode picker)
```

---

## 3. The four (now six) states

The popup renders one body. Three orthogonal axes determine what shows:

| Axis | Values |
|---|---|
| **Mode** | `experimental` (default for new users) · `apikey` |
| **Enabled** | `true` (default) · `false` — dims body to 40% |
| **Sub-state** (apikey mode only) | `firstrun` · `active` · `invalidkey` · `overquota` |

Pick at popup open with this storage read order:

```js
const mode      = storage.get('mode') ?? 'experimental';
const enabled   = storage.get('enabled') ?? true;
const apiKey    = storage.get('apiKey');
const invalid   = storage.get('apiKeyInvalid');
const usage     = storage.get('usage.' + ym());
const cap       = storage.get('monthlyCap') ?? 10000;
const capOn     = storage.get('capEnforced') ?? true;

let sub = 'active';
if (mode === 'apikey') {
  if (!apiKey)                                   sub = 'firstrun';
  else if (invalid)                              sub = 'invalidkey';
  else if (capOn && usage.sv >= cap)             sub = 'overquota';
}
```

`experimental` mode has no quota/key, so it has no sub-states. It just renders Advanced.

Near-quota (`used/cap > 0.9`) is **not a sub-state** — only changes the hero number color to amber. No banner.

---

## 4. Layout (top-to-bottom)

### 4.1 Header
- 16px padding all around, 1px bottom border `line`. Flex row, 12px gap.
- Left: 26×26 icon (`icons/icon128.png` source).
- Center: "Street View Preview" 15px/600 + version "v1.5.0" 12px/`dim`/tabular-nums on the same baseline, 7px gap. Truncate the title with ellipsis if needed; never wrap.
- Right: **Switch + `S` kbd hint**.
  - Switch: 36×20px pill. On = `accent` bg; off = `#c9cdd5` bg. Thumb 16×16 white, 2px inset, slides 18px on toggle. 150ms transition. `role="switch" aria-checked={on}`.
  - `kbd`: 1×6 padding, 4px radius, `#d6d9de` border, `#fafbfc` bg, 12px/600 `dim`, 1px shadow `#e6e8ec`. Reads "S".
  - Wrap both in a `<label>` with `title="Click to disable (S)"` / `"Click to enable (S)"`.
  - **Keyboard shortcut:** `S` (any case) toggles enabled when no input is focused. Wire globally on the popup.

The header is **always live** regardless of enabled state. Everything below it dims.

### 4.2 Body wrapper (dim when disabled)
Wrap §4.3 through §4.7 in a single `<div>` with:
- `opacity: enabled ? 1 : 0.4`
- `pointer-events: enabled ? auto : none`

No transition needed; the toggle is the visual feedback.

### 4.3 Mode picker
- 14px padding-top, 16px sides, no padding-bottom (the body below absorbs it).
- Two stacked `<button>`s with 6px gap. Each is an explicit radio choice (`aria-pressed`).
- **Active card:** 10×12 padding, 1.5px `accent` border, 8 radius, `#f3f7fe` bg. Two-row layout:
  - Top: filled radio + label in `accent`/14px/600 (e.g. "Experimental", "Bring your own API key").
  - Bottom: description in 13px/`dim`/1.45 line-height.
- **Inactive card:** 8×12 padding, 1.5px `#e6e8ec` border, 8 radius, white bg. Single row:
  - Empty radio + label 14px/500 + short label 13px/`dim` right-aligned (e.g. "no API key", "better coverage").
- Both cards transition `border-color, background 120ms` on hover. Cursor `pointer`.

**Radio circle** — 16×16, 1.5px border (`accent` active, `#c9cdd5` inactive), white fill. When active, an 8×8 `accent` dot centered.

Copy:
- `experimental` — label "Experimental", short "no API key", desc "No API key needed. Bike trail coverage is limited."
- `apikey` — label "Bring your own API key", short "better coverage", desc "Better bike trail coverage. 10,000 free requests / month."

**Persistence:** clicking writes `mode` to storage immediately and re-renders the body. No "Save" step.

### 4.4 Body — Experimental mode

Just one section: **Advanced** (§4.7). 16px padding around it. That's it.

> **Why:** experimental mode has no quota, no key, no per-month state. The Advanced settings are the only thing left to configure. Don't invent filler.

### 4.5 Body — API key mode (post-onboarding, valid key)

16px padding around. Two collapsible sections, one of which can be open at a time (accordion behavior — see §6).

#### 4.5.1 "Google Maps API" disclosure (was "Usage")
- Header button: caret + "Google Maps API" 14px/500/`ink` left; right shows the inline summary `{used} / {cap}` in 13px tabular-nums (used colored `warn` if >90%, otherwise `#33363d`; "/cap" in `dim`). 10×0 padding.
- **Collapsed by default.**
- Expanded content (6px top padding):
  - Eyebrow row: "May 2026" 13/`dim`/500 left, "Reset" link 13/`accent`/500 right.
  - Bar: 10px tall, 5 radius, `line` track, `accent` fill at `usedPct%`. Color shifts to `warn` if >90%, `danger` if `overquota`. Cache is **not** in this bar.
  - Scale row: "0" left, "10k" right — 12/`dim`.
  - "Served from cache" row — label 13/`dim` left, value `#33363d` tabular-nums right. 12px top margin.
  - "Geocoding (separate quota)" row — same style, 4px top margin.
  - **Active-on-this-page pill** — `bg #f7f9fc / border line / radius 8 / 8px×12px padding`. Green dot + "Active on this page" 13/500 left; "{sv} sv · {cached} cached · {geo} geo" 13/`dim`/tabular-nums right. 10px top margin.
  - **Cap row** — top border `line`, 12px padding/margin top. `<input type=checkbox>` (accent) + "Enforce monthly cap of" 14px + `<input value="10000">` 80×30 right-aligned tabular-nums.
  - **API key row** — top border `line`, 12px padding/margin top. "API key" eyebrow 13/`dim`/500. Below: 32px-tall field, 6 radius, `#e6e8ec` border, `#fafbfc` bg, holding masked dots `••••…` (30 dots) and an eye toggle on the right. Click eye reveals full key. Field accepts edits in place — no separate "Replace" button.

#### 4.5.2 "Advanced" disclosure (§4.7)

### 4.6 Body — API key mode, **first run** (`!apiKey`)

Replace the §4.5 disclosures with the onboarding card. Advanced (§4.7) still renders below.

- Card: `linear-gradient(180deg, #f7f9fc 0%, #f1f4f9 100%)`, 1px dashed `#c9cdd5`, 12 radius, 18px padding, centered text.
- Headline: "Paste your Google Maps API key" 18/600/-0.01.
- Subhead: "The Street View Static API gives you 10,000 free requests every month." 13/`dim`/1.5 — two lines (break before "10,000").
- Input + Save button row, 6px gap. Input 38px, 8 radius, `#d6d9de` border, placeholder `AIza...`, autoFocus. Save 38×16 padding, accent bg, white text, 14/600.
- 14px below: **"How to get an API key"** disclosure. Caret + label 14/`accent`/500 left; "3 min" 13/`dim` right. Open: ordered list inside `bg #f7f9fc / radius 8 / 12px padding`, 13px/1.7. Steps:
  1. Open Google Cloud Console *(link with external icon, accent)*
  2. Create or select a project
  3. Enable **Street View Static API**
  4. Credentials → Create credentials → API key
  5. Restrict to Street View Static (recommended)
  6. Copy & paste the key above

### 4.7 Advanced (collapsible) — both modes

- 14px top margin from previous section (0 if it's the first thing in the body, like in experimental mode).
- Disclosure header: caret + "Advanced" 14/500/`ink` left, nothing on the right. Top border `line`, 10×0 padding.
- Open body (6px top padding):
  - **Debug row first** — full-width row: checkbox + "Enable debug logging" 14/inherit. 12px bottom padding, 1px dashed `line` bottom border, 14px bottom margin. This is the verbose-logging control — keep it visually attached to the rest of Advanced but the dashed rule separates it from the tuning grid.
  - **2-column grid**, 14px gap, 4 fields (Pano radius / Position rounding / Min cursor move / Settle delay). Each cell:
    - Label 13/500 + ` (unit)` in 13/400/`dim`, 4px bottom margin.
    - Input full-width, 32px tall, 6 radius, `#d6d9de` border, tabular-nums.
    - Hint 13/`dim`/1.4 below, 4px top margin.

  | Label | Unit | Default | Hint |
  |---|---|---|---|
  | Pano radius | m | 10 | How far Google searches around the point. |
  | Position rounding | m | 25 | Snap nearby positions to reuse cached images. |
  | Min cursor move | m | 25 | Distance threshold before refetching. |
  | Settle delay | ms | 100 | Wait for cursor to stop before fetching. |

  - **"Reset all to defaults"** link at bottom — right-aligned, 13/500/`accent`, refresh icon left. 14px top margin. Click resets all 4 tuning fields **and** debug logging. *Show only if at least one differs from default* (cheap to compute; nice polish).

> **Storage keys for these stay the same as today.** Just match labels/hints/order.

---

## 5. Invalid key & over quota (API-key mode, post-onboarding)

These render inside the §4.5.1 "Google Maps API" disclosure when expanded — they're API-key-mode concerns and don't apply to experimental.

- **Auto-expand** the Google Maps API section on popup open if `invalidkey` or `overquota`. Don't make the user hunt for the error.
- **Over quota** — hero number renders `danger`, "Monthly cap reached" 12/`danger`/500 line under the number, bar fill `danger`. Below the cache/geo rows, render a notice (`bg #fef2f2 / border #fecaca / radius 8 / 8×12 padding`): bullet `●` in danger + "Cap reached. Previews paused until {next-reset-date}, or raise the cap below." Suppress the Active-on-this-page pill in this state.
- **Invalid key** — replace the hero quota with the invalid-key block (`bg #fef2f2 / border #fecaca / radius 10 / padding 14`):
  - 20×20 danger-bg circle, white "!" 13/700.
  - Title: "API key rejected by Google" 13/600/`#991b1b`.
  - Body: "Last response: **REQUEST_DENIED**. The key may be invalid, restricted to a different API, or the Street View Static API isn't enabled." 12/`#7f1d1d`/1.45.
  - Buttons row (10 margin-top, 8 gap):
    - **Replace key** — danger bg, white text, 30px, 12/500. Clears `apiKey` + `apiKeyInvalid`, returns to first-run.
    - **Troubleshoot** — white bg, `#fecaca` border, `#991b1b` text, 30×12 padding, 12/500. Links to your existing troubleshooting doc.
  - Cap row + API key row below dim to 50% opacity.

---

## 6. Accordion behavior

Inside a given mode body, only **one** of `usage` / `advanced` is open at a time. Clicking an open section closes it; clicking a closed one opens it (and closes the other).

Defaults:
- Experimental mode: `null` (nothing open).
- API key mode, normal: `null`.
- API key mode, `invalidkey` or `overquota`: `usage` open (so the user sees the error context).

State lives in popup memory — don't persist accordion open/close across popup re-opens.

---

## 7. Behavior contract

Wire to existing storage/messages. Mockup uses dummy data.

### Reads on popup open

```js
storage.get([
  'mode',                  // 'experimental' | 'apikey' — NEW key, default 'experimental'
  'enabled',               // bool, NEW key, default true
  'debugLogging',          // bool, NEW key, default false
  'apiKey',                // string | null
  'apiKeyInvalid',         // bool
  'monthlyCap',            // number, default 10000
  'capEnforced',           // bool, default true
  `usage.${ym()}`,         // {sv, cached, geo}
  'rateLimitedAt',         // timestamp | null
  'panoRadius',            // 10
  'positionRounding',      // 25
  'minCursorMove',         // 25
  'settleDelay',           // 100
]);
```

Per-page counters come from the active tab's content script (existing message).

### Writes

| Control | Behavior |
|---|---|
| Mode card | Writes `mode` immediately. Body re-renders. No save button. |
| Switch / `S` key | Writes `enabled` immediately. Body dims/undims. **Also broadcast** to background → content scripts: `chrome.runtime.sendMessage({type: 'setEnabled', enabled})`. The content script must stop fetching when disabled. |
| API-key field | Debounce 400ms, validate prefix `AIza`, save on blur or after debounce. |
| Cap checkbox + number | Save on change (same as today). |
| Advanced tuning fields | Save on change (same as today). |
| Debug logging | Save on change. Broadcast to background → content: `chrome.runtime.sendMessage({type: 'setDebug', enabled})`. |
| "Reset" link in Usage eyebrow | Same as today — clears `usage.${ym()}`. |
| "Reset all to defaults" in Advanced | Sets pano=10, rounding=25, move=25, delay=100, debug=false. Locally **and** save. |
| "Replace key" (invalidkey) | Clears `apiKey` + `apiKeyInvalid` → first-run renders. |

### `S` keyboard shortcut

Bind `keydown` on `window` in the popup. On `e.key === 's' || 'S'`, if no `<input>`/`<textarea>` is focused, toggle `enabled`. That's it — no modifier required (popup is short-lived, accidental presses are fine).

### Disabled-state semantics

When `enabled === false`:
- Popup body dims (40% opacity, pointer-events none) — header + switch stay live.
- Content script must **not** fetch new Street View images.
- Cache + per-page counters still display the last-known values; nothing actively updates.
- Toggle back on → content script resumes on next cursor settle.

---

## 8. Accessibility

- All collapsibles: `<button aria-expanded>`.
- Mode cards: `<button aria-pressed>`. Group them under `role="radiogroup" aria-label="Mode"` if you'd like, though the explicit pressed state already covers it.
- Switch: `<button role="switch" aria-checked>`. `S` shortcut hint is a decorative `<kbd>` inside the same `<label>` — the actual handler is on `window`, not the kbd.
- API key field has `aria-label="Google Maps API key"`; eye toggle: `aria-label="Show key" / "Hide key"`.
- Color is never the only signal:
  - Near-quota: amber + the literal numbers tell the story.
  - Over-quota: red + "Monthly cap reached" text + notice.
  - Invalid: red + circled "!" + title text.
  - Disabled: opacity AND pointer-events none AND switch position.
- Focus rings: use browser default. If you restyle, ≥2px, accent-colored.
- `S` shortcut: skipped when an input is focused so users can type "s" in the API-key field.

---

## 9. Migration from old storage

If `mode` doesn't exist in storage on first popup open after this update:
- If `apiKey` exists → set `mode = 'apikey'` (preserve their workflow).
- Else → set `mode = 'experimental'` (the new default).

If `enabled` doesn't exist → set to `true`.
If `debugLogging` doesn't exist → set to `false`.

Write these defaults once and move on; don't re-prompt.

---

## 10. Don'ts (cumulative — applies across versions)

- **Don't** put cache hits in the quota bar. Cache = not billable.
- **Don't** show a "Cache saved 276 ✓" green panel. Stats, not events.
- **Don't** show a "Setup required" / "Welcome" eyebrow on first run.
- **Don't** show a yellow near-quota banner. Amber number is enough.
- **Don't** introduce a monospace font anywhere — `tabular-nums` on Inter instead.
- **Don't** use text smaller than 12px.
- **Don't** add new top-level features beyond what's spec'd here.
- **Don't** keep the old giant red on/off button — the header switch replaces it entirely.
- **Don't** put "Verbose logging" anywhere outside the Advanced disclosure.

---

## 11. What changed vs. the v1 handoff

If you already implemented the previous handoff, here's the delta:

| # | Change | Why |
|---|---|---|
| 1 | **Mode picker** added at top — Experimental vs. API key. Active card expanded; inactive collapsed to a single row. | Some users won't ever get an API key; we need to support that path explicitly instead of leaving them stuck on first-run. |
| 2 | **Enable toggle moved to header** as a 36×20 switch + `S` shortcut hint. Body dims to 40% when off. | The previous "giant red button" was actually an on/off control mislabeled as an action. Color now reflects state (green dot), not action. |
| 3 | **Verbose / debug logging** moved into Advanced under a dashed sub-rule. | Belongs with the other tuning knobs, not as a top-level setting. |
| 4 | **Usage section is now a disclosure**, collapsed by default. Inline summary `{used} / {cap}` shows on the right when collapsed. | Matches the disclosure pattern already used for Advanced and API key. Reduces vertical noise when nothing's wrong. |
| 5 | Popup width **360 → 380px**. | Mode picker needs the extra room for two-card layout without cramping. |

Existing implementations of First-run, Invalid-key, and Over-quota stay valid — they now live *inside* the "Google Maps API" disclosure (auto-expanded when there's an error).
