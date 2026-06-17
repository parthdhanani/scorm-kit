#!/usr/bin/env node
/*
 * scorm-rum — inject a Real User Monitoring runtime into a SCORM 1.2 package.
 *
 *   scorm-rum course.zip --endpoint https://rum.example.com/ingest [--token TOKEN]
 *
 * Captures nav timing, resource errors, JS errors, long tasks, and slide
 * transitions. Beacons batched and POSTed to the configured endpoint.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var os = require("os");
var { spawnSync } = require("child_process");
var verifyConfinement = require("../confine");

function parseArgs(argv) {
  var a = { input: "", out: "", endpoint: "", token: "", courseId: "", flushMs: 2000, dryRun: false };
  for (var i = 0; i < argv.length; i++) {
    var k = argv[i];
    if (k === "--out") a.out = argv[++i];
    else if (k === "--endpoint") a.endpoint = argv[++i];
    else if (k === "--token") a.token = argv[++i];
    else if (k === "--course-id") a.courseId = argv[++i];
    else if (k === "--flush-ms") a.flushMs = +argv[++i];
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "-h" || k === "--help") { usage(); process.exit(0); }
    else if (k[0] === "-") { console.error("Unknown flag: " + k); process.exit(2); }
    else if (!a.input) a.input = k;
    else { console.error("Unexpected arg: " + k); process.exit(2); }
  }
  if (!a.input || !a.endpoint) { usage(); process.exit(2); }
  return a;
}
function usage() {
  console.error("Usage: scorm-rum <package.zip|dir> --endpoint URL [options]");
  console.error("  --token T         optional bearer token (Authorization header)");
  console.error("  --course-id ID    course id (default: manifest identifier)");
  console.error("  --flush-ms N      beacon batch interval (default 2000)");
  console.error("  --out PATH        output zip");
}

function unzipToTemp(zipPath) {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scorm-rum-"));
  var r = spawnSync("unzip", ["-q", "-o", zipPath, "-d", tmp]);
  if (r.status !== 0) throw new Error("unzip: " + r.stderr.toString());
  verifyConfinement(tmp);
  return tmp;
}
function zipFromDir(dir, out) {
  if (fs.existsSync(out)) fs.unlinkSync(out);
  var r = spawnSync("zip", ["-qrX", out, "."], { cwd: dir });
  if (r.status !== 0) throw new Error("zip: " + r.stderr.toString());
}
function findLaunchHref(root) {
  var p = path.join(root, "imsmanifest.xml");
  if (!fs.existsSync(p)) return null;
  var xml = fs.readFileSync(p, "utf8");
  var m = /<resource\b[^>]*\bscormtype\s*=\s*["']sco["'][^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(xml);
  if (!m) m = /<resource\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\bscormtype\s*=\s*["']sco["']/i.exec(xml);
  if (!m) m = /<resource\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(xml);
  return m ? m[1] : null;
}
function parseId(root) {
  var p = path.join(root, "imsmanifest.xml");
  if (!fs.existsSync(p)) return "";
  var xml = fs.readFileSync(p, "utf8");
  var m = /<manifest\b[^>]*\bidentifier\s*=\s*["']([^"']+)["']/i.exec(xml);
  return m ? m[1] : "";
}
function injectScripts(html, cfgName, runtimeName) {
  if (/<script\s+[^>]*src=["']scorm-rum\.js["']/i.test(html)) return { html: html, injected: false };
  var tags =
    '<script src="' + cfgName + '"></script>\n' +
    '<script src="' + runtimeName + '"></script>\n';
  if (/<\/head>/i.test(html))
    return { html: html.replace(/<\/head>/i, tags + "</head>"), injected: true };
  // Some HTML omits the closing </head> tag — fall back to the opening one.
  if (/<head\b[^>]*>/i.test(html))
    return { html: html.replace(/<head\b[^>]*>/i, function (m) { return m + "\n" + tags; }), injected: true };
  if (/<html\b[^>]*>/i.test(html))
    return { html: html.replace(/<html\b[^>]*>/i, function (m) { return m + "\n<head>\n" + tags + "</head>"; }), injected: true };
  return { html: tags + html, injected: true };
}

function main() {
  var args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.input)) { console.error("Not found: " + args.input); process.exit(2); }

  var runtimeSrc = path.join(__dirname, "runtime", "rum.js");
  if (!fs.existsSync(runtimeSrc)) { console.error("Runtime missing"); process.exit(2); }

  var isZip = fs.statSync(args.input).isFile();
  var root, cleanup = function () {};
  if (isZip) {
    root = unzipToTemp(args.input);
    cleanup = function () { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {} };
  } else {
    root = path.resolve(args.input);
  }

  try {
    var href = findLaunchHref(root);
    if (!href) { console.error("No launch HTML in manifest."); process.exit(2); }
    var courseId = args.courseId || parseId(root) || "course";
    var launchPath = path.resolve(root, href.split("?")[0]);

    console.log("endpoint: " + args.endpoint);
    console.log("course:   " + courseId);
    console.log("flushMs:  " + args.flushMs);
    if (args.token) console.log("auth:     Bearer (" + args.token.length + " chars)");

    if (args.dryRun) { console.log("(dry-run)"); return; }

    var launchDir = path.dirname(launchPath);
    fs.copyFileSync(runtimeSrc, path.join(launchDir, "scorm-rum.js"));
    fs.writeFileSync(
      path.join(launchDir, "rum-config.js"),
      "window.RUM_CONFIG = " + JSON.stringify({
        endpoint: args.endpoint, token: args.token, courseId: courseId, flushMs: args.flushMs,
      }, null, 2) + ";\n"
    );
    var html = fs.readFileSync(launchPath, "utf8");
    var inj = injectScripts(html, "rum-config.js", "scorm-rum.js");
    if (inj.injected) {
      fs.writeFileSync(launchPath, inj.html);
      console.log("injected  " + path.relative(root, launchPath));
    } else {
      console.log("inject    skipped (already wrapped); config refreshed");
    }
    console.log("copied    scorm-rum.js");
    console.log("wrote     rum-config.js");

    if (isZip) {
      var out = path.resolve(args.out || args.input.replace(/\.zip$/i, "") + "-rum.zip");
      zipFromDir(root, out);
      console.log("\nwrote " + out);
    }
  } finally {
    cleanup();
  }
}
main();
