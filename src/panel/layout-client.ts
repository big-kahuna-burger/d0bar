import {
  F_DEGENERATE,
  F_HAS_LOG,
  F_ERROR,
  F_ORPHAN,
  LAYOUT_PROTOCOL_VERSION,
  VERSION_MISMATCH_COPY,
  layoutViews,
  type LayoutResponse,
  type LayoutSummary,
  type LogRecord,
  type LayoutViews,
} from "../shared/protocol";
import type { SpanRow } from "../trace/traceMachine";

/**
 * The panel's side of the layout worker.
 *
 * Everything this file does is arrange for work *not* to happen here: it posts a string, waits,
 * and keeps typed arrays. It never parses JSON, never walks a tree, never sorts and never
 * computes a position. If a future change makes it do any of those, the worker has stopped
 * earning its existence.
 *
 * ## Lifecycle
 *
 * One worker, created on the first trace opened and terminated after {@link IDLE_MS} of not
 * being asked for anything. Not created with the panel: opening the panel must cost a panel,
 * and a developer who never opens a trace never pays for a worker thread. Not kept forever
 * either — a page left on a dashboard overnight should not be holding a thread for a trace
 * somebody looked at once.
 *
 * A terminated worker is not a broken one. The next request builds another; that is the whole
 * of the recovery path, and it is why nothing here retries.
 */

/** How long the worker may sit idle before it is terminated. */
export const IDLE_MS = 30_000;

/** Long enough for a cold worker to start and lay out a large trace; short enough to not hang. */
const TIMEOUT_MS = 15_000;

/**
 * The rows, read straight out of the transferred buffer.
 *
 * `read(index, out)` fills a caller-owned record rather than returning one, the same shape the
 * ring uses everywhere else in this codebase and for the same reason: the span list repaints on
 * scroll, and a per-row object would put four thousand allocations behind every drag. The
 * virtualizer only ever holds a viewport's worth of rows, so only a viewport's worth of strings
 * is ever materialised.
 */
export interface SpanRows {
  readonly count: number;
  read(index: number, out: SpanRow): boolean;
}

function spanRows(views: LayoutViews, count: number, strings: string[]): SpanRows {
  return {
    count,
    read(index, out) {
      if (index < 0 || index >= count) return false;
      out.name = strings[views.nameId[index]!] ?? "";
      out.service = strings[views.serviceId[index]!] ?? "";
      out.depth = views.depth[index]!;
      out.left = views.left[index]!;
      out.width = views.width[index]!;
      /* The only unit conversion on this side, and it is one divide on a row already about to
         be painted — not four thousand of them up front. */
      out.durationMs = views.durationNs[index]! / 1e6;
      out.colorIndex = views.paletteIndex[index]!;
      const flags = views.flags[index]!;
      out.orphan = (flags & F_ORPHAN) !== 0;
      out.error = (flags & F_ERROR) !== 0;
      out.degenerate = (flags & F_DEGENERATE) !== 0;
      out.hasLog = (flags & F_HAS_LOG) !== 0;
      return true;
    },
  };
}

export interface Flattened {
  rows: SpanRows;
  summary: LayoutSummary;
  /** The correlated logs, capped and with each row resolved by the worker. */
  logs: LogRecord[];
  /** Records the response held, before the cap. */
  logsSeen: number;
  /** Milliseconds the worker spent. The only number the header's cost line may be printed from. */
  workerMs: number;
}

export interface LayoutClient {
  /**
   * Lays out one response body.
   *
   * Rejects with an {@link Error} whose message is displayable — the machine turns a rejection
   * into its `failed` state, and that state's copy is shown verbatim.
   */
  flatten(body: string, from: number, to: number, signal?: AbortSignal): Promise<Flattened>;
  /** Terminates the worker if one exists. Called when the panel is destroyed. */
  destroy(): void;
}

export interface LayoutClientOptions {
  /**
   * Builds the worker. Injected so a test can drive the whole client against a fake without a
   * bundler, a URL, or a browser — the default is the real one and is used everywhere else.
   */
  spawn?: () => Worker;
  idleMs?: number;
}

/**
 * The worker's URL, resolved against the panel's own.
 *
 * `import.meta.url` rather than a configured path: stage 2 and the worker are emitted into one
 * directory and served together, so the panel already knows where its sibling is. A host that
 * moves one moves both. This also keeps the CSP requirement at `worker-src 'self'` — nothing
 * here builds a `blob:` URL, so no host needs to widen their policy to allow one.
 *
 * **The URL is built on its own line, and that is load-bearing.** Vite's
 * `worker-import-meta-url` plugin pattern-matches `new Worker(new URL(…, import.meta.url))` and
 * tries to resolve the argument as a *source module* to bundle — which fails, because this
 * names a sibling build artifact that does not exist in `src/`:
 *
 *     Could not resolve entry module "src/panel/d0bar-layout-worker.js".
 *
 * Hoisting the URL out of the call breaks the pattern and leaves the resolution where it
 * belongs: at runtime, against wherever the panel was actually served from. The worker is its
 * own build entry (`D0BAR_STAGE=worker`) precisely so that it is a file and not a chunk.
 */
