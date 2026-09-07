# @d0bar/signals

**A ~1 kB signals core with direct DOM bindings. No virtual DOM, no scheduler, no framework.**

[![size](https://img.shields.io/badge/gzip-1.11%20kB-blue)](.size-limit.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

```bash
npm i @d0bar/signals
```

```ts
import { signal, computed, effect } from "@d0bar/signals/signal";

const count = signal(0);
const doubled = computed(() => count() * 2);

effect(() => console.log(doubled())); // logs 0
count.set(21); // logs 42
```

---

## Who this is for

**You, if you need reactivity inside something that isn't a page you control** — and every
kilobyte and every millisecond is somebody else's.

Concretely:

- **Embedded widgets, SDKs and browser extensions** injected into a third party's page, where
  shipping a framework is not an option and _your_ main-thread time is _their_ main-thread
  time.
- **Devtools, overlays and debug panels** — anything measuring a page it lives inside, where
  the tool's own cost corrupts the reading.
- **People who want to understand their reactivity library.** It is four small files. You can
  read all of it in fifteen minutes and there is nothing hidden underneath.

**This is probably not for you if** you are building an application. Use Solid, Svelte, Vue or
Preact — they are excellent, they have ecosystems, and they solve problems this deliberately
does not. This exists because d0bar could not afford any of them, not because they are wrong.

---

## Why it exists

Extracted from [d0bar](https://github.com/big-kahuna-burger/d0bar), an observability toolbar whose single
constraint is **it must not distort what it measures.** A UI framework that costs main-thread
time inside a page whose main-thread time _is the product_ would be self-defeating.

So this is what was left after removing everything that wasn't load-bearing.

---

## API

```ts
import { signal, computed, effect, scope } from "@d0bar/signals/signal";
import {
  bindText,
  bindVar,
  bindStyle,
  bindAttr,
  bindClass,
  bindHidden,
  on,
} from "@d0bar/signals/bind";
import { list } from "@d0bar/signals/list";
```

**`signal(initial)`** — a readable/writable value. Call it to read, `.set(v)` to write,
`.peek()` to read without subscribing.

**`computed(fn)`** — a derived value, cached until a dependency changes.

**`effect(fn)`** — runs immediately, then whenever anything it read changes. Returns a
disposer.

**`scope()`** — collects disposers so a view tears down in one call.

**Bindings** each own exactly one mutable thing — a text node, a custom property, an attribute
— and write it only when the value actually changed.

**`list({ container, key, create })`** — keyed reconciliation with an append-only fast path.

---

## Design notes

**Push is synchronous.** A write runs its dependent effects before it returns. No microtask
queue, no batching. This is a deliberate limit, not an omission: the consumer updates on a
coalescing clock or a user gesture, so there is no burst for a scheduler to absorb — and a
synchronous graph is one that appears in a stack trace.

**Computeds are lazy.** Most derived values feed a view that isn't currently on screen.
Recomputing a hidden tab's state on every write is work nobody can see.

**Every binding re-reads before it writes.** Most ticks have nothing to say, and a write that
happens anyway dirties layout for no reason.

**`bindHidden` uses the `hidden` property**, not `style.display`, so an element's own display
mode survives being hidden and restored — a flex row doesn't come back as a block. Your
stylesheet needs `[hidden] { display: none !important }`.

**The list's fast path** handles the streaming case: rows arrive at the end and nothing before
them moves, so new rows go in as one fragment with no moves and no reparenting. Surviving rows
are still updated in place, because a key being unchanged says nothing about its contents.

---

## Development guard

Define `__DEV__` at build time to enable guards: a write from inside a `computed` throws
rather than silently desynchronising the graph, and a reactive cycle throws instead of
exhausting the stack.

If your bundler doesn't define it, this resolves it to `false` rather than throwing a
`ReferenceError` — so the package works with no build step at all.

---

## Budgets

|                               |                                       |
| ----------------------------- | ------------------------------------- |
| everything                    | ≤ 1.6 kB gzip — currently **1.11 kB** |
| `@d0bar/signals/signal` alone | ≤ 900 B gzip                          |

Enforced by `pnpm size` in CI. These are limits, not aspirations.

---

## License

[MIT](LICENSE).
