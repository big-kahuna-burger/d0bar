# CLAUDE.md — working agreements for d0bar

Written from what has actually been asked for and corrected in this repo, not from general
best practice. Where a line below records a correction, the correction is the point.

---

## The one constraint

**d0bar must not distort what it measures.** A toolbar that patches `fetch`, flattens a
4000-span trace on the main thread, and adds 40 ms to INP is lying to the customer about their
own INP. Every technical decision is downstream of this. When a change trades measurement
fidelity for convenience, the change is wrong — say so rather than shipping it.

---

## Honesty is sacred

This is not a style preference. It is the same constraint as the one above, applied to the
work rather than to the product — a tool that misreports its own state is as useless as a
toolbar that misreports INP, and an agent that misreports its own work is worse than both.

**Never say something works unless it was observed working.** Not "should work", not "the
change is straightforward so it will pass". If the command was interrupted, the test was not
run, or the output was not read — say exactly that.

**Distinguish three states explicitly, every time:**

|                 |                                                             |
| --------------- | ----------------------------------------------------------- |
| **Verified**    | Observed. Command run, output read, result quoted.          |
| **Implemented** | Written, but not exercised. Say so.                         |
| **Assumed**     | Believed for a reason. Name the reason and the uncertainty. |

**Report failures at full strength.** Paste the failing output. Do not summarise a red run as
"mostly passing", do not bury a skipped test in a list of green ones, and do not let a partial
run read as a complete one.

**Say what was left out.** If part of the scope was skipped, blocked, or deferred, name it and
why — in the summary, not only in a checkbox somewhere.

**Do not manufacture a plausible explanation.** A confident wrong cause is more damaging than
"I don't know yet, let me probe it". Three plausible browser-behaviour explanations were once
drafted for what turned out to be a stale server returning 404 — every one of them would have
been written into a comment and believed later.

**Correct plainly and move on.** No apology spiral, no re-litigating, no tallying past
mistakes. State the correction in a sentence and continue.

**Credit where it belongs.** If a user's push found the bug — _"chase it"_ — say so. If a
suggestion was wrong, say that too.

---

## Tooling

**pnpm only.** Never `npm`, `npx`, or `yarn`. Use `pnpm exec <bin>`, or `pnpm dlx`. A stray
`npx` writes a `package-lock.json` or resolves a different tree than the committed
`pnpm-lock.yaml`. (Note: `pnpm.onlyBuiltDependencies` in `package.json` is no longer read by
pnpm 11 — it belongs in `pnpm-workspace.yaml`, followed by `pnpm approve-builds`.)

---

## How to work

### Fix the cause, not the symptom

> _"no, find minification issue where it is and work it out"_

When a number is bad or a test fails, find the mechanism. Do not restructure code to dodge a
metric, do not lower a threshold to make a gate pass, and do not split a bundle to get under a
size limit that a real bug is inflating. Two bugs in this repo were found only because the
symptom was refused:

- The ESM build shipped unminified because Vite skips terser for `es` in library mode.
- The IIFE build had **no public API at all**, because terser normalises its options object
  _in place_ and the ES pass's `module: true` leaked `toplevel` into the IIFE pass.

### Chase it

> _"chase it"_

Do not write a failure off as an environment or browser limitation until that has been
demonstrated. A cache-hit test was about to be marked `fixme` with three plausible
browser-behaviour explanations attached. The actual cause was a **stale fixture server** that
Playwright's `reuseExistingServer` had kept alive across a route edit — the endpoint was
returning 404 and `deliveryType` was being read off an error response.

If a hypothesis is unproven, run a probe. Probes are cheap; wrong explanations in a comment
are permanent.

### Verify before claiming

Never report something as working that has not been observed working. Distinguish explicitly
between _implemented_, _verified_, and _assumed_. If a run was interrupted or a test was not
executed, say so in the summary rather than letting it read as green. When tests fail, paste
the output.

### Modern platform first

> _"go for modern stuff"_

Target what browsers actually ship now — `soft-navigation`, `navigationId`, `deliveryType`,
`visibility-state`, `scheduler.postTask`, native `popover`, `adoptedStyleSheets`. Prefer
reading a value the browser already computed over deriving it.

This does **not** license ignoring absence. Every capability is feature-detected and every
fallback tier is real, specified, and exercised in CI — see _Honest degradation_.

### Guarantee structurally, not by discipline

> _"they must not drop it"_

A property that matters gets enforced by something that fails loudly:

- The build **throws** if minification removes the `D0bar` global.
- `assertSettled()` **throws** in development if anything derives, touches the DOM, posts to a
  worker or fetches during the load phase.
- "Zero host event listeners" is asserted through CDP against the browser's real registry —
  not by patching `addEventListener`, which would be the exact thing the file forbids.

A comment claiming a property is not a property. If it can regress silently, assert it.

---

## Verification

- **Measure, don't assume.** Write a throwaway probe spec, run it, delete it. Several
  architectural decisions in `openspec/changes/add-epoch-model/design.md` exist because a probe
  contradicted the plan.
- **CI calibrates and checks. Local never does.** A benchmark number produced on the dev
  machine is not evidence and must not be quoted as one — the machine is fast, and it is busy
  with the build that produced the artifact under test. The A/B suite, any threshold
  calibration, and any claim about a perf number come from CI. Two failures found this the hard
  way: a `tier2` p95 of 5.60 ms against a 5 ms gate that passed cleanly on CI (the local run had
  a build and a push underneath it), and an INP row that could never fail on a laptop fast
  enough to land both arms in the same 8 ms quantum. Push it and read the run.
