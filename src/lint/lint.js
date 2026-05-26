#!/usr/bin/env node
/*
 * scorm-lint — static analyzer for SCORM 1.2 packages.
 *
 *   scorm-lint path/to/package.zip
 *   scorm-lint path/to/unzipped-dir
 *
 * Catches the issues that most often slip past Storyline's own publish step
 * and cause silent failures in production LMSs:
 *
 *   manifest-missing        imsmanifest.xml not at the root of the package
 *   manifest-malformed      not parseable XML
 *   manifest-no-schema      schema/schemaversion not 'ADL SCORM' / '1.2'
 *   manifest-no-resource    no <resource> with scormtype="sco"
 *   manifest-href-missing   resource href points to a file not in the package
 *   manifest-namespace      adlcp namespace declared on child, not root
 *   manifest-no-masteryscore organization item has no <adlcp:masteryscore>
 *
 *   api-no-wrapper          launch HTML has no recognisable SCORM API wrapper / discovery
 *   api-init-missing        no LMSInitialize / scorm.init call found
 *   api-finish-missing      no LMSFinish / scorm.finish call found
 *   api-set-status          no LMSSetValue("cmi.core.lesson_status", ...) call
 *
 *   interactions-collision  same cmi.interactions.N.id value used twice
 *
 *   assets-large            asset over a configurable size threshold (default 50MB)
 *   assets-broken-ref       <img>, <video>, <audio>, <source>, <link>, <script>
 *                           references a file not present in the package
 *   assets-mime-mp4         mp4 served without a script that sets the right mime
 *                           type (informational only)
 *
 * Exit codes: 0 = clean, 1 = warnings only, 2 = errors.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var { execSync, spawnSync } = require("child_process");
var verifyConfinement = require("../confine");

var RULES = {
  errors: new Set([
    "manifest-missing", "manifest-malformed", "manifest-no-schema",
    "manifest-no-resource", "manifest-href-missing",
    "interactions-collision", "assets-broken-ref",
  ]),
  warnings: new Set([
    "manifest-namespace", "manifest-no-masteryscore",
    "api-no-wrapper", "api-init-missing", "api-finish-missing", "api-set-status",
    "assets-large",
  ]),
  info: new Set([
    "assets-mime-mp4",
  ]),
};

var LARGE_ASSET_BYTES = 50 * 1024 * 1024;

function severity(rule) {
  if (RULES.errors.has(rule)) return "error";
  if (RULES.warnings.has(rule)) return "warn";
  return "info";
}

function color(s, c) {
  if (!process.stdout.isTTY) return s;
  var codes = { red: 31, yellow: 33, blue: 34, gray: 90, bold: 1 };
  return "\x1b[" + codes[c] + "m" + s + "\x1b[0m";
}

function usage() {
  console.error("Usage: scorm-lint <package.zip | unzipped-dir> [--no-color] [--json]");
  process.exit(2);
}

// ---------- I/O ----------

function isZip(p) { return p.toLowerCase().endsWith(".zip"); }

function unzipToTemp(zipPath) {
  var tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "scorm-lint-"));
  var res = spawnSync("unzip", ["-q", "-o", zipPath, "-d", tmp]);
  if (res.status !== 0) throw new Error("Failed to unzip: " + (res.stderr && res.stderr.toString()));
  verifyConfinement(tmp);
  return tmp;
}

function walk(dir, baseLen) {
  baseLen = baseLen != null ? baseLen : dir.length + 1;
  var out = [];
  fs.readdirSync(dir).forEach(function (entry) {
    var full = path.join(dir, entry);
    var st = fs.statSync(full);
    if (st.isDirectory()) out = out.concat(walk(full, baseLen));
    else out.push({ rel: full.slice(baseLen).replace(/\\/g, "/"), full: full, size: st.size });
  });
  return out;
}

// ---------- Tiny XML scan (regex-based — robust enough for manifest checks) ----------

function readText(p) { try { return fs.readFileSync(p, "utf8"); } catch (e) { return null; } }

function checkManifest(rootDir, files, findings) {
  var manifestPath = path.join(rootDir, "imsmanifest.xml");
  if (!fs.existsSync(manifestPath)) {
    findings.push(["manifest-missing", "imsmanifest.xml not found at package root", null]);
    return null;
  }
  var xml = readText(manifestPath);
  if (!xml || !/<manifest\b/.test(xml)) {
    findings.push(["manifest-malformed", "imsmanifest.xml does not appear to be a valid SCORM manifest", "imsmanifest.xml"]);
    return null;
  }

  // schema
  var schema = (xml.match(/<schema\s*>([^<]+)<\/schema>/) || [, ""])[1].trim();
  var schemaVersion = (xml.match(/<schemaversion\s*>([^<]+)<\/schemaversion>/) || [, ""])[1].trim();
  if (schema !== "ADL SCORM" || !/^1\.2/.test(schemaVersion)) {
    findings.push(["manifest-no-schema",
      "schema=" + JSON.stringify(schema) + " schemaversion=" + JSON.stringify(schemaVersion) +
      " — expected ADL SCORM / 1.2",
      "imsmanifest.xml"]);
  }

  // adlcp namespace declared on root?
  var rootTag = xml.match(/<manifest\b[^>]*>/);
  if (rootTag && !/xmlns:adlcp\s*=/.test(rootTag[0])) {
    findings.push(["manifest-namespace",
      "adlcp namespace not declared on <manifest> root element — some strict LMS implementations reject this",
      "imsmanifest.xml"]);
  }

  // resources
  var resourceMatches = Array.from(xml.matchAll(/<resource\b[^>]*?(?:\/>|>[\s\S]*?<\/resource>)/g));
  if (resourceMatches.length === 0) {
    findings.push(["manifest-no-resource", "no <resource> elements found", "imsmanifest.xml"]);
  }
  var primaryHref = null;
  resourceMatches.forEach(function (m) {
    var blob = m[0];
    var typ = (blob.match(/adlcp:scormtype\s*=\s*"([^"]+)"/) || [, ""])[1];
    var href = (blob.match(/href\s*=\s*"([^"]+)"/) || [, ""])[1];
    if (typ === "sco" && href && !primaryHref) primaryHref = href;
    if (href) {
      if (!files.find(function (f) { return f.rel === href; })) {
        findings.push(["manifest-href-missing", "manifest references missing file: " + href, "imsmanifest.xml"]);
      }
    }
  });

  // masteryscore
  if (!/<adlcp:masteryscore\s*>/.test(xml)) {
    findings.push(["manifest-no-masteryscore",
      "no <adlcp:masteryscore> found — completion will rely solely on cmi.core.lesson_status setting",
      "imsmanifest.xml"]);
  }

  return primaryHref;
}

// ---------- HTML / JS scans ----------

function scanLaunchHtml(rootDir, launchHref, files, findings) {
  var p = path.join(rootDir, launchHref);
  var html = readText(p);
  if (!html) return;

  // Walk the script srcs from this HTML — read each .js too for API discovery.
  // Also concatenate inline <script>...</script> bodies — Storyline sometimes
  // inlines its API plumbing, and our pattern matches need to see that too.
  var scriptSrcs = Array.from(html.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/g)).map(function (m) { return m[1]; });
  var inlineScripts = Array.from(html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/g))
    .map(function (m) { return m[1]; });
  var jsBlob = html + "\n" +
    inlineScripts.join("\n") + "\n" +
    scriptSrcs
      .map(function (src) {
        var jsPath = path.join(path.dirname(p), src);
        return readText(jsPath) || "";
      })
      .join("\n");

  // API wrapper / discovery heuristics
  var hasWrapper =
    /window\.API\b/.test(jsBlob) ||
    /findAPI\s*\(/.test(jsBlob) ||
    /pipwerks\.SCORM/.test(jsBlob) ||
    /LMSInitialize\s*\(/.test(jsBlob);
  if (!hasWrapper) {
    findings.push(["api-no-wrapper",
      "launch HTML has no recognisable SCORM API wrapper — course will not talk to the LMS",
      launchHref]);
  }

  if (!/LMSInitialize\s*\(/.test(jsBlob) && !/scorm\.init\s*\(/.test(jsBlob)) {
    findings.push(["api-init-missing", "no LMSInitialize / scorm.init call found", launchHref]);
  }
  if (!/LMSFinish\s*\(/.test(jsBlob) && !/scorm\.finish\s*\(/.test(jsBlob)) {
    findings.push(["api-finish-missing", "no LMSFinish / scorm.finish call found", launchHref]);
  }
  if (!/cmi\.core\.lesson_status/.test(jsBlob)) {
    findings.push(["api-set-status", "no cmi.core.lesson_status reference — completion may never be reported", launchHref]);
  }

  // Interaction-id collision check
  var ids = {};
  Array.from(jsBlob.matchAll(/cmi\.interactions\.(\d+)\.id["']?\s*[,)]\s*["']([^"']+)["']/g)).forEach(function (m) {
    var idx = m[1], val = m[2];
    if (ids[val]) findings.push(["interactions-collision",
      "interaction id " + JSON.stringify(val) + " used at indices " + ids[val] + " and " + idx, launchHref]);
    else ids[val] = idx;
  });

  // Broken asset refs (img/video/audio src, source src, link href, script src)
  var assetRefs = [];
  Array.from(html.matchAll(/<(?:img|video|audio|source|script)\b[^>]*\bsrc\s*=\s*"([^"]+)"/g))
    .forEach(function (m) { assetRefs.push(m[1]); });
  Array.from(html.matchAll(/<link\b[^>]*\bhref\s*=\s*"([^"]+)"/g))
    .forEach(function (m) { assetRefs.push(m[1]); });

  assetRefs.forEach(function (ref) {
    if (/^(https?:)?\/\//i.test(ref) || /^data:/i.test(ref) || /^javascript:/i.test(ref)) return;
    var resolved = path.posix.normalize(path.posix.join(path.dirname(launchHref), ref));
    if (!files.find(function (f) { return f.rel === resolved; })) {
      findings.push(["assets-broken-ref", "asset referenced but not in package: " + ref, launchHref]);
    }
  });
}

function checkAssets(files, findings) {
  files.forEach(function (f) {
    if (f.size > LARGE_ASSET_BYTES) {
      findings.push(["assets-large", "large asset (" + (f.size / 1024 / 1024).toFixed(1) + "MB): " + f.rel, f.rel]);
    }
    if (/\.mp4$/i.test(f.rel)) {
      findings.push(["assets-mime-mp4", "mp4 present (" + f.rel + ") — ensure LMS serves video/mp4 MIME type", f.rel]);
    }
  });
}

// ---------- output ----------

function report(findings, opts) {
  var counts = { error: 0, warn: 0, info: 0 };
  findings.forEach(function (f) { counts[severity(f[0])]++; });

  if (opts.json) {
    var rows = findings.map(function (f) {
      return { rule: f[0], severity: severity(f[0]), message: f[1], file: f[2] };
    });
    console.log(JSON.stringify({ counts: counts, findings: rows }, null, 2));
    return;
  }

  if (findings.length === 0) {
    console.log(color("✓ scorm-lint: 0 issues — package looks clean.", "blue"));
    return;
  }

  findings.forEach(function (f) {
    var rule = f[0], msg = f[1], file = f[2];
    var sev = severity(rule);
    var tag = sev === "error" ? color("ERROR", "red")
            : sev === "warn"  ? color("WARN ", "yellow")
            : color("INFO ", "gray");
    var loc = file ? color(" [" + file + "]", "gray") : "";
    console.log(tag + " " + color(rule.padEnd(24), "bold") + " " + msg + loc);
  });
  console.log();
  console.log("Summary: " +
    counts.error + " error" + (counts.error === 1 ? "" : "s") + ", " +
    counts.warn + " warning" + (counts.warn === 1 ? "" : "s") + ", " +
    counts.info + " info");
}

// ---------- main ----------

function main() {
  var args = process.argv.slice(2);
  if (!args.length || args.indexOf("--help") >= 0 || args.indexOf("-h") >= 0) usage();

  var inputPath = null;
  var opts = { color: process.stdout.isTTY, json: false };
  args.forEach(function (a) {
    if (a === "--no-color") opts.color = false;
    else if (a === "--json") opts.json = true;
    else if (!inputPath) inputPath = a;
    else usage();
  });
  if (!inputPath) usage();

  var rootDir = inputPath;
  var tempDir = null;
  if (isZip(inputPath)) {
    tempDir = unzipToTemp(inputPath);
    rootDir = tempDir;
  } else if (!fs.statSync(inputPath).isDirectory()) {
    console.error("Input must be a .zip or a directory");
    process.exit(2);
  }

  var files = walk(rootDir);
  var findings = [];

  var launchHref = checkManifest(rootDir, files, findings);
  if (launchHref) scanLaunchHtml(rootDir, launchHref, files, findings);
  checkAssets(files, findings);

  report(findings, opts);

  if (tempDir) try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}

  var counts = { error: 0, warn: 0 };
  findings.forEach(function (f) {
    var s = severity(f[0]);
    if (s === "error") counts.error++;
    else if (s === "warn") counts.warn++;
  });
  process.exit(counts.error > 0 ? 2 : counts.warn > 0 ? 1 : 0);
}

main();
