# add-epoch-model

## Why
Every view in the toolbar answers a question with an implied time window — *these* requests,
*that* LCP, the trace for *this* route. On a single-page app the window is a route, and the
toolbar had no notion of one: a request from three routes ago sat in the same list as the one
that just fired.

The obvious implementation is to detect route changes ourselves and keep a table of epoch
boundaries to bucket entries against at read time. That table is unnecessary. Chrome stamps
`navigationId` on **every** `PerformanceEntry` — resource, LCP, event, soft-navigation alike —
and a `soft-navigation` entry announces the boundary with its own `navigationType`,
`interactionId` and paint time. Verified on Chrome 152 stable: a resource fetched after a
soft navigation carries the soft nav's `navigationId`, while the click that *caused* the
navigation still carries the previous one.

So the epoch is a `u32` the browser already computed. Reading it is cheaper and more correct
than deriving it, and it is the only source that can attribute an entry to an epoch the
toolbar never observed — entries buffered from before mount.

Not every browser supplies it, and the capability is younger than the browsers our own tooling
runs (bundled Chromium 148 lacks `soft-navigation`; CI's 151 has it). The fallback is therefore
not hypothetical and is specified here as a first-class path, not a degradation footnote.

## What Changes
- An epoch is identified by the browser's `navigationId` wherever the platform supplies one.
- A three-tier epoch source, mirroring the observation tier stack: `soft-navigation` entries →
  Navigation API `currententrychange` → a single document-lifetime epoch.
- The request ring gains an `epochId` column; queries filter on an integer, not a time range.
- An epoch registry: a bounded table of `{ id, url, startTime, navigationType, source }` for
  labelling only. It is not consulted to classify an entry.
- The active epoch is what every view scopes to by default, with an explicit affordance to
  widen to the whole document.
- Which tier produced the epochs is disclosed in the UI, because tier 3 means "there is one
  epoch and it is the page".

## Impact
- New capability: `epoch-model`
- New: `src/collector/epoch.ts`
- Modified: `src/collector/ring.ts` (record stride 80 → 84 bytes), `src/collector/observe.ts`
- Depends on: `add-observation-core`
- Depended on by: `add-requests-view`, `add-vitals-view`, `add-trace-view`, `add-untraced-view`
