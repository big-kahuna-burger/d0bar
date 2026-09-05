# add-panel-detach

## Why
Every other change reduces the toolbar's cost on the host's main thread. This one removes it.

`documentPictureInPicture` gives a same-origin, always-on-top window with its own document —
and therefore its own rendering. Detached, the host page keeps the collector and a 34px button;
all panel rendering, all worker messaging, all trace layout happens in a window that is not the
host's document at all.

It also fits the product: when you are actually staring at the numbers, the UI is not on the
page it is measuring. And it makes Budget A trivially provable rather than merely budgeted.

## What Changes
- Detach affordance; panel DOM moves into a PiP window, stylesheets re-adopted.
- Collector stays in the host page — it must, since only that realm sees the entries.
- Re-attach on window close, on navigation, and on unsupported browsers.
- A budget row measuring host cost while detached.

## Impact
- New capability: `panel-detach`
- New: `src/panel/detach.ts`
- Depends on: `add-panel-shell`
- Chromium-only today; progressive enhancement, hidden where unsupported
