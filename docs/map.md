# Which file answers which question

One line per document, so a question can be taken to one file instead of four being read whole.
Add a line when you add a document; delete one when you delete it.

## Start here

| Question                                                       | File                                   |
| -------------------------------------------------------------- | -------------------------------------- |
| How do I use d0bar? What does it claim?                        | `readme.md`                            |
| How is it built, and why in that shape?                        | `architecture.md`                      |
| What are the working agreements — how do I change things here? | `CLAUDE.md`                            |
| What is being built right now, and what is agreed?             | `openspec/changes/`, `openspec/specs/` |

## The product

| Question                                                                     | File                       |
| ---------------------------------------------------------------------------- | -------------------------- |
| What may run during the host's load phase, and what ends it                  | `src/collector/phase.ts`   |
| Which entry types are observed, and what happens where one is missing        | `src/collector/observe.ts` |
| How a request is stored without allocating                                   | `src/collector/ring.ts`    |
| Why the stage-1 bundle is the only thing on the critical path                | `src/collector/index.ts`   |
| How LCP, CLS and INP are accumulated, and why the LCP seal is a timestamp    | `src/collector/vitals.ts`  |
| The three tier-2 outcomes, including the one where d0bar refuses to register | `src/collector/sw.ts`      |
| How the host's own OpenTelemetry SDK is adopted rather than shipped          | `src/collector/otel.ts`    |
| What the pill draws and when it refreshes                                    | `src/collector/pill.ts`    |
| How the panel is loaded on first open rather than at init                    | `src/shared/stage2.ts`     |

## Measurement

| Question                                                                      | File                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------ |
| What the perturbation suite runs, and how the fixture is built                | `bench/README.md`                          |
| The committed thresholds, each with the measurement and the reason for it     | `bench/budget.json`                        |
| Why a budget row must resolve finer than its own threshold, and the sign test | `bench/quantized-metrics.md`               |
| How per-task main-thread time is attributed to a script by URL                | `packages/frame-budget/src/attribution.ts` |
| The last run's numbers, per arm                                               | `bench/last-budget.json`                   |

## Rules of thumb

- **`grep -n` before `Read`.** Most of these files are long because the reasoning is written down,
  which is deliberate — but it means reading one whole to answer a narrow question costs several
  times what the answer is worth.
- **A comment is usually the answer.** Where a decision came from a measurement, the measurement
  is in the comment beside it. `phase.ts` is 42% comments for this reason.
- **`budget.json` rationales are the history.** Every threshold carries what it was, what moved
  it, and what was measured — often more useful than the git log.
