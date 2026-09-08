# Tasks

## 1. The credential carries a dataset

- [x] 1.1 `src/shared/broker.ts`: add `dataset: string` to `TokenStatus`, documented as the
      dataset queries are sent to — resolved by the worker, so never `""` when connected.
- [x] 1.2 `src/shared/broker.ts`: add `dataset: string` to the `connect` request variant. Note
      beside it that unlike `region` this is not resolved against a compiled table — it names no
      destination, so a page-supplied value cannot send the token anywhere.
- [x] 1.3 `src/shared/broker.ts`: add `dataset: DEFAULT_DATASET` to `DISCONNECTED`.
- [x] 1.4 `src/shared/broker.ts`: export `DEFAULT_DATASET = "default"` — one definition, imported
      by the worker, the connect surface and the trace copy.

## 2. The worker holds it

- [x] 2.1 `src/sw/token.ts`: `let dataset = DEFAULT_DATASET` beside `region`, with a comment
      naming the observed failure — a query into the wrong dataset returns 404, which the panel
      rendered as ingest lag.
- [x] 2.2 `src/sw/token.ts`: `set(token, persist, regionId, datasetName)` — trim, and fall back to
      `DEFAULT_DATASET` when blank. **The only writer of the fallback** (design decision 2).
- [x] 2.3 `src/sw/token.ts`: `status()` reports `dataset`.
- [x] 2.4 `src/sw/token.ts`: persist under a third key `DATASET_KEY = "dataset"` in `putStored`;
      delete it in `removeStored`.
- [x] 2.5 `src/sw/token.ts`: `restore()` reads it, treating a missing key as `DEFAULT_DATASET` —
      unlike an unknown region, which refuses. Comment the asymmetry: a region names an origin
      the token would be sent to, a dataset names nothing.
- [x] 2.6 `src/sw/token.ts`: `clear()` and `resetMemory()` reset it to `DEFAULT_DATASET`.
- [x] 2.7 `src/sw/broker.ts`: pass `request.dataset` through to `set`.

## 3. The connect surface collects it

- [x] 3.1 `src/panel/views/connect/copy.ts`: `DATASET_LABEL`, and `DATASET_NOTE` saying what blank
      means and that d0bar cannot check the name against the token — a wrong dataset presents as
      a trace that is not there.
- [x] 3.2 `src/panel/views/connect/copy.ts`: the `Dataset` row in `REQUIREMENTS` currently reads
      "just this page's", which is advice about scoping the token, not the name. Leave the row and
      make the new field's label distinct so the two are not read as the same control.
- [x] 3.3 `src/panel/views/connect/index.ts`: a text input under the token field, placeholder
      `default`, `spellcheck = false`, `autocomplete = "off"`. Not a `password`.
- [x] 3.4 `src/panel/views/connect/index.ts`: prefill from `connection().dataset` on render so a
      reconnect does not silently retype the default over a chosen dataset.
- [x] 3.5 `src/panel/views/connect/index.ts`: pass it to `connect(...)`; Enter in the field submits,
      as it does in the token field.
- [x] 3.6 `src/panel/views/connect/index.ts`: append the field and its note to `root`, between the
      token field and `envField`.
- [x] 3.7 `src/panel/broker.ts`: widen `connect()` to take the dataset.
- [x] 3.8 `src/panel/views/connect/copy.ts`: `connectedLine` names the dataset, so the header chip
      states what the panel will query.

## 4. The query sends it, read per call

- [x] 4.1 `src/trace/query.ts`: replace `dataset?: string` with `dataset(): string` and document
      it with the same reasoning as `apiOrigin` — plus the sharper failure: a captured dataset
      does not fail as an authorization error, it 404s and reads as a missing trace.
- [x] 4.2 `src/trace/query.ts`: delete `const dataset = options.dataset ?? "default"` and call
      `options.dataset()` inside the returned function.
- [x] 4.3 `src/panel/index.ts`: `dataset: () => connection().dataset`.

## 5. The exhausted state stops naming a cause

- [x] 5.1 `src/panel/views/trace/index.ts`: `exhausted` title becomes a statement of what is
      known, not of why — the trace was not found in the connected dataset.
- [x] 5.2 `src/panel/views/trace/index.ts`: the `why` line for `exhausted` names both causes and
      the dataset it queried, replacing "d0bar stopped retrying rather than polling indefinitely."
      alone. Keep the elapsed-time prefix; it is what makes ingest lag implausible when it is.
- [x] 5.3 The dataset reaches the trace view from `connection()`, not from a prop threaded through
      the machine — the machine has no business knowing about credentials.

