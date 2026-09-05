# modernize-observation-apis

## Why
`add-observation-core` shipped with two compromises that the platform has since made
unnecessary, and both are visible in the code as comments that overclaim.

`src/collector/observe.ts` says the toolbar "adds nothing to the host page's event surface",
but `src/collector/phase.ts` registers a `load` listener and a `visibilitychange` listener on
the host. Two shipped entry types replace both:

- The `navigation` entry is delivered **twice** — measured at 22 ms with `loadEventEnd: 0`,
  then again at 47 ms with `loadEventEnd: 35`, exactly the load event's timestamp. Guarding on
  `loadEventEnd > 0` gives the load signal from an observer we already register.
- `visibility-state` is supported everywhere we care about and yields a buffered
  `{ name: "visible", startTime: 0 }`, so the initial state is known without a listener.

Separately, `ring.ts` infers cache hits from `transferSize === 0 && encodedBodySize > 0`.
`deliveryType` reports it directly. The heuristic agreed with `deliveryType` on 250 of 250
fixture requests — but all 250 were `(network)`, because the fixture serves `no-store`. The
agreement is therefore not evidence, and the fixture's inability to produce a cache hit is
itself a gap worth closing.

## What Changes
- `phase.ts` takes its load signal from the `navigation` entry and its visibility from the
  `visibility-state` entry type. The host `load` and `visibilitychange` listeners are removed.
- Zero host event listeners becomes an asserted property rather than a comment.
- `deliveryType` becomes the cache signal where present; the size heuristic remains only as
  the fallback and is marked as such in the UI.
- The fixture gains a cacheable subresource so the two can actually be compared.

## Impact
- Modified capability: `observation-core`
- Modified: `src/collector/phase.ts`, `src/collector/observe.ts`, `src/collector/ring.ts`,
  `bench/fixtures/`
- Depends on: `add-observation-core`, `add-perturbation-budget`
