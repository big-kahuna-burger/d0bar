/**
 * Fixture server for the observer-effect budget.
 *
 * Deterministic by construction: every delay is fixed, nothing depends on wall-clock time or
 * network conditions. A measured delta between the two arms therefore reflects a code change
 * rather than fixture variance.
 *
 * Binds on all interfaces so the fixture page (served from 127.0.0.1) can issue genuinely
 * cross-origin requests to the same server via localhost — which is how the fixture exercises
 * responses with no `Timing-Allow-Origin`, where the browser zeroes the phase timings.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const hostDir = join(here, "host");
const PORT = Number(process.env.D0BAR_FIXTURE_PORT ?? 8732);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

/** A 1x1 PNG, expanded by CSS into the fixture's LCP element. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function serveFile(res, absolute, extraHeaders = {}) {
  try {
    const body = await readFile(absolute);
    res.writeHead(200, {
      "content-type": TYPES[extname(absolute)] ?? "application/octet-stream",
      ...extraHeaders,
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const path = url.pathname;

  /* Live reload for `pnpm dev`. Only ever opened by a page loaded with `?live`, so the perf
     runs never hold this connection. Watches the built bundle and the fixture itself; the
     server's own restarts under `node --watch` are picked up by the client noticing its
     EventSource reopen. */
  if (path === "/__live") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write("retry: 200\n\n");

    let pending;
    const changed = () => {
      /* Coalesced: a build writes several files and would otherwise reload once each. */
      clearTimeout(pending);
      pending = setTimeout(() => res.write("event: change\ndata: 1\n\n"), 120);
    };
    const watchers = [join(repoRoot, "dist"), hostDir].map((dir) =>
      watch(dir, { recursive: true }, changed),
    );

    req.on("close", () => {
      clearTimeout(pending);
      for (const w of watchers) w.close();
    });
    return;
  }

  if (path === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  /* The LCP element. A fixed, slow first byte gives the fixture a poor LCP of its own, so
     the toolbar is measured against a page that is already struggling. */
  if (path === "/slow-image") {
    await sleep(Number(url.searchParams.get("delay") ?? 800));
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    res.end(PNG);
    return;
  }

  /* A genuinely cacheable asset. Everything else here is `no-store`, which meant the fixture
     could never produce a cache hit — so the cache-status handling in `ring.ts` was measured
     only against misses and `deliveryType` was never actually exercised. Requested twice. */
  if (path === "/cacheable.json") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "max-age=300",
      etag: '"d0bar-fixture"',
    });
    res.end(JSON.stringify({ cacheable: true }));
    return;
  }

  /**
   * Reflects what the *request* looked like, for probing what the browser attaches.
   *
   * Exists because `add-pasted-token` rests on an assumption worth measuring rather than
   * reasoning about: that a worker-initiated cross-origin `fetch` carries the page's origin in
   * `Origin`, and is therefore not subject to the allowlisting that killed the OAuth path.
   *
   * Cross-origin without a second server: `localhost:8732` and `127.0.0.1:8732` are the same
   * process and different origins.
   *
   * **The `authorization` header is reported as present or absent and never echoed.** A probe
   * route that printed a bearer back into a transcript would be the one place in this repo that
   * leaks a credential, and the probe needs only the boolean.
   */
  if (path === "/__echo") {
    /* An `Authorization` header makes the request non-simple, so the browser preflights it. No
       other route here needs this because no other route is fetched cross-origin with a header. */
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,OPTIONS",
        "access-control-allow-headers": "authorization",
        "access-control-max-age": "0",
      });
      res.end();
      return;
    }
    const auth = req.headers["authorization"];
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization",
    });
    res.end(
      JSON.stringify({
        origin: req.headers["origin"] ?? null,
        referer: req.headers["referer"] ?? null,
        secFetchSite: req.headers["sec-fetch-site"] ?? null,
        secFetchMode: req.headers["sec-fetch-mode"] ?? null,
        secFetchDest: req.headers["sec-fetch-dest"] ?? null,
        hasCookie: "cookie" in req.headers,
        authScheme: typeof auth === "string" ? auth.split(" ")[0] : null,
      }),
    );
    return;
  }

  if (path.startsWith("/api/") || path.startsWith("/legacy/")) {
    await sleep(Number(url.searchParams.get("delay") ?? 20));
    /* Same-origin responses expose their timings. Requests the fixture sends to `localhost`
       instead of `127.0.0.1` are cross-origin and deliberately carry no
       Timing-Allow-Origin, so the browser reports zeroed phase timings for them. */
    res.writeHead(Number(url.searchParams.get("status") ?? 200), {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(JSON.stringify({ ok: true, path }));
    return;
  }

  /**
   * The service worker, served from the **root** path rather than out of `/dist/`.
   *
   * This is not a fixture convenience — it is the constraint a host has to satisfy. A worker
   * script controls a scope no wider than its own directory, so a file served at
   * `/dist/d0bar-sw.js` can only ever see requests under `/dist/`, which is none of the
   * page's traffic. Serving it at the root is what lets it observe the whole origin.
   *
   * `Service-Worker-Allowed` is sent anyway so a host that *does* serve it from a
   * subdirectory can widen the scope explicitly, which is the documented escape hatch.
   */
  /**
   * The *host page's* own worker, served from the root for the same reason d0bar's is.
   *
   * Not part of any measured arm — reachable only under `?hostsw=1` — but served from the root
   * because the scope it has to own is the whole origin. A worker at `/dist/host-sw.js` would
   * own `/dist/` and d0bar would register happily beside it, which is the opposite of the state
   * this fixture exists to produce.
   */
  if (path === "/host-sw.js") {
    await serveFile(res, join(repoRoot, "bench", "fixtures", "host", "host-sw.js"), {
      "service-worker-allowed": "/",
      "cache-control": "no-store",
    });
    return;
  }

  if (path === "/d0bar-sw.js") {
    await serveFile(res, join(repoRoot, "dist", "d0bar-sw.js"), {
      "service-worker-allowed": "/",
      "cache-control": "no-store",
    });
    return;
  }

  /* The built bundle, served as a host application would serve it. */
  if (path.startsWith("/dist/")) {
    await serveFile(res, join(repoRoot, normalize(path).replace(/^(\.\.[/\\])+/, "")));
    return;
  }

  const file = path === "/" ? "/index.html" : path;
  await serveFile(res, join(hostDir, normalize(file).replace(/^(\.\.[/\\])+/, "")));
});

server.listen(PORT, () => {
  console.log(`fixture server on http://127.0.0.1:${PORT}`);
});
