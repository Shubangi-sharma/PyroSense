# Design System — Industrial Thermal Intelligence Platform
### Codename: TERRA WATCH

---

## 1. Positioning & Design Philosophy

This is not a "fire tracker app." It is a **mission control / command center** product — the kind of interface a national disaster-response agency, a refinery operator, or a satellite-ops team would actually run on a wall display at 2 AM. The visual language should borrow from:

- Satellite ground station UIs (NASA JPL Eyes, ESA mission control)
- Military/aviation command dashboards (radar, ATC screens)
- Financial trading terminals (Bloomberg Terminal density, real-time tickers)

**Core principle:** *Dark, data-dense, calm by default, alarming only when it needs to be.* The UI should feel like it's always watching, and the only moments of visual loudness are genuine anomalies — never decoration. If everything is glowing red all the time, red means nothing. Restraint on 95% of the screen makes the 5% (a Critical alert) hit hard.

This directly encodes the product's own thesis — "don't just detect heat, tell me what deserves attention" — into the UI itself.

---

## 2. Color System

### 2.1 Base / Structural (dark mode only — no light mode)

| Token | Hex | Usage |
|---|---|---|
| `--bg-void` | `#05070A` | Outermost page background |
| `--bg-base` | `#0A0E14` | Main canvas / map container background |
| `--bg-surface` | `#10151D` | Cards, panels, sidebar |
| `--bg-surface-raised` | `#161C26` | Modals, dropdowns, hover states |
| `--bg-surface-inset` | `#0D1117` | Input fields, code/data blocks |
| `--border-hairline` | `#1E2732` | Default borders/dividers |
| `--border-strong` | `#2B3644` | Focused/emphasized borders |
| `--text-primary` | `#E6EBF2` | Headings, primary data |
| `--text-secondary` | `#8B96A5` | Labels, captions, metadata |
| `--text-tertiary` | `#5A6472` | Disabled, timestamps, placeholders |

### 2.2 Risk / Status Scale (the single most important color decision in the product)

