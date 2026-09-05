/**
 * Background scheduling.
 *
 * Deferred work is explicitly background priority, never a timer. `setTimeout` chunking
 * competes with the host page at normal priority, which is the opposite of what a toolbar
 * measuring that page should do. The chosen mechanism is recorded so the UI can disclose
 * it rather than implying a guarantee the platform did not give.
 */

type Cancel = () => void;

export type ScheduleMode = "postTask" | "requestIdleCallback" | "timeout";

let mode: ScheduleMode = "timeout";

interface SchedulerLike {
  postTask(
    callback: () => void,
    options?: { priority?: string; signal?: AbortSignal; delay?: number },
  ): Promise<unknown>;
}

const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler;

if (scheduler && typeof scheduler.postTask === "function") mode = "postTask";
else if (typeof globalThis.requestIdleCallback === "function") mode = "requestIdleCallback";

/** The mechanism in use on this browser. Surfaced in diagnostics. */
export function scheduleMode(): ScheduleMode {
  return mode;
}

/**
 * Runs `task` no sooner than `ms` from now, at background priority where the platform
 * supports it. A delay is a delay — the point is the wait, not the priority — so a timer is
 * the correct primitive here rather than an idle callback that could fire at any moment.
 */
export function delayed(task: () => void, ms: number): Cancel {
  if (mode === "postTask" && scheduler) {
    const controller = new AbortController();
    void scheduler
      .postTask(task, { priority: "background", signal: controller.signal, delay: ms })
      .catch(() => {});
    return () => controller.abort();
  }
  const handle = setTimeout(task, ms);
  return () => clearTimeout(handle);
}

/**
 * Runs `task` at background priority. Returns a cancel function; a cancelled task never
 * runs. Rejection from an aborted `postTask` is swallowed — cancellation is not an error.
 */
export function background(task: () => void): Cancel {
  if (mode === "postTask" && scheduler) {
    const controller = new AbortController();
    void scheduler
      .postTask(task, { priority: "background", signal: controller.signal })
      .catch(() => {});
    return () => controller.abort();
  }
  if (mode === "requestIdleCallback") {
    const handle = requestIdleCallback(task);
    return () => cancelIdleCallback(handle);
  }
  /* Last resort, on browsers with neither API. Reported as `timeout` so the toolbar does
     not claim background priority it does not have. */
  const handle = setTimeout(task, 0);
  return () => clearTimeout(handle);
}
