import { effect, type Dispose } from "./signal";

/**
 * Direct DOM bindings.
 *
 * There is no virtual DOM here and no diffing. A binding owns exactly one mutable thing — one
 * text node, one custom property, one attribute — and writes it when its inputs change. That
 * is the whole abstraction, and it is enough because the panel's dynamic surface is a few
 * dozen scalars rather than an arbitrary tree.
 *
 * Every binding **re-reads before it writes** and returns early when the value is unchanged.
 * The panel refreshes on a coalescing clock, so most ticks have nothing to say; a write that
 * happens anyway would dirty layout in a page whose layout we are measuring.
 */

/** Binds a text node's content. Text nodes, not `textContent` — no child churn, no reparse. */
export function bindText(node: Text, fn: () => string): Dispose {
  let shown: string | undefined;
  return effect(() => {
    const next = fn();
    if (next === shown) return;
    node.nodeValue = next;
    shown = next;
  });
}

/**
 * Binds a CSS custom property on an element.
 *
 * The waterfall's bar geometry rides on these. Writing `--l` and `--w` on a row that is
 * `contain: layout paint style` lets the browser recompute one contained subtree rather than
 * re-laying out the list, which is why bar positions are custom properties and not inline
 * `left` / `width`.
 */
export function bindVar(el: HTMLElement, name: string, fn: () => string): Dispose {
  let shown: string | undefined;
  return effect(() => {
    const next = fn();
    if (next === shown) return;
    el.style.setProperty(name, next);
    shown = next;
  });
}

/** Binds one inline style property. */
export function bindStyle(
  el: HTMLElement,
  property: string,
  fn: () => string,
): Dispose {
  let shown: string | undefined;
  return effect(() => {
    const next = fn();
    if (next === shown) return;
    el.style.setProperty(property, next);
    shown = next;
  });
}

/**
 * Binds an attribute. A `false` result removes the attribute rather than setting `"false"` —
 * which is what ARIA and boolean attributes actually mean.
 */
export function bindAttr(
  el: Element,
  name: string,
  fn: () => string | boolean | null,
): Dispose {
  let shown: string | boolean | null | undefined;
  return effect(() => {
    const next = fn();
    if (next === shown) return;
    if (next === false || next === null) el.removeAttribute(name);
    else el.setAttribute(name, next === true ? "" : next);
    shown = next;
  });
}

/** Binds a single class name's presence. */
export function bindClass(el: Element, name: string, fn: () => boolean): Dispose {
  let shown: boolean | undefined;
  return effect(() => {
    const next = fn();
    if (next === shown) return;
    el.classList.toggle(name, next);
    shown = next;
  });
}

/**
 * Binds visibility through the `hidden` property.
 *
 * `hidden`, not `style.display`: the panel's stylesheet carries `[hidden] { display: none }`,
 * so an element's own display mode survives being hidden and restored — a flex row does not
 * come back as a block.
 */
export function bindHidden(el: HTMLElement, fn: () => boolean): Dispose {
  let shown: boolean | undefined;
  return effect(() => {
    const next = fn();
    if (next === shown) return;
    el.hidden = next;
    shown = next;
  });
}

/** Adds a listener and returns its remover, so it can join a scope like any other binding. */
export function on<K extends keyof HTMLElementEventMap>(
  el: HTMLElement,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): Dispose {
  el.addEventListener(type, handler as EventListener, options);
  return () => el.removeEventListener(type, handler as EventListener, options);
}
