import { expect, test } from "@playwright/test";

/**
 * The trace surface's no-span screen, wired to the real classifier in a real browser.
 *
 * `tests/unit/trace-view.test.ts` settles what each cause *says*, against an injected `seen`
 * set and a fake ring. What only a browser settles is that the cause a reader actually gets is
 * the one this page's requests classify to: the ring's own records, the real `initiatorType`
 * the browser reported, and the `seen` set the correlation flush filled — three inputs that
 * exist nowhere in jsdom.
 *
 * The case chosen is the one the old three-way copy got wrong. Before task 4.2 every non-XHR
 * request rendered as *"the service worker saw this request leave with no traceparent"* — an
 * instrumentation finding, printed over a stylesheet the browser's own parser fetched, under a
 * line claiming a worker had observed it.
 */

declare global {
  interface Window {
    __fixtureReady: Promise<void>;
    __d0root: ShadowRoot | undefined;
  }
}

test.beforeEach(async ({ page }) => {
  /* The pill's shadow root is closed on purpose — the host page must not be able to reach into
     the toolbar. Opened at the platform level, before d0bar runs, rather than by weakening the
     product. Same seam as `requests-view.spec.ts`. */
  await page.addInitScript(() => {
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      const root = original.call(this, { ...init, mode: "open" });
      if (this.tagName === "D0-BAR") window.__d0root = root;
      return root;
    };
  });
});

/**
 * Opens the panel with tier 2 **controlling the page**, and waits for the list to have rows.
 *
 * Two loads, not one, and the second is not a nicety. A worker registered on a first load does
 * not control the page that registered it, so `Tier2State` is not `live`, and `inputFor` short
 * -circuits every selection to `tier-2-off` before any classification happens — which is
 * correct behaviour and useless as an instrument. Observed on the first run of this file, where
 * both tests read back the tier-2 sentence.
 */
async function openPanel(page: import("@playwright/test").Page) {
  await page.goto("/?d0bar=on", { waitUntil: "load" });
  await page.evaluate(() => window.__fixtureReady);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 20_000,
  });

  await page.goto("/?d0bar=on", { waitUntil: "load" });
  await page.evaluate(() => window.__fixtureReady);
  await page.waitForFunction(() => window.__d0root !== undefined);
  await page.locator("d0-bar").click();
  await page.waitForFunction(() => window.__d0root!.querySelector(".row") !== null, undefined, {
    timeout: 15_000,
  });
}

/**
 * Clicks the first row whose request cell contains `needle`, and returns the no-span screen.
 *
 * Scrolls the list to the top first: the ring is at capacity by the time the panel opens, and
 * the page's own subresources are its earliest records.
 */
async function openRow(
  page: import("@playwright/test").Page,
  needle: string,
  /* `startsWith` is how a same-origin row is told from a cross-origin one: `displayPath`
     renders a foreign origin as `host + path` and this page's own as a bare path, so `/api/`
     anchored at the start is the same-origin fixture traffic and nothing else. */
  mode: "contains" | "startsWith" = "contains",
) {
  /* The list is virtualized and holds a viewport's worth of nodes for several hundred records,
     so a row is only in the DOM while it is near the scroll position — searching what is
     rendered finds the first screenful and nothing else. Scanned a viewport at a time, from the
     top, letting the virtualizer repaint between steps. */
  let clicked = false;
  for (let top = 0; !clicked; top += 240) {
    const atEnd = await page.evaluate((scrollTop: number) => {
      const rows = window.__d0root!.querySelector(".rows") as HTMLElement;
      rows.scrollTop = scrollTop;
      return rows.scrollTop < scrollTop;
    }, top);

    /* Two frames: one for the scroll to settle, one for the rows it schedules. */
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );

    clicked = await page.evaluate(
      ({ text, anchored }: { text: string; anchored: boolean }) => {
        const rows = [...window.__d0root!.querySelectorAll<HTMLElement>(".row")];
        const row = rows.find((node) => {
          if (node.hidden) return false;
          /* The request cell holds the method and the path in one text run, so a row reads
             `GET/legacy/export?i=1`. Anchoring means "at the start of the path", which is
             after the method — probed against the fixture, not assumed. */
          const label = (node.querySelector(".col-req")?.textContent ?? "")
            .trim()
            .replace(/^[A-Z]+/, "");
          return anchored ? label.startsWith(text) : label.includes(text);
        });
        if (!row) return false;
        row.click();
        return true;
      },
      { text: needle, anchored: mode === "startsWith" },
    );

    if (!clicked && atEnd) break;
  }
  expect(clicked, `no row matching ${needle}`).toBe(true);

  await page.waitForFunction(() => {
    const trace = window.__d0root!.querySelector(".trace") as HTMLElement | null;
    return trace !== null && !trace.hidden;
  });

  return page.evaluate(() => {
    const root = window.__d0root!;
    const none = root.querySelector(".trace-none") as HTMLElement;
    const sw = root.querySelector(".trace-none-sw") as HTMLElement;
    return {
      shown: !none.hidden,
      title: root.querySelector(".trace-none-title")?.textContent?.trim() ?? "",
      why: root.querySelector(".trace-none-why")?.textContent?.trim() ?? "",
      swShown: !sw.hidden,
    };
  });
}

