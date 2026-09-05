import type { Dispose } from "./signal";

/**
 * Keyed list reconciliation, with an append-only fast path.
 *
 * The panel's lists are almost always *streaming*: requests arrive at the end and nothing
 * before them moves. The fast path detects that up front and inserts the new rows in a single
 * fragment, without moving or reparenting anything already rendered. Surviving rows are still
 * updated in place — their keys being unchanged says nothing about their contents — but a
 * binding writes only when its value actually changed, so an unchanged row touches no DOM.
 *
 * The general path handles the rest — filtering, sorting, the ring dropping its oldest
 * records — by index-mapping existing rows and moving only what actually moved.
 *
 * Rows are created by the caller. This module never decides what a row looks like; it only
 * decides which rows exist and in what order.
 */

export interface Row<T> {
  el: HTMLElement;
  /** Updates an existing row in place, so a changed value never recreates a node. */
  update(item: T): void;
  dispose: Dispose;
}

export interface ListOptions<T> {
  container: HTMLElement;
  key(item: T): string | number;
  create(item: T): Row<T>;
}

export interface ListHandle<T> {
  /** Reconciles the container against `items`. */
  render(items: readonly T[]): void;
  /** Removes every row and disposes its bindings. */
  dispose: Dispose;
}

export function list<T>(options: ListOptions<T>): ListHandle<T> {
  const { container, key, create } = options;
  /* Insertion-ordered, so iteration reflects the currently rendered order. */
  let rows = new Map<string | number, Row<T>>();

  function render(items: readonly T[]): void {
    const next = new Map<string | number, Row<T>>();

    /* Append-only fast path: every currently rendered key still occupies the same index, and
       the new items are strictly a suffix. This is the streaming case, and here it costs no
       node moves and no reparenting — only the new rows are inserted. */
    if (items.length >= rows.size) {
      let sharedPrefix = true;
      let checked = 0;
      for (const existing of rows.keys()) {
        const item = items[checked];
        if (item === undefined || key(item) !== existing) {
          sharedPrefix = false;
          break;
        }
        checked++;
      }

      if (sharedPrefix) {
        /* Surviving rows still have to be updated — a row's *key* being unchanged says
           nothing about its contents, and skipping this renders a stale value that looks
           exactly like a working list. No DOM is written unless a binding's value actually
           changed, so an unchanged row still costs nothing beyond the call. */
        let i = 0;
        for (const [k, row] of rows) {
          row.update(items[i] as T);
          next.set(k, row);
          i++;
        }
        /* One fragment, so appending N rows is one insertion rather than N. */
        const fragment = document.createDocumentFragment();
        for (let j = rows.size; j < items.length; j++) {
          const item = items[j] as T;
          const row = create(item);
          next.set(key(item), row);
          fragment.appendChild(row.el);
        }
        if (fragment.childNodes.length > 0) container.appendChild(fragment);
        rows = next;
        return;
      }
    }

    /* General path. Reuse a row wherever its key survives — a reused row keeps its DOM node,
       so scroll position and any focus inside it survive a reorder. */
    let cursor: ChildNode | null = container.firstChild;
    for (const item of items) {
      const k = key(item);
      let row = rows.get(k);
      if (row) {
        rows.delete(k);
        row.update(item);
      } else {
        row = create(item);
      }

      if (cursor === row.el) {
        cursor = cursor.nextSibling;
      } else {
        container.insertBefore(row.el, cursor);
      }
      next.set(k, row);
    }

    /* Whatever is left in `rows` did not survive this render. */
    for (const row of rows.values()) {
      row.dispose();
      row.el.remove();
    }

    rows = next;
  }

  return {
    render,
    dispose() {
      for (const row of rows.values()) {
        row.dispose();
        row.el.remove();
      }
      rows.clear();
    },
  };
}
