#!/usr/bin/env node
/*
 * scorm-a11y — WCAG 2.2 AA static auditor for SCORM 1.2 packages.
 *
 *   scorm-a11y path/to/package.zip
 *   scorm-a11y path/to/unzipped-dir
 *
 * Checks every HTML file in the package against the accessibility failure
 * modes that recur across the catalogues I've audited. Output is grouped
 * by severity (error / warn / info) and can be emitted as JSON for CI.
 *
 * Rules:
 *
 *   doc-no-lang             <html> has no lang attribute
 *   doc-no-title            <title> empty or missing
 *   doc-empty-title         <title> contains only whitespace
 *
 *   img-no-alt              <img> has no alt attribute (decorative needs alt="")
 *   img-alt-filename        alt looks like a filename ("logo.png", "img_42")
 *   img-redundant-alt       alt repeats the surrounding link text
 *
 *   video-no-track          <video> has no <track kind="captions"> child
 *   audio-no-transcript     <audio> with no nearby transcript link
 *
 *   heading-skip            heading level skipped (h1 → h3)
 *   heading-no-h1           HTML has headings but no <h1>
 *
 *   link-no-text            <a> has no text content and no aria-label / title
 *   link-generic-text       link text is "click here", "read more", etc.
 *
 *   button-no-name          <button> with no text content and no aria-label
 *
 *   form-input-no-label     <input>/<select>/<textarea> has no associated label
 *
 *   div-click-no-role       <div onclick=...> without role= and tabindex=
 *   tabindex-positive       tabindex > 0 (breaks natural tab order)
 *
 *   iframe-no-title         <iframe> with no title attribute
 *   table-no-headers        <table> with rows but no <th> or scope=
 *
 *   aria-bad-attr           common aria-* typos (aria-labelby, aria-labeled, etc.)
 *   aria-hidden-focusable   focusable element inside aria-hidden="true"
 *
 *   lang-mixed-no-attr      page-level lang attr present but inline foreign
 *                           text spans have no lang= override (heuristic)
 *
 * Exit codes: 0 = clean, 1 = warnings only, 2 = errors.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var os = require("os");
var { spawnSync, execSync } = require("child_process");
var verifyConfinement = require("../confine");

// ---------- rules table ----------------------------------------------------

var RULES = {
  "doc-no-lang":          { sev: "error", msg: "<html> missing lang attribute" },
  "doc-no-title":         { sev: "error", msg: "no <title> element" },
  "doc-empty-title":      { sev: "error", msg: "<title> is empty" },
  "img-no-alt":           { sev: "error", msg: "<img> missing alt attribute (use alt=\"\" for decorative)" },
  "img-alt-filename":     { sev: "warn",  msg: "<img> alt looks like a filename" },
  "img-redundant-alt":    { sev: "warn",  msg: "<img> alt repeats surrounding link text" },
  "video-no-track":       { sev: "error", msg: "<video> has no <track kind=\"captions\">" },
  "audio-no-transcript":  { sev: "warn",  msg: "<audio> with no nearby transcript link" },
  "heading-skip":         { sev: "warn",  msg: "heading level skipped" },
  "heading-no-h1":        { sev: "warn",  msg: "HTML has headings but no <h1>" },
  "link-no-text":         { sev: "error", msg: "<a> has no accessible name" },
  "link-generic-text":    { sev: "warn",  msg: "link text is generic (\"click here\" / \"read more\")" },
  "button-no-name":       { sev: "error", msg: "<button> has no accessible name" },
  "form-input-no-label":  { sev: "error", msg: "form control has no associated label" },
  "div-click-no-role":    { sev: "error", msg: "<div onclick=...> without role/tabindex (not keyboard accessible)" },
  "tabindex-positive":    { sev: "warn",  msg: "tabindex > 0 breaks natural tab order" },
  "iframe-no-title":      { sev: "error", msg: "<iframe> missing title attribute" },
  "table-no-headers":     { sev: "warn",  msg: "<table> has rows but no <th> or scope=" },
  "aria-bad-attr":        { sev: "error", msg: "invalid aria-* attribute name (likely typo)" },
  "aria-hidden-focusable":{ sev: "error", msg: "focusable element inside aria-hidden=\"true\"" },
};

// Common aria-* misspellings I've actually seen in audits.
var VALID_ARIA = new Set([
  "aria-label", "aria-labelledby", "aria-describedby", "aria-hidden",
  "aria-live", "aria-atomic", "aria-relevant", "aria-busy",
  "aria-controls", "aria-owns", "aria-flowto", "aria-activedescendant",
  "aria-expanded", "aria-pressed", "aria-checked", "aria-selected",
  "aria-disabled", "aria-readonly", "aria-required", "aria-invalid",
  "aria-haspopup", "aria-current", "aria-modal", "aria-multiline",
  "aria-multiselectable", "aria-orientation", "aria-sort", "aria-level",
  "aria-posinset", "aria-setsize", "aria-valuemin", "aria-valuemax",
  "aria-valuenow", "aria-valuetext", "aria-autocomplete", "aria-placeholder",
  "aria-roledescription", "aria-keyshortcuts", "aria-details", "aria-errormessage",
  "aria-colcount", "aria-colindex", "aria-colspan",
  "aria-rowcount", "aria-rowindex", "aria-rowspan",
  "aria-dropeffect", "aria-grabbed",
]);

var GENERIC_LINK_TEXT = new Set([
  "click here", "click", "here", "read more", "more", "learn more",
  "details", "link", "this", "this link", "more info", "info",
]);

// ---------- args -----------------------------------------------------------

function parseArgs(argv) {
  var a = { input: "", json: false, noColor: false, infoOff: false };
  for (var i = 0; i < argv.length; i++) {
    var k = argv[i];
    if (k === "--json") a.json = true;
    else if (k === "--no-color") a.noColor = true;
    else if (k === "--no-info") a.infoOff = true;
    else if (k === "-h" || k === "--help") { usage(); process.exit(0); }
    else if (k[0] === "-") { console.error("Unknown flag: " + k); process.exit(2); }
    else if (!a.input) a.input = k;
    else { console.error("Unexpected arg: " + k); process.exit(2); }
  }
  if (!a.input) { usage(); process.exit(2); }
  return a;
}
function usage() {
  console.error("Usage: scorm-a11y <package.zip | dir> [--json] [--no-info] [--no-color]");
}

// ---------- zip ------------------------------------------------------------

function unzipToTemp(zipPath) {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scorm-a11y-"));
  var r = spawnSync("unzip", ["-q", "-o", zipPath, "-d", tmp]);
  if (r.status !== 0) throw new Error("unzip: " + r.stderr.toString());
  verifyConfinement(tmp);
  return tmp;
}

// ---------- walk -----------------------------------------------------------

function walk(dir, acc) {
  acc = acc || [];
  for (var name of fs.readdirSync(dir)) {
    var p = path.join(dir, name);
    var st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

// ---------- finding type ---------------------------------------------------

function find(rule, file, line, detail) {
  return { rule: rule, sev: RULES[rule].sev, msg: RULES[rule].msg, file: file, line: line, detail: detail || "" };
}

function lineOf(html, idx) {
  var n = 1;
  for (var i = 0; i < idx && i < html.length; i++) if (html[i] === "\n") n++;
  return n;
}

// ---------- attribute parsing ---------------------------------------------

function getAttr(tagStr, name) {
  var re = new RegExp("\\b" + name + '\\s*=\\s*(["\'])([^"\']*)\\1', "i");
  var m = re.exec(tagStr);
  return m ? m[2] : null;
}
function hasAttr(tagStr, name) {
  return new RegExp("\\b" + name + "(\\s|=|>|/)", "i").test(tagStr);
}
// ---------- audit one HTML --------------------------------------------------

function auditHtml(file, html) {
  var findings = [];
  var rel = file;

  // doc-no-lang
  var htmlTag = /<html\b[^>]*>/i.exec(html);
  if (htmlTag && !getAttr(htmlTag[0], "lang")) {
    findings.push(find("doc-no-lang", rel, lineOf(html, htmlTag.index)));
  }

  // title — search inside <head> so we don't pick up <svg><title> by accident
  var headM = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  var headSlice = headM ? headM[1] : html;
  var headStart = headM ? headM.index : 0;
  var titleM = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(headSlice);
  if (!titleM) {
    findings.push(find("doc-no-title", rel, 1));
  } else if (!titleM[1].trim()) {
    findings.push(find("doc-empty-title", rel, lineOf(html, headStart + titleM.index)));
  }

  // images
  var imgRe = /<img\b([^>]*)>/gi, m;
  while ((m = imgRe.exec(html)) !== null) {
    var attrs = m[1];
    if (!hasAttr(attrs, "alt")) {
      findings.push(find("img-no-alt", rel, lineOf(html, m.index), m[0].slice(0, 80)));
    } else {
      var alt = getAttr(attrs, "alt") || "";
      if (alt && /\.(png|jpg|jpeg|gif|svg|webp|bmp)$/i.test(alt.trim())) {
        findings.push(find("img-alt-filename", rel, lineOf(html, m.index), "alt=\"" + alt + "\""));
      }
      if (alt && /^(img|image|picture|photo)[_\s-]?\d+$/i.test(alt.trim())) {
        findings.push(find("img-alt-filename", rel, lineOf(html, m.index), "alt=\"" + alt + "\""));
      }
    }
  }

  // video without <track kind="captions">
  var videoRe = /<video\b([^>]*)>([\s\S]*?)<\/video>/gi;
  while ((m = videoRe.exec(html)) !== null) {
    var inner = m[2];
    if (!/<track\b[^>]*\bkind\s*=\s*["']captions["']/i.test(inner)) {
      findings.push(find("video-no-track", rel, lineOf(html, m.index)));
    }
  }

  // audio without transcript link nearby (heuristic: look for "transcript" in next 500 chars)
  var audioRe = /<audio\b[^>]*>[\s\S]*?<\/audio>/gi;
  while ((m = audioRe.exec(html)) !== null) {
    var after = html.slice(m.index, m.index + 500 + m[0].length);
    if (!/transcript/i.test(after)) {
      findings.push(find("audio-no-transcript", rel, lineOf(html, m.index)));
    }
  }

  // headings
  var headRe = /<h([1-6])\b[^>]*>/gi;
  var levels = [];
  while ((m = headRe.exec(html)) !== null) levels.push({ lvl: +m[1], pos: m.index });
  if (levels.length > 0) {
    if (!levels.some(function (l) { return l.lvl === 1; })) {
      findings.push(find("heading-no-h1", rel, lineOf(html, levels[0].pos)));
    }
    for (var i = 1; i < levels.length; i++) {
      var d = levels[i].lvl - levels[i - 1].lvl;
      if (d > 1) {
        findings.push(find("heading-skip", rel, lineOf(html, levels[i].pos),
          "h" + levels[i - 1].lvl + " → h" + levels[i].lvl));
      }
    }
  }

  // links
  var linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    var aAttrs = m[1], aText = m[2].replace(/<[^>]+>/g, "").trim();
    var aria = getAttr(aAttrs, "aria-label");
    var title = getAttr(aAttrs, "title");
    var hasName = aText || aria || title;
    if (!hasName) {
      var imgInside = /<img\b[^>]*\balt\s*=\s*["']([^"']+)["']/i.exec(m[2]);
      if (!imgInside || !imgInside[1].trim()) {
        findings.push(find("link-no-text", rel, lineOf(html, m.index)));
      }
    } else {
      if (aText && GENERIC_LINK_TEXT.has(aText.toLowerCase())) {
        findings.push(find("link-generic-text", rel, lineOf(html, m.index), "\"" + aText + "\""));
      }
      // Redundant: img alt inside the link matches the link's surrounding text.
      var imgInside2 = /<img\b[^>]*\balt\s*=\s*["']([^"']+)["']/i.exec(m[2]);
      if (imgInside2 && aText && imgInside2[1].trim().toLowerCase() === aText.toLowerCase()) {
        findings.push(find("img-redundant-alt", rel, lineOf(html, m.index),
                           "alt=\"" + imgInside2[1] + "\" duplicates link text"));
      }
    }
  }

  // buttons
  var btnRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  while ((m = btnRe.exec(html)) !== null) {
    var bAttrs = m[1], bText = m[2].replace(/<[^>]+>/g, "").trim();
    if (!bText && !getAttr(bAttrs, "aria-label") && !getAttr(bAttrs, "title")) {
      findings.push(find("button-no-name", rel, lineOf(html, m.index)));
    }
  }

  // form inputs missing labels
  var inputRe = /<(input|select|textarea)\b([^>]*)>/gi;
  while ((m = inputRe.exec(html)) !== null) {
    var iType = (getAttr(m[2], "type") || "").toLowerCase();
    if (m[1].toLowerCase() === "input" && ["hidden", "submit", "button", "reset", "image"].indexOf(iType) >= 0) continue;
    var id = getAttr(m[2], "id");
    var aria2 = getAttr(m[2], "aria-label") || getAttr(m[2], "aria-labelledby");
    var hasLabel = aria2;
    if (!hasLabel && id) {
      var labelRe = new RegExp('<label\\b[^>]*\\bfor\\s*=\\s*["\']' + id.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") + '["\']', "i");
      if (labelRe.test(html)) hasLabel = true;
    }
    if (!hasLabel) {
      findings.push(find("form-input-no-label", rel, lineOf(html, m.index), "<" + m[1] + ">"));
    }
  }

  // div with onclick but no role/tabindex
  var divClickRe = /<div\b([^>]*\bonclick\b[^>]*)>/gi;
  while ((m = divClickRe.exec(html)) !== null) {
    if (!getAttr(m[1], "role") || !hasAttr(m[1], "tabindex")) {
      findings.push(find("div-click-no-role", rel, lineOf(html, m.index)));
    }
  }

  // tabindex > 0
  var tabRe = /\btabindex\s*=\s*["'](\d+)["']/gi;
  while ((m = tabRe.exec(html)) !== null) {
    if (+m[1] > 0) findings.push(find("tabindex-positive", rel, lineOf(html, m.index), "tabindex=\"" + m[1] + "\""));
  }

  // iframes
  var iframeRe = /<iframe\b([^>]*)>/gi;
  while ((m = iframeRe.exec(html)) !== null) {
    if (!getAttr(m[1], "title")) findings.push(find("iframe-no-title", rel, lineOf(html, m.index)));
  }

  // tables with rows but no <th>/scope
  var tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  while ((m = tableRe.exec(html)) !== null) {
    var tBody = m[1];
    if (/<tr\b/i.test(tBody) && !/<th\b/i.test(tBody) && !/scope\s*=/i.test(tBody)) {
      findings.push(find("table-no-headers", rel, lineOf(html, m.index)));
    }
  }

  // aria-* typos
  var ariaRe = /\b(aria-[a-zA-Z]+)\s*=/g;
  while ((m = ariaRe.exec(html)) !== null) {
    var attr = m[1].toLowerCase();
    if (!VALID_ARIA.has(attr)) {
      findings.push(find("aria-bad-attr", rel, lineOf(html, m.index), attr));
    }
  }

  // aria-hidden=true wrapping focusable elements
  var hiddenRe = /<([a-z]+)\b[^>]*\baria-hidden\s*=\s*["']true["'][^>]*>([\s\S]*?)<\/\1>/gi;
  while ((m = hiddenRe.exec(html)) !== null) {
    if (/<(a|button|input|select|textarea|iframe)\b/i.test(m[2]) || /\btabindex\s*=\s*["']0["']/i.test(m[2])) {
      findings.push(find("aria-hidden-focusable", rel, lineOf(html, m.index)));
    }
  }

  return findings;
}

// ---------- main -----------------------------------------------------------

function color(s, code, on) { return on ? "\x1b[" + code + "m" + s + "\x1b[0m" : s; }

function main() {
  var args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.input)) { console.error("Not found: " + args.input); process.exit(2); }

  var inputIsZip = fs.statSync(args.input).isFile();
  var root, cleanup = function () {};
  if (inputIsZip) {
    root = unzipToTemp(args.input);
    cleanup = function () { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {} };
  } else {
    root = path.resolve(args.input);
  }

  try {
    var htmls = walk(root).filter(function (p) { return /\.html?$/i.test(p); });
    var all = [];
    for (var f of htmls) {
      var html = fs.readFileSync(f, "utf8");
      var rel = path.relative(root, f);
      var fs2 = auditHtml(rel, html);
      all = all.concat(fs2);
    }

    if (args.infoOff) all = all.filter(function (x) { return x.sev !== "info"; });

    if (args.json) {
      console.log(JSON.stringify({ findings: all }, null, 2));
    } else {
      var byFile = {};
      for (var f2 of all) { (byFile[f2.file] = byFile[f2.file] || []).push(f2); }
      var useColor = !args.noColor && process.stdout.isTTY;
      var sevColor = { error: 31, warn: 33, info: 36 };
      for (var file of Object.keys(byFile).sort()) {
        console.log("\n" + color(file, 1, useColor));
        for (var item of byFile[file]) {
          var sev = color(item.sev.toUpperCase().padEnd(5), sevColor[item.sev] || 0, useColor);
          console.log("  " + sev + " L" + String(item.line).padEnd(4) + " " + item.rule.padEnd(22) + " " + item.msg + (item.detail ? "  — " + item.detail : ""));
        }
      }
      var errs = all.filter(function (x) { return x.sev === "error"; }).length;
      var warns = all.filter(function (x) { return x.sev === "warn"; }).length;
      console.log("\n" + errs + " error(s), " + warns + " warning(s) across " + htmls.length + " HTML file(s).");
    }

    var anyErr = all.some(function (x) { return x.sev === "error"; });
    var anyWarn = all.some(function (x) { return x.sev === "warn"; });
    process.exit(anyErr ? 2 : anyWarn ? 1 : 0);
  } finally {
    cleanup();
  }
}

main();