test("classifies a browser-issued subresource as one, not as an instrumentation gap", async ({
  page,
}) => {
  await openPanel(page);
  const screen = await openRow(page, "/app.css");

  expect(screen.shown).toBe(true);
  expect(screen.title).toBe("No span exists for this request.");
  /* The classifier reached `subresource` from the resource entry's own `initiatorType`, which
     is the browser's word for who asked — not a guess from the `.css` extension. */
  expect(screen.why).toContain("Fetched by the browser itself");
  expect(screen.why).toContain("Not a gap to close.");
  /* And no observation is claimed. `subresource` is decided before the worker is consulted, so
     whether a worker saw it is simply not known here. */
  expect(screen.swShown).toBe(false);
});

test("gives four rows on one page four different causes", async ({ page }) => {
  /* The point of taking the cause from `classify()` rather than deriving one. Every row here
     is a request that reached the network with no traceparent on it, and the old three-way
     copy could separate exactly one of them from the rest — the XHR. The other three all read
     as "the service worker saw this request leave with no traceparent header", which for the
     stylesheet and the cross-origin call is a claim about instrumentation that nothing
     observed. */
  await openPanel(page);

  const subresource = await openRow(page, "/app.css");
  await back(page);
  /* `displayPath` renders this as `localhost:8732/api/…` while the page is on `127.0.0.1` —
     the same server, a genuinely different origin. The fixture issues these deliberately. */
  const thirdParty = await openRow(page, "localhost:8732/api/");
  await back(page);
  /* The fixture sends `/legacy/export` over XMLHttpRequest and puts a traceparent only on its
     `fetch` calls, which is the split a fetch-only SDK produces. */
  const xhr = await openRow(page, "/legacy/export", "startsWith");
  await back(page);
  /* A same-origin `fetch` the fixture deliberately leaves bare. */
  const bare = await openRow(page, "/cacheable.json", "startsWith");

  expect(subresource.why).toContain("Fetched by the browser itself");
  expect(thirdParty.why).toContain("A different origin.");
  expect(xhr.why).toContain("Sent with XMLHttpRequest.");
  /* Which of the two same-origin causes applies depends on whether the worker held a record
     for this particular request, and the first requests of a load legitimately predate it.
     Both are accepted — what must not happen is the third thing, a sentence claiming an
     observation for a request no worker saw, which is what `swShown` pins down. */
  expect(
    bare.why.startsWith("The service worker read this request's headers") ||
      bare.why.startsWith("No worker record exists for this request"),
    bare.why,
  ).toBe(true);
  expect(bare.swShown).toBe(bare.why.startsWith("The service worker read"));

  expect(new Set([subresource.why, thirdParty.why, xhr.why, bare.why]).size).toBe(4);
  /* Only the cause that entails an observation is allowed to claim one. */
  expect(subresource.swShown).toBe(false);
  expect(thirdParty.swShown).toBe(false);
  expect(xhr.swShown).toBe(false);
});

/* ── the correlated log list, in a browser ──
 *
 * `tests/unit/trace-view.test.ts` settles what the list *renders*, against a hand-built summary.
 * What only a browser settles is the whole path: a real `d0-bar` element, the real panel bundle,
 * the shipped layout worker parsing real OTLP off a message boundary, the `F_HAS_LOG` bit crossing
 * in a transferred `ArrayBuffer`, and a real click landing on the row the worker resolved.
 *
 * **The broker is faked in the page, not the API.** The trace query runs inside the service
 * worker, which holds the credential and resolves its destination against a compiled region table
 * — a page cannot name an origin, which is the point of that design and not something to weaken
 * for a test. So the fake goes at the message boundary the page already owns: one wrapper around
 * `ServiceWorker.prototype.postMessage` that answers `status` and `query` on the `MessagePort` the
 * caller transferred, and passes everything else through. Same seam, and the same reasoning, as
 * the `attachShadow` interception above: open the platform, not the product.
 */

