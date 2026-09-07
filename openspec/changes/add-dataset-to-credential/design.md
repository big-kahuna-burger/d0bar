## Context

The credential the panel connects with already has two parts: the token and the region. The
region is held in the worker's realm beside the token, persisted with it, and resolved to an
origin on every read — never stored as an origin, so a persisted value cannot smuggle a
destination in. `src/sw/token.ts` explains why: *"a token for one region is not a token for
another"*.

A dataset has the same property and is missing entirely. What that produced, observed against a
live tenant:

```
  spans ingested ──▶ token's own dataset (whatever it is named)
  d0bar queries  ──▶ "default"                    ← src/trace/query.ts:90
                     │
                     └─▶ 404, five times, backoff ──▶ "The trace did not become queryable."
```

Two independent observations pin it down. Dash0 refused an explicit `dash0-dataset: default` on
the ingest side with *"authentication token is not authorized to ingest into dataset
`default`"*, so the token's dataset is definitely not `default`; and `src/panel/index.ts:326`
passes no `dataset`, so the query's fallback is unconditional. The panel then rendered a
statement about the trace for what was a statement about the connection.

## Goals / Non-Goals

**Goals:**

- The dataset travels with the credential, under the region's existing rules.
- A trace query names the dataset that is connected *now*.
- The exhausted state stops asserting a cause it cannot know.

**Non-Goals:**

- Discovering datasets from the API. Dash0 has a datasets endpoint, but calling it would mean
  d0bar issuing a request the developer did not ask for, on a surface whose whole premise is that
  it fetches nothing until asked (`trace-view`: *"Nothing is fetched until asked"*).
- Validating the dataset against the token. d0bar cannot verify the token's permissions either;
  claiming to verify the dataset would be the same false confidence, and `pasted-token` already
  requires stating that limit rather than papering over it.
- Any change to ingest. `bench/fixtures/server.mjs` already sends no dataset header, which is
  correct: omitted, the token ingests into the dataset it belongs to.

## Decisions

**1. The dataset lives in the worker beside the token, not in panel-side storage.**

It is not a secret — unlike the token, returning it in `status()` is harmless, and the panel needs
it to say what it queried. But it is part of the credential's *meaning*, and a panel-side copy is
a second source of truth that can drift from the token the worker actually holds: reconnect in one
tab, and the other tab's copy is stale while its token is not. Holding it where `region` is held
gives it the same lifecycle for free — persisted with the token, removed with it, restored with
it, reset to the default by `clear()`.

*Alternative rejected:* `localStorage` on the panel side. Cheaper, and wrong for the reason above;
it would also survive a disconnect, leaving the dataset of a credential that no longer exists.

**2. Blank resolves to `default` in the worker's `set()`, not in the query.**

Exactly one writer of the fallback. `status()` then never reports `""`, so the connect surface can
display the dataset that will actually be queried rather than the string the user typed, and the
trace view can name it in its copy without re-deriving the fallback. Today's `?? "default"` sits in
`createTraceQuery`, which means the value the UI could show and the value the query sends are
computed in different places — the arrangement that let this bug stay invisible.

*Alternative rejected:* refuse a blank dataset. Considered, because a required field would have
made this impossible from the start. Rejected because `default` is genuinely right for most
tenants, and a required field on the paste surface adds friction to the common case to prevent an
uncommon one — now that the field exists and says what blank means, the disclosure does the work.

**3. `dataset` becomes a callback on `TraceQueryOptions`, read per call.**

`apiOrigin` is already a callback with the reason written above it: *"the developer can connect,
disconnect and reconnect to a different region with the panel open, and a captured origin would
send the next trace query to the previous region — which fails as an authorization error and reads
as a bad token."* Every word applies to the dataset, and the failure is worse: a captured dataset
does not fail as an authorization error, it returns 404 and reads as a missing trace. The current
`const dataset = options.dataset ?? "default"` outside the closure is the same latent bug in
miniature and is removed rather than kept.

**4. The exhausted copy names the dataset and stops naming a cause.**

`query.ts` says a 404 is "the ingest-lag signal", which is what it is *usually* — but it is not
what it *means*, and the panel printed the usual case as the fact. The state now reports what is
known (five queries, no trace, this dataset) and lets the two causes stand side by side. This
follows the repo's honest-degradation rule literally: *cannot infer ──▶ say "unavailable", never
name a likely cause*.

## Risks / Trade-offs

| risk | mitigation |
| --- | --- |
| `TokenStatus` gains a required field; a stale persisted token restores without a dataset | `restore()` treats a missing key as `default`, the same way it already treats a missing region as a refusal — except a dataset cannot leak a credential anywhere, so defaulting is safe here and refusing would be gratuitous |
| The connect surface grows a fourth control on a surface deliberately kept to four | The dataset field is text, sits under the token, and the region note already carries a sentence — no new section, and `pasted-token`'s "four rather than seven" note is about *choices*, of which this adds one |
| Stage 1 shares `TokenStatus`, so the shape change touches the size-gated bundle | The field is a string on an interface; no new code reaches stage 1. Verified against `pnpm size`, not assumed |
| A user who types a wrong dataset now gets the same 404 they got before | Which is the honest outcome, and is now *legible*: the exhausted copy names the dataset it queried, so the mistake is visible in the failure rather than hidden behind it |

## Open Questions

None. The one that was open — whether d0bar should list datasets for the user — is closed as a
non-goal above, on the "nothing is fetched until asked" requirement.
