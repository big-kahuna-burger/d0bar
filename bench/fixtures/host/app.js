/**
 * The hostile part of the fixture: a page that is already slow, so the toolbar is measured
 * against realistic pressure rather than an empty document.
 *
 * Every delay is fixed. Nothing here reads the clock to decide what to do.
 */
(function () {
  var TOTAL = 300;
  var origin = location.origin;
  /* Same server, different host: genuinely cross-origin, and served without
     Timing-Allow-Origin, so the browser zeroes the phase timings for these. */
  var foreign = origin.replace("127.0.0.1", "localhost");

  /**
   * A W3C `traceparent`, as an OpenTelemetry-instrumented host would send.
   *
   * The fixture is the instrument, so this is deliberately minimal: it puts a well-formed
   * header on the requests a real SDK would instrument and nothing on the ones it would not.
   * `fetch` gets one, `XMLHttpRequest` does not — which is the same split the untraced view
   * exists to surface, and is already why the XHR branch below is here.
   *
   * Inert for the benchmark: it is a header on a request the fixture was issuing anyway, and
   * both arms issue it identically, so the on/off comparison stays controlled.
   */
  function hex(n) {
    var out = "";
    for (var k = 0; k < n; k++) out += ((Math.random() * 16) | 0).toString(16);
    return out;
  }

  function traceparent() {
    return "00-" + hex(32) + "-" + hex(16) + "-01";
  }

  function fire(i) {
    var crossOrigin = i % 5 === 0;
    var base = crossOrigin ? foreign : origin;
    var status = i % 37 === 0 ? 500 : 200;
    var delay = 10 + (i % 7) * 12;

    if (i % 4 === 1) {
      /* XMLHttpRequest: the SDK instruments fetch only, so these are exactly the requests
         the untraced view exists to surface. */
      var xhr = new XMLHttpRequest();
      xhr.open("GET", base + "/legacy/export?i=" + i + "&delay=" + delay);
      xhr.send();
      return;
    }
    /* Same-origin only. A custom header on a cross-origin request triggers a CORS
       preflight, which would add an OPTIONS round trip the fixture never had and change the
       traffic shape the budget is measured against. Real propagators are allowlisted for the
       same reason, so this is faithful rather than a workaround. */
    fetch(
      base + "/api/resource?i=" + i + "&delay=" + delay + "&status=" + status,
      crossOrigin ? undefined : { headers: { traceparent: traceparent() } },
    )
      .then(function (r) {
        /* The body must be drained. An unread body holds the connection open, and the
           browser's six-per-origin limit then throttles the storm to a trickle. */
        return r.text();
      })
      .catch(function () {});
  }

  /* A burst during load, then a tail — the shape that puts observer callbacks in the middle
     of the page's own LCP and TBT window. */
  for (var i = 0; i < 120; i++) fire(i);
  var next = 120;
  var pump = setInterval(function () {
    for (var n = 0; n < 12 && next < TOTAL; n++) fire(next++);
    if (next >= TOTAL) clearInterval(pump);
  }, 60);

  fetch("/api/hero?delay=800", { headers: { traceparent: traceparent() } })
    .then(function (r) {
      return r.text();
    })
    .then(function () {
      document.getElementById("hero").innerHTML =
        '<span class="hero-title">Rotterdam → Duisburg</span>';
    })
    .catch(function () {});

  /* A long task during load, so total blocking time is non-zero in both arms and a delta
     between them means something. */
  setTimeout(function () {
    var end = performance.now() + 120;
    while (performance.now() < end) {
      /* deliberate block */
    }
  }, 300);

  /* A layout shift after load: a row appears above the rate table. */
  setTimeout(function () {
    var row = document.createElement("div");
    row.className = "injected";
    row.textContent = "Rate breakdown";
    var anchor = document.getElementById("shift-anchor");
    anchor.parentNode.insertBefore(row, anchor);
  }, 1200);

  /* A long animation frame on interaction, so INP has something real to measure. */
  document.getElementById("confirm-hold").addEventListener("click", function () {
    var end = performance.now() + 84;
    while (performance.now() < end) {
      /* deliberate block */
    }
  });

  /* The fixture declares its own readiness, so the harness never guesses with a sleep. */
  window.__fixtureReady = new Promise(function (resolve) {
    addEventListener("load", function () {
      /* Requested twice, after load so the load-phase burst stays exactly as it was: the
         second request is served from cache, which is the only way this fixture produces a
         non-network `deliveryType` for the cache-status handling to be measured against. */
      window.__cacheHitReady = fetch("/cacheable.json")
        .then(function (r) {
          return r.text();
        })
        .then(function () {
          return fetch("/cacheable.json");
        })
        .then(function (r) {
          return r.text();
        })
        .catch(function () {});

      setTimeout(resolve, 1600);
    });
  });
})();
