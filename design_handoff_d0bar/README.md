# Handoff: d0bar — Dash0 in-page observability toolbar

## Overview
An overlay button + expandable toolbar that Dash0 injects into a customer's own web app. It
shows, for the current page: every network request on a page-relative waterfall, the browser's
Core Web Vitals with attribution, the requests that produced **no** span, and a per-request
distributed-trace waterfall.

The governing constraint — and the reason for nearly every design decision — is that **the
toolbar must not distort what it measures**. A toolbar that patches \`fetch\`, flattens a
4000-span trace on the main thread, and adds 40 ms to INP is lying to you about your own INP.
So: browser-recorded measurements over self-instrumented ones, observation without
interception, heavy work off the main thread. The UI states this out loud in its footer strip
(\`fetch unpatched\`, \`Δ INP 0.0ms\`, \`flattened in worker · 0 ms on main thread\`) — that
copy is load-bearing, not decoration. Keep it, and keep it true.

## About the Design Files
The files in this bundle are **design references created in HTML** — a prototype of the
intended look and behavior, not production code to copy. Recreate the design in the target
codebase using its established framework, patterns, and libraries (the real d0bar ships as an
injected widget, so expect a Shadow DOM + web component or an isolated React root rather than
this flat DOM). If no environment exists yet, pick the most appropriate one for an injected
third-party widget and implement there.

\`d0bar.dc.html\` is a prototype-format file: markup with \`{{ value }}\` holes plus a small
logic class at the bottom of the file holding all mock data and derived values. Read the logic
class for the exact data shapes; read the markup for exact layout and styling.

## Fidelity
**High-fidelity.** Colors, typography, spacing, sizes, and interaction states are final and
should be reproduced closely. All colors come from the Dash0 design system's CSS custom
properties — use the real tokens from the codebase rather than the resolved hex values.

## Non-negotiable engineering constraints
These are requirements, not implementation suggestions. The design is dishonest without them.

1. **Never patch \`fetch\` or \`XMLHttpRequest\`.** Request data comes from
   \`PerformanceObserver\` \`resource\` entries (with \`buffered: true\`, hence the
   \`buffered: true\` label in the tab row) and, where available, a Service Worker that
   observes \`fetch\` events **without calling \`respondWith\`** — observation, not
   interception. The footer's \`fetch unpatched\` claim must remain literally accurate.
2. **All vitals are browser-recorded.** LCP, CLS, INP, and long-animation-frame counts come
   from \`PerformanceObserver\` entry types (\`largest-contentful-paint\`, \`layout-shift\`,
   \`event\`, \`long-animation-frame\`) including their attribution fields. d0bar computes no
   timing of its own.
3. **Trace flattening happens in a Web Worker.** Parsing and laying out a trace (potentially
   thousands of spans) must never run on the main thread. Post the raw trace to a worker,
   receive a flat array of positioned rows, render. Target: 0 ms main-thread cost, which is
   what the trace header asserts.
4. **A declared, ordered observation stack.** Four tiers, ordered by how invasive they are —
   the UI names all four and shows which are live, so the user always knows what the numbers
   are made of:
   - **Tier 1 — \`PerformanceObserver\`** (live, always available). Nothing intercepted.
   - **Tier 2 — Service Worker** (live when the scope is uncontested). Observes \`fetch\`
     events **without \`respondWith\`**; adds traceparent correlation and reveals
     never-instrumented requests. When unavailable the UI must **say so and degrade visibly** —
     no correlation, no trace jump — rather than silently showing a thinner picture.
   - **Tier 3 — Server-Timing** (planned, slot reserved in the UI). Read the trace id the
     backend echoes in its \`Server-Timing\` header, straight off the resource entry:
     correlation with zero interception, but the backend must opt in.
   - **Tier 4 — host OTel SDK** (planned, slot reserved). Adopt client spans from the host
     app's own OpenTelemetry browser SDK **if one is already installed**. d0bar must never
     install it — that SDK patches \`fetch\`, and the cost belongs to whoever chose it.

   Tiers 3 and 4 are rendered now, in a "planned" state (hollow dot, label at ~52% opacity),
   so the stack reads as a roadmap rather than a shrug. Implement 1 and 2; keep 3 and 4 as
   declared-but-inactive slots until they ship.
5. **Honest empty states.** Three distinct outcomes when opening a request, never conflated:
   trace found; trace not yet queryable (ingest lag → retry with backoff); no span exists at
   all (never instrumented). Each has its own panel state in the design.
6. **Contained rendering.** The overlay root uses \`contain: layout paint style\` so the
   toolbar can never trigger layout or paint work in the host page.

## Screens / Views

### 0. Host page (reference only — do NOT build)
The prototype includes a fake customer app ("Northwind Freight": light sidebar + shipment
detail, \`#f4f4f2\` background, its own green \`#2f6f5e\` brand) purely to show the toolbar
sitting over *someone else's* website. It is scaffolding for the mock. Ignore it, except as
evidence that the toolbar must not inherit or leak host styles.

### 1. Collapsed pill
**Purpose:** ambient, glanceable status; click to expand.

- Position: fixed, \`left: 24px; bottom: 22px\`. Height **34px**, \`border-radius: 999px\`,
  \`background: var(--lvl-1-bg)\`, \`1px solid var(--lvl-1-stroke)\`, \`box-shadow: var(--shadow-lg)\`.
  Padding \`0 6px 0 8px\`, flex row, \`gap: 9px\`.
- Hover: \`border-color: var(--lvl-1-hover-stroke)\`, \`background: var(--lvl-1-hover-bg)\`.
- Contents, left to right:
  1. **Logo mark** — 20px circle, \`2px solid var(--cta-bg)\` ring with a centered 6px
     \`var(--cta-bg)\` dot.
  2. \`11px\` mono, \`var(--lvl-0-intense-text)\`, tabular-nums: **"11 req"**.
  3. 1px × 14px \`var(--lvl-1-stroke)\` divider.
  4. Vitals worst-offender: 5px dot \`var(--warning-bg)\` + \`11px\` mono
     \`var(--lvl-0-text)\`: **"LCP 4.53s"**. Dot color follows the worst vital's threshold
     bucket (healthy / warning / error).
  5. Untraced badge — 22px tall pill, \`background: var(--lvl-2-bg)\`, \`10px\` mono
     \`var(--warning-text-inline)\`: **"3 untraced"**. Hidden when the count is 0.
- The pill is the whole click target (toggles the panel). It sits **below** the panel in the
  same bottom-anchored flex column, \`gap: 10px\` — so the panel grows upward.

### 2. Panel shell
- **620px** wide (fixed), \`border-radius: 12px\`, \`background: var(--lvl-1-bg)\`,
  \`1px solid var(--lvl-1-stroke)\`, \`box-shadow: var(--shadow-2xl)\`, \`overflow: hidden\`.
- Entry animation \`d0-rise\`: \`.18s ease-out\`, from \`opacity: 0; translateY(8px) scale(.985)\`
  to resting.
- **Header, 42px:** padding \`0 12px 0 14px\`, \`background: var(--lvl-1-subtle-bg)\`, bottom
  \`1px solid var(--lvl-1-stroke)\`. Left: "d0bar" at \`13px/600\`,
  \`var(--lvl-0-intense-text)\`, \`letter-spacing: -.01em\`. Next to it the current URL in
  \`11px\` mono \`var(--lvl-subtle-text)\` (\`northwind-freight.app/shipments/8821\`). Right:
  \`⌘⇧0\` hint in \`10px\` mono, then a 22px square close button (\`✕\`, transparent →
  \`var(--lvl-1-hover-bg)\` on hover, \`border-radius: 5px\`).
- **Keyboard:** \`⌘⇧0\` toggles the panel. Escape closes; from the trace view Escape should go
  back to the list first.
- **Footer observer strip** (see below) is pinned at the bottom of the panel in every view.

### 3. Tab row (list view only), 36px
Padding \`0 8px\`, \`gap: 2px\`, bottom \`1px solid var(--lvl-1-stroke)\`. Each tab is a
borderless button, \`12px\` sans, padding \`0 10px\`. Inactive \`var(--lvl-subtle-text)\`;
active \`var(--lvl-0-intense-text)\` + a 2px underline drawn as
\`box-shadow: inset 0 -2px 0 0 var(--cta-bg)\`.

- **Requests** + count \`11\` in \`10px\` mono \`var(--lvl-subtle-text)\`.
- **Vitals**.
- **Untraced** + badge: \`min-width: 15px; height: 15px\`, \`border-radius: 4px\`,
  \`background: var(--warning-bg)\`, \`color: var(--warning-text)\`, \`10px\` mono, showing
  \`3\`. On hover the tab shows a **styled popover** (see Tooltips): "**3 of 11 requests** on
  this page produced no span." Badge hidden at 0; the tab stays.
- Right-aligned: \`buffered: true\` in \`10px\` mono \`var(--lvl-subtle-text)\` — a deliberate
  signal that entries recorded before d0bar loaded are included.

### 4. Requests tab
A 5-column grid, identical template in header and rows:
\`grid-template-columns: 44px 1fr 40px 54px 210px; gap: 10px; white-space: nowrap\`.

- **Column header:** padding \`5px 14px\`, \`10px\` mono \`var(--lvl-subtle-text)\`, bottom
  \`1px solid var(--lvl-1-subtle-stroke)\`. Labels: \`trace\`, \`request\`, \`status\`,
  \`dur\` (right-aligned), \`0 → 3.0s\`.
- **Rows:** padding \`3px 14px\` (deliberately dense — ~21px tall), bottom
  \`1px solid var(--lvl-1-subtle-stroke)\`, \`cursor: pointer\`, hover
  \`background: var(--lvl-1-hover-bg)\`. Scroll container \`max-height: 288px\`.
- **Trace chip (col 1)** — strictly sized **44 × 15px**, \`border-radius: 3px\`, centered
  \`9px\` mono, \`letter-spacing: .04em\`:
  - has a span → \`TRACE\`, \`color: var(--cta-text-inline)\`,
    \`background: color-mix(in oklab, var(--cta-bg) 22%, transparent)\`
  - no span → \`NONE\`, \`color: var(--warning-text-inline)\`,
    \`background: color-mix(in oklab, var(--warning-bg) 18%, transparent)\`
- **Request (col 2):** baseline-aligned flex, \`gap: 6px\`, \`min-width: 0\`. Method in
  \`9px\` mono \`var(--lvl-subtle-text)\`, fixed \`width: 26px\`. Path in \`10px\` mono
  \`var(--lvl-0-intense-text)\`, ellipsized. Then a \`10px\` mono \`xhr\` marker
  (\`var(--lvl-subtle-text)\`) for XHR requests only.
- **Status (col 3):** \`10px\` mono. 2xx → \`var(--healthy-text-inline)\`; 304 →
  \`var(--lvl-subtle-text)\`; 5xx → \`var(--error-text-inline)\`.
- **Duration (col 4):** \`10px\` mono \`var(--lvl-0-text)\`, right-aligned, tabular-nums.
  Format: \`<1000ms\` → \`412ms\`; else \`1.24s\` (2 dp).
- **Waterfall (col 5):** 210px track, 6px tall, \`border-radius: 2px\`,
  \`background: var(--lvl-1-subtle-bg)\`. The bar is absolutely positioned with
  \`left = start/3000 * 100%\` and \`width = max(1.2%, dur/3000 * 100%)\` — i.e. a fixed
  **3000 ms page-relative window shared by every row**, so bars are directly comparable.
  Inside, phase segments as flex children (\`overflow: hidden\` on the bar so the radius clips):
  connect \`var(--neutral-500)\` ≈9% (6% for XHR), wait \`var(--purple-500)\` ≈62%, transfer
  \`var(--light-blue-600)\` remainder. **Error rows are solid \`var(--error-bg)\`** with wait
  inflated to ~86%. In production, derive these from the resource entry's real phase timings
  (\`connectStart\`/\`requestStart\`/\`responseStart\`/\`responseEnd\`).
- Clicking a row opens the trace view for it.

Mock rows (method, path, kind, status, start ms, dur ms, has-span):
\`\`\`
GET  /api/shipments?status=open     fetch 200   60   412  yes
POST /api/shipments/8821/hold       fetch 200  180   233  yes
GET  /api/rates/quote               fetch 500  300  1240  yes   (error styling)
GET  /api/customers/4410            fetch 200  340    88  yes
GET  /legacy/export.csv             xhr   200  420  2100  no
GET  /api/fleet/positions           fetch 304  700    41  yes
POST /api/shipments/8821/reprice    fetch 200 1980   690  yes   (ingest-lag state)
POST /legacy/audit                  xhr   204 1140   130  no
GET  cdn.stripe.com/v3              fetch 200 1260   156  no
GET  /api/notifications             fetch 200 1500    62  yes
GET  /api/shipments/8821            fetch 200 1700   174  yes
\`\`\`

### 5. Vitals tab
Padding \`14px\`. Four equal cards (\`repeat(4, 1fr)\`, \`gap: 10px\`): \`var(--lvl-2-bg)\`,
\`1px solid var(--lvl-2-stroke)\`, \`border-radius: 8px\`, padding \`10px 12px\`. Each card:
name in \`10px\` mono \`var(--lvl-subtle-text)\`; value in \`20px\` mono tabular-nums, colored
by threshold; attribution in \`11px\` sans \`var(--lvl-subtle-text)\`, \`line-height: 1.35\`.

| Vital | Value | Color | Attribution line |
|---|---|---|---|
| LCP | 4.53s | \`var(--warning-text-inline)\` | element: img.hero-map · TTFB 1.9s |
| CLS | 0.04 | \`var(--healthy-text-inline)\` | largest shift: rate table |
| INP | 112ms | \`var(--healthy-text-inline)\` | target: button.confirm-hold |
| LoAF | 3 | \`var(--lvl-0-intense-text)\` | longest 84ms · quote render |

Below, a provenance note (padding \`10px 12px\`, \`var(--lvl-1-subtle-bg)\`,
\`1px solid var(--lvl-1-stroke)\`, \`border-radius: 8px\`, \`11px\`/1.5): "Every number here is
read from the browser's own \`PerformanceObserver\` entries: LCP, layout-shift, event and
long-animation-frame, with attribution. d0bar records nothing itself." The attribution strings
must come from the real entry attribution fields, never from a guess.

### 6. Untraced tab
Padding \`14px\`. Headline: \`20px\` mono \`var(--warning-text-inline)\` "3 of 11" +
\`12px\` sans \`var(--lvl-0-text)\` "requests on this page produced no span."
Then one card per gap: \`grid-template-columns: 18px 1fr; gap: 10px\`, padding \`9px 11px\`,
\`var(--lvl-2-bg)\`, \`1px solid var(--lvl-2-stroke)\`, \`border-radius: 8px\`. 6px
\`var(--warning-bg)\` dot (\`margin-top: 5px\`), URL in \`11px\` mono
\`var(--lvl-0-intense-text)\`, cause below in \`11px\` \`var(--lvl-subtle-text)\`/1.4.

- \`GET /legacy/export.csv\` — "XMLHttpRequest — the SDK instruments fetch only, so no
  traceparent was attached."
- \`POST /legacy/audit\` — "XMLHttpRequest — same cause. Seen by the Service Worker, absent
  from the backend."
- \`GET cdn.stripe.com/v3\` — "Outside your PropagatorConfig.match list — deliberately not
  propagated."

Closing note, \`11px\` \`var(--lvl-subtle-text)\`/1.5: "Only the Service Worker can see these —
the un-instrumented request never reaches the backend, so no amount of querying Dash0 would
surface them." **This tab is the strongest argument for tier 2** and should distinguish causes
(wrong transport vs. deliberate propagator exclusion), never lump them as "missing".

### 7. Trace view
Replaces the tab row + tab body; reached by clicking a request row.

- **Sub-header** (padding \`10px 14px\`, bottom \`1px solid var(--lvl-1-stroke)\`): a
  "← requests" back button — 22px tall, padding \`0 8px 0 6px\`, \`1px solid var(--lvl-2-stroke)\`,
  \`border-radius: 5px\`, \`var(--lvl-2-bg)\`, \`11px\` sans \`var(--lvl-0-text)\`; hover raises
  border to \`var(--lvl-2-hover-stroke)\` and text to \`var(--lvl-0-intense-text)\`. Then
  \`METHOD /path\` in \`11px\` mono \`var(--lvl-0-intense-text)\`, ellipsized. Right-aligned:
  the trace id in \`10px\` mono \`var(--lvl-subtle-text)\`
  (\`4bf92f3577b34da6a3ce929d0e0e4736\`), or the literal string \`no traceparent\` when absent.

**7a. Trace found**
- Meta row (padding \`9px 14px\`, \`10px\` mono \`var(--lvl-subtle-text)\`, \`gap: 14px\`,
  bottom \`1px solid var(--lvl-1-subtle-stroke)\`): \`7 spans\`, \`4 services\`, \`3 logs\`,
  \`timeRange ±2s\`, and right-aligned in \`var(--healthy-text-inline)\`:
  \`flattened in worker · 0 ms on main thread\`. (\`timeRange ±2s\` documents the bounded
  query window used to find the trace — keep it.)
- Span rows: \`grid-template-columns: 300px 1fr 56px; gap: 10px\`, padding \`6px 14px\`, hover
  \`var(--lvl-1-hover-bg)\`; scroll container \`max-height: 300px\`, padding \`4px 0\`.
  Col 1: \`padding-left: depth * 14px\`, a 6px rounded (\`2px\`) service swatch, span name in
  \`11px\` mono (root \`var(--lvl-0-intense-text)\`, others \`var(--lvl-0-text)\`), then service
  name in \`10px\` mono \`var(--lvl-subtle-text)\`. Col 2: 10px track,
  \`var(--lvl-1-subtle-bg)\`, bar positioned by percent, filled with the service color. Col 3:
  duration, \`10px\` mono, right-aligned, tabular-nums.
  Span colors come from the chart categorical palette: \`var(--palette-auto-<n>-fill)\`,
  assigned **per service** so a service keeps one color down the tree.
- Mock spans (name, service, depth, left%, width%, dur, palette index):
\`\`\`
GET /shipments/8821   browser · webEvent  0   0 100  412ms  4
HTTP GET /api/shipments  edge-gateway     1   4  92  396ms  1
GET /shipments        shipments-api       2   9  79  340ms  0
SELECT shipments      postgres            3  14  32  137ms  5
GET /rates/{corridor} pricing-svc         3  48  36  155ms  2
GET rate:eu:nl-de     redis               4  52   6    3ms  3
SELECT tariffs        postgres            4  60  22   94ms  5
\`\`\`
  Note the root span is the **browser \`webEvent\`** span — the browser is part of the trace,
  not a caller outside it.
- Correlated-log footer (padding \`9px 14px\`, top \`1px solid var(--lvl-1-subtle-stroke)\`,
  \`var(--lvl-1-subtle-bg)\`): \`WARN\` in \`10px\` mono \`var(--error-text-inline)\`, message in
  \`11px\` mono \`var(--lvl-0-text)\` ellipsized ("tariff cache miss for corridor NL-DE,
  falling back to pricing-svc"), right-aligned link "3 correlated logs".

**7b. No span exists** (untraced request, or tier 2 unavailable)
Centered column, padding \`24px 14px 22px\`, \`gap: 9px\`: a 22px circle with
\`1px dashed var(--warning-bg)\`; \`12px\` \`var(--lvl-0-intense-text)\` "No span exists for
this request."; a \`11px\` \`var(--lvl-subtle-text)\` cause line, \`max-width: 44ch\` — the
transport/propagator reason for untraced requests, or "Tier 2 is unavailable on this origin,
so d0bar never saw a traceparent. It says so rather than guessing." when degraded; then
\`10px\` mono "seen by the SW · never reached the backend".

**7c. Waiting for ingest** (span exists, not yet queryable)
Centered column, padding \`26px 14px 22px\`, \`gap: 10px\`: three 6px \`var(--cta-bg)\` dots
pulsing on the \`d0-pulse\` keyframe (\`opacity .35 → 1 → .35\`, \`1.1s ease-in-out infinite\`,
staggered \`0 / .18s / .36s\`); \`12px\` \`var(--lvl-0-intense-text)\` "Trace not queryable yet —
waiting for ingest."; \`11px\` mono \`var(--lvl-subtle-text)\` "retry 2 of 5 · next in 1.6s ·
backoff"; \`11px\` explanation \`max-width: 40ch\`: "The request finished 700 ms ago. d0bar
retries on a backoff and cancels in flight if you click another request."
**Behavior:** exponential backoff, max 5 attempts, and the in-flight query is **aborted** when
the user selects another request. Never show a spinner that implies the trace is missing.

### 8. Footer observer strip (all views)
32px, padding \`0 14px\`, \`gap: 14px\`, top \`1px solid var(--lvl-1-stroke)\`,
\`var(--lvl-1-subtle-bg)\`, \`10px\` mono \`var(--lvl-subtle-text)\`, \`white-space: nowrap\`
(labels must stay on one line at 620px).
Left side: the four-tier observation stack as one flex row, \`gap: 11px\`, each item a 5px dot
+ label, \`cursor: help\`, with its own popover on hover:
\`1 PerformanceObserver\`, \`2 SW\` (or \`2 SW off\` when degraded), \`3 Server-Timing\`,
\`4 OTel SDK\`. Dot and label per state:
- **live** — dot \`background: var(--healthy-bg)\`, label \`var(--lvl-subtle-text)\`
- **off** — dot \`background: var(--warning-bg)\`, label \`var(--lvl-subtle-text)\`,
  popover title in \`var(--warning-text-inline)\`
- **planned** — dot transparent with \`box-shadow: inset 0 0 0 1px var(--lvl-2-hover-stroke)\`
  (a hollow ring), label
  \`color-mix(in oklab, var(--lvl-subtle-text) 52%, transparent)\`

Right-aligned: \`Δ INP 0.0ms\` in \`var(--healthy-text-inline)\`, \`cursor: help\`, with the INP
popover on hover. The whole row measures 618px of the 618px available at the 620px panel width
— adding a fifth label would overflow, so any new tier replaces a label rather than joining it.

Tier popovers use the same styling as the other two, 258px wide, opening upward from
\`left: -8px\` with the arrow at \`left: 14px\`. Copy (title + body) is in the logic class
under \`tiers\`; it is explanatory copy that carries the architecture and should be kept.

## Interactions & Behavior
- **Pill click** → toggle panel (\`d0-rise\` in; panel grows upward from the pill).
- **Close ✕** → collapse to pill. **\`⌘⇧0\`** → toggle. **Escape** → back, then close.
- **Tab click** → switch list body; tab underline moves.
- **Request row click** → trace view for that request, resolving to state 7a / 7b / 7c.
- **"← requests"** → back to the list, preserving scroll position and active tab.
- **Row hover** → \`var(--lvl-1-hover-bg)\`. **Button hovers** as specified per component.
- **Tooltips** (2): styled popovers, not native \`title\`. \`var(--lvl-3-bg)\`,
  \`1px solid var(--lvl-3-stroke)\`, \`border-radius: 7px\`, \`box-shadow: var(--shadow-xl)\`,
  \`11px\` sans/1.45 \`var(--lvl-0-text)\`, \`d0-rise .12s ease-out\`, with a 7px 45°-rotated
  square arrow using two borders. Untraced tab: 216px wide, opens **down**
  (\`top: calc(100% + 7px); left: 4px\`), arrow at \`left: 22px\`. INP: 268px wide, opens **up**
  (\`bottom: calc(100% + 8px); right: -2px\`), arrow at \`right: 22px\`. Shown on
  mouseenter/mouseleave; **also show on keyboard focus** in the real implementation.
  INP copy: "**INP — Interaction to Next Paint.** The browser's own measure of how fast the
  page responds to input. d0bar adds nothing to it: \`fetch\` stays unpatched and traces are
  flattened in a worker, so the number you read is the number your users get."
- **Live updates:** the request list and vitals stream in as observer entries arrive. Appends
  must not scroll-jump the user; a row already selected keeps its selection.
- **Responsive:** the panel is fixed at 620px by design. Below ~700px viewport width, drop to
  \`calc(100vw - 32px)\` and let the waterfall column collapse first (it is the only
  droppable column).

## State Management
\`\`\`
open      : boolean          // panel expanded
view      : 'list' | 'trace'
tab       : 'requests' | 'vitals' | 'coverage'   // 'coverage' renders the Untraced tab
sel       : number           // index of selected request
tip       : null | 'untraced' | 'inp' | 't1' | 't2' | 't3' | 't4'
\`\`\`
Plus, in production: the observer-entry buffer (requests), the vitals map, tier-2 availability,
and per-request trace fetch status (\`idle | pending | found | absent\`) with retry count.

Derived (do not store): tab colors/underlines, row bar geometry, duration formatting, which of
7a/7b/7c to render, chip label + colors.

**Data fetching:** trace lookup is by \`traceId\` from the traceparent within a \`±2s\`
timeRange, on demand per selected request, retried with backoff and abortable. Nothing is
prefetched — opening the toolbar must cost nothing.

## Design Tokens
All from the Dash0 design system CSS custom properties; use the codebase's tokens, not hex.
- **Surfaces:** \`--lvl-1-bg\` (panel), \`--lvl-1-subtle-bg\` (header/footer/tracks),
  \`--lvl-2-bg\` (cards, buttons), \`--lvl-3-bg\` (tooltips)
- **Strokes:** \`--lvl-1-stroke\`, \`--lvl-1-subtle-stroke\` (row rules), \`--lvl-2-stroke\`,
  \`--lvl-2-hover-stroke\`, \`--lvl-3-stroke\`, \`--lvl-1-hover-stroke\`
- **Text:** \`--lvl-0-intense-text\` (primary), \`--lvl-0-text\` (body),
  \`--lvl-subtle-text\` (meta)
- **Hover:** \`--lvl-1-hover-bg\`
- **Accent / status:** \`--cta-bg\`, \`--cta-text-inline\`, \`--healthy-bg\`,
  \`--healthy-text-inline\`, \`--warning-bg\`, \`--warning-text\`, \`--warning-text-inline\`,
  \`--error-bg\`, \`--error-text-inline\`
- **Waterfall phases:** \`--neutral-500\` (connect), \`--purple-500\` (wait),
  \`--light-blue-600\` (transfer), \`--error-bg\` (failed)
- **Span colors:** \`--palette-auto-0..N-fill\` (chart categorical palette), per service
- **Type:** \`--font-sans\` for UI text, \`--font-mono\` for every measurement, id, URL, and
  status. Sizes used: 9, 10, 11, 12, 13, 20px. Tabular-nums on all numeric columns.
- **Radius:** 3px (chip), 4px (badge), 5px (small buttons), 6px, 7px (tooltip), 8px (cards),
  12px (panel), 999px (pill)
- **Shadows:** \`--shadow-lg\` (pill), \`--shadow-xl\` (tooltip), \`--shadow-2xl\` (panel)
- **Spacing:** 2, 3, 5, 6, 7, 8, 9, 10, 12, 14, 22, 24px
- **Motion:** \`d0-rise\` \`.18s ease-out\` (panel) / \`.12s\` (tooltip);
  \`d0-pulse\` \`1.1s ease-in-out infinite\`. Honor \`prefers-reduced-motion\`.

## Variants
The prototype exposes two toggles worth carrying into the implementation:
- **\`tier\`**: \`Tier 1 + 2\` (default) vs \`Tier 1 only (degraded)\`. Degraded changes the
  tier-2 dot to warning, the label to \`2 SW off\`, its popover to the host-owns-the-scope
  explanation, the perturbation label to
  \`degraded — no trace jump\` in \`--warning-text-inline\`, and forces **every** request into
  state 7b. This is the honest-degradation path — build it, don't stub it.
- **\`showObserverStrip\`**: boolean, default true. Only for embedding the panel in docs or
  screenshots; the strip should be on in the product.

## Assets
None. The logo mark is a CSS ring + dot; every other glyph is a text character
(\`✕\`, \`←\`, \`→\`, \`·\`, \`Δ\`, \`⌘⇧0\`). Substitute the real Dash0 mark and the
codebase's icon set. Font families come from the design-system tokens.

## Files
- \`d0bar.dc.html\` — the full design: fake host page, collapsed pill, panel, all three tabs,
  all three trace states, tooltips, footer strip. Mock data and all derived values live in the
  logic class at the bottom of the file.
- \`tokens/\` — the Dash0 design-system token CSS the design is styled against, copied here for
  reference resolution.
