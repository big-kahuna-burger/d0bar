# Tasks — epoch model

## 1. Tier selection
- [x] 1.1 `src/collector/epoch.ts` — `selectTier()`, run once at start: `soft-navigation` in `PerformanceObserver.supportedEntryTypes` → 1; `typeof navigation !== "undefined"` → 2; else 3
- [x] 1.2 `epochSource(): "soft-navigation" | "navigation-api" | "document"` for the diagnostics surface
- [ ] 1.3 Tier is frozen after selection; assert in dev that no tier-2 id is assigned once tier 1 is chosen
- [x] 1.4 Feature-detect via `supportedEntryTypes`, not by observing and catching — a caught throw is indistinguishable from a real failure

## 2. Tier 1 — soft-navigation
- [ ] 2.1 Observe `soft-navigation` with `buffered: true`; each entry opens an epoch keyed by its `navigationId`
- [ ] 2.2 Register `{ id, url: entry.name, startTime, navigationType, source: "soft-navigation" }`
- [ ] 2.3 `entry.navigationType === "replace"` updates the current epoch's URL instead of opening one
- [ ] 2.4 Retain `interactionId` so the trace view can name the interaction that caused the epoch
- [ ] 2.5 Retain `presentationTime` where present; it is the epoch's paint, and is not the same as `startTime`
- [ ] 2.6 Do not retain the entry itself

## 3. Tier 2 — Navigation API
- [ ] 3.1 `navigation.addEventListener("currententrychange", …)`; ids from a counter starting at 1, 0 reserved for pre-mount
- [ ] 3.2 Read `event.navigationType`; `push`/`traverse` open an epoch, `replace` updates the current URL
- [ ] 3.3 Record `performance.now()` at the boundary — `navigation.currentEntry` exposes no timestamp, confirmed
- [ ] 3.4 Listener registered on `navigation`, not on `window`; teardown removes it
- [ ] 3.5 `navigation.activation` read once at start to distinguish a prerender activation from a fresh load

## 4. Tier 3 — document
- [x] 4.1 Constant epoch 0, no listeners, no observers
- [x] 4.2 UI copy: route boundaries unavailable on this browser — asserted, not left to the view layer

## 5. Ring
- [ ] 5.1 Add `epochId` as a fourth `u32` column; stride 80 → 84 bytes, `U32_COUNT` 3 → 4
- [ ] 5.2 `pushResource` writes `currentEpochId()`; tiers 2 and 3 supply it, tier 1 reads `entry.navigationId`
- [ ] 5.3 Coerce absent `navigationId` to 0 in the caller so the ring write stays branch-free
- [ ] 5.4 Extend `read()` and the record scratch with `epochId`
- [ ] 5.5 Declare `navigationId` in the `ResourceTimingExtras` interface rather than casting at the use site
- [ ] 5.6 Update the stride comment and the `CAPACITY` byte arithmetic in the module doc

## 6. Registry
- [ ] 6.1 Fixed 32-slot ring of `{ id, urlId, startTime, navigationType, source }`; URL interned, not stored as a string
- [ ] 6.2 `labelFor(epochId)` returns the record or `undefined`; never throws, never consulted for classification
- [ ] 6.3 `activeEpochId()` and `epochs()` for the views
- [ ] 6.4 Unit test: 40 epochs registered, 32 retained, records referencing the 8 dropped still group correctly

## 7. Tests
- [ ] 7.1 Browser test on a real soft navigation — trusted click, `pushState`, contentful paint — asserting the subsequent resource shares the soft nav's `navigationId`
- [ ] 7.2 Assert the causing `event` entry carries the *previous* epoch id, not the new one
- [ ] 7.3 Force tier 2 with a test seam and run the same scenario; both tiers exercised in CI, not tier 1 alone
- [ ] 7.4 Force tier 3; assert one epoch and the disclosure string
- [ ] 7.5 `replace` produces no new epoch; `push` and `traverse` each produce one
- [ ] 7.6 Extend `non-perturbation.spec.ts`: `history.pushState` and `history.replaceState` strictly equal to the originals after start
- [ ] 7.7 A/B budget re-run with epochs enabled; commit the measured deltas to `bench/budget.json`
- [ ] 7.8 Record the bundled-Chromium (148) capability set in the test README so a future reader knows why tier 2 is forced in CI

## 8. Fixture
- [ ] 8.1 Add a route-change flow to `bench/fixtures/host/` — button, `pushState`, new contentful paint, a burst of requests after it
- [ ] 8.2 Flow is inert unless requested by query parameter, so the existing A/B numbers stay comparable
