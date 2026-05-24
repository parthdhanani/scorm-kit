/*
 * Mock SCORM 1.2 LMS — runs in the shell window, exposes window.API so the
 * course (in the iframe) finds it via parent-walking. Stores CMI state in
 * an in-memory tree, logs every call, persists to localStorage by package.
 */
(function () {
  "use strict";

  // SCORM 1.2 error codes (subset that matters in practice).
  var ERR = {
    OK: "0",
    GENERAL: "101",
    INVALID_ARG: "201",
    ELEMENT_CANNOT_HAVE_CHILDREN: "202",
    ELEMENT_NOT_ARRAY: "203",
    NOT_INITIALIZED: "301",
    NOT_IMPLEMENTED: "401",
    READ_ONLY: "403",
    WRITE_ONLY: "404",
    INCORRECT_DATA_TYPE: "405",
  };
  var ERR_STRINGS = {
    "0": "No error", "101": "General exception", "201": "Invalid argument error",
    "202": "Element cannot have children", "203": "Element not an array",
    "301": "Not initialized", "401": "Not implemented error",
    "403": "Element is read-only", "404": "Element is write-only",
    "405": "Incorrect data type",
  };

  // Default CMI 1.2 model (only the elements courses actually use).
  function defaultCmi() {
    return {
      "cmi.core._children": "student_id,student_name,lesson_location,credit,lesson_status,entry,score,total_time,lesson_mode,exit,session_time",
      "cmi.core.student_id": "mock-student",
      "cmi.core.student_name": "Mock, Student",
      "cmi.core.lesson_location": "",
      "cmi.core.credit": "credit",
      "cmi.core.lesson_status": "not attempted",
      "cmi.core.entry": "",
      "cmi.core.score._children": "raw,min,max",
      "cmi.core.score.raw": "",
      "cmi.core.score.min": "",
      "cmi.core.score.max": "",
      "cmi.core.total_time": "0000:00:00.00",
      "cmi.core.lesson_mode": "normal",
      "cmi.core.exit": "",
      "cmi.core.session_time": "0000:00:00.00",
      "cmi.suspend_data": "",
      "cmi.launch_data": "",
      "cmi.comments": "",
      "cmi.comments_from_lms": "",
      "cmi.objectives._count": "0",
      "cmi.objectives._children": "id,score,status",
      "cmi.student_data._children": "mastery_score,max_time_allowed,time_limit_action",
      "cmi.student_preference._children": "audio,language,speed,text",
      "cmi.interactions._count": "0",
      "cmi.interactions._children": "id,objectives,time,type,correct_responses,weighting,student_response,result,latency",
    };
  }

  // Write-permission map. Anything not in here = read-only.
  var WRITABLE = new Set([
    "cmi.core.lesson_location", "cmi.core.lesson_status", "cmi.core.exit",
    "cmi.core.session_time", "cmi.core.score.raw", "cmi.core.score.min",
    "cmi.core.score.max", "cmi.suspend_data", "cmi.comments",
  ]);
  // Dynamic-prefix writables (arrays): cmi.objectives.N.*, cmi.interactions.N.*
  function isDynamicWritable(key) {
    return /^cmi\.objectives\.\d+\.(id|score\.(raw|min|max)|status)$/.test(key) ||
           /^cmi\.interactions\.\d+\.(id|objectives\.\d+\.id|time|type|correct_responses\.\d+\.pattern|weighting|student_response|result|latency)$/.test(key);
  }

  // ---------- state ------------------------------------------------------

  var state = {
    initialized: false,
    terminated: false,
    cmi: defaultCmi(),
    lastError: ERR.OK,
    log: [],
    failMode: "none",
    packageKey: location.search.slice(1) || "default",
  };
  var STORAGE_KEY = "mockLMS:" + state.packageKey;

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.cmi)); } catch (e) {}
  }
  function restore() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      if (v) {
        Object.assign(state.cmi, JSON.parse(v));
        // SCORM 1.2 resume semantics: tell the course this is a resume so it
        // knows to read suspend_data / lesson_location instead of starting fresh.
        state.cmi["cmi.core.entry"] = "resume";
      }
    } catch (e) {}
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
    if (e.err && e.err !== ERR.OK) li.className = "err";
    var argText = e.args.map(function (a) { return JSON.stringify(a); }).join(", ");
    li.innerHTML =
      '<span class="t">' + e.t + 's</span>' +
      '<span class="m"></span>' +
      '<span class="a"></span>' +
      '<span class="r"></span>';
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
    if (!cmiEl) return;
    // Skip the _children noise — show actual values only.
    var lines = Object.keys(state.cmi).sort().filter(function (k) {
      return !/_children$|_count$/.test(k);
    }).map(function (k) {
      return k + " = " + JSON.stringify(state.cmi[k]);
    });
    cmiEl.textContent = lines.join("\n");
  }

  function setStateBadge(text, cls) {
    if (!stateEl) return;
    stateEl.textContent = text;
    stateEl.className = "state " + (cls || "");
  }

  // ---------- the SCORM 1.2 API surface ---------------------------------

  function setLastError(code) { state.lastError = code; }

  function lmsInit(s) {
    if (state.failMode === "init") { setLastError(ERR.GENERAL); logCall("LMSInitialize", [s], "false", ERR.GENERAL); return "false"; }
    if (state.initialized) { setLastError(ERR.GENERAL); logCall("LMSInitialize", [s], "false", ERR.GENERAL); return "false"; }
    state.initialized = true;
    state.terminated = false;
    setStateBadge("connected", "connected");
    setLastError(ERR.OK);
    logCall("LMSInitialize", [s], "true", ERR.OK);
    return "true";
  }

  function lmsFinish(s) {
    if (state.failMode === "finish") { setLastError(ERR.GENERAL); logCall("LMSFinish", [s], "false", ERR.GENERAL); return "false"; }
    if (!state.initialized) { setLastError(ERR.NOT_INITIALIZED); logCall("LMSFinish", [s], "false", ERR.NOT_INITIALIZED); return "false"; }
    state.initialized = false; state.terminated = true;
    persist();
    setStateBadge("terminated", "terminated");
    setLastError(ERR.OK);
    logCall("LMSFinish", [s], "true", ERR.OK);
    return "true";
  }

  function lmsCommit(s) {
    if (state.failMode === "commit") { setLastError(ERR.GENERAL); logCall("LMSCommit", [s], "false", ERR.GENERAL); return "false"; }
    if (!state.initialized) { setLastError(ERR.NOT_INITIALIZED); logCall("LMSCommit", [s], "false", ERR.NOT_INITIALIZED); return "false"; }
    persist();
    setLastError(ERR.OK);
    logCall("LMSCommit", [s], "true", ERR.OK);
    return "true";
  }

  function lmsGetValue(key) {
    if (!state.initialized) { setLastError(ERR.NOT_INITIALIZED); logCall("LMSGetValue", [key], "", ERR.NOT_INITIALIZED); return ""; }
    var v = state.cmi[key];
    if (v == null) {
      setLastError(ERR.NOT_IMPLEMENTED);
      logCall("LMSGetValue", [key], "", ERR.NOT_IMPLEMENTED);
      return "";
    }
    setLastError(ERR.OK);
    logCall("LMSGetValue", [key], v, ERR.OK);
    return String(v);
  }

  function lmsSetValue(key, value) {
    if (state.failMode === "set") {
      setLastError(ERR.GENERAL); logCall("LMSSetValue", [key, value], "false", ERR.GENERAL); return "false";
    }
    if (!state.initialized) {
      setLastError(ERR.NOT_INITIALIZED); logCall("LMSSetValue", [key, value], "false", ERR.NOT_INITIALIZED); return "false";
    }
    // Auto-expand array _count on first interactions/objectives.N write.
    var arr = /^cmi\.(interactions|objectives)\.(\d+)\./.exec(key);
    if (arr) {
      var countKey = "cmi." + arr[1] + "._count";
      var idx = +arr[2];
      var current = +(state.cmi[countKey] || "0");
      if (idx >= current) state.cmi[countKey] = String(idx + 1);
    }
    if (!WRITABLE.has(key) && !isDynamicWritable(key)) {
      // Known CMI elements that exist in defaultCmi but aren't writable are
      // read-only (per SCORM 1.2 RTE) — surface that with err 403. Unknown
      // keys still get NOT_IMPLEMENTED (401). Either way, we record the
      // attempted value so the call shows up in the panel for debugging.
      var code = (state.cmi[key] != null && !/_children$|_count$/.test(key))
        ? ERR.READ_ONLY
        : ERR.NOT_IMPLEMENTED;
      state.cmi[key] = String(value);
      setLastError(code);
      logCall("LMSSetValue", [key, value], "false", code);
      return "false";
    }
    state.cmi[key] = String(value);
    setLastError(ERR.OK);
    logCall("LMSSetValue", [key, value], "true", ERR.OK);
    return "true";
  }

  function lmsGetLastError() { return state.lastError; }
  function lmsGetErrorString(code) { return ERR_STRINGS[String(code)] || ""; }
  function lmsGetDiagnostic(code) { return lmsGetErrorString(code); }

  window.API = {
    LMSInitialize: lmsInit,
    LMSFinish: lmsFinish,
    LMSCommit: lmsCommit,
    LMSGetValue: lmsGetValue,
    LMSSetValue: lmsSetValue,
    LMSGetLastError: lmsGetLastError,
    LMSGetErrorString: lmsGetErrorString,
    LMSGetDiagnostic: lmsGetDiagnostic,
  };

  // ---------- UI wiring -------------------------------------------------

  function el(id) { return document.getElementById(id); }
  function boot() {
    logEl = el("log");
    cmiEl = el("cmi");
    countEl = el("log-count");
    filterEl = el("filter");
    stateEl = el("state");

    el("restart").addEventListener("click", function () {
      state.cmi = defaultCmi();
      state.initialized = false; state.terminated = false;
      state.log = []; state.lastError = ERR.OK;
      logEl.innerHTML = ""; updateCount();
      persist(); renderCmi();
      setStateBadge("disconnected", "");
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
      el("course").src = el("course").src;
    });
    el("clear").addEventListener("click", function () {
      state.log = []; logEl.innerHTML = ""; updateCount();
    });
    el("export").addEventListener("click", function () {
      var dump = { exportedAt: new Date().toISOString(), cmi: state.cmi, log: state.log };
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
      // Apply CMI presets BEFORE the course runs.
      restore();
      Object.keys(cfg.cmiPresets || {}).forEach(function (k) {
        var fullKey = k.indexOf("cmi.") === 0 ? k : "cmi.core." + k;
        state.cmi[fullKey] = cfg.cmiPresets[k];
      });
      state.failMode = cfg.fail || "none";
      el("fail-mode").value = state.failMode;
      renderCmi();
      el("course").src = cfg.launchUrl;
    });
  }
  document.addEventListener("DOMContentLoaded", boot);
})();
