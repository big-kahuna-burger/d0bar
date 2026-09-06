/**
 * The measuring instrument, identical in both arms of the A/B run.
 *
 * Everything here reads the browser's own entries. It is deliberately tiny and registered
 * before anything else, so both arms carry exactly the same observation overhead and the
 * delta between them is attributable to d0bar alone.
 */
(function () {
  var m = (window.__metrics = {
    lcp: 0,
    cls: 0,
    tbt: 0,
    longTasks: 0,
    inp: 0,
    interactions: [],
    /**
     * The cheap interaction target, counted above the reporting floor.
     *
     * `PerformanceObserver`'s `event` type clamps `durationThreshold` to a minimum of 16 ms and
     * Chrome quantizes durations to 8 ms, so 16 is both the smallest observable value and the
     * bucket everything cheap lands in. Measured on CI: 297 of ~300 delivered entries in every
     * arm sat at exactly 16, identically for `off`, `gated` and `on` — counting entries that
     * *reached* the floor saturates and says nothing.
     *
     * So this counts entries strictly *above* it. A cheap tap has to gain a full 8 ms quantum
     * to appear here, which makes a non-zero count a real statement: something added at least
     * a quantum to an interaction that otherwise costs nothing. Zero in all three arms is the
     * present reading, and it bounds d0bar's cost on a cheap interaction at under one quantum.
     */
    cheapTapsOverQuantum: 0,
    /** Every cheap-tap entry delivered at all, for reading. Saturates; do not gate on it. */
    cheapTapEntries: 0,
    /** The worst reported cheap tap. 16 means every one sat on the floor. */
    cheapTapMax: 0,
    d0barMountedAt: -1,
    /* The LCP the browser had reported at the moment the pill was inserted. The final LCP is
       not the right comparison and cannot be: on this fixture the hero paints at ~1.6 s from
       a delayed fetch, and nothing can know at mount time whether a larger paint is still
       coming — LCP is only final at first input or hidden. What the moratorium can promise is
       that the toolbar came after everything the page had painted so far, and that it did not
       move the final number; the second half is measured in `ab.spec.ts`. */
    lcpAtMount: -1,
    /* The load-phase side effects the moratorium forbids, each as the page-timeline moment it
       first happened, or -1 for "never". A DOM insertion is one of four, and it was the only
       one being recorded. */
    d0barFirstRequestAt: -1,
    d0barSwRegisterAt: -1,
    d0barWorkerMessageAt: -1,
  });

  /* When the toolbar first touches the host DOM. The moratorium says this must not happen
     until after the load phase, so it is recorded rather than assumed. */
  try {
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          if (added[j].nodeName === "D0-BAR" && m.d0barMountedAt < 0) {
            m.d0barMountedAt = performance.now();
            m.lcpAtMount = m.lcp;
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    /* no MutationObserver */
  }

  /* d0bar's own network requests, read out of the browser's resource entries rather than by
     patching `fetch`. Patching it would put the instrument inside the host's own request path
     — the exact thing this fixture must never do — and would miss the ones d0bar makes that
     are not fetches: the stage-2 module import and the service-worker script. */
  var D0BAR = /d0bar/i;
  /* The host's own script tag for the bundle is not a request d0bar made. Everything else
     matching — the panel module, the worker script, the service-worker script — is. */
  var HOST_LOADED = /\/dist\/d0bar\.(iife|dev\.iife)\.js(\?|$)/;

  /* Service-worker registration and worker messages have no entry type, so these two are
     captured. Neither is on any path d0bar measures through: d0bar reads performance entries,
     and nothing here touches PerformanceObserver, performance.*, or the DOM. */
  try {
    if (navigator.serviceWorker) {
      var register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      navigator.serviceWorker.register = function () {
        if (m.d0barSwRegisterAt < 0) m.d0barSwRegisterAt = performance.now();
        return register.apply(null, arguments);
      };
    }
  } catch {
    /* no service worker container */
  }

  try {
    var post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function () {
      if (m.d0barWorkerMessageAt < 0) m.d0barWorkerMessageAt = performance.now();
      return post.apply(this, arguments);
    };
  } catch {
    /* no Worker constructor */
  }

  function on(type, fn, extra) {
    try {
      var o = new PerformanceObserver(function (l) {
        l.getEntries().forEach(fn);
      });
      var init = { type: type, buffered: true };
      for (var k in extra) init[k] = extra[k];
      o.observe(init);
    } catch {
      /* unsupported entry type */
    }
  }

  on("resource", function (e) {
    if (m.d0barFirstRequestAt >= 0) return;
    if (!D0BAR.test(e.name) || HOST_LOADED.test(e.name)) return;
    m.d0barFirstRequestAt = e.startTime;
  });

  on("largest-contentful-paint", function (e) {
    m.lcp = e.startTime;
  });

  /* Session-window CLS, matching the standard definition. */
  var sessionValue = 0;
  var sessionFirst = 0;
  var sessionLast = 0;
  on("layout-shift", function (e) {
    if (e.hadRecentInput) return;
    if (sessionValue && e.startTime - sessionLast < 1000 && e.startTime - sessionFirst < 5000) {
      sessionValue += e.value;
      sessionLast = e.startTime;
    } else {
      sessionValue = e.value;
      sessionFirst = e.startTime;
      sessionLast = e.startTime;
    }
    if (sessionValue > m.cls) m.cls = sessionValue;
  });

  /* Total blocking time: the part of each long task beyond 50ms. */
  on("longtask", function (e) {
    m.longTasks++;
    if (e.duration > 50) m.tbt += e.duration - 50;
  });

  on(
    "event",
    function (e) {
      if (!e.interactionId) return;
      m.interactions.push(e.duration);
      if (e.duration > m.inp) m.inp = e.duration;
      /* `target` is null once the element is gone; both fixture buttons outlive the run. */
      if (e.target && e.target.id === "cheap-tap") {
        /* Entries, not taps: one click emits several — pointerdown, pointerup, click — sharing
           an `interactionId`. An earlier version called this count "taps" and reported 297 for
           what were 100 clicks. */
        m.cheapTapEntries++;
        if (e.duration > 16) m.cheapTapsOverQuantum++;
        if (e.duration > m.cheapTapMax) m.cheapTapMax = e.duration;
      }
    },
    /* 16 is the floor the spec allows; anything lower is clamped to it. Stated rather than
       left as a magic number, because the clamp is the whole reason `cheapTapsOverQuantum`
       counts instead of timing, and the value everything cheap is pinned to. */
    { durationThreshold: 16 },
  );
})();
