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

/**
 * Dash0 forwarding for `/try/`'s OpenTelemetry export.
 *
 * **The token lives here and never reaches the browser.** A page exporting straight to Dash0's
 * ingress would have to carry the auth token in script, readable by every extension and every
 * other script on the page — and this repo already ships a service-worker broker
 * (`src/sw/broker.ts`) built on the premise that a Dash0 token does not belong in the page. A
 * fixture that contradicted that would be teaching the wrong thing, so the fixture server plays
 * the part a collector plays in a real deployment.
 *
 * Everything except the token has a default, because everything except the token is guessable
 * and the token is not. Put the token in `.env` (gitignored; `.env.example` is the template)
 * and the rest only needs touching to leave eu-west-1 prod:
 *
 * ```
 *   DASH0_TOKEN     required. No default, and no default is possible.
 *                   `INGEST_TOKEN` is accepted as an alias — it is what Dash0's own UI calls
 *                   the thing, so it is what ends up pasted into a `.env`.
 *   DASH0_ENV       prod | dev              default dev
 *   DASH0_CLOUD     aws | gcp               default aws
 *   DASH0_REGION    e.g. eu-west-1          default eu-west-1
 *   DASH0_DATASET                           default: send no header at all
 *   DASH0_INGRESS   full origin; overrides the three above outright
 * ```
 *
 * The host pattern is `ingress.<region>.<cloud>.dash0[-dev].com`, mirroring the `api.` table in
 * `src/shared/regions.ts` — and probed the same way rather than assumed, since a name that
 * resolves is not a name that ingests:
 *
 * ```
 *                                          POST /v1/traces, unauthenticated
 * ingress.eu-west-1.aws.dash0.com          401
 * ingress.us-west-2.aws.dash0.com          401
 * ingress.eu-west-1.aws.dash0-dev.com      401
 * ingress.europe-west4.gcp.dash0-dev.com   401
 * ```
 *
 * `401` rather than `404` is what separates an ingest endpoint from a wildcard cert.
 */

/* Optional, and optional in the strong sense: no `.env`, no warning, no behaviour change.
   `loadEnvFile` throws on a missing file, and the fixture's ordinary use has no `.env` at all —
   every perf arm runs without one and must not learn to depend on it. */
try {
  process.loadEnvFile(join(repoRoot, ".env"));
} catch {
  /* Absent or unreadable. `DASH0_TOKEN` from the real environment still works. */
}

/* `dev` by default. This fixture is a development demo in a repository whose org lives on
   `dash0-dev.com`, and a default that 401s for everyone who actually runs it is not a default. */
const DASH0_ENV = process.env.DASH0_ENV === "prod" ? "prod" : "dev";
const DASH0_CLOUD = process.env.DASH0_CLOUD === "gcp" ? "gcp" : "aws";
const DASH0_REGION =
  process.env.DASH0_REGION ?? (DASH0_CLOUD === "gcp" ? "europe-west4" : "eu-west-1");

const DASH0 = {
  ingress:
    process.env.DASH0_INGRESS?.replace(/\/+$/, "") ??
    `https://ingress.${DASH0_REGION}.${DASH0_CLOUD}.${DASH0_ENV === "dev" ? "dash0-dev" : "dash0"}.com`,
  /* `INGEST_TOKEN` second, because Dash0's UI names it that and a `.env` written from the UI
     will say so. Silently ignoring the name the product used is how a correctly configured
     setup reports itself unconfigured. */
  token: process.env.DASH0_TOKEN ?? process.env.INGEST_TOKEN,
  /**
   * No default, and specifically not `"default"`.
   *
   * `dash0-dataset: default` is not "the obvious dataset" — it is a *claim* the token has to be
   * authorized for, and an ingest token usually is not:
   *
   *     PermissionDenied: authentication token is not authorized to ingest into dataset "default"
   *
   * That surfaced as a 401 through the proxy while the identical request sent by hand returned
   * `200 {"partialSuccess":{}}`, because the hand-written one carried no dataset header. Omitted,
   * the token ingests into whatever dataset it belongs to, which is what anyone pasting a token
   * means. Set this only to override that deliberately.
   */
  dataset: process.env.DASH0_DATASET,
};

/* The token alone decides this. The endpoint always resolves to something, so treating a
   defaulted endpoint as "configured" would turn a missing token into a 401 from a real Dash0
   region — a confusing failure a long way from its cause. */
const dash0Configured = Boolean(DASH0.token);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Forwards one OTLP/HTTP payload to Dash0, unchanged.
 *
 * The body is passed through byte for byte — this is a pipe, not a translator, and rewriting
 * spans in a fixture whose whole job is to show what the page really sent would be the same
 * class of lie as a toolbar that distorts what it measures.
 *
 * Upstream's status and body are relayed as they are. A 401 from Dash0 must look like a 401 to
 * whoever is debugging, not like a fixture error.
 */
