#!/usr/bin/env node
/*
 * scorm-i18n — bundle a translation pack into a SCORM 1.2 package.
 *
 *   scorm-i18n <package.zip | dir> --strings strings.json [opts]
 *
 * What this tool does NOT do: auto-translate. It bundles strings the author
 * already provides, and ships a runtime that swaps text + media at page load.
 *
 * What the author must do upfront in their course HTML:
 *
 *   <h1 data-i18n="title">Welcome</h1>            ← default (en) text;
 *                                                   runtime replaces it.
 *   <button data-i18n="btn.submit">Submit</button>
 *   <input  data-i18n-attr="placeholder:input.name.placeholder">
 *   <video>
 *     <source data-i18n-source src="lesson.en.mp4">
 *     <track  data-i18n-track  src="lesson.en.vtt" kind="captions">
 *   </video>
 *
 * The CLI bundles the strings.json + the runtime, injects two <script>
 * tags into the launch HTML, and re-zips.
 *
 * strings.json shape:
 *
 *   {
 *     "defaultLang": "en",
 *     "names":       { "en": "English", "hi": "हिन्दी" },
 *     "rtl":         ["ar","he"],
 *     "strings": {
 *       "en": { "title": "Welcome", "btn.submit": "Submit" },
 *       "hi": { "title": "स्वागत", "btn.submit": "जमा करें" }
 *     }
 *   }
 *
 * The CLI validates the file and warns about missing keys per language.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var os = require("os");
var { spawnSync } = require("child_process");
var verifyConfinement = require("../confine");

// ---------- args -----------------------------------------------------------

function parseArgs(argv) {
  var a = { input: "", strings: "", out: "", hideSwitcher: false, dryRun: false };
  for (var i = 0; i < argv.length; i++) {
    var k = argv[i];
    if (k === "--strings") a.strings = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--hide-switcher") a.hideSwitcher = true;
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "-h" || k === "--help") { usage(); process.exit(0); }
    else if (k[0] === "-") { console.error("Unknown flag: " + k); process.exit(2); }
    else if (!a.input) a.input = k;
    else { console.error("Unexpected arg: " + k); process.exit(2); }
  }
  if (!a.input || !a.strings) { usage(); process.exit(2); }
  return a;
}
function usage() {
  console.error("Usage: scorm-i18n <package.zip | dir> --strings file.json [options]");
  console.error("  --out <path>        output zip path");
  console.error("  --hide-switcher     bundle without the floating lang selector UI");
  console.error("  --dry-run           print plan, change nothing");
}

// ---------- zip ------------------------------------------------------------

function unzipToTemp(zipPath) {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scorm-i18n-"));
  var r = spawnSync("unzip", ["-q", "-o", zipPath, "-d", tmp]);
  if (r.status !== 0) throw new Error("unzip: " + r.stderr.toString());
  verifyConfinement(tmp);
  return tmp;
}
function zipFromDir(dir, outZip) {
  if (fs.existsSync(outZip)) fs.unlinkSync(outZip);
  var r = spawnSync("zip", ["-qrX", outZip, "."], { cwd: dir });
  if (r.status !== 0) throw new Error("zip: " + r.stderr.toString());
}

// ---------- manifest + injection ------------------------------------------

function findLaunchHref(root) {
  var mPath = path.join(root, "imsmanifest.xml");
  if (!fs.existsSync(mPath)) return null;
  var xml = fs.readFileSync(mPath, "utf8");
  var m = /<resource\b[^>]*\bscormtype\s*=\s*["']sco["'][^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(xml);
  if (!m) m = /<resource\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\bscormtype\s*=\s*["']sco["']/i.exec(xml);
  if (!m) m = /<resource\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(xml);
  return m ? m[1] : null;
}

function injectScripts(html, stringsName, runtimeName) {
  if (/<script\s+[^>]*src=["']i18n-strings\.js["']/i.test(html) &&
      /<script\s+[^>]*src=["']i18n\.js["']/i.test(html)) return { html: html, injected: false };
  var tags =
    '<script src="' + stringsName + '"></script>\n' +
    '<script src="' + runtimeName + '"></script>\n';
  if (/<\/head>/i.test(html)) {
    return { html: html.replace(/<\/head>/i, tags + "</head>"), injected: true };
  }
  if (/<head\b[^>]*>/i.test(html)) {
    return { html: html.replace(/<head\b[^>]*>/i, function (m) { return m + "\n" + tags; }), injected: true };
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return { html: html.replace(/<html\b[^>]*>/i, function (m) { return m + "\n<head>\n" + tags + "</head>"; }), injected: true };
  }
  return { html: tags + html, injected: true };
}

// ---------- strings validation --------------------------------------------

function validateStrings(strings) {
  var problems = [];
  if (!strings || typeof strings !== "object") {
    problems.push("strings.json is empty or not an object");
    return problems;
  }
  if (!strings.strings || typeof strings.strings !== "object") {
    problems.push("missing top-level `strings` map");
    return problems;
  }
  var langs = Object.keys(strings.strings);
  if (langs.length < 2) problems.push("only " + langs.length + " language(s) — i18n needs ≥ 2");
  if (strings.defaultLang && !strings.strings[strings.defaultLang]) {
    problems.push("defaultLang \"" + strings.defaultLang + "\" not in strings map");
  }
  // Key parity
  if (langs.length >= 2) {
    var base = strings.defaultLang || langs[0];
    var baseKeys = new Set(Object.keys(strings.strings[base]));
    langs.forEach(function (l) {
      if (l === base) return;
      var ks = new Set(Object.keys(strings.strings[l]));
      var missing = [], extra = [];
      baseKeys.forEach(function (k) { if (!ks.has(k)) missing.push(k); });
      ks.forEach(function (k) { if (!baseKeys.has(k)) extra.push(k); });
      if (missing.length) problems.push("[" + l + "] missing " + missing.length + " key(s): " + missing.slice(0, 5).join(", ") + (missing.length > 5 ? "…" : ""));
      if (extra.length) problems.push("[" + l + "] " + extra.length + " key(s) not in " + base + ": " + extra.slice(0, 5).join(", ") + (extra.length > 5 ? "…" : ""));
    });
  }
  return problems;
}

// ---------- main -----------------------------------------------------------

function main() {
  var args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.input)) { console.error("Not found: " + args.input); process.exit(2); }
  if (!fs.existsSync(args.strings)) { console.error("Strings file not found: " + args.strings); process.exit(2); }

  var strings;
  try { strings = JSON.parse(fs.readFileSync(args.strings, "utf8")); }
  catch (e) { console.error("strings.json is not valid JSON: " + e.message); process.exit(2); }
  if (args.hideSwitcher) strings.hideSwitcher = true;

  var problems = validateStrings(strings);
  problems.forEach(function (p) { console.warn("warn  " + p); });

  var runtimeSrc = path.join(__dirname, "runtime", "i18n.js");
  if (!fs.existsSync(runtimeSrc)) { console.error("Runtime missing at " + runtimeSrc); process.exit(2); }

  var inputIsZip = fs.statSync(args.input).isFile();
  var root, cleanup = function () {};
  if (inputIsZip) {
    root = unzipToTemp(args.input);
    cleanup = function () { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {} };
  } else {
    root = path.resolve(args.input);
  }

  try {
    var launchHref = findLaunchHref(root);
    if (!launchHref) { console.error("No launch HTML in manifest."); process.exit(2); }
    var launchPath = path.resolve(root, launchHref.split("?")[0]);
    if (!fs.existsSync(launchPath)) { console.error("Launch HTML missing: " + launchHref); process.exit(2); }

    var langs = Object.keys(strings.strings || {});
    console.log("languages:  " + langs.join(", "));
    console.log("default:    " + (strings.defaultLang || langs[0]));
    console.log("rtl:        " + ((strings.rtl || []).join(", ") || "none"));
    console.log("strings:    " + (strings.strings[langs[0]] ? Object.keys(strings.strings[langs[0]]).length : 0) + " keys per language");

    if (args.dryRun) {
      console.log("\n(dry-run) would write i18n-strings.js + i18n.js next to launch HTML, inject 2 <script> tags");
      return;
    }

    var launchDir = path.dirname(launchPath);
    fs.copyFileSync(runtimeSrc, path.join(launchDir, "i18n.js"));
    fs.writeFileSync(
      path.join(launchDir, "i18n-strings.js"),
      "window.I18N_STRINGS = " + JSON.stringify(strings, null, 2) + ";\n"
    );

    var html = fs.readFileSync(launchPath, "utf8");
    var inj = injectScripts(html, "i18n-strings.js", "i18n.js");
    if (inj.injected) {
      fs.writeFileSync(launchPath, inj.html);
      console.log("injected    " + path.relative(root, launchPath));
    } else {
      console.log("inject      skipped (already wrapped); strings refreshed");
    }
    console.log("copied      i18n.js");
    console.log("wrote       i18n-strings.js");

    if (inputIsZip) {
      var out = args.out || args.input.replace(/\.zip$/i, "") + "-i18n.zip";
      zipFromDir(root, path.resolve(out));
      console.log("\nwrote " + out);
    }
  } finally {
    cleanup();
  }
}

main();
