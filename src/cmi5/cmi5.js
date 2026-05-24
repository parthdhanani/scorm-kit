#!/usr/bin/env node
/*
 * scorm-kit cmi5 — cmi5 package validator, linter, and SCORM-to-cmi5 wrapper.
 *
 * cmi5 (ADL, 2016/2023) is the spec that replaces SCORM 1.2 for new builds:
 * SCORM-style "launch and handshake" + xAPI-based tracking. Most LMS RFPs in
 * 2026 require cmi5 support. This subcommand:
 *
 *   scorm-kit cmi5 validate <package.zip|dir>
 *       Validates a cmi5 package against the AICC cmi5 v1 spec:
 *       - cmi5.xml present at archive root
 *       - <courseStructure> root, valid xmlns
 *       - <course id="..."> with IRI-shaped id
 *       - At least one <au> (Assignable Unit)
 *       - Each AU has id (IRI), launchMethod, moveOn, url, title (langstring)
 *       - launchMethod ∈ { OwnWindow, AnyWindow }
 *       - moveOn ∈ { Passed, Completed, CompletedAndPassed, CompletedOrPassed, NotApplicable }
 *       - masteryScore (if present) is 0.0–1.0
 *       - activityType (if present) is a IRI
 *       - All AU launch URLs resolve within the package
 *
 *   scorm-kit cmi5 lint <package.zip|dir>
 *       Same as validate, plus stylistic / interop checks:
 *       - course id and AU ids unique
 *       - title and description present in at least 'en'
 *       - no AU duplicated url
 *       - duration follows ISO-8601
 *       - extensions namespaced (https://...)
 *       - waivedMoveOnConditions consistent with moveOn
 *
 *   scorm-kit cmi5 convert <scorm-package.zip> --out <cmi5-package.zip>
 *       Wraps a SCORM 1.2 package as cmi5: emits cmi5.xml referencing the
 *       SCORM SCO's launch HTML as the cmi5 AU. The SCORM API is left in
 *       place so the package degrades gracefully if launched from a SCORM-
 *       only LMS. This is the "dual-stream" pattern most teams now use:
 *       SCORM for HR completion records, cmi5/xAPI for behavioural data.
 *
 * Exit codes: 0 = clean, 1 = warnings only, 2 = errors.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var os = require("os");
var { spawnSync, execSync } = require("child_process");

// ---------- rules table ----------------------------------------------------

var RULES = {
  // structural (errors)
  "cmi5-missing":             { sev: "error", msg: "cmi5.xml not found at package root" },
  "cmi5-bad-xml":             { sev: "error", msg: "cmi5.xml is not well-formed XML" },
  "cmi5-bad-root":            { sev: "error", msg: "root element must be <courseStructure>" },
  "cmi5-bad-namespace":       { sev: "error", msg: "courseStructure xmlns must be https://w3id.org/xapi/profiles/cmi5/v1" },
  "course-missing":           { sev: "error", msg: "<course> element missing" },
  "course-no-id":             { sev: "error", msg: "<course id=...> missing or empty" },
  "course-id-not-iri":        { sev: "error", msg: "<course id=...> must be an IRI (https://... or urn:...)" },
  "course-no-title":          { sev: "error", msg: "<course> must contain at least one <title><langstring/></title>" },
  "au-none":                  { sev: "error", msg: "no <au> (Assignable Unit) found" },
  "au-no-id":                 { sev: "error", msg: "<au id=...> missing or empty" },
  "au-id-not-iri":            { sev: "error", msg: "<au id=...> must be an IRI" },
  "au-no-launchmethod":       { sev: "error", msg: "<au launchMethod=...> required" },
  "au-bad-launchmethod":      { sev: "error", msg: "launchMethod must be OwnWindow or AnyWindow" },
  "au-no-moveon":             { sev: "error", msg: "<au moveOn=...> required" },
  "au-bad-moveon":            { sev: "error", msg: "moveOn must be Passed | Completed | CompletedAndPassed | CompletedOrPassed | NotApplicable" },
  "au-no-url":                { sev: "error", msg: "<au> must contain <url> element" },
  "au-url-not-found":         { sev: "error", msg: "<au> launch URL does not resolve inside the package" },
  "au-no-title":              { sev: "error", msg: "<au> must contain at least one <title><langstring/></title>" },
  "au-mastery-out-of-range":  { sev: "error", msg: "masteryScore must be between 0.0 and 1.0" },
  "au-activity-type-not-iri": { sev: "error", msg: "activityType must be an IRI" },

  // interop / style (warnings — lint only)
  "lint-id-duplicate":        { sev: "error", msg: "duplicate id within course structure (must be unique)" },
  "lint-url-duplicate":       { sev: "warn",  msg: "two AUs share the same launch URL" },
  "lint-no-en-title":         { sev: "warn",  msg: "no 'en' langstring on title — many LMSs default to en and will show blank" },
  "lint-no-description":      { sev: "info",  msg: "no <description> on this element (recommended for LMS catalogues)" },
  "lint-duration-not-iso":    { sev: "warn",  msg: "duration is not ISO-8601 (e.g. PT15M)" },
  "lint-extension-bad-iri":   { sev: "warn",  msg: "extension key should be a resolvable https:// IRI" },
  "lint-waived-without-mco":  { sev: "warn",  msg: "waivedMoveOnConditions ignored unless moveOn is CompletedAndPassed or CompletedOrPassed" },
};

var LAUNCH_METHODS = new Set(["OwnWindow", "AnyWindow"]);
var MOVE_ON_VALUES = new Set(["Passed", "Completed", "CompletedAndPassed", "CompletedOrPassed", "NotApplicable"]);
var CMI5_NS = "https://w3id.org/xapi/profiles/cmi5/v1";

// ---------- arg parsing ----------------------------------------------------

var USAGE = [
  "Usage: scorm-kit cmi5 <validate|lint|convert> <package> [options]",
  "",
  "Commands:",
  "  validate <package>            structural validation (errors only)",
  "  lint     <package>            validate + interop / style warnings",
  "  convert  <scorm.zip>          wrap a SCORM 1.2 package as cmi5",
  "",
  "Options:",
  "  --out <path>                  output path (convert only)",
  "  --json                        emit findings as JSON",
  "  --no-info                     suppress info findings",
  "  --no-color                    plain output",
  "",
  "Exit codes: 0 = clean, 1 = warnings, 2 = errors.",
].join("\n");

function usage(code) {
  if (code === 0) { console.log(USAGE); process.exit(0); }
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv) {
  var args = argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") usage(0);
  var mode = args.shift();
  if (mode !== "validate" && mode !== "lint" && mode !== "convert") {
    console.error("cmi5: unknown mode '" + mode + "'");
    usage(2);
  }
  var pkg = null, out = null, json = false, infoOff = false, color = true;
  for (var i = 0; i < args.length; i++) {
    var a = args[i];
    if (a === "--out") out = args[++i];
    else if (a === "--json") json = true;
    else if (a === "--no-info") infoOff = true;
    else if (a === "--no-color") color = false;
    else if (a === "-h" || a === "--help") usage(0);
    else if (a[0] === "-") { console.error("unknown flag: " + a); usage(2); }
    else if (pkg === null) pkg = a;
    else { console.error("unexpected arg: " + a); usage(2); }
  }
  if (!pkg) { console.error("cmi5: package required"); usage(2); }
  if (mode === "convert" && !out) out = pkg.replace(/\.zip$/i, "") + "-cmi5.zip";
  return { mode: mode, pkg: pkg, out: out, json: json, infoOff: infoOff, color: color };
}

// ---------- io helpers -----------------------------------------------------

function unzipToTemp(zipPath, tag) {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scorm-cmi5-" + (tag || "") + "-"));
  var r = spawnSync("unzip", ["-q", "-o", zipPath, "-d", tmp]);
  if (r.status !== 0) throw new Error("unzip: " + r.stderr.toString());
  return tmp;
}

function walk(dir, acc, base) {
  acc = acc || [];
  base = base || dir;
  for (var name of fs.readdirSync(dir)) {
    var p = path.join(dir, name);
    var st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc, base);
    else acc.push(path.relative(base, p));
  }
  return acc;
}

function find(rule, line, detail) {
  return { rule: rule, sev: RULES[rule].sev, msg: RULES[rule].msg, line: line || 0, detail: detail || "" };
}

// ---------- tiny XML reader ------------------------------------------------
//
// cmi5.xml is small (<10KB typical) and the schema is shallow. A regex-based
// reader is enough — and avoids the dep tree of a full XML parser. We
// extract: root element name+attrs, every <course>, every <au>, every
// <title><langstring lang="..">..</langstring></title>, every <url>, and
// every attribute on each <au>.

function readXml(text) {
  // Reject if not well-formed (very loose check — unbalanced tags only)
  // We don't try to be a real validator; the well-formedness check below
  // catches the common copy/paste failures.
  var openCount = (text.match(/<[a-zA-Z][^!?>]*[^/]>/g) || []).length;
  var closeCount = (text.match(/<\/[a-zA-Z][^>]*>/g) || []).length;
  var selfCount = (text.match(/<[a-zA-Z][^>]*\/>/g) || []).length;
  if (openCount !== closeCount) {
    return { ok: false, reason: "unbalanced tags (open=" + openCount + " close=" + closeCount + ")" };
  }
  return { ok: true, text: text, selfCount: selfCount };
}

function rootEl(text) {
  var m = text.match(/<([a-zA-Z][\w:\-]*)\b([^>]*)>/);
  if (!m) return null;
  return { name: m[1], attrs: parseAttrs(m[2]), index: m.index };
}

function parseAttrs(s) {
  var out = {};
  var re = /\b([\w:\-]+)\s*=\s*"([^"]*)"/g;
  var m;
  while ((m = re.exec(s)) !== null) out[m[1]] = m[2];
  return out;
}

// Extract repeated nested elements by tag name, returning text slice + attrs.
function elements(text, tag) {
  var out = [];
  var re = new RegExp("<" + tag + "\\b([^>]*)>([\\s\\S]*?)<\\/" + tag + ">", "g");
  var m;
  while ((m = re.exec(text)) !== null) {
    out.push({ attrs: parseAttrs(m[1]), inner: m[2], outer: m[0], index: m.index });
  }
  // also pick up self-closing (e.g. <au id="x" launchMethod="..."/>) — rare for AUs but legal
  re = new RegExp("<" + tag + "\\b([^>]*)\\/>", "g");
  while ((m = re.exec(text)) !== null) {
    out.push({ attrs: parseAttrs(m[1]), inner: "", outer: m[0], index: m.index });
  }
  return out;
}

function firstText(text, tag) {
  var m = text.match(new RegExp("<" + tag + "\\b[^>]*>([\\s\\S]*?)<\\/" + tag + ">"));
  return m ? m[1].trim() : null;
}

function langstrings(inner) {
  // <title><langstring lang="en">..</langstring><langstring lang="fr">..</langstring></title>
  // or <description>...</description>
  var out = [];
  var re = /<langstring\b([^>]*)>([\s\S]*?)<\/langstring>/g;
  var m;
  while ((m = re.exec(inner)) !== null) {
    var attrs = parseAttrs(m[1]);
    out.push({ lang: attrs.lang || "", text: m[2].trim() });
  }
  return out;
}

function lineOf(text, idx) {
  var n = 1;
  for (var i = 0; i < idx && i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}

// ---------- IRI / format checks -------------------------------------------

function isIri(s) {
  if (!s) return false;
  return /^(https?:\/\/|urn:)\S+$/i.test(s);
}

function isIsoDuration(s) {
  // ISO-8601 P[n]Y[n]M[n]DT[n]H[n]M[n]S
  return /^P(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/.test(s);
}

// ---------- validate / lint ------------------------------------------------

function auditCmi5(rootDir, opts) {
  opts = opts || {};
  var findings = [];
  var cmi5Path = path.join(rootDir, "cmi5.xml");
  if (!fs.existsSync(cmi5Path)) {
    findings.push(find("cmi5-missing"));
    return findings;
  }
  var text = fs.readFileSync(cmi5Path, "utf8");
  var parsed = readXml(text);
  if (!parsed.ok) {
    findings.push(find("cmi5-bad-xml", 0, parsed.reason));
    return findings;
  }
  var root = rootEl(text);
  if (!root || root.name !== "courseStructure") {
    findings.push(find("cmi5-bad-root", root ? lineOf(text, root.index) : 0,
      root ? root.name : "<no root>"));
    return findings;
  }
  if (root.attrs.xmlns && root.attrs.xmlns !== CMI5_NS) {
    findings.push(find("cmi5-bad-namespace", lineOf(text, root.index), root.attrs.xmlns));
  }

  // course
  var courses = elements(text, "course");
  if (courses.length === 0) {
    findings.push(find("course-missing"));
  } else {
    var c = courses[0];
    if (!c.attrs.id) {
      findings.push(find("course-no-id", lineOf(text, c.index)));
    } else if (!isIri(c.attrs.id)) {
      findings.push(find("course-id-not-iri", lineOf(text, c.index), c.attrs.id));
    }
    var cTitle = firstText(c.inner, "title");
    if (!cTitle || langstrings(cTitle).length === 0) {
      findings.push(find("course-no-title", lineOf(text, c.index)));
    } else if (opts.lint) {
      var hasEn = langstrings(cTitle).some(function (l) { return l.lang === "en" || /^en[-_]/.test(l.lang); });
      if (!hasEn) findings.push(find("lint-no-en-title", lineOf(text, c.index), "course"));
    }
    if (opts.lint) {
      var cDesc = firstText(c.inner, "description");
      if (!cDesc) findings.push(find("lint-no-description", lineOf(text, c.index), "course"));
    }
  }

  // AUs
  var aus = elements(text, "au");
  if (aus.length === 0) {
    findings.push(find("au-none"));
  }

  // package files for URL resolution
  var allFiles = walk(rootDir).map(function (p) { return p.replace(/\\/g, "/"); });
  var fileSet = new Set(allFiles);

  var seenIds = new Set();
  var seenUrls = new Set();

  aus.forEach(function (au) {
    var line = lineOf(text, au.index);

    // id
    if (!au.attrs.id) findings.push(find("au-no-id", line));
    else {
      if (!isIri(au.attrs.id)) findings.push(find("au-id-not-iri", line, au.attrs.id));
      if (opts.lint) {
        if (seenIds.has(au.attrs.id)) findings.push(find("lint-id-duplicate", line, au.attrs.id));
        seenIds.add(au.attrs.id);
      }
    }

    // launchMethod
    if (!au.attrs.launchMethod) findings.push(find("au-no-launchmethod", line));
    else if (!LAUNCH_METHODS.has(au.attrs.launchMethod)) {
      findings.push(find("au-bad-launchmethod", line, au.attrs.launchMethod));
    }

    // moveOn
    if (!au.attrs.moveOn) findings.push(find("au-no-moveon", line));
    else if (!MOVE_ON_VALUES.has(au.attrs.moveOn)) {
      findings.push(find("au-bad-moveon", line, au.attrs.moveOn));
    }

    // masteryScore
    if (au.attrs.masteryScore != null && au.attrs.masteryScore !== "") {
      var s = parseFloat(au.attrs.masteryScore);
      if (isNaN(s) || s < 0 || s > 1) {
        findings.push(find("au-mastery-out-of-range", line, au.attrs.masteryScore));
      }
    }

    // activityType
    if (au.attrs.activityType && !isIri(au.attrs.activityType)) {
      findings.push(find("au-activity-type-not-iri", line, au.attrs.activityType));
    }

    // url
    var url = firstText(au.inner, "url");
    if (!url) {
      findings.push(find("au-no-url", line));
    } else {
      // strip query/fragment, normalise
      var cleanUrl = url.split("?")[0].split("#")[0].replace(/^\.\//, "");
      if (!/^https?:\/\//i.test(cleanUrl) && !fileSet.has(cleanUrl)) {
        findings.push(find("au-url-not-found", line, url));
      }
      if (opts.lint) {
        if (seenUrls.has(cleanUrl)) findings.push(find("lint-url-duplicate", line, cleanUrl));
        seenUrls.add(cleanUrl);
      }
    }

    // title langstring(s)
    var auTitle = firstText(au.inner, "title");
    if (!auTitle || langstrings(auTitle).length === 0) {
      findings.push(find("au-no-title", line));
    } else if (opts.lint) {
      var hasEnAu = langstrings(auTitle).some(function (l) {
        return l.lang === "en" || /^en[-_]/.test(l.lang);
      });
      if (!hasEnAu) findings.push(find("lint-no-en-title", line, "au"));
    }

    if (opts.lint) {
      var auDesc = firstText(au.inner, "description");
      if (!auDesc) findings.push(find("lint-no-description", line, "au"));
    }

    // duration (optional, but if present must be ISO-8601)
    if (opts.lint && au.attrs.duration && !isIsoDuration(au.attrs.duration)) {
      findings.push(find("lint-duration-not-iso", line, au.attrs.duration));
    }

    // waivedMoveOnConditions only meaningful with CompletedAndPassed / CompletedOrPassed
    if (opts.lint && au.attrs.waivedMoveOnConditions
        && au.attrs.moveOn && au.attrs.moveOn !== "CompletedAndPassed"
        && au.attrs.moveOn !== "CompletedOrPassed") {
      findings.push(find("lint-waived-without-mco", line, au.attrs.moveOn));
    }
  });

  // extensions (lint only)
  if (opts.lint) {
    var extRe = /<extension\b([^>]*)>/g;
    var m;
    while ((m = extRe.exec(text)) !== null) {
      var k = parseAttrs(m[1]).key || "";
      if (k && !isIri(k)) {
        findings.push(find("lint-extension-bad-iri", lineOf(text, m.index), k));
      }
    }
  }

  return findings;
}

// ---------- convert: SCORM 1.2 → cmi5 wrapper ------------------------------

function convertScormToCmi5(srcZip, dstZip) {
  // 1. unzip the SCORM package
  var src = unzipToTemp(srcZip, "src");
  // 2. find the launch HTML (imsmanifest.xml → resource[adlcp:scormtype="sco"]/@href)
  var manifestPath = path.join(src, "imsmanifest.xml");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("source has no imsmanifest.xml — not a SCORM 1.2 package");
  }
  var manifest = fs.readFileSync(manifestPath, "utf8");
  // crude: first resource href that ends in .html
  var hrefMatch = manifest.match(/href\s*=\s*"([^"]+\.html?)"/i);
  if (!hrefMatch) throw new Error("could not locate SCO launch HTML in imsmanifest.xml");
  var launchHref = hrefMatch[1];

  // title from manifest
  var titleMatch = manifest.match(/<title>\s*([\s\S]*?)\s*<\/title>/i);
  var title = titleMatch ? titleMatch[1].trim() : path.basename(srcZip, path.extname(srcZip));

  // organisation identifier becomes the courseId (best-effort)
  var orgMatch = manifest.match(/<organization\b[^>]*identifier\s*=\s*"([^"]+)"/i);
  var orgId = orgMatch ? orgMatch[1] : ("scorm-" + Date.now());
  var courseIri = "urn:scorm:" + orgId.replace(/[^a-zA-Z0-9\-._]/g, "-");
  var auIri = courseIri + ":au:1";

  // 3. write cmi5.xml
  var cmi5Xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1">',
    '  <course id="' + xmlEscape(courseIri) + '">',
    '    <title><langstring lang="en">' + xmlEscape(title) + '</langstring></title>',
    '    <description><langstring lang="en">SCORM 1.2 package wrapped as cmi5 (dual-stream).</langstring></description>',
    '  </course>',
    '  <au id="' + xmlEscape(auIri) + '" moveOn="CompletedOrPassed" launchMethod="AnyWindow">',
    '    <title><langstring lang="en">' + xmlEscape(title) + '</langstring></title>',
    '    <url>' + xmlEscape(launchHref) + '</url>',
    '  </au>',
    '</courseStructure>',
    '',
  ].join("\n");
  fs.writeFileSync(path.join(src, "cmi5.xml"), cmi5Xml);

  // 4. re-zip into destination
  var absDst = path.resolve(dstZip);
  try { fs.unlinkSync(absDst); } catch (e) {}
  var r = spawnSync("zip", ["-qr", absDst, "."], { cwd: src });
  if (r.status !== 0) throw new Error("zip: " + r.stderr.toString());

  // 5. clean up
  try { execSync('rm -rf "' + src + '"'); } catch (e) {}

  return { courseId: courseIri, auId: auIri, launchHref: launchHref, title: title };
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------- report ---------------------------------------------------------

function color(s, code, on) { return on ? "\x1b[" + code + "m" + s + "\x1b[0m" : s; }

function report(findings, opts) {
  if (opts.json) {
    var counts = { error: 0, warn: 0, info: 0 };
    findings.forEach(function (f) { counts[f.sev]++; });
    console.log(JSON.stringify({
      ok: counts.error === 0,
      counts: counts,
      findings: findings.map(function (f) {
        return { rule: f.rule, sev: f.sev, msg: f.msg, line: f.line, detail: f.detail };
      }),
    }, null, 2));
    return;
  }
  if (findings.length === 0) {
    console.log(color("✓ cmi5.xml is valid (no findings)", "32", opts.color));
    return;
  }
  var groups = { error: [], warn: [], info: [] };
  findings.forEach(function (f) { groups[f.sev].push(f); });
  ["error", "warn", "info"].forEach(function (sev) {
    if (groups[sev].length === 0) return;
    var head = sev.toUpperCase() + " (" + groups[sev].length + ")";
    console.log("\n" + color(head, sev === "error" ? "31" : sev === "warn" ? "33" : "36", opts.color));
    groups[sev].forEach(function (f) {
      var loc = f.line ? "cmi5.xml:" + f.line : "cmi5.xml";
      var det = f.detail ? "  [" + f.detail + "]" : "";
      console.log("  " + f.rule.padEnd(28) + " " + loc.padEnd(16) + " " + f.msg + det);
    });
  });
  var errs = groups.error.length, warns = groups.warn.length;
  console.log("\n" + errs + " errors, " + warns + " warnings, " + groups.info.length + " info");
}

// ---------- main -----------------------------------------------------------

function main() {
  var opts = parseArgs(process.argv);
  var root, cleanup = function () {};

  if (opts.mode === "convert") {
    try {
      var info = convertScormToCmi5(opts.pkg, opts.out);
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, out: opts.out, info: info }, null, 2));
      } else {
        console.log(color("✓ wrote cmi5 package", "32", opts.color) + "  " + opts.out);
        console.log("  course id: " + info.courseId);
        console.log("  au id:     " + info.auId);
        console.log("  launch:    " + info.launchHref);
      }
      process.exit(0);
    } catch (e) {
      console.error("convert failed: " + e.message);
      process.exit(2);
    }
  }

  try {
    if (fs.statSync(opts.pkg).isDirectory()) {
      root = opts.pkg;
    } else {
      root = unzipToTemp(opts.pkg);
      cleanup = function () { try { execSync('rm -rf "' + root + '"'); } catch (e) {} };
    }
  } catch (e) {
    console.error("cannot read package: " + e.message);
    process.exit(2);
  }

  try {
    var findings = auditCmi5(root, { lint: opts.mode === "lint" });
    if (opts.infoOff) findings = findings.filter(function (f) { return f.sev !== "info"; });
    report(findings, opts);
    var anyErr = findings.some(function (f) { return f.sev === "error"; });
    var anyWarn = findings.some(function (f) { return f.sev === "warn"; });
    process.exit(anyErr ? 2 : anyWarn ? 1 : 0);
  } finally {
    cleanup();
  }
}

if (require.main === module) main();

module.exports = { auditCmi5: auditCmi5, convertScormToCmi5: convertScormToCmi5, RULES: RULES };
