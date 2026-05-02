# Popup UX Refresh — Spec

Source of truth: `popup-reference.html` in this folder. Open it; click around. Where this doc and the reference disagree, **the reference wins** for layout/copy. This doc covers the *why* and the *behavior contract*.

---

## 1. Scope

- **In scope:** `popup/popup.html`, `popup/popup.css` (or equivalent), `popup/popup.js`, `manifest.json` icons, `icons/` folder.
- **Out of scope:** `background.js`, `content/`, `lib/`, storage layer, message types, the Street View API call itself, the content-script overlay UX. Don't touch these.

---

## 2. Design tokens

```
Font:         "Inter Tight", system-ui, sans-serif      (everything — no mono)
Numerals:     font-variant-numeric: tabular-nums        (any number that updates)
Min size:     12px for body / hint copy. Never smaller.

Colors:
  ink         #131418   primary text
  dim         #6a6f7a   secondary text, hints
  line        #eef0f3   borders, dividers, bar track
  surface alt #fafbfc   subtle field backgrounds
  surface hi  #f7f9fc   "Active on this page" pill bg
  accent      #1f6feb   primary blue (links, primary button, focus)
  ok          #22c55e   status dot only
  warn        #d97706   near-quota number color (>90%)
  warn bg     #fffbeb / border #fde68a / text #854d0e   rate-limit notice
  danger      #dc2626   over-quota number, invalid-key block
  danger bg   #fef2f2 / border #fecaca / text #991b1b   invalid-key, over-quota notice

Radii:        6 (inputs/buttons), 8 (notices), 10 (invalid-key block), 12 (onboarding card)
Popup width:  360px
```

---

## 3. States

The popup renders **one of four states**. Pick by reading from storage in this order:

| State | Trigger | What renders |
|---|---|---|
| **First run** | No API key in storage | Onboarding card |
| **Invalid key** | Last API call returned `REQUEST_DENIED` (sticky flag in storage; cleared on next successful call) | Red invalid-key block *replaces* the hero quota; rest of popup dims to 50% |
| **Over quota** | `used >= cap` for current month | Hero quota in red + "Cap reached" notice under bar |
| **Active** (default) | Anything else | Hero quota + (optional) rate-limit notice + "Active on this page" pill |

Near-quota (`used/max > 0.9`) is **not a separate state** — it just changes the hero number color to amber. No banner, no extra UI.

---

## 4. Layout — Active state (top-to-bottom)

### 4.1 Header
- 14/16px padding top, 12px bottom. 1px bottom border `line`.
- Left: 24×24px icon (`icon128.png` source, rendered at 24) + "Street View Preview" 14px/600.
- Right: status dot (6×6, `ok` green) + version label `v1.4.2` 12px/`dim`.
- Status dot color: `ok` normal, `danger` if invalid-key, `warn` if first-run.

### 4.2 Hero quota
- Eyebrow row: "Usage · {Month YYYY}" 12px/`dim`/500 — and a "Reset" link on the right (12px/`accent`/500). Reset clears the current-month counter (existing behavior — wire to whatever your reset action already calls).
- Number: `{used.toLocaleString()}` 26px/600/-0.02 letter-spacing. Color: `ink` normal, `warn` if `used/max > 0.9`, `danger` if over-quota.
- After the number, on the same line: ` / {max.toLocaleString()}` in 18px/400/`#a0a4ad`.
- 10px gap, then the bar.
- **Bar:** 10px tall, `line` track, accent fill at `usedPct = used/max*100`. Fill color matches number (ink/warn/danger). **Cache does NOT appear in this bar** — the bar is billable usage only.
- Below the bar, a small scale: "0" left, "10k" right, 11px/`dim`. (Use `${max/1000}k` for the right label.)

### 4.3 Secondary stats (cache + geo)
Two plain rows directly under the bar. No box, no color, no icon — they read as quiet metadata.

```
Served from cache              276
Geocoding (separate quota)   1,494
```

12px label/`dim` left, 12px value `#33363d` tabular-nums right. 12px gap above the first row, 4px between them.