## 6. Tests

- [x] 6.1 `tests/unit/token.test.ts`: dataset held, defaulted from blank, reported in `status()`,
      persisted with the token, removed with it, restored, and reset by `clear()`.
- [x] 6.2 `tests/unit/token.test.ts`: session-only mode writes no dataset to the store — the same
      assertion the token already has, and for the same reason it once failed.
- [x] 6.3 `tests/unit/trace-query.test.ts`: `traceDetailsBody` carries the dataset; the query
      calls `dataset()` **per invocation**, asserted by returning a different value the second
      time and reading both bodies. This is the assertion that would have caught the original bug.
- [x] 6.4 `tests/unit/broker.test.ts` (or wherever `connect` round-trips): the dataset survives
      the message.

## 7. Verification

- [x] 7.1 `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm vitest run`, `pnpm build` — all local, all
      permitted.
- [x] 7.2 `pnpm size`. `TokenStatus` is shared by stage 1, so the ceilings are checked rather
      than assumed. Do not raise one without finding the cause first.
- [ ] 7.3 Browser verification is CI's. The end-to-end claim — a trace resolving against the
      user's real dev tenant — can only be made by the user with a token, and is reported as
      unverified until they make it.

## 8. Connect gave no response at all

Reported separately while the above was landing, on the same surface, and it is why the dataset
bug was hard to reach in the first place: the button that would have said "the worker refused
this" said nothing.

- [x] 8.1 `src/panel/views/connect/index.ts`: the failure notice gets **its own node**. It was
      written into `.conn-state`, which `render()` assigns unconditionally — and `onSubmit` calls
      `render()` in its own `finally`, so every failure message was written and blanked in one
      tick. Success hid it by calling `popToList()`. One writer per node, not careful ordering.
- [x] 8.2 `src/panel/views/connect/index.ts`: `say()` is that node's only writer, and hides it
      when empty so the warning block takes no space unused.
- [x] 8.3 `src/panel/views/connect/index.ts`: an empty token field answers `EMPTY_TOKEN` instead
      of `return`ing silently — the first thing anyone does when a click appears dead.
- [x] 8.4 `src/panel/broker.ts`: export `controlled()`. `askStatus` collapses no-controller, a
      timeout and a refusal into one disconnected status, so the surface could not tell them
      apart and reported all three as "no worker".
- [x] 8.5 `src/panel/views/connect/copy.ts`: `REFUSED` beside `NO_WORKER`, and `EMPTY_TOKEN`.
      Opposite next steps — check the region, versus reload — so one message for both sends the
      developer round a loop that cannot help.
- [x] 8.6 `tests/unit/connect-view.test.ts`: five tests, and **verified to fail on the old
      arrangement** — the shared node was reinstated, 4 of the 5 failed, and the fix was restored.

## 9. Tier 2 said "live" while observing nothing

Found by chasing "everything on /try/ reports as untraced". Not a /try/ bug and not this change's
doing — a defect in the tier model that misreported **every first visit** since tier 2 landed.
`startTier2` set `{kind: "live"}` the moment `register()` resolved; a worker never controls the
page that registered it, so `controller` was null, no `fetch` event reached the worker, and the
panel asserted the opposite with full confidence. It is the same failure as §8 inverted: there,
a surface said nothing when it should have spoken; here, it spoke when it did not know.

- [x] 9.1 `src/collector/sw.ts`: third state `{kind: "pending"; reason: Tier2Pending}`, with
      `Tier2Pending = "awaiting-control"`. One reason, not two: "not controlled yet" and "a new
      version is waiting" have the same remedy and cannot always be told apart from the page.
- [x] 9.2 `src/collector/sw.ts`: `tier2State()` derives the reading at call time through
      `controlled()` rather than caching it — no `controllerchange` listener, so the file still
      adds nothing to anything the host owns, and the answer corrects itself when control lands.
      A throwing container counts as not controlling: understating, never overstating.
- [x] 9.3 `src/collector/sw.ts`: `owner: "host"` stays exempt. It is only reachable through
      `noteWorkerRecords`, which is evidence that records are arriving, and evidence outranks a
      capability check.
- [x] 9.4 `src/shared/stage2.ts`: mirror the variant, per the stage-duplication rule.
- [x] 9.5 `src/panel/tier.ts`: `TierState` gains `"pending"`; `tier2Row()` extracted; label reads
      `2 SW — reload` so the remedy is in the strip, not only the tooltip. `traceJumpAvailable`
      still requires `live`, so pending cannot offer a jump that would resolve to "not found".
