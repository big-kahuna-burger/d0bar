# Design — epoch model

## What the platform gives us

Measured on Chrome 152 stable, with a trusted click driving `history.pushState` plus a
contentful paint:

```
soft-navigation              name "/detail"   navigationId 4865
                             navigationType "push"   interactionId 1107
                             startTime 394.3  paintTime 427.9  presentationTime 432
interaction-contentful-paint                  navigationId 4865
resource /probe-asset.json                    navigationId 4865
largest-contentful-paint (initial load)       navigationId 4858
event click (the one that caused the soft nav) navigationId 4858
```

Three properties matter, and each one removes work we would otherwise have to do:

1. **`navigationId` is on the base `PerformanceEntry`.** Not on the soft-navigation entry
   alone. Bucketing is a field read.
2. **The causing interaction stays in the old epoch.** A boundary is not a timestamp
   comparison — the click at t=394.3 and the soft nav at t=394.3 land in *different* epochs.
   Any scheme that bucketed by `startTime` against a boundary table would get this wrong,
   and would get it wrong precisely on the entry the user is asking about.
3. **Buffered entries carry it too.** Entries that arrived before the toolbar mounted are
   attributable. A boundary table we built ourselves could only start at mount.

`soft-navigation` also exposes `getLargestInteractionContentfulPaint()`, giving a per-epoch
LCP analogue that we are not otherwise entitled to compute.

## Decision: read the id, do not derive it

The epoch is `entry.navigationId`, stored as a `u32` alongside the rest of the record. There is
no epoch table lookup on the read path, no binary search, and no boundary timestamps.

The rejected alternative — record boundaries, binary-search `startTime` at read time — is
strictly worse on all three counts above, and costs a lookup per row on a path that renders
during a scroll. It was the design before these measurements; it is superseded.

## Decision: three tiers, and the fallback is not decoration

| Tier | Source | Epoch id | What is true |
| --- | --- | --- | --- |
| 1 | `soft-navigation` entries | browser `navigationId` | Boundaries are the browser's, including for buffered entries. Per-epoch ICP available. |
| 2 | Navigation API `currententrychange` | ours, `1 + n` | Boundaries are correct from mount onward. Entries before mount belong to epoch 0. No per-epoch ICP. |
| 3 | neither | constant `0` | One epoch, the document. The UI says so. |

Tier 2 is the interesting one. `currententrychange` fires on raw `history.pushState` **and**
`replaceState` — verified — so every SPA router bottoms out in it and nothing needs patching.
This preserves the non-perturbation guarantee: `add-perturbation-budget` asserts `fetch` and
`XMLHttpRequest` are unpatched, and a router-detection scheme that monkey-patched `history`
would violate the spirit of that even where it passes the letter.

`navigationType` from `navigation.currentEntry` distinguishes `push` and `traverse` (a real
boundary) from `replace` (an in-epoch URL correction — routers use it for query-string edits,
and treating each as an epoch would shred the timeline). Tier 1 gets the same distinction from
the soft-navigation entry's own `navigationType`.

Tier 2 assigns ids from a counter starting at 1, reserving 0 for "before we were watching". A
tier-2 epoch id is **not** comparable with a tier-1 `navigationId`, and the two are never mixed
within a session: the tier is decided once, at start.

## Decision: the registry labels, it does not classify

`{ id, url, startTime, navigationType, source }` per epoch, capped at 32 with oldest-dropped.
It exists so a row can say which route it belongs to. Nothing on the classification path reads
it, so a dropped entry costs a label, never a misfiled record.

The cap matters: a long-lived SPA session is unbounded in routes, and an uncapped registry is a
leak with a plausible-sounding excuse.

## Ring cost

One `u32` column: 80 → 84 bytes per record, 40,960 → 43,008 bytes at `CAPACITY = 512`. The
write is one more straight-line typed-array store in `pushResource`, which is the hot path
during load. `navigationId` is read from a property that is `undefined` on tiers 2 and 3 — the
`|| 0` coercion is in the caller, not per-field in the ring, so the hot path stays branch-free.

## What this does not solve

- **Firefox and Safari are tier 3.** Neither ships the Navigation API. On those browsers the
  toolbar has one epoch and must not pretend otherwise.
- **A soft navigation needs a paint.** Chrome's heuristic requires interaction → URL change →
  contentful paint. A route change that renders nothing new produces no entry, and on tier 1
  that route is invisible. This is the browser's definition of a navigation, not ours, and we
  adopt it rather than second-guessing it.
- **Chrome-version skew in our own tooling.** The bundled Chromium is 148 (no
  `soft-navigation`), CI's Chromium is 151 (has it), stable Chrome is 152. Tests that only
  exercise tier 1 pass in CI and say nothing about tier 2, so the suite forces both.