> **Why no green check / no celebration:** cache savings aren't an event, they're a stat. Treating them like a completed task makes them feel boastful and visually competitive with the quota meter, which is the actual primary info.

### 4.4 Inline notices (only if applicable)
Render under secondary stats, **before** the cap row.

- **Over-quota:** `bg #fef2f2 / border #fecaca / text #991b1b`. Bullet `●` in danger, then "Cap reached. Previews paused until {next-reset-date}, or raise the cap below."
- **Rate-limit (transient):** `bg #fffbeb / border #fde68a / text #854d0e`. `↻` in warn, then "Google rate-limited the last request. Slowing down…"

If neither applies (and not invalid-key), render the **"Active on this page"** pill instead:
- `bg #f7f9fc / border line`. Left: green dot + "Active on this page" 12px/500. Right: per-page counter, 12px/`dim`/tabular-nums, format `{sv} sv · {cached} cached · {geo} geo`.

### 4.5 Cap row
- Top border `line`, 12px padding-top.
- `<input type="checkbox" defaultChecked>` (accent color) + "Enforce monthly cap of" + a number input (80px wide, right-aligned, tabular-nums, default `10000`).

### 4.6 Advanced (collapsible)
- Disclosure button: caret + "Advanced" + "{N} settings" right-aligned dim, 12px above with `line` top border.
- Open: 2-column grid, 14px gap, 4 fields:

| Label | Unit | Default | Hint |
|---|---|---|---|
| Pano radius | m | 10 | How far Google searches around the point. |
| Position rounding | m | 25 | Snap nearby positions to reuse cached images. |
| Min cursor move | m | 25 | Distance threshold before refetching. |
| Settle delay | ms | 100 | Wait for cursor to stop before fetching. |

Each field: 12px/500 label with `(unit)` in 12px/400/`dim`, 30px input below (full width, tabular-nums), then 12px/`dim` hint underneath.

> **Behavior:** these are the existing 4 settings. Don't rename storage keys; just match labels/hints/order. If your current code uses different defaults, **keep your defaults** — these are illustrative.

### 4.7 Footer — API key
- 14px margin-top, 10px padding-top, top border `line`.
- Collapsed (default): one row, 12px/`dim`. Caret + key icon + "API key configured" + tiny green check + "Edit" link on the right. Whole row is the click target.
- Expanded: a single 32px field below showing the masked key (`•••••••••••••••••••••••••• ` + last 5 chars), with an eye toggle on the right to reveal full key. Tapping the eye toggles between masked and full — no separate "Replace" button needed; the field accepts edits in place. (If your existing code requires explicit replace, add a small text "Replace" link to the right of the field — your call.)

---

## 5. Layout — First run

Replace the body (everything below the header) with the **onboarding card**:

- Outer container: `linear-gradient(180deg, #f7f9fc 0%, #f1f4f9 100%)`, 1px dashed `#c9cdd5`, 12px radius, 18px padding, centered text.
- Headline: "Paste your Google Maps API key" 17px/600/-0.01.
- Subhead: "The Street View Static API gives you 10,000 free requests every month." 12px/`dim`/1.5 line-height. Two lines (break before "10,000").
- Input + button row, 6px gap:
  - Input: full-flex, 38px tall, 8px radius, `#d6d9de` border, placeholder `AIza...`, autoFocus.
  - Save button: 38px tall, accent bg, white text, 600 weight, 16px horizontal padding.

Below the card (14px margin-top):
- Disclosure button: caret + "How to get an API key", in `accent`/13px/500. Right side: "3 min" in `dim`.
- Open: ordered list inside `bg #f7f9fc / radius 8 / 12px padding`, 12.5px font, 1.7 line-height:
  1. Open Google Cloud Console *(link with external-link icon, accent)*
  2. Create or select a project
  3. Enable **Street View Static API**
  4. Credentials → Create credentials → API key
  5. Restrict to Street View Static (recommended)
  6. Copy & paste the key above

> **Don't show:** "SETUP REQUIRED" eyebrow, "Welcome", any onboarding chrome. The headline carries it.