This scale must be used **consistently everywhere** — map pins, facility cards, badges, the health score ring, timeline events. Never introduce a second "red" or "green" for unrelated UI (e.g. don't use this green for a generic "success" toast — invent a separate `--success` if needed).

| Status | Hex | Glow (box-shadow color, 40% opacity) | Meaning |
|---|---|---|---|
| 🟢 Normal | `#22C55E` | `#22C55E66` | Within historical baseline |
| 🟡 Watch | `#EAB308` | `#EAB30866` | Minor deviation, keep an eye |
| 🟠 Suspicious | `#F97316` | `#F9731666` | Meaningful deviation, needs review |
| 🔴 Critical | `#EF4444` | `#EF444499` (pulsing to 20%) | Immediate attention required |
| ⚪ Unknown/Unmapped | `#64748B` | none | New/unclassified site |

**Rule:** Critical is the only status allowed to animate (a slow 2s pulse on the glow, never on the icon shape itself — nothing should "jitter"). Normal/Watch/Suspicious are always static. This keeps the map calm except where it genuinely shouldn't be.

### 2.3 Accent / Brand

| Token | Hex | Usage |
|---|---|---|
| `--accent-primary` | `#3B82F6` (cool signal blue) | Primary buttons, active nav state, selected facility outline, links |
| `--accent-secondary` | `#06B6D4` (cyan) | Satellite-data-specific elements (Sentinel/Landsat badges), secondary chart lines |
| `--accent-violet` | `#8B5CF6` | AI/explainability features only — "AI Summary," "Explain Incident," anything model-generated gets a violet accent so users always know "this sentence was generated, not measured" |

This violet-for-AI-output convention matters: it visually separates *raw sensor fact* (blue/cyan) from *AI interpretation* (violet), which reinforces the "Explainable AI" pillar without needing a label every time.

### 2.4 Data Visualization Palette (charts, FRP graphs, timelines)

Sequential heat scale for continuous data (e.g. FRP intensity gradients on the map or in charts):
`#1E3A8A → #2563EB → #06B6D4 → #FACC15 → #F97316 → #DC2626 → #7F1D1D`
(cool blue = cold/no signal, through to deep red = extreme thermal output). This is distinct from the discrete Risk Scale above — the Risk Scale is for *classification*, this gradient is for *raw magnitude* (e.g. shading FRP heatmap overlays).

---

## 3. Typography

| Role | Font | Weight | Size / Line-height | Tracking |
|---|---|---|---|---|
| Display (hero numbers, e.g. "14,238 Facilities") | **Space Grotesk** | 600 | 48px / 52px | -0.02em |
| H1 (page/section titles) | Space Grotesk | 600 | 28px / 34px | -0.01em |
| H2 (panel headers, e.g. "WHAT CHANGED?") | Space Grotesk | 600 | 16px / 22px, all-caps | 0.06em |
| Body | **Inter** | 400 | 14px / 20px | 0 |
| Body strong | Inter | 600 | 14px / 20px | 0 |
| Caption / metadata (timestamps, coords) | **JetBrains Mono** | 400 | 12px / 16px | 0 |
| Data readouts (FRP values, lat/long, scores) | JetBrains Mono | 500 | 14–32px depending on context | 0 |

**Rationale:** Space Grotesk gives the product a slightly technical, aerospace-adjacent personality without being a cliché "hacker" font. JetBrains Mono for anything numeric (coordinates, scores, timestamps, FRP values) reinforces "this is measured data" vs Inter for prose/UI chrome. This mono/sans split is a load-bearing part of the visual identity — never render a raw sensor number in Inter.

---

## 4. Layout — Overall Application Shell

Desktop-first (this is an ops tool, optimize for 1440px+ wide monitors; tablet is secondary, mobile is a read-only companion view).

```
┌────────────────────────────────────────────────────────────────────────────┐
│  TOP BAR  (56px height, --bg-surface, border-bottom hairline)              │
│  [Logo/Wordmark]   [Global search]        [Live ticker]   [Alerts] [User]  │
├───────────┬──────────────────────────────────────────────────┬─────────────┤
│           │                                                  │             │
│  LEFT     │              MAIN MAP CANVAS                     │  RIGHT      │
│  NAV      │              (fills remaining space,             │  INTEL      │
│  (72px    │               min 60% of viewport width)         │  PANEL      │
│  collapsed│                                                  │  (360px     │
│  /240px   │   - India command view by default                │  fixed,     │
│  expanded)│   - World map toggle for "simulation mode"        │  --bg-      │
│           │   - Floating legend, bottom-left                 │  surface)   │
│  Icon nav │   - Floating layer toggle, top-right              │             │
│  stack    │                                                  │  Selected   │
│           │                                                  │  facility   │
│           │                                                  │  detail OR  │
│           │                                                  │  fleet      │
│           │                                                  │  summary    │
├───────────┴──────────────────────────────────────────────────┴─────────────┤
│  BOTTOM TIMELINE STRIP (88px height, collapsible to 0)                      │
│  [Play ▶] [======●===========] Yesterday — Now — +6h    [Incident markers] │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Grid specifics
- **Container**: 12-column grid, 24px gutters, 32px outer margin on ≥1440px; 16px margin below 1024px.
- **Top bar**: height 56px fixed, `z-index: 50`, background `--bg-surface`, 1px bottom border `--border-hairline`.
- **Left nav**: width 72px collapsed (icon-only, tooltip on hover) / 240px expanded (icon + label). Toggle button pinned at bottom of nav. Icons: Command Dashboard, Facility Explorer, Incidents, Timeline Replay, Reports, Settings.
- **Main map canvas**: flexible width, minimum 60vw. Corner radius 0 (map is edge-to-edge within its container, no rounded corners — it should feel like a sensor feed, not a widget). Uses `--bg-base`.
- **Right intel panel**: fixed 360px width on desktop, becomes a bottom sheet on tablet/mobile. Padding 20px. Scrollable independently of the map.
- **Bottom timeline strip**: 88px height, `--bg-surface`, 1px top border. Collapsible via a chevron tab centered on its top edge. This is where "Timeline Replay" and "Incident Story Engine" live.

---

## 5. The World Map (Simulation Mode) — Detailed Spec

The brief explicitly asks for a world map for simulation purposes (distinct from the India-focused production command view). Treat it as a **mode toggle** on the same map component, not a separate page.

### 5.1 Toggle
- Top-right floating pill control on the map: `[ India ] [ Global Simulation ]` — segmented control, `--bg-surface-raised` background, active segment filled `--accent-primary` at 15% opacity with `--accent-primary` text and a 1px `--accent-primary` border.

### 5.2 Base map styling
- Use a **custom dark vector basemap** (e.g., Mapbox "Dark" style or MapLibre + a dark GL style, or CARTO Dark Matter tiles) — never a default light OSM tile layer. Land: `#0D1117`. Country borders: `#1E2732`, 0.5px. Ocean/water: `#05070A` (slightly darker than land so landmass reads clearly). Labels (country/city names): `--text-tertiary`, hidden below a zoom threshold to reduce clutter.
- No satellite photo imagery as the base layer — keep it abstract/vector so hotspot markers stay legible. Satellite imagery (Sentinel/Landsat) appears only as an on-demand overlay for a *selected* facility, not as the world backdrop.

### 5.3 Facility & hotspot markers on the globe
- Each facility = a circular marker, 10px diameter at default zoom, color = current Risk Scale status (§2.2), with the glow effect as specified. Clustering at low zoom: clusters render as a slightly larger ring showing count (e.g. "34"), colored by the *highest* risk status within the cluster (so a cluster containing one Critical facility shows red, even if the other 33 are green) — this ensures critical events are never hidden by clustering.
- Hover: marker scales to 14px, tooltip card appears (facility name, type, current status, thermal health score) — tooltip uses `--bg-surface-raised`, 8px corner radius, 1px `--border-strong`.
- Click: marker gets a 2px `--accent-primary` selection ring, right Intel Panel populates with full facility detail, map optionally flies-to and zooms.

### 5.4 Simulation-specific chrome
Because this is explicitly a *simulation* view (for demo/judging purposes), make that legible rather than pretending it's live global coverage:
- A persistent small badge top-left of the map, `SIMULATION MODE`, `--accent-violet` text on `--bg-surface-raised`, so it's never confused with the real India production feed.
- The bottom timeline strip becomes the star of this mode: scrubbing it animates marker colors/positions changing over simulated time (this is the "Timeline Replay" feature from the brief — drag slider, watch heat evolve across Yesterday → Now → +6h). Use smooth 300–500ms color transitions on markers as the slider moves, not instant snaps — reinforces "evolution," not "toggle."
- Include 3–5 pre-scripted demo scenarios accessible from a small dropdown ("Load scenario: Refinery Explosion — Gujarat" / "Load scenario: Wildfire vs Industrial — Indonesia" / "Load scenario: Gas Flare Baseline — Middle East") so judges can trigger a compelling story without needing real data.

### 5.5 Map layer toggles (top-right, below the mode switch)
Icon toggle stack, each a 32×32px button in `--bg-surface-raised`, active state gets `--accent-primary` icon color + 15% bg fill:
- Thermal hotspots (FIRMS layer)
- Facility boundaries (OSM industrial polygons)
- Land cover
- FRP heatmap gradient overlay (uses the sequential palette in §2.4)

---

## 6. Core Component Specs

### 6.1 Facility Card (used in lists, right panel, search results)
- Container: `--bg-surface`, 12px corner radius, 16px padding, 1px `--border-hairline`, hover → `--border-strong` + subtle 2px lift shadow.
- Layout: left-aligned 8px status-color dot + facility name (Inter 600, 14px) on top row; facility type + location as secondary text row (Inter 400, 12px, `--text-secondary`); right-aligned Thermal Health Score as a compact circular ring gauge (32px diameter, stroke = status color, center number in JetBrains Mono 500, 13px).

### 6.2 Thermal Health Score Ring (hero component, used big in Intel Panel)
- 120px diameter circular progress ring, 8px stroke width, track color `--border-hairline`, progress color = current status color, rounded stroke caps.
- Center: large score number (Space Grotesk 600, 32px) + "/100" (Inter 400, 14px, `--text-secondary`) beneath it, and a status word badge below that (e.g. "WATCH") as a pill: 4px vertical / 10px horizontal padding, background = status color at 15% opacity, text = status color, uppercase, 11px, letter-spacing 0.06em.

### 6.3 "What Changed?" Panel
- List of rows, each: a checkmark (✅, `--Normal-green`) or warning triangle (⚠, matching the deviation's severity color) icon at 16px, followed by Inter 400 14px text. Rows separated by 1px `--border-hairline`. Deviation magnitude (e.g. "+214%") rendered in JetBrains Mono 500, color-coded to severity, right-aligned on its row.

### 6.4 Incident Story Engine / AI Summary block
- Distinct visual treatment from the rest of the UI to signal "generated content": `--bg-surface-raised` background, left border 3px solid `--accent-violet`, 16px padding, corner radius 8px (only on the non-border side, i.e. `border-radius: 0 8px 8px 0`). A small violet spark/sparkle icon + "AI Summary" label (Inter 600, 11px, uppercase, `--accent-violet`) sits above the generated paragraph text (Inter 400, 14px, `--text-primary`, slightly increased line-height 22px for readability since this is prose, not data).
- The incident timeline itself (10:20 AM → 12:05 PM style vertical sequence) uses a vertical connector line (`--border-strong`, 2px) with 8px circular nodes color-coded by event severity, timestamp in JetBrains Mono to the left, event description in Inter to the right.

### 6.5 India-Level Command Dashboard Summary Bar
- A horizontal strip of 6 stat tiles (Facilities Monitored / Thermal Hotspots / Known Persistent / New Anomalies / High-Risk / Critical), each tile: `--bg-surface`, 12px radius, equal-width in a flex row with 16px gaps. Big number in Space Grotesk 600 28px, label beneath in Inter 400 12px uppercase `--text-secondary`. The last two tiles (High-Risk, Critical) get their number colored orange/red respectively instead of default `--text-primary` — everything else stays neutral so the eye is drawn to what matters.

### 6.6 Risk Priority List
- A ranked table/list (Facility C → Critical, Facility B → High, Facility A → Low from the brief): each row is full-width, left edge has a 4px solid color bar in the status color, rank number in a small circle badge, facility name, one-line reason ("New hotspot + high FRP + storage-zone activity"), and a right-aligned "Investigate →" text button in `--accent-primary` that only appears on row hover.

### 6.7 Buttons
- Primary: `--accent-primary` fill, white text, 8px radius, 10px/20px padding, Inter 600 14px. Hover: brightness +8%.
- Secondary/ghost: transparent fill, 1px `--border-strong`, `--text-primary` text. Hover: `--bg-surface-raised` fill.
- Destructive/Critical action (e.g. "Escalate Now"): `#EF4444` fill, used sparingly — only for actions tied to actual Critical-status facilities.

### 6.8 Alerts / Toasts
- Slide in from top-right, `--bg-surface-raised`, left border 4px = status color, 12px radius, drop shadow `0 8px 24px rgba(0,0,0,0.4)`. Critical alerts additionally get a single soft audio chime cue (optional, user-toggleable) — never looping/repeating sounds.

---

## 7. Motion Principles

- Default transition: 150–200ms ease-out for hovers, 300ms ease-in-out for panel open/close and map fly-to.
- The ONLY looping/ambient animation permitted anywhere in the product is the Critical-status glow pulse (§2.2). Everything else is response-to-action only. This is a deliberate contrast to typical dashboards that animate everything — stillness here is a feature, communicating "nothing to worry about."
- Timeline scrubbing: marker color/position interpolation should feel fluid (use requestAnimationFrame-driven tweening, not discrete jumps) — this single interaction is the demo's "wow moment" per the brief, so it deserves the most animation polish in the whole product.

---

## 8. Iconography

- Use a single consistent icon set (Lucide or Phosphor, "duotone"/regular weight, 1.5px stroke) throughout — never mix icon libraries.
- Status icons (dot/triangle/circle) are custom-drawn simple shapes, not from the icon library, so they can be perfectly color- and size-matched to the Risk Scale.

## 9. Accessibility & Practical Notes

- Do not rely on color alone for risk status — always pair color with a text label or icon shape (dot vs triangle vs octagon) for colorblind users, since red/green/orange confusion is a real risk-communication failure mode here.
- Minimum contrast: body text `--text-primary` on `--bg-surface` exceeds WCAG AA; `--text-tertiary` should only be used for non-critical metadata, never for anything a user must act on.
- All data-dense screens should support keyboard navigation between facility list rows (this is an ops tool — power users will not want to be mouse-only).