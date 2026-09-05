import { DEV } from "./dev";

/**
 * The reactive core: `signal`, `computed`, `effect`.
 *
 * Roughly a kilobyte, and it exists instead of a framework because the panel's needs are
 * narrow and its budget is not. Nothing here diffs a tree — a binding writes one text node or
 * one custom property, which is the shape every view in this panel actually needs.
 *
 * Push is **synchronous**: a write runs its dependent effects before it returns. There is no
 * scheduler and no microtask queue. That is a deliberate limit rather than a simplification —
 * the panel only updates on a coalescing clock or a user gesture, so there is no burst for a
 * scheduler to absorb, and a synchronous graph is one that can be reasoned about in a stack
 * trace.
 *
 * Reads are tracked automatically: calling a signal inside a `computed` or `effect` subscribes
 * it. `peek()` reads without subscribing, for the cases where tracking would be wrong.
 */

/** Something that can be depended upon. */
interface Source {
  subs: Set<Consumer>;
}

/** Something that depends on sources and must re-run when they change. */
interface Consumer {
  deps: Set<Source>;
  /** Re-run this consumer. */
  run(): void;
  disposed: boolean;
  /** Only computeds have this; effects re-run eagerly. */
  markDirty?(): void;
}

/** The consumer currently executing, if any. Reads register against it. */
let active: Consumer | undefined;

/**
 * Depth of the current notification, so a cycle fails loudly rather than blowing the stack
 * somewhere unrelated. A legitimate graph is nowhere near this deep.
 */
let depth = 0;
const MAX_DEPTH = 100;

/** True while a computed is evaluating. Writing from there desynchronises the graph. */
let computing = false;

export interface Signal<T> {
  (): T;
  set(next: T): void;
  /** Reads without subscribing the active consumer. */
  peek(): T;
}

export interface ReadonlySignal<T> {
  (): T;
  peek(): T;
}

function link(source: Source): void {
  if (!active) return;
  source.subs.add(active);
  active.deps.add(source);
}

/** Drops every dependency edge, so a re-run re-registers only what it actually reads. */
function unlink(consumer: Consumer): void {
  for (const dep of consumer.deps) dep.subs.delete(consumer);
  consumer.deps.clear();
}

function notify(source: Source): void {
  if (source.subs.size === 0) return;
  if (++depth > MAX_DEPTH) {
    depth = 0;
    throw new Error("d0bar: reactive cycle — a signal write re-triggered its own dependents.");
  }
  try {
    /* Copied: a consumer may re-subscribe or dispose while running, and mutating the set
       under iteration would silently skip a subscriber. */
    for (const sub of [...source.subs]) {
      if (sub.disposed) continue;
      if (sub.markDirty) sub.markDirty();
      else sub.run();
    }
  } finally {
    depth--;
  }
}

function run<T>(consumer: Consumer, fn: () => T): T {
  const previous = active;
  active = consumer;
  try {
    return fn();
  } finally {
    active = previous;
  }
}

export function signal<T>(initial: T): Signal<T> {
  const source: Source = { subs: new Set() };
  let value = initial;

  const read = (() => {
    link(source);
    return value;
  }) as Signal<T>;

  read.peek = () => value;
  read.set = (next: T) => {
    if (Object.is(next, value)) return;
    if (DEV && computing) {
      throw new Error(
        "d0bar: a computed wrote to a signal. Computeds must be pure — derive the value instead.",
      );
    }
    value = next;
    notify(source);
  };

  return read;
}

/**
 * A derived value, evaluated lazily and cached until a dependency changes.
 *
 * Lazy rather than eager because most computeds in the panel feed a view that is not currently
 * on screen. Recomputing a hidden tab's derived state on every ring write would be work the
 * user cannot see, which is the category of work this project exists to avoid.
 */
export function computed<T>(fn: () => T): ReadonlySignal<T> {
  const source: Source = { subs: new Set() };
  let value: T;
  let dirty = true;

  const consumer: Consumer = {
    deps: new Set(),
    disposed: false,
    run() {
      /* Nothing eager to do; `markDirty` already invalidated the cache. */
    },
    markDirty() {
      if (dirty) return;
      dirty = true;
      /* Invalidation is transitive: dependents must hear about it even though this computed
         has not been re-evaluated yet. */
      notify(source);
    },
  };

  const read = (() => {
    link(source);
    if (dirty) {
      unlink(consumer);
      const wasComputing = computing;
      computing = true;
      try {
        value = run(consumer, fn);
      } finally {
        computing = wasComputing;
      }
      dirty = false;
    }
    return value;
  }) as ReadonlySignal<T>;

  read.peek = () => {
    const previous = active;
    active = undefined;
    try {
      return read();
    } finally {
      active = previous;
    }
  };

  return read;
}

export type Dispose = () => void;

/**
 * Runs `fn` immediately and again whenever anything it read changes. Returns a disposer;
 * a disposed effect never runs again and holds no references.
 */
export function effect(fn: () => void): Dispose {
  const consumer: Consumer = {
    deps: new Set(),
    disposed: false,
    run() {
      if (consumer.disposed) return;
      unlink(consumer);
      run(consumer, fn);
    },
  };

  consumer.run();

  return () => {
    if (consumer.disposed) return;
    consumer.disposed = true;
    unlink(consumer);
  };
}

/**
 * Collects disposers so a view tears down in one call.
 *
 * The panel is created and destroyed repeatedly — every open and close — inside someone
 * else's long-lived page, so a leaked effect is not a slow leak but a permanent one.
 */
export function scope(): { add(dispose: Dispose): void; dispose: Dispose } {
  const disposers: Dispose[] = [];
  return {
    add: (dispose) => disposers.push(dispose),
    dispose: () => {
      for (const d of disposers) d();
      disposers.length = 0;
    },
  };
}