/** Two spans and three log records. Every case the list can render is in here once. */
const TRACE_WITH_LOGS = JSON.stringify({
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "edge" } }] },
      scopeSpans: [
        {
          spans: [
            {
              spanId: "aaaaaaaaaaaaaaaa",
              name: "GET /api/hero",
              startTimeUnixNano: "1700000000000000000",
              endTimeUnixNano: "1700000000400000000",
            },
            {
              spanId: "bbbbbbbbbbbbbbbb",
              parentSpanId: "aaaaaaaaaaaaaaaa",
              name: "pricing.lookup",
              startTimeUnixNano: "1700000000100000000",
              endTimeUnixNano: "1700000000300000000",
            },
          ],
        },
      ],
    },
  ],
  resourceLogs: [
    {
      scopeLogs: [
        {
          logRecords: [
            {
              severityNumber: 9,
              severityText: "INFO",
              body: { stringValue: "corridor cache warm" },
              timeUnixNano: "1700000000050000000",
            },
            {
              severityNumber: 17,
              severityText: "ERROR",
              body: { stringValue: "tariff lookup failed" },
              timeUnixNano: "1700000000200000000",
              spanId: "bbbbbbbbbbbbbbbb",
              attributes: [
                { key: "corridor", value: { stringValue: "NL-DE" } },
                { key: "http.status_code", value: { intValue: "503" } },
                { key: "payload", value: { kvlistValue: { values: [] } } },
              ],
            },
            {
              severityNumber: 13,
              severityText: "WARN",
              body: { stringValue: "retrying once" },
              timeUnixNano: "1700000000250000000",
              spanId: "cccccccccccccccc",
            },
          ],
        },
      ],
    },
  ],
});

