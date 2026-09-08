# @d0bar/frame-budget

Measures how much main-thread script time a URL-matched subject contributes to each Chromium
task. It uses CDP tracing outside the product, so the code being measured does not time itself.

`long-animation-frame` and `longtask` both have a 50 ms floor and report the whole frame or task,
not one script's share. In-product timers perturb the code they measure. CDP attribution avoids
those limits and retains microsecond trace resolution.

The result covers JavaScript execution. It cannot attribute style recalculation, layout, or paint
back to the script that caused them. Tracing adds overhead, so measured script time is an upper
bound. The API deliberately supports Chromium only and fails if no matching script ran.

```ts
import { attributedDuring } from "@d0bar/frame-budget";

const result = await attributedDuring(
  page,
  (url) => url.includes("/widget.js"),
  async () => {
    await page.goto("/");
  },
);
```
