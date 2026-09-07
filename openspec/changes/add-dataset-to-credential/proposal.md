## Why

**d0bar cannot resolve a trace for any token whose dataset is not named `default`, and it reports
that as a statement about the trace.** Found against a live Dash0 tenant: every request in the
panel carried a real `traceparent`, the queries reached the API and succeeded, and every trace
ended in `exhausted` — "The trace did not become queryable."

The cause is a dataset the spans were never written to. `src/trace/query.ts:90` reads
`options.dataset ?? "default"`, and `src/panel/index.ts:326` never passes `dataset`, so the
fallback is unconditional in the shipped product. The same assumption was already found and fixed
once on the ingest side of the fixture, where Dash0 named it outright:

    PermissionDenied: authentication token is not authorized to ingest into dataset "default"

A token belongs to one dataset. `openspec/specs/pasted-token/spec.md` already requires the paste
affordance to *name* that restriction — "`Reading` permission, one dataset, spans and logs" — but
nothing in the credential records **which** dataset, so the query has nothing to send and guesses.

The second defect is the copy. `exhausted` is reached by five 404s, and 404 has two causes: the
trace has not been ingested yet, and the dataset does not contain it. The panel asserts the first.
That is the conflation `trace-view` exists to prevent, stated in `query.ts` itself — "a query that
could not be issued must not render as a trace that does not exist".

## What Changes

- The dataset becomes part of the connected credential, held beside the token in the worker's
  realm exactly as `region` is, persisted with it, and reported in `TokenStatus`.
- The connect surface gains a dataset field. Blank means `default`, and the surface says so —
  the fallback stays, but it is now a visible choice rather than an invisible one.
- `createTraceQuery` reads the dataset **at call time**, not at construction. Today it snapshots
  it in the factory, which is the same defect `apiOrigin`'s callback exists to avoid: reconnecting
  to a different dataset with the panel open would keep querying the old one.
- `exhausted` copy stops naming ingest lag as the cause and names the dataset alongside it.
- **BREAKING** for `TokenStatus` consumers: one new required field. Internal surface only; the
  package's public API (`init`, `destroy`, `diagnostics`, `otelSpanProcessor`) is unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `pasted-token`: the credential gains a dataset — collected, persisted, resolved and reported
  alongside the region.
- `trace-view`: the query sends the connected dataset, reads it at call time, and `exhausted`
  no longer attributes itself to ingest lag.

## Impact

| file | change |
| --- | --- |
| `src/shared/broker.ts` | `TokenStatus.dataset`, `connect` request carries it, `DISCONNECTED` |
| `src/sw/token.ts` | held beside `region`, third persisted key, surfaced in `status()` |
| `src/sw/broker.ts` | passes it through `connect` |
| `src/panel/views/connect/index.ts` | the field, and the blank-means-default note |
| `src/panel/views/connect/copy.ts` | the note's text |
| `src/panel/index.ts` | `dataset: () => connection().dataset` |
| `src/trace/query.ts` | `dataset()` callback, read per call |
| `src/panel/views/trace/index.ts` | `exhausted` copy |
| `bench/fixtures/server.mjs` | `/otlp/status` already reports the ingest dataset; unchanged |

No hot-path change: nothing here runs during load, and none of it is reachable from
`pushResource`. Stage 1 is untouched except for the shared `TokenStatus` shape.