- [x] 9.6 `src/panel/panel.css` + `src/trace/traceMachine.ts` + `src/panel/views/trace/index.ts`:
      pending dot in the error colour with a reduced-motion-gated pulse, and `TIER2_PENDING_COPY`
      so an untraced row says "reload" instead of "tier 2 is off".
- [x] 9.7 `bench/fixtures/host/try/index.html`: the state said out loud on the page itself — a
      three-state banner with a reload button, repainted on `controllerchange` and on
      `serviceWorker.ready` (the only edge that fires when control never arrives this
      navigation). The lede no longer claims "all tiers live". Fixture-only, and `/try/` is never
      a measured arm.
- [x] 9.8 `tests/unit/tier2-pending.test.ts`: 9 tests, **verified to fail on the old model** —
      the lazy resolution was removed, 4 of 9 failed, and the fix was restored.
- [x] 9.9 `tests/perf/tier2-control.spec.ts`: the invariant in a real browser — the reading and
      `navigator.serviceWorker.controller` never disagree.

      **Corrected after it was pushed.** The first version asserted "pending on a first visit, live
      after a reload" and the claim behind it — that a worker never controls the page that
      registered it — is false for d0bar's own worker: `src/sw/observe.ts` calls `skipWaiting()` on
      install and `clients.claim()` on activate, so it usually claims the registering page a moment
      later. The spec passed once, then failed on re-run reading `live` where it expected `pending`.
      It was asserting a race. The wrong explanation had also been written into `collector/sw.ts`,
      `panel/tier.ts`'s pending copy, the `/try/` banner and two spec comments, and is corrected in
      all of them: pending is the window before the claim lands, and it persists only when the claim
      does not happen — a rebuilt worker file waiting behind an open client, or a claim that threw.

## 10. The panel read the worker's log exactly once

Reported as "it only works after a soft reload on first request, next are never instrumented".
Independent of §9 and worse: tier 2 was observing correctly the whole time.

Measured by counting `getAll` on the `requests` store from page script — 0 reads before the panel
opens, 1 at open, and still 1 after two more scenarios by which point the worker had written 28
records. 22 of 28 were never read, so every request issued after the panel opened rendered
untraced for the life of the panel.

- [x] 10.1 `src/panel/index.ts`: flush on every tier-1 resource batch, not once at open. `onBatch`
      is the right edge — it is the same signal the list repaints on, so a ring slot exists for the
      join to land in; a worker message would arrive before the resource entry and find nothing.
- [x] 10.2 `src/panel/index.ts`: coalesced. One flush at a time with a trailing pass, so a burst of
      batches cannot start N concurrent full log reads, and the batch that arrived mid-flush is not
      the one dropped. `flushStopped` guards a flush that outlives `destroy()`.
- [x] 10.3 `src/collector/correlate.ts`: idempotence made structural, since repeated flushing is
      now the normal case. `tier2ByIndex` and `adoptedByIndex` record what each ring index was
      already given; without them every batch would push a duplicate `TraceContext` for the life of
      the panel, and tier 4 would adopt a span over a header tier 2 had already resolved.
- [x] 10.4 `src/collector/correlate.ts`: both ledgers key on `(index, startTime)`, not index alone.
      The ring wraps, and a reused slot keyed on the index would look already-correlated and never
      get a trace id — the same bug in a rarer form. Cleared by `resetCorrelation`.
- [x] 10.5 `src/sw/db.ts` + `src/sw/protocol.ts`: the log moves off `keyPath: "order"` onto a
      generated key, `DB_VERSION` 2 → 3. `order` is a module counter in the worker and a service
      worker is terminated when idle, so it restarted at 0 and the next generation's records
      overwrote the previous one's at keys 0, 1, 2… A second defect, found by reading the key path
      while chasing the first, and invisible until §10.1 made the log actually get read.
- [x] 10.6 `src/collector/join.ts`: unjoined records sort by `(at, order)`. `order` alone was wrong
      across worker generations for the same reason.
- [x] 10.7 `tests/perf/otel-context.spec.ts`: opened the log at a hardcoded version 2, which throws
      `VersionError` once `DB_VERSION` is 3. Unversioned now, in both specs that read it.
- [x] 10.8 `tests/perf/correlation-reflush.spec.ts`: counts the reads rather than inspecting rows —
      upstream of every rendering question, so a failure names the cause. **Verified to fail on the
      old arrangement**: with the `onBatch` subscription removed it stops at 1 read and reports "no
      flush followed a scenario run with the panel already open".