async function forwardOtlp(req, res, signal) {
  /* Logged before the configuration check, not after. The 501 branch used to return silently,
     so an export that never left the machine and an export that was never attempted looked
     identical from here — which is the first thing you need to tell apart. */
  console.log(
    `otlp ${signal}: received${dash0Configured ? "" : " (not forwarding — unconfigured)"}`,
  );
  if (!dash0Configured) {
    res.writeHead(501, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        error: "DASH0_TOKEN is not set, so nothing was forwarded.",
        required: ["DASH0_TOKEN (or INGEST_TOKEN)"],
        defaulted: { ingress: DASH0.ingress, dataset: DASH0.dataset ?? "(the token's own)" },
        hint: "Put DASH0_TOKEN (or INGEST_TOKEN) in .env at the repo root — see .env.example — and restart the fixture server.",
      }),
    );
    return;
  }

  const body = await readBody(req);
  const headers = {
    "content-type": req.headers["content-type"] ?? "application/json",
    authorization: `Bearer ${DASH0.token}`,
  };
  if (DASH0.dataset) headers["dash0-dataset"] = DASH0.dataset;

  try {
    const upstream = await fetch(`${DASH0.ingress}/v1/${signal}`, {
      method: "POST",
      headers,
      body,
    });
    const text = await upstream.text();
    /* Logged because a silent export is indistinguishable from a working one, and the first
       question when nothing shows up in Dash0 is always whether it left the machine. */
    console.log(`otlp ${signal}: ${body.length}B -> ${upstream.status}`);
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "access-control-allow-origin": "*",
    });
    res.end(text);
  } catch (error) {
    console.error(`otlp ${signal}: forward failed —`, error.message);
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: String(error) }));
  }
}

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

  /**
   * The 4000-span trace the layout budget is measured against.
   *
   * Generated by `scripts/build-trace-fixture.mjs` and served from `bench/fixtures/` rather
   * than inlined into a spec: it is 951 kB, and a benchmark that measures how long it takes to
   * lay out a trace has to fetch one the way the panel does.
   *
   * `access-control-allow-origin` because the layout spec fetches it from the page and hands
   * the text straight to the worker — the same path `trace/query.ts` takes with a real API
   * response, minus the credential.
   */
  if (path === "/trace-4000.json") {
    await serveFile(res, join(here, "trace-4000.json"), {
      "access-control-allow-origin": "*",
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

  /* An empty script whose first byte is deliberately late, used to push the fixture's own
     `load` event out. Without it the fixture loads in ~140 ms, which is too short a window to
     land a click inside — and `moratorium.spec.ts`'s interaction-before-load test could not be
     made to fail even with the gate it guards removed. */
  if (path === "/slow-script.js") {
    await sleep(Number(url.searchParams.get("delay") ?? 900));
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end("/* deliberately empty */\n");
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

  /**
   * The same worker for `/try/`, scoped to `/try/` and nothing else.
   *
   * Deliberately *not* the root-scoped `/d0bar-sw.js`. `/try/` is a demo page, so it wants tier
   * 2 live — but a worker it installed at root scope would go on controlling `/?d0bar=off` and
   * `/?d0bar=gated` in the same browser profile afterwards, and a benchmark arm with a service
   * worker under it is not the arm it claims to be. Visiting the demo would silently poison
   * every later local run against the fixture.
   *
   * Serving it from `/try/` gives it a scope that covers the demo and cannot reach the arms.
   * No `service-worker-allowed` header here for the same reason: widening is the thing to avoid.
   */
  if (path === "/try/d0bar-sw.js") {
    await serveFile(res, join(repoRoot, "dist", "d0bar-sw.js"), {
      "cache-control": "no-store",
    });
    return;
  }

  /* OpenTelemetry export from `/try/`, forwarded to Dash0 with the token this process holds. */
  if (path === "/otlp/v1/traces" || path === "/otlp/v1/logs") {
    await forwardOtlp(req, res, path.endsWith("traces") ? "traces" : "logs");
    return;
  }

  /* Whether forwarding is configured, so the page can say so instead of exporting into a 501
     and looking like it worked. The token itself is never in this response. */
  if (path === "/otlp/status") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    /* The resolved endpoint is returned whether or not a token exists, so someone reading the
       badge can see they are pointed at the wrong region before they wonder about the token.
       The token itself is never in this response, set or not. */
    res.end(
      JSON.stringify({
        configured: dash0Configured,
        ingress: DASH0.ingress,
        dataset: DASH0.dataset ?? null,
        environment: DASH0_ENV,
      }),
    );
    return;
  }

  /* The built bundle, served as a host application would serve it.
   *
   * Cross-origin allowed, for `/try` — dropping d0bar onto a real site is the only way to see
   * it against traffic the fixture cannot imitate. A script tag needs no CORS, but stage 2 is
   * reached through `import()` and does, so without this the pill mounts on a real page and the
   * panel never opens. Inert for every measured arm: those load same-origin, where a permissive
   * `access-control-allow-origin` changes no byte of the response body and no timing.
   *
   * `*`, not a reflected `Origin`: this serves a public build from a loopback dev server, there
   * is nothing here to protect, and reflecting would need `vary: origin` to be correct. */
  if (path.startsWith("/dist/")) {
    await serveFile(res, join(repoRoot, normalize(path).replace(/^(\.\.[/\\])+/, "")), {
      "access-control-allow-origin": "*",
    });
    return;
  }

  /* `/` and any directory path resolve to their `index.html`. The trailing-slash form matters:
     `/try/` is what registers a worker scoped to `/try/`, and `/try.html` would scope it to the
     root — the thing the separate route above exists to prevent. */
  const file = path.endsWith("/") ? `${path}index.html` : path;
  await serveFile(res, join(hostDir, normalize(file).replace(/^(\.\.[/\\])+/, "")));
});

server.listen(PORT, () => {
  console.log(`fixture server on http://127.0.0.1:${PORT}`);
});
