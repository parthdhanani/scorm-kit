/*
 * scorm-i18n runtime — runs in the course window at page load.
 *
 * Reads window.I18N_STRINGS (injected by the CLI), determines the active
 * language from (in order):
 *   1. ?lang=xx query param
 *   2. cmi.student_preference.language (if SCORM API is available)
 *   3. <html lang="..."> attribute
 *   4. config.defaultLang
 *
 * Then walks the DOM and:
 *   - replaces textContent on [data-i18n="key"] elements with strings[key]
 *   - rewrites src on <track data-i18n-track="suffix"> from
 *       "video.vtt"  →  "video.{lang}.vtt"
 *   - rewrites src on <source data-i18n-source="suffix"> the same way
 *   - sets <html lang> to the active language
 *   - injects a small language switcher in the top-right
 */
(function () {
  "use strict";
  var data = window.I18N_STRINGS;
  if (!data || !data.strings) { console.warn("[scorm-i18n] no strings"); return; }

  var langs = Object.keys(data.strings);
  var defaultLang = data.defaultLang || langs[0];

  function findApi() {
    var win = window, d = 500;
    while (win && d-- > 0) {
      if (win.API) return win.API;
      if (win.parent && win.parent !== win) { win = win.parent; continue; }
      break;
    }
    return null;
  }
  function getScormLang() {
    // Read without calling LMSInitialize — initializing here would emit a
    // premature `launched` xAPI statement when paired with scorm-xapi, and
    // could also conflict with the course's own init sequence. If the LMS
    // hasn't been initialized yet, LMSGetValue returns "" and we move on.
    var api = findApi();
    if (!api) return null;
    try {
      var v = api.LMSGetValue("cmi.student_preference.language");
      return v || null;
    } catch (e) { return null; }
  }

  function pick() {
    var q = (location.search.match(/[?&]lang=([^&]+)/) || [])[1];
    if (q && data.strings[q]) return q;
    var scorm = getScormLang();
    if (scorm && data.strings[scorm]) return scorm;
    try {
      var ls = localStorage.getItem("scormI18nLang");
      if (ls && data.strings[ls]) return ls;
    } catch (e) {}
    var htmlLang = document.documentElement.getAttribute("lang");
    if (htmlLang && data.strings[htmlLang]) return htmlLang;
    return defaultLang;
  }

  function applyText(lang) {
    var strings = data.strings[lang] || {};
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      if (strings[key] != null) el.textContent = strings[key];
    });
    document.querySelectorAll("[data-i18n-attr]").forEach(function (el) {
      // data-i18n-attr="title:tooltipKey,aria-label:labelKey"
      el.getAttribute("data-i18n-attr").split(",").forEach(function (pair) {
        var p = pair.split(":");
        if (p.length === 2 && strings[p[1].trim()] != null) {
          el.setAttribute(p[0].trim(), strings[p[1].trim()]);
        }
      });
    });
  }

  function applyMedia(lang) {
    function rewrite(src, lang) {
      // Split off query / hash so a "foo.en.mp4?v=2" round-trips correctly.
      var qi = src.search(/[?#]/);
      var base = qi >= 0 ? src.slice(0, qi) : src;
      var tail = qi >= 0 ? src.slice(qi) : "";
      // foo.vtt → foo.<lang>.vtt ; foo.en.vtt → foo.<lang>.vtt
      var m = base.match(/^(.+?)(?:\.[a-z]{2,3}(?:-[A-Z]{2})?)?(\.[a-z0-9]+)$/i);
      if (!m) return src;
      return m[1] + "." + lang + m[2] + tail;
    }
    document.querySelectorAll("track[data-i18n-track]").forEach(function (el) {
      var orig = el.getAttribute("data-i18n-track-orig") || el.getAttribute("src");
      if (!el.getAttribute("data-i18n-track-orig")) el.setAttribute("data-i18n-track-orig", orig);
      el.setAttribute("src", rewrite(orig, lang));
      el.setAttribute("srclang", lang);
    });
    document.querySelectorAll("source[data-i18n-source]").forEach(function (el) {
      var orig = el.getAttribute("data-i18n-source-orig") || el.getAttribute("src");
      if (!el.getAttribute("data-i18n-source-orig")) el.setAttribute("data-i18n-source-orig", orig);
      el.setAttribute("src", rewrite(orig, lang));
    });
    // Force <video> elements to reload their selected source after we changed it.
    document.querySelectorAll("video").forEach(function (v) {
      if (v.querySelector("source[data-i18n-source]")) {
        var t = v.currentTime;
        v.load();
        v.currentTime = t;
      }
    });
  }

  function persistChoice(lang) {
    try {
      var api = (function f(w, d) {
        while (w && d-- > 0) { if (w.API) return w.API; if (w.parent && w.parent !== w) w = w.parent; else break; }
        return null;
      })(window, 500);
      if (api) api.LMSSetValue("cmi.student_preference.language", lang);
    } catch (e) {}
    try { localStorage.setItem("scormI18nLang", lang); } catch (e) {}
  }

  function injectSwitcher(current) {
    if (langs.length < 2 || data.hideSwitcher) return;
    var wrap = document.createElement("div");
    wrap.id = "i18n-switcher";
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Language selector");
    wrap.style.cssText = "position:fixed;top:8px;right:8px;z-index:99999;background:#fff;" +
      "border:1px solid #ccc;border-radius:6px;padding:4px 8px;font:13px system-ui,sans-serif;" +
      "box-shadow:0 1px 3px rgba(0,0,0,0.1);";
    var sel = document.createElement("select");
    sel.setAttribute("aria-label", "Language");
    sel.style.cssText = "border:0;background:transparent;font:inherit;cursor:pointer;";
    langs.forEach(function (l) {
      var o = document.createElement("option");
      o.value = l;
      o.textContent = (data.names && data.names[l]) || l.toUpperCase();
      if (l === current) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () {
      var newLang = sel.value;
      persistChoice(newLang);
      apply(newLang);
    });
    wrap.appendChild(sel);
    document.body.appendChild(wrap);
  }

  function apply(lang) {
    document.documentElement.setAttribute("lang", lang);
    document.documentElement.setAttribute("dir",
      data.rtl && data.rtl.indexOf(lang) >= 0 ? "rtl" : "ltr");
    applyText(lang);
    applyMedia(lang);
    var sel = document.querySelector("#i18n-switcher select");
    if (sel && sel.value !== lang) sel.value = lang;
  }

  function boot() {
    var lang = pick();
    apply(lang);
    injectSwitcher(lang);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
