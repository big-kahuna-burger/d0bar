import { describe, expect, it, vi } from "vitest";
import { computed, effect, scope, signal } from "../src/signal";

describe("signal", () => {
  it("reads, writes, and notifies", () => {
    const count = signal(0);
    const seen: number[] = [];
    effect(() => seen.push(count()));

    count.set(1);
    count.set(2);

    /* The effect runs once immediately, then on each change. */
    expect(seen).toEqual([0, 1, 2]);
  });

  it("does not notify when the value is unchanged", () => {
    const name = signal("a");
    const run = vi.fn();
    effect(() => {
      name();
      run();
    });

    name.set("a");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("treats NaN as unchanged, per Object.is", () => {
    const n = signal(Number.NaN);
    const run = vi.fn();
    effect(() => {
      n();
      run();
    });

    n.set(Number.NaN);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("peek reads without subscribing", () => {
    const a = signal(1);
    const run = vi.fn();
    effect(() => {
      a.peek();
      run();
    });

    a.set(2);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("computed", () => {
  it("derives and caches", () => {
    const a = signal(2);
    const work = vi.fn(() => a() * 10);
    const ten = computed(work);

    expect(ten()).toBe(20);
    expect(ten()).toBe(20);
    /* Cached: reading twice evaluates once. */
    expect(work).toHaveBeenCalledTimes(1);

    a.set(3);
    expect(ten()).toBe(30);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("is lazy — an unread computed never evaluates", () => {
    const a = signal(1);
    const work = vi.fn(() => a() * 2);
    computed(work);

    a.set(2);
    expect(work).not.toHaveBeenCalled();
  });

  it("evaluates once per change on a diamond dependency", () => {
    /*      a
     *     / \
     *    b   c      b and c both depend on a; d depends on both. A naive graph runs `d`
     *     \ /       twice per change to `a`.
     *      d
     */
    const a = signal(1);
    const b = computed(() => a() + 1);
    const c = computed(() => a() + 2);
    const work = vi.fn(() => b() + c());
    const d = computed(work);

    expect(d()).toBe(5);
    expect(work).toHaveBeenCalledTimes(1);

    a.set(2);
    expect(d()).toBe(7);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("propagates through a chain of computeds", () => {
    const a = signal(1);
    const b = computed(() => a() * 2);
    const c = computed(() => b() + 1);
    const seen: number[] = [];
    effect(() => seen.push(c()));

    a.set(5);
    expect(seen).toEqual([3, 11]);
  });

  it("throws in development when a computed writes to a signal", () => {
    const a = signal(1);
    const bad = computed(() => {
      a.set(2);
      return 0;
    });

    expect(() => bad()).toThrow(/computed wrote to a signal/);
  });
});

describe("effect", () => {
  it("tracks only what the latest run read", () => {
    const useA = signal(true);
    const a = signal("a");
    const b = signal("b");
    const seen: string[] = [];

    effect(() => seen.push(useA() ? a() : b()));
    expect(seen).toEqual(["a"]);

    useA.set(false);
    expect(seen).toEqual(["a", "b"]);

    /* `a` is no longer a dependency, so writing it must do nothing. */
    a.set("a2");
    expect(seen).toEqual(["a", "b"]);

    b.set("b2");
    expect(seen).toEqual(["a", "b", "b2"]);
  });

  it("stops running and releases its edges once disposed", () => {
    const a = signal(0);
    const run = vi.fn();
    const dispose = effect(() => {
      a();
      run();
    });

    dispose();
    a.set(1);
    expect(run).toHaveBeenCalledTimes(1);

    /* Disposing twice is not an error — teardown paths call it defensively. */
    expect(() => dispose()).not.toThrow();
  });

  it("holds no reference to a disposed effect", () => {
    const a = signal(0);
    const dispose = effect(() => a());
    dispose();

    /* The panel is opened and closed repeatedly inside a long-lived host page, so an
       effect that stays subscribed after teardown is a permanent leak, not a slow one. */
    const subs = (a as unknown as { subs?: Set<unknown> }).subs;
    expect(subs === undefined || subs.size === 0).toBe(true);
  });

  it("detects a cycle rather than exhausting the stack", () => {
    const a = signal(0);
    expect(() => {
      effect(() => {
        a.set(a() + 1);
      });
    }).toThrow(/cycle/);
  });
});

describe("scope", () => {
  it("disposes everything it collected", () => {
    const a = signal(0);
    const run = vi.fn();
    const s = scope();
    s.add(
      effect(() => {
        a();
        run();
      }),
    );

    s.dispose();
    a.set(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