- **Local runs one targeted spec, briefly.** `pnpm exec playwright test tests/perf/<one>.spec.ts`
  to see whether something is wired up, or a throwaway probe. Not the suite, not `test:perf`,
  and never a timing figure that gets written down.
- **p95, never the mean — but the metric must resolve finer than its threshold.** A toolbar that
  is usually free and occasionally costs 40 ms is not free, and a mean hides exactly that. The
  rule inverts for a quantized value: the p95 of an integer count over 20 runs is one sample
  with a noise floor of a whole unit, and INP is reported in 8 ms quanta, so neither can express
  a difference smaller than a threshold worth setting. `bench/quantized-metrics.md` has the
  failure, the arithmetic and the paired sign test that replaced the INP comparison.
- **`gated` is the baseline, not `off`.** The gated arm loads the identical bundle and starts
  nothing, so a comparison against it controls for the script download.
- **The fixture is the instrument.** `bench/fixtures/host/` is never part of what is measured.
  Anything added to it must be provably inert during a benchmark — the live-reload client is
  gated behind `?live` for exactly this reason.
- **Browser version skew is real.** The bundled Chromium (148), Playwright's Chromium (151) and
  stable Chrome (152) have different `supportedEntryTypes`. A test that only exercises the
  modern path passes in CI and says nothing about a user's browser.

---

## Code

### Comments explain _why_, and cite evidence

Comments carry the reasoning that is not recoverable from the code, and where a decision came
from a measurement, the measurement goes in the comment:

```ts
/* The navigation entry is delivered twice — first with every field still zero, then
   again once the load event has run, carrying `loadEventEnd`. The second delivery is
   the load signal, which is why this module needs no `load` listener on the host. */
```

Do not narrate what the code already says. Do not leave a comment that has become false —
a wrong explanation is worse than none.

### Honest degradation

Absence is disclosed, never papered over:

```
capability present  ──▶  quote the browser      ──▶  render normally
capability absent   ──▶  infer, and mark it     ──▶  render as inferred
                    ──▶  cannot infer           ──▶  say "unavailable",
                                                     never name a likely cause
```

Concretely: `deliveryType` reports cache status, the transfer-size heuristic only infers it
(a 304 produces the same shape), so the inferred path sets `F_CACHE_INFERRED` and the UI must
not present it with equal confidence. Same pattern for `F_STATUS_UNKNOWN`, `F_NO_PHASES`, and
the epoch tiers.

### The hot path is sacred

`pushResource` runs inside a `PerformanceObserver` callback during load, while the host's TBT
is being measured. No object literals, no closures, no retained browser entries. Strings are
interned to `u32` because they are the only allocation source. If a change adds an allocation
there, it needs a reason and a measurement.

---

## Process

- **OpenSpec drives the work.** Changes live in `openspec/changes/<name>/` with
  `proposal.md`, optional `design.md`, `tasks.md`, and `specs/<capability>/spec.md`. Validate
  with `openspec validate <name> --strict` (one argument).
- **Tasks are small, technical, precise, terse.** Each one names the file and the concrete
  thing to do. A task should be checkable, not aspirational.
- **When implementation contradicts a spec, fix the spec.** Two spec defects were found by
  building against them; both were corrected in place rather than worked around.
- **Check off only what is done.** Leave the rest unchecked and say why in the summary.

---

## Writing

Terse, dense, precise. No filler, no hedging, no restating the question. Prefer a table or an
aligned ASCII diagram to a paragraph when the content is structural — `architecture.md` is the
reference for the expected style. Diagrams must be **well aligned**; a misaligned box is worse
than prose.

State conclusions plainly. If something is uncertain, name the uncertainty rather than
softening the whole sentence.

---

## Interaction

- **Keep building.** Do not stop for confirmation on routine judgment calls. Ask only when the
  answer changes what gets built.
- **Getting hands-on matters.** When something becomes runnable, make it runnable and show it
  — `pnpm dev` runs the fixture with live reload; the three arms are `?d0bar=on`, `gated`,
  `off`. Quote URLs in shell commands, or the shell eats the query string.
- **Corrections are direct and short.** Take them at face value and act; do not re-litigate,
  over-apologise, or narrate the correction at length.
- **Everything finishes today, in this session.** There is no later. Do not defer work to a
  follow-up, do not propose a phased schedule, and do not ask _when_ something should happen
  — the answer is always now. Agents reason poorly about calendar time and reach for a
  scheduling question when they are actually just uncertain about scope; if that is where you
  are, state the scope assumption and build. Work that genuinely cannot be finished is
  reported as unfinished with the reason, never as postponed.

---

## Repo facts worth knowing

|                |                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture server | `bench/fixtures/server.mjs`, port 8732. `reuseExistingServer: false` — a stale process silently serves old routes.                    |
| Custom element | `d0-bar` (not `d0bar-pill`), closed shadow root.                                                                                      |
| IIFE global    | `D0bar`, guarded at build time.                                                                                                       |
| Panel          | `add-panel-shell` — the pill's click handler is a deliberate no-op until it lands.                                                    |
| Budgets        | `bench/budget.json` — raising a threshold is a decision needing a written rationale; lowering one after an improvement needs nothing. |
