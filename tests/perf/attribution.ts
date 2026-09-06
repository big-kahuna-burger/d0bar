import type { Page } from "@playwright/test";

/**
 * Per-task main-thread time attributed to a specific script, from the browser's own tracer.
 *
 * ## Why this exists
 *
 * `requests-view`'s budget is written as *"no frame with more than 8 ms of toolbar work"*, and
 * the two obvious instruments both answer a different question:
 *
 * | instrument                | what it actually reports                                     |
 * | ------------------------- | ------------------------------------------------------------ |
 * | `long-animation-frame`    | the whole frame, and only when it exceeds 50 ms               |
 * | `longtask`                | the whole task, and only when it exceeds 50 ms                |
 * | `performance.now()` in-product | d0bar measuring d0bar — instrumentation inside the thing under test |
 *
 * A 50 ms floor cannot see an 8 ms budget, and *"the frame was short"* is not the same claim as
 * *"the toolbar's share of the frame was small"* — on an idle fixture the two coincide, which is
 * an argument from the fixture's behaviour rather than a measurement of provenance.
 *
 * CDP tracing answers it directly. `FunctionCall` and `EvaluateScript` events carry the script
 * URL that entered, at microsecond resolution and with no floor, so d0bar's share of a frame is
 * a sum over the events whose URL is d0bar's. This is the same move as the listener assertion in
 * `non-perturbation.spec.ts`: read the browser's own record rather than patch the product to
 * report on itself.
 *
 * ## What it does not report
 *
 * **Script time only.** Style recalculation and layout provoked by d0bar's writes land in
 * `AnimationFrame::StyleAndLayout`, which is attributed to no script — the browser does not
 * record who dirtied the tree. That work is bounded structurally instead, by `contain: layout
 * style` on the row, and any caller that needs the whole-frame figure should read
 * {@link Attribution.maxTaskMs} beside {@link Attribution.maxAnyTaskMs}.
 *
 * **Measured under tracing overhead**, which inflates rather than flatters: the tracer's own
 * cost lands inside the intervals it reports, so a number produced here is an upper bound on the
 * untraced one.
 */

/** A trace event, as `Tracing.dataCollected` delivers it. `ts` and `dur` are microseconds. */
interface TraceEvent {
  name?: string;
  ph?: string;
  ts?: number;
  dur?: number;
  args?: { data?: { url?: string } };
}

export interface Attribution {
  /** The largest d0bar-attributed script total inside any one top-level task, in ms. */
  maxTaskMs: number;
  /** Every task that ran d0bar script, descending by that task's d0bar total, in ms. */
  taskMs: number[];
  /** d0bar-attributed script time across the whole window, in ms. */
  totalMs: number;
  /** The longest top-level task in the window regardless of who ran in it, in ms. */
  maxAnyTaskMs: number;
  /** Top-level tasks observed in the window. */
  taskCount: number;
}

/** The script-entry events that name a URL. Anything else is not script execution. */
const SCRIPT_EVENTS = new Set(["FunctionCall", "EvaluateScript"]);

/**
 * Runs `body` with the tracer on and reports what `matches` spent on the main thread.
 *
 * @param matches - Predicate over a script URL. Given d0bar's two bundles, a substring test on
 *   `/dist/d0bar` is enough and is deliberately not a regex over the host's own scripts.
 */
export async function attributedDuring(
  page: Page,
  matches: (url: string) => boolean,
  body: () => Promise<void>,
): Promise<Attribution> {
  const cdp = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  cdp.on("Tracing.dataCollected", (payload: { value: TraceEvent[] }) => {
    for (const event of payload.value) events.push(event);
  });
  const complete = new Promise<void>((resolve) =>
    cdp.on("Tracing.tracingComplete", () => resolve()),
  );

  await cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    /* Both categories, and the disabled-by-default one is not optional: `RunTask` is only
       emitted there. Without it every attributed call lands in its own bucket, and two
       separate entries into d0bar within one frame are then reported as two frames — which
       flatters exactly the maximum this is gating. */
    traceConfig: {
      includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline"],
    },
  });
  try {
    await body();
  } finally {
    await cdp.send("Tracing.end");
    await complete;
    await cdp.detach();
  }

  return reduce(events, matches);
}

/** Exported for its own unit test — the arithmetic is worth settling without a browser. */
export function reduce(events: TraceEvent[], matches: (url: string) => boolean): Attribution {
  const tasks: Array<{ start: number; end: number }> = [];
  const calls: Array<{ start: number; end: number }> = [];

  for (const event of events) {
    if (event.ts === undefined || event.dur === undefined) continue;
    const span = { start: event.ts, end: event.ts + event.dur };
    if (event.name === "RunTask") {
      tasks.push(span);
      continue;
    }
    if (!SCRIPT_EVENTS.has(event.name ?? "")) continue;
    const url = event.args?.data?.url;
    if (url && matches(url)) calls.push(span);
  }

  tasks.sort((a, b) => a.start - b.start);
  calls.sort((a, b) => a.start - b.start || b.end - a.end);

  /* A d0bar function that calls another d0bar function produces two events covering the same
     microseconds. Counting both would report roughly twice the time actually spent, so a call
     already inside an accepted one is dropped rather than added — the outermost entry into
     d0bar code is the whole of what d0bar cost. */
  const outermost: Array<{ start: number; end: number }> = [];
  let reach = -Infinity;
  for (const call of calls) {
    if (call.end <= reach) continue;
    outermost.push(call);
    reach = Math.max(reach, call.end);
  }

  const perTask = new Map<number, number>();
  let total = 0;
  for (const call of outermost) {
    total += call.end - call.start;
    /* The innermost task containing the call. Tasks do not normally nest, but picking the
       tightest enclosure keeps the per-task figure right if one ever does. */
    let best = -1;
    let bestWidth = Infinity;
    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[i]!;
      if (task.start > call.start) break;
      if (task.end < call.end) continue;
      const width = task.end - task.start;
      if (width < bestWidth) {
        best = i;
        bestWidth = width;
      }
    }
    /* A call with no enclosing RunTask is its own bucket rather than discarded — losing it
       would flatter the maximum, which is the number being gated. */
    const key = best === -1 ? -call.start : best;
    perTask.set(key, (perTask.get(key) ?? 0) + (call.end - call.start));
  }

  const taskMs = [...perTask.values()].map((us) => us / 1000).sort((a, b) => b - a);
  const anyMs = tasks.map((task) => (task.end - task.start) / 1000);
  return {
    maxTaskMs: taskMs[0] ?? 0,
    taskMs,
    totalMs: total / 1000,
    maxAnyTaskMs: anyMs.length ? Math.max(...anyMs) : 0,
    taskCount: tasks.length,
  };
}

/** d0bar's own bundles, and nothing the fixture serves. */
export const isD0bar = (url: string): boolean => url.includes("/dist/d0bar");