---

## 6. Layout — Invalid key

Render the invalid-key block at the top of the body **in place of the hero quota**. Then render the rest of the popup (cap row, advanced, footer-key) below it at **50% opacity** to indicate they're informational only.

- Block: `bg #fef2f2 / border #fecaca / radius 10 / padding 14`. Flex row, 10px gap.
- Left: 20×20 circle, `bg danger`, white "!" 13px/700, flex-shrink:0.
- Right column:
  - Title: "API key rejected by Google" 13px/600/`#991b1b`.
  - Body: "Last response: **REQUEST_DENIED**. The key may be invalid, restricted to a different API, or the Street View Static API isn't enabled." 12px/`#7f1d1d`/1.45.
  - Buttons row, 10px margin-top, 8px gap:
    - **Replace key** — danger bg, white text, 30px, 12px font, 500.
    - **Troubleshoot** — white bg, `#fecaca` border, `#991b1b` text, 30px, 12px font, 500. Links to a docs URL (your existing one — `docs/troubleshooting.md` or wherever).

---

## 7. Layout — Over quota

Same as Active, with three differences:
1. Hero number renders in `danger`.
2. "Monthly cap reached" 12px/`danger`/500 line under the number, before the bar.
3. Over-quota notice (4.4) renders under the secondary stats.

The "Active on this page" pill is **suppressed** in this state.

---

## 8. Behavior contract

Wire to your existing storage and message layer. The mockup uses dummy data; replace with real reads.

### Reads on popup open
```
storage.get([
  'apiKey',                  // string | null
  'apiKeyInvalid',           // bool — sticky flag set by background on REQUEST_DENIED
  'monthlyCap',              // number, default 10000
  'capEnforced',             // bool, default true
  'usage.{YYYY-MM}',         // {sv, cached, geo}
  'rateLimitedAt',           // timestamp | null — if within last 60s, show rate-limit notice
  'panoRadius',              // number, default 10
  'positionRounding',        // number, default 25
  'minCursorMove',           // number, default 25
  'settleDelay',              // number, default 100
])

// Per-page counters come from the active tab's content script (existing message)
```

### State decision (pseudo)
```js
if (!apiKey) return 'firstrun';
if (apiKeyInvalid) return 'invalidkey';
if (capEnforced && usage.sv >= monthlyCap) return 'overquota';
return 'active';
```

### Writes
- API key field: debounce 400ms, validate prefix `AIza`, save on blur or after debounce.
- Cap input: same as today.
- Advanced fields: same as today.
- "Reset" link in eyebrow: same as today (whatever current reset does).
- "Replace key" button (invalid-key state): clears `apiKey` AND `apiKeyInvalid`, returns popup to first-run state.

### Per-page counter format
`{sv} sv · {cached} cached · {geo} geo` — match the mockup. If your content script reports differently, adapt the format here, not the script.

---

## 9. Accessibility

- All collapsibles are `<button aria-expanded>`.
- API key field has `aria-label="Google Maps API key"` and the eye toggle has `aria-label="Show key" / "Hide key"`.
- Status dot: `aria-hidden="true"` (decorative). Adjacent text carries the status.
- Color is never the only signal:
  - Near-quota: amber + the literal numbers tell the story.
  - Over-quota: red + "Monthly cap reached" text + "Cap reached…" notice.
  - Invalid-key: red + circled "!" + the title text.
- Focus rings: use the browser default (don't `outline: none`). If you must restyle, ≥2px and `accent`-colored.

---

## 10. Don'ts (lessons from the redesign)

- **Don't** put cache hits in the quota bar. Cache = not billable.
- **Don't** show a "Cache saved 276 ✓" green panel. It implies a completed task.
- **Don't** show a "Setup required" / "Welcome" eyebrow on first run.
- **Don't** show a yellow near-quota banner. The amber number is enough.
- **Don't** introduce a monospace font anywhere — use `tabular-nums` on Inter Tight instead.
- **Don't** use any text smaller than 12px.
- **Don't** add new top-level features. This is a refresh, not a redesign of behavior.