function defaultSpawn(): Worker {
  const url = new URL("./d0bar-layout-worker.js", import.meta.url);
  return new Worker(url, { type: "module" });
}

export function layoutClient(options: LayoutClientOptions = {}): LayoutClient {
  const spawn = options.spawn ?? defaultSpawn;
  const idleMs = options.idleMs ?? IDLE_MS;

  let worker: Worker | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let nextId = 1;

  interface Pending {
    resolve(value: Flattened): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
    detach(): void;
  }
  const pending = new Map<number, Pending>();

  function settleAll(message: string): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.detach();
      entry.reject(new Error(message));
    }
    pending.clear();
  }

  function terminate(): void {
    if (idle !== undefined) {
      clearTimeout(idle);
      idle = undefined;
    }
    if (!worker) return;
    worker.terminate();
    worker = undefined;
  }

  function armIdle(): void {
    if (idle !== undefined) clearTimeout(idle);
    /* Only when nothing is in flight. A long layout must not have the thread pulled out from
       under it by a timer that started before it did. */
    if (pending.size > 0) return;
    idle = setTimeout(terminate, idleMs);
  }

  function ensure(): Worker {
    if (idle !== undefined) {
      clearTimeout(idle);
      idle = undefined;
    }
    if (worker) return worker;

    const created = spawn();
    created.addEventListener("message", (event: MessageEvent<LayoutResponse>) => {
      const reply = event.data;
      if (!reply || typeof reply !== "object") return;
      const entry = pending.get(reply.id);
      /* A reply for an id nobody is waiting on — the selection moved and the caller abandoned
         it. Dropped here rather than resolved into nothing. */
      if (!entry) return;
      pending.delete(reply.id);
      clearTimeout(entry.timer);
      entry.detach();

      if (reply.version !== LAYOUT_PROTOCOL_VERSION) {
        entry.reject(new Error(VERSION_MISMATCH_COPY));
      } else if (reply.kind === "layout-error") {
        entry.reject(new Error(reply.message));
      } else {
        entry.resolve({
          rows: spanRows(layoutViews(reply.buffer, reply.count), reply.count, reply.strings),
          summary: reply.summary,
          logs: reply.logs,
          logsSeen: reply.logsSeen,
          workerMs: reply.workerMs,
        });
      }
      armIdle();
    });

    /* A worker that fails to load — a 404 on the sibling script, a CSP that forbids workers —
       arrives here, not as a rejected message. Every caller is told, and the instance is
       dropped so the next attempt builds a fresh one rather than talking to a dead handle. */
    created.addEventListener("error", () => {
      settleAll("d0bar could not start its layout worker, so this trace cannot be laid out.");
      terminate();
    });

    worker = created;
    return created;
  }

  return {
    flatten(body, from, to, signal) {
      if (signal?.aborted) {
        return Promise.reject(new Error("The trace layout was cancelled."));
      }
      const target = ensure();
      const id = nextId++;

      return new Promise<Flattened>((resolve, reject) => {
        const onAbort = (): void => {
          const entry = pending.get(id);
          if (!entry) return;
          pending.delete(id);
          clearTimeout(entry.timer);
          entry.detach();
          reject(new Error("The trace layout was cancelled."));
          /* The worker is *not* terminated. It finishes the abandoned layout and posts a reply
             for an id nobody holds, which is dropped above. Killing the thread mid-parse would
             make every selection change cost a worker start, and the panel would spend more
             time booting workers than laying traces out. */
          armIdle();
        };

        const detach = (): void => signal?.removeEventListener("abort", onAbort);
        const timer = setTimeout(() => {
          const entry = pending.get(id);
          if (!entry) return;
          pending.delete(id);
          entry.detach();
          entry.reject(new Error("The trace layout did not finish in time."));
          /* A worker that missed its deadline is not trusted with the next trace. */
          terminate();
        }, TIMEOUT_MS);

        pending.set(id, { resolve, reject, timer, detach });
        signal?.addEventListener("abort", onAbort, { once: true });

        target.postMessage({
          kind: "layout",
          version: LAYOUT_PROTOCOL_VERSION,
          id,
          body,
          from,
          to,
        });
      });
    },
    destroy() {
      settleAll("The panel closed before this trace was laid out.");
      terminate();
    },
  };
}
