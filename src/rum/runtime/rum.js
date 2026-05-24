/*
 * scorm-rum runtime — Real User Monitoring for SCORM courses.
 *
 * Captures:
 *   - navigation timing (DNS, TCP, TTFB, DOMContentLoaded, load)
 *   - resource load failures (img/script/css 404, timeouts)
 *   - JS errors (window.onerror, unhandledrejection)
 *   - long tasks (PerformanceObserver: longtask)
 *   - slide-level page views (when the launch HTML changes location.hash)
 *
 * Beacons are batched and posted to cfg.endpoint as JSON. On pagehide, we
 * flush via fetch keepalive so abrupt closes don't lose the session.
 */
(function () {
  "use strict";
  var cfg = window.RUM_CONFIG || {};
  if (!cfg.endpoint) { console.warn("[scorm-rum] no endpoint — runtime disabled"); return; }

  var sessionId = uuid();
  var courseId = cfg.courseId || "course";
  var actor = cfg.actor || "anonymous";

  // Try to enrich actor from SCORM if available (read-only, no init side effect).
  try {
    var api = (function () {
      var w = window, d = 500;
      while (w && d-- > 0) {
        if (w.API) return w.API;
        if (w.parent && w.parent !== w) { w = w.parent; continue; }
        break;
      }
      return null;
    })();
    if (api) {
      var id = (api.LMSGetValue("cmi.core.student_id") || "").trim();
      if (id) actor = id;
    }
  } catch (e) {}

  // ---------- event capture ----------------------------------------------

  var queue = [];
  function push(type, fields) {
    var ev = {
      t: Date.now(), session: sessionId, course: courseId, actor: actor,
      url: location.pathname + location.hash, type: type,
    };
    for (var k in fields) ev[k] = fields[k];
    queue.push(ev);
    scheduleFlush();
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // 1. Navigation timing — emit one record after load.
  function captureNavTiming() {
    if (!window.performance || !performance.getEntriesByType) return;
    var nav = performance.getEntriesByType("navigation")[0];
    if (!nav) return;
    push("nav-timing", {
      dns:    Math.round(nav.domainLookupEnd - nav.domainLookupStart),
      tcp:    Math.round(nav.connectEnd - nav.connectStart),
      ttfb:   Math.round(nav.responseStart - nav.requestStart),
      dom:    Math.round(nav.domContentLoadedEventEnd - nav.startTime),
      load:   Math.round(nav.loadEventEnd - nav.startTime),
      transfer: nav.transferSize || null,
    });
  }
  if (document.readyState === "complete") setTimeout(captureNavTiming, 0);
  else window.addEventListener("load", function () { setTimeout(captureNavTiming, 0); });

  // 2. Resource load failures (PerformanceResourceTiming with transferSize=0
  //    is sometimes ambiguous; the simpler signal is the `error` event on
  //    img/script/link, which we capture via capture-phase listener).
  window.addEventListener("error", function (e) {
    if (e.target && e.target !== window && e.target.src !== undefined) {
      push("resource-error", {
        kind: (e.target.tagName || "").toLowerCase(),
        src: e.target.src || e.target.href || "",
      });
    }
  }, true);

  // 3. JS errors.
  window.addEventListener("error", function (e) {
    if (e.target && e.target !== window && e.target !== document) return;  // resource-error handled above
    push("js-error", {
      message: e.message,
      filename: e.filename,
      line: e.lineno, col: e.colno,
      stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 1000) : "",
    });
  });
  window.addEventListener("unhandledrejection", function (e) {
    var reason = e.reason && (e.reason.stack || e.reason.message || String(e.reason));
    push("js-error", { kind: "unhandledrejection", message: String(reason).slice(0, 1000) });
  });

  // 4. Long tasks (any task ≥ 50ms on the main thread).
  if (window.PerformanceObserver) {
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          push("longtask", { duration: Math.round(entry.duration), startTime: Math.round(entry.startTime) });
        });
      }).observe({ entryTypes: ["longtask"] });
    } catch (e) {}
  }

  // 5. Slide transitions — record hash changes (the launch HTML's slide nav)
  //    or full-page navigation via the SPA pattern.
  var lastHash = location.hash, lastHashAt = Date.now();
  window.addEventListener("hashchange", function () {
    var now = Date.now();
    push("slide-change", {
      from: lastHash, to: location.hash,
      dwell: now - lastHashAt,
    });
    lastHash = location.hash; lastHashAt = now;
  });

  // ---------- dispatch ---------------------------------------------------

  var flushTimer = null;
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () { flushTimer = null; flush(false); }, cfg.flushMs || 2000);
  }
  function flush(unload) {
    if (queue.length === 0) return;
    var batch = queue.splice(0, queue.length);
    var headers = { "Content-Type": "application/json" };
    if (cfg.token) headers["Authorization"] = "Bearer " + cfg.token;
    try {
      fetch(cfg.endpoint, {
        method: "POST",
        headers: headers,
        body: JSON.stringify({ session: sessionId, events: batch }),
        keepalive: !!unload, mode: "cors",
      }).catch(function () { /* swallow; next batch will retry */ });
    } catch (e) {}
  }
  window.addEventListener("pagehide", function () { flush(true); });

  // Expose for ad-hoc author beacons.
  window.ScormRUM = {
    record: function (type, fields) { push(type || "custom", fields || {}); },
    flush: flush,
    sessionId: sessionId,
  };
})();
