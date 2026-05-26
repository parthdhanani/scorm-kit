#!/usr/bin/env node
/*
 * scorm-mock-lms — local SCORM 1.2 runtime for testing courses without an LMS.
 *
 *   scorm-mock-lms <package.zip | dir> [--port 8080] [--persist session.json]
 *                                      [--cmi key=value]... [--fail set|init|none]
 *
 * Starts a tiny HTTP server that:
 *   - serves the unpacked SCORM package at /pkg/...
 *   - serves the mock LMS shell at /
 *
 * The shell loads the package's launch HTML in an iframe. The shell window
 * exposes window.API — a full SCORM 1.2 RTE — and records every method call
 * with timestamp, args, return value, and last-error code. The course (in
 * the iframe) walks window.parent looking for `API` and finds the mock.
 *
 * Use it to:
 *   - debug a SCORM package without uploading to Moodle
 *   - inject failures (LMSSetValue returns "false") to test error handling
 *   - export a full session log as JSON for regression tests
 *   - preset CMI values (student_id, completion_status) for resume testing
 */
"use strict";

var fs = require("fs");
var path = require("path");
var os = require("os");
var http = require("http");
var url = require("url");
var { spawnSync, execSync } = require("child_process");
var verifyConfinement = require("../confine");

// ---------- args ----------------------------------------------------------

function parseArgs(argv) {
  var a = { input: "", port: 8080, persist: "", cmi: {}, fail: "none", open: false };
  for (var i = 0; i < argv.length; i++) {
    var k = argv[i];
    if (k === "--port") a.port = +argv[++i];
    else if (k === "--persist") a.persist = argv[++i];
    else if (k === "--cmi") {
      var kv = argv[++i] || "";
      var eq = kv.indexOf("=");
      if (eq < 0) { console.error("--cmi expects key=value"); process.exit(2); }
      a.cmi[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    else if (k === "--fail") a.fail = argv[++i];
    else if (k === "--open") a.open = true;
    else if (k === "-h" || k === "--help") { usage(); process.exit(0); }
    else if (k[0] === "-") { console.error("Unknown flag: " + k); process.exit(2); }
    else if (!a.input) a.input = k;
    else { console.error("Unexpected arg: " + k); process.exit(2); }
  }
  if (!a.input) { usage(); process.exit(2); }
  if (["none", "set", "init", "finish", "commit"].indexOf(a.fail) < 0) {
    console.error("--fail must be one of: none, set, init, finish, commit");
    process.exit(2);
  }
  return a;
}
function usage() {
  console.error("Usage: scorm-mock-lms <package.zip | dir> [options]");
  console.error("  --port N                listen port (default 8080)");
  console.error("  --persist file.json     save session log on Ctrl-C");
  console.error("  --cmi key=value         preset a CMI value (repeatable)");
  console.error("  --fail none|set|init|finish|commit   inject API failure");
  console.error("  --open                  open default browser on start");
}

// ---------- package prep --------------------------------------------------

function unzipToTemp(zipPath) {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scorm-mock-"));
  var r = spawnSync("unzip", ["-q", "-o", zipPath, "-d", tmp]);
  if (r.status !== 0) throw new Error("unzip: " + r.stderr.toString());
  verifyConfinement(tmp);
  return tmp;
}

function findLaunchHref(root) {
  var mPath = path.join(root, "imsmanifest.xml");
  if (!fs.existsSync(mPath)) return null;
  var xml = fs.readFileSync(mPath, "utf8");
  var m = /<resource\b[^>]*\bscormtype\s*=\s*["']sco["'][^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(xml);
  if (!m) m = /<resource\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\bscormtype\s*=\s*["']sco["']/i.exec(xml);
  if (!m) m = /<resource\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(xml);
  return m ? m[1] : null;
}

// ---------- HTTP server ---------------------------------------------------

var MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".webp": "image/webp",
  ".mp4": "video/mp4", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".vtt": "text/vtt", ".xml": "application/xml; charset=utf-8",
  ".woff": "font/woff", ".woff2": "font/woff2",
};

function serveFile(filePath, res) {
  fs.stat(filePath, function (err, st) {
    if (err || !st.isFile()) { res.writeHead(404); return res.end("not found"); }
    var mime = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "content-type": mime, "cache-control": "no-cache" });
    fs.createReadStream(filePath).pipe(res);
  });
}

function safeJoin(base, rel) {
  var resolved = path.resolve(base, "." + (rel.startsWith("/") ? rel : "/" + rel));
  if (resolved !== base && resolved.indexOf(base + path.sep) !== 0) return null;
  return resolved;
}

function startServer(args, packageRoot, launchHref, webDir) {
  var server = http.createServer(function (req, res) {
    var u = url.parse(req.url);
    var p = decodeURIComponent(u.pathname || "/");

    if (p === "/") return serveFile(path.join(webDir, "mock-lms.html"), res);
    if (p === "/config.json") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        // Encode each path segment so a launch href like "story space.html"
        // round-trips correctly through fetch + iframe src.
        launchUrl: "/pkg/" + launchHref.split("/").map(encodeURIComponent).join("/"),
        cmiPresets: args.cmi,
        fail: args.fail,
      }));
    }
    if (p.startsWith("/assets/")) {
      var asset = safeJoin(webDir, p.slice("/assets".length));
      if (!asset) { res.writeHead(403); return res.end("forbidden"); }
      return serveFile(asset, res);
    }
    if (p.startsWith("/pkg/")) {
      var rel = p.slice("/pkg".length);
      var fp = safeJoin(packageRoot, rel);
      if (!fp) { res.writeHead(403); return res.end("forbidden"); }
      return serveFile(fp, res);
    }
    res.writeHead(404); res.end("not found");
  });
  server.listen(args.port, function () {
    console.log("scorm-mock-lms ready  →  http://localhost:" + args.port);
    console.log("  package:  " + packageRoot);
    console.log("  launch:   " + launchHref);
    if (Object.keys(args.cmi).length) console.log("  presets:  " + JSON.stringify(args.cmi));
    if (args.fail !== "none") console.log("  fail:     " + args.fail);
    if (args.open) tryOpen("http://localhost:" + args.port);
    console.log("\nCtrl-C to stop.");
  });
  return server;
}

function tryOpen(target) {
  var cmd = process.platform === "darwin" ? "open" :
            process.platform === "win32" ? "start" : "xdg-open";
  try { spawnSync(cmd, [target], { stdio: "ignore", detached: true }); } catch (e) {}
}

// ---------- main ----------------------------------------------------------

function main() {
  var args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.input)) { console.error("Not found: " + args.input); process.exit(2); }

  var packageRoot, cleanup = function () {};
  var st = fs.statSync(args.input);
  if (st.isFile()) {
    packageRoot = unzipToTemp(args.input);
    cleanup = function () { try { fs.rmSync(packageRoot, { recursive: true, force: true }); } catch (e) {} };
  } else {
    packageRoot = path.resolve(args.input);
  }

  var launchHref = findLaunchHref(packageRoot);
  if (!launchHref) {
    console.error("No launch resource found in imsmanifest.xml.");
    cleanup(); process.exit(2);
  }

  var webDir = path.join(__dirname, "web");
  var server = startServer(args, packageRoot, launchHref, webDir);

  process.on("SIGINT", function () {
    console.log("\nstopping...");
    server.close(function () { cleanup(); process.exit(0); });
    setTimeout(function () { process.exit(0); }, 1000).unref();
  });
}

main();
