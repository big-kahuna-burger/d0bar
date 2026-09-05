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
    d0barMountedAt: -1,
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
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    /* no MutationObserver */
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
    },
    { durationThreshold: 16 },
  );
})();
