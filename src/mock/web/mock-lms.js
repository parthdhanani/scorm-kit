/*
 * Mock SCORM 1.2 LMS — runs in the shell window, exposes window.API so the
 * course (in the iframe) finds it via parent-walking.
 *
 * SCORM 1.2 runtime powered by scorm-again (MIT © Jonathan Putney)
 * https://github.com/jcputney/scorm-again
 *
 * This wrapper keeps the existing logging/fail-mode/UI layer and delegates
 * all spec-compliance work to Scorm12API from scorm-again.
 */
(function () {
  "use strict";

  var state = {
    log: [],
    failMode: "none",
    packageKey: location.search.slice(1) || "default",
  };
  var STORAGE_KEY = "mockLMS:" + state.packageKey;
  var currentPresets = {};
  var sapi = null;

  // ---------- scorm-again integration ------------------------------------

  // Methods we expose on window.API and intercept for logging + fail-mode.
  var METHODS = [
    "LMSInitialize", "LMSFinish", "LMSCommit",
    "LMSGetValue", "LMSSetValue",
    "LMSGetLastError", "LMSGetErrorString", "LMSGetDiagnostic",
  ];
  // Maps failMode value → method name that gets injected.
  var FAIL_FOR = { init: "LMSInitialize", finish: "LMSFinish", commit: "LMSCommit", set: "LMSSetValue" };

  function createSapi(presets) {
    currentPresets = presets || {};
    var instance = new window.Scorm12API({
      sendFullCommit: false,
      lmsCommitUrl: false,
    });

    // Restore saved CMI from localStorage (resume semantics).
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        instance.loadFromJSON(JSON.parse(saved));
        // Tell the course this is a resume so it reads suspend_data/lesson_location.
        instance.loadFromFlattenedJSON({ "cmi.core.entry": "resume" });
      }
    } catch (e) {}

    // Apply LMS defaults + CLI presets (presets override restore for the same key).
    var defaults = {
      "cmi.core.student_id": "mock-student",
      "cmi.core.student_name": "Mock, Student",
    };
    instance.loadFromFlattenedJSON(Object.assign(defaults, currentPresets));

    return instance;
  }

  function buildProxy(instance) {
    var api = {};
    METHODS.forEach(function (m) {
      api[m] = function () {
        var args = [].slice.call(arguments);

        // Fail-mode injection: return "false" without calling scorm-again.
        if (state.failMode !== "none" && FAIL_FOR[state.failMode] === m) {
          logCall(m, args, "false", "101");
          return "false";
        }

        var ret = instance[m].apply(instance, args);
        var errCode = String(instance.lastErrorCode || "0");
        logCall(m, args, ret, errCode);

        if (m === "LMSInitialize" && ret === "true") setStateBadge("connected", "connected");
        if (m === "LMSCommit"    && ret === "true") persistCmi();
        if (m === "LMSFinish") {
          if (ret === "true") persistCmi();
          setStateBadge("terminated", "terminated");
        }

        return ret;
      };
    });
    return api;
  }

  function persistCmi() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sapi.cmi)); } catch (e) {}
  }

  // ---------- log --------------------------------------------------------

  var logEl, cmiEl, countEl, filterEl, stateEl;
  var t0 = performance.now();

  function logCall(method, args, ret, err) {
    var entry = {
      t: ((performance.now() - t0) / 1000).toFixed(2),
      method: method,
      args: args,
      ret: ret,
      err: err,
    };
    state.log.push(entry);
    appendLogRow(entry);
    updateCount();
  }

  function appendLogRow(e) {
    if (!logEl) return;
    var li = document.createElement("li");
    if (e.err && e.err !== "0") li.className = "err";
    var argText = e.args.map(function (a) { return JSON.stringify(a); }).join(", ");
    li.innerHTML =
      '<span class="t"></span>' +
      '<span class="m"></span>' +
      '<span class="a"></span>' +
      '<span class="r"></span>';
    li.children[0].textContent = e.t + "s";
    li.children[1].textContent = e.method;
    li.children[2].textContent = argText;
    li.children[3].textContent = JSON.stringify(e.ret);
    li.dataset.method = e.method.toLowerCase();
    li.dataset.args = argText.toLowerCase();
    applyFilter(li);
    logEl.appendChild(li);
    logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
  }

  function updateCount() {
    if (countEl) countEl.textContent = state.log.length + " call" + (state.log.length === 1 ? "" : "s");
  }

  function applyFilter(li) {
    if (!filterEl) return;
    var q = filterEl.value.trim().toLowerCase();
    if (!q) { li.classList.remove("hidden"); return; }
    var hit = li.dataset.method.indexOf(q) >= 0 || li.dataset.args.indexOf(q) >= 0;
    li.classList.toggle("hidden", !hit);
  }

  function renderCmi() {
    if (!cmiEl || !sapi) return;
    try {
      cmiEl.textContent = JSON.stringify(JSON.parse(JSON.stringify(sapi.cmi)), null, 2);
    } catch (e) {
      cmiEl.textContent = String(e);
    }
  }

  function setStateBadge(text, cls) {
    if (!stateEl) return;
    stateEl.textContent = text;
    stateEl.className = "state " + (cls || "");
  }

  // ---------- UI wiring -------------------------------------------------

  function el(id) { return document.getElementById(id); }

  function boot() {
    logEl = el("log");
    cmiEl = el("cmi");
    countEl = el("log-count");
    filterEl = el("filter");
    stateEl = el("state");

    el("restart").addEventListener("click", function () {
      state.log = []; state.failMode = "none";
      logEl.innerHTML = ""; updateCount();
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
      el("fail-mode").value = "none";
      setStateBadge("disconnected", "");
      sapi = createSapi(currentPresets);
      window.API = buildProxy(sapi);
      el("course").src = el("course").src;
    });

    el("clear").addEventListener("click", function () {
      state.log = []; logEl.innerHTML = ""; updateCount();
    });

    el("export").addEventListener("click", function () {
      var cmiSnap = {};
      try { cmiSnap = JSON.parse(JSON.stringify(sapi ? sapi.cmi : {})); } catch (e) {}
      var dump = { exportedAt: new Date().toISOString(), cmi: cmiSnap, log: state.log };
      var blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "scorm-session-" + Date.now() + ".json";
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });

    el("fail-mode").addEventListener("change", function (e) {
      state.failMode = e.target.value;
    });

    filterEl.addEventListener("input", function () {
      [].forEach.call(logEl.children, applyFilter);
    });

    [].forEach.call(document.querySelectorAll(".tabs button"), function (b) {
      b.addEventListener("click", function () {
        document.querySelectorAll(".tabs button").forEach(function (x) { x.classList.remove("active"); });
        document.querySelectorAll(".tab-pane").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        el("tab-" + b.dataset.tab).classList.add("active");
        if (b.dataset.tab === "cmi") renderCmi();
      });
    });

    // Load config + boot the iframe.
    fetch("/config.json").then(function (r) { return r.json(); }).then(function (cfg) {
      sapi = createSapi(cfg.cmiPresets);
      window.API = buildProxy(sapi);
      el("fail-mode").value = cfg.fail || "none";
      state.failMode = cfg.fail || "none";
      renderCmi();
      el("course").src = cfg.launchUrl;
    });
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