/** Two frames: one for the effect the click scheduled, one for the paint it schedules in turn. */
function settle(page: import("@playwright/test").Page) {
  return page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

/** Answers the panel's broker messages in the page, leaving the real worker alone otherwise. */
async function fakeBroker(page: import("@playwright/test").Page, body: string) {
  await page.addInitScript((payload: string) => {
    const original = ServiceWorker.prototype.postMessage;
    ServiceWorker.prototype.postMessage = function (
      message: unknown,
      transfer?: unknown,
    ): void {
      const request = message as { kind?: string };
      const ports = (Array.isArray(transfer) ? transfer : []) as MessagePort[];
      const port = ports[0];
      /* Only the two the panel asks for. Anything else — the collector's own messages to its
         worker — goes through untouched, so tier 2 stays genuinely live. */
      if (port && request.kind === "status") {
        port.postMessage({
          kind: "status",
          status: {
            connected: true,
            source: "session",
            hint: "••••test",
            apiOrigin: "https://api.eu-west-1.aws.dash0.com",
            dataset: "default",
          },
        });
        return;
      }
      if (port && request.kind === "query") {
        port.postMessage({ kind: "query", outcome: { ok: true, status: 200, body: payload } });
        return;
      }
      original.call(this, message as never, transfer as never);
    };
  }, body);
}

/** Opens the first traced row, which the fake broker answers with `TRACE_WITH_LOGS`. */
async function openTracedRow(page: import("@playwright/test").Page) {
  /* A **same-origin** `/api/resource` fetch: `app.js` puts a `traceparent` on those and on nothing
     else, so this is the row that has a span id to query with. Anchored, because the cross-origin
     copies render as `localhost:8732/api/…` and carry no header. (`/api/hero` also has one, but it
     is issued with `?delay=800` and is not in the ring when the panel opens — probed.) */
  await openRow(page, "/api/resource", "startsWith");
  await page.waitForFunction(() => {
    const found = window.__d0root!.querySelector(".trace-found") as HTMLElement | null;
    return found !== null && !found.hidden;
  });
  /* Two frames, so the virtualizer has painted its row pool. */
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

test("carries a log's span through the real worker to the row it names", async ({ page }) => {
  await fakeBroker(page, TRACE_WITH_LOGS);
  await openPanel(page);
  await openTracedRow(page);

  const list = await page.evaluate(() => {
    const root = window.__d0root!;
    const rows = [...root.querySelectorAll<HTMLElement>(".log-row")];
    return {
      count: rows.length,
      messages: rows.map((row) => row.querySelector(".log-msg")?.textContent?.trim() ?? ""),
      badges: rows.map((row) => row.querySelector(".log-span") !== null),
      labels: rows.map((row) => row.querySelector(".log-nospan")?.textContent?.trim() ?? ""),
      /* The footer's worst-of, derived from the list rather than carried as a second field. */
      worst: root.querySelector(".trace-log-level")?.textContent?.trim() ?? "",
      link: root.querySelector(".trace-log-link")?.textContent?.trim() ?? "",
    };
  });

  expect(list.count).toBe(3);
  expect(list.messages).toEqual([
    "corridor cache warm",
    "tariff lookup failed",
    "retrying once",
  ]);
  /* Only the record naming a span the worker emitted gets a badge — and the two that do not are
     labelled with *why*, which is the distinction the whole `LogUnattached` enum exists for. */
  expect(list.badges).toEqual([false, true, false]);
  expect(list.labels).toEqual(["trace-level", "", "span not returned"]);
  expect(list.worst).toBe("ERROR");
  expect(list.link).toBe("3 correlated logs");

  /* The click. `F_HAS_LOG` and the row index both came out of a transferred buffer the shipped
     worker wrote — nothing on this side computed either. */
  await page.evaluate(() => {
    const rows = [...window.__d0root!.querySelectorAll<HTMLElement>(".log-row")];
    rows[1]!.querySelector<HTMLElement>(".log-span")!.click();
  });
  /* Read on a later turn than the click: `data-picked` is written by the virtualizer's repaint,
     which is scheduled on a frame. Reading in the same `evaluate` sees the pre-click DOM. */
  await settle(page);

  const picked = await page.evaluate(() => {
    const root = window.__d0root!;
    const spans = [...root.querySelectorAll<HTMLElement>(".span-row")].filter((r) => !r.hidden);
    return {
      picked: spans.map((row) => row.dataset["picked"]),
      hasLog: spans.map((row) => row.dataset["haslog"]),
      labels: spans.map((row) => row.querySelector(".span-label")?.textContent?.trim() ?? ""),
    };
  });

  expect(picked.labels).toEqual(["GET /api/hero", "pricing.lookup"]);
  expect(picked.picked).toEqual(["false", "true"]);
  expect(picked.hasLog).toEqual(["false", "true"]);
});

test("opens a log record's detail view and returns to the trace", async ({ page }) => {
  await fakeBroker(page, TRACE_WITH_LOGS);
  await openPanel(page);
  await openTracedRow(page);

  await page.evaluate(() => {
    [...window.__d0root!.querySelectorAll<HTMLElement>(".log-row")][1]!
      .querySelector<HTMLElement>(".log-open")!
      .click();
  });
  await settle(page);

  const detail = await page.evaluate(() => {
    const root = window.__d0root!;
    const view = root.querySelector(".logview") as HTMLElement;
    return {
      shown: !view.hidden,
      level: root.querySelector(".logview-level")?.textContent?.trim() ?? "",
      body: root.querySelector(".logview-body")?.textContent?.trim() ?? "",
      head: root.querySelector(".logview-attrs-head")?.textContent?.trim() ?? "",
      keys: [...root.querySelectorAll<HTMLElement>(".logview-attrs dt")].map(
        (node) => node.textContent ?? "",
      ),
      values: [...root.querySelectorAll<HTMLElement>(".logview-attrs dd")].map(
        (node) => node.textContent ?? "",
      ),
      /* The trace *surface* is hidden while the log sits over it — probed, not assumed; the
         panel shows one surface at a time. What is preserved is the selection behind it, which
         is why the back button below lands on a found trace and not on a refetch. */
      traceHidden: (root.querySelector(".trace") as HTMLElement).hidden,
    };
  });

  expect(detail.shown).toBe(true);
  expect(detail.level).toBe("ERROR");
  expect(detail.body).toBe("tariff lookup failed");
  expect(detail.head).toBe("attributes · 3");
  expect(detail.keys).toEqual(["corridor", "http.status_code", "payload"]);
  /* The `kvlistValue` is **named**, not blank. A blank third value here is the exact reading the
     old `stringValue`-only reader produced, and it is indistinguishable from an empty attribute. */
  expect(detail.values).toEqual(["NL-DE", "503", "⟨kvlist⟩"]);
  expect(detail.traceHidden).toBe(true);

  await page.evaluate(() =>
    window.__d0root!.querySelector<HTMLElement>(".logview-back")!.click(),
  );
  await settle(page);

  const returned = await page.evaluate(() => {
    const root = window.__d0root!;
    return {
      logShown: !(root.querySelector(".logview") as HTMLElement).hidden,
      /* Back to the trace, not to the list: `popToList` would clear the selection and abort the
         query whose result the reader was just reading. */
      foundShown: !(root.querySelector(".trace-found") as HTMLElement).hidden,
      listShown: !(root.querySelector(".requests") as HTMLElement).hidden,
    };
  });

  expect(returned.logShown).toBe(false);
  expect(returned.foundShown).toBe(true);
  expect(returned.listShown).toBe(false);
});

/** Pops back to the list, so the next row can be opened. */
async function back(page: import("@playwright/test").Page) {
  await page.evaluate(() =>
    window.__d0root!.querySelector<HTMLElement>(".trace-back")?.click(),
  );
  await page.waitForFunction(
    () => !(window.__d0root!.querySelector(".requests") as HTMLElement).hidden,
  );
}
