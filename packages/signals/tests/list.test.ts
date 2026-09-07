// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { list, type Row } from "../src/list";

interface Item {
  id: number;
  label: string;
}

let created = 0;
let disposed = 0;

function harness() {
  created = 0;
  disposed = 0;
  const container = document.createElement("div");
  const handle = list<Item>({
    container,
    key: (item) => item.id,
    create(item): Row<Item> {
      created++;
      const el = document.createElement("p");
      el.dataset.id = String(item.id);
      el.textContent = item.label;
      return {
        el,
        update(next) {
          el.textContent = next.label;
        },
        dispose() {
          disposed++;
        },
      };
    },
  });
  const ids = () => Array.from(container.children, (c) => (c as HTMLElement).dataset.id);
  const labels = () => Array.from(container.children, (c) => c.textContent);
  return { container, handle, ids, labels };
}

const items = (...ns: number[]): Item[] => ns.map((n) => ({ id: n, label: `i${n}` }));

describe("list", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders in order", () => {
    const { handle, ids } = harness();
    handle.render(items(1, 2, 3));
    expect(ids()).toEqual(["1", "2", "3"]);
  });

  it("appends without recreating existing rows", () => {
    const { handle, ids } = harness();
    handle.render(items(1, 2, 3));
    const before = created;

    handle.render(items(1, 2, 3, 4, 5));

    expect(ids()).toEqual(["1", "2", "3", "4", "5"]);
    /* The streaming case: only the two new rows are built, and no existing node is touched. */
    expect(created - before).toBe(2);
    expect(disposed).toBe(0);
  });

  it("keeps the same DOM nodes across an append", () => {
    const { container, handle } = harness();
    handle.render(items(1, 2));
    const first = container.firstElementChild;

    handle.render(items(1, 2, 3));

    /* Node identity is what preserves scroll position and focus inside a row. */
    expect(container.firstElementChild).toBe(first);
  });

  it("reorders by moving nodes, not rebuilding them", () => {
    const { container, handle, ids } = harness();
    handle.render(items(1, 2, 3));
    const nodeFor = new Map(
      Array.from(container.children, (c) => [(c as HTMLElement).dataset.id, c]),
    );
    const before = created;

    handle.render(items(3, 1, 2));

    expect(ids()).toEqual(["3", "1", "2"]);
    expect(created - before).toBe(0);
    expect(container.firstElementChild).toBe(nodeFor.get("3"));
  });

  it("removes and disposes rows that disappear", () => {
    const { handle, ids } = harness();
    handle.render(items(1, 2, 3));

    handle.render(items(1, 3));

    expect(ids()).toEqual(["1", "3"]);
    expect(disposed).toBe(1);
  });

  it("updates a surviving row in place", () => {
    const { handle, labels } = harness();
    handle.render(items(1, 2));
    const before = created;

    handle.render([
      { id: 1, label: "changed" },
      { id: 2, label: "i2" },
    ]);

    expect(labels()).toEqual(["changed", "i2"]);
    expect(created - before).toBe(0);
  });

  it("handles the ring dropping its oldest records", () => {
    const { handle, ids } = harness();
    handle.render(items(1, 2, 3, 4));
    const before = created;

    /* The window slid: the head was dropped and a new record arrived at the tail. */
    handle.render(items(2, 3, 4, 5));

    expect(ids()).toEqual(["2", "3", "4", "5"]);
    expect(disposed).toBe(1);
    expect(created - before).toBe(1);
  });

  it("empties completely", () => {
    const { handle, ids } = harness();
    handle.render(items(1, 2, 3));
    handle.render([]);
    expect(ids()).toEqual([]);
    expect(disposed).toBe(3);
  });

  it("disposes every row on teardown", () => {
    const { container, handle } = harness();
    handle.render(items(1, 2, 3));

    handle.dispose();

    expect(container.children.length).toBe(0);
    expect(disposed).toBe(3);
  });

  it("does not take the fast path when a key changes at the same index", () => {
    const { handle, ids } = harness();
    handle.render(items(1, 2));
    const create = vi.fn();
    void create;

    /* Same length prefix, different key — the fast path must not fire. */
    handle.render(items(9, 2, 3));

    expect(ids()).toEqual(["9", "2", "3"]);
    expect(disposed).toBe(1);
  });
});
