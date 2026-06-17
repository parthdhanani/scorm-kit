#!/usr/bin/env node
/*
 * scorm-diff — structured diff between two SCORM 1.2 packages.
 *
 *   scorm-diff before.zip after.zip
 *   scorm-diff before.zip after.zip --json
 *
 * Output sections:
 *   - Manifest changes (parsed: identifier, title, masteryscore, schema, …)
 *   - Asset list (added, removed, modified)
 *   - Per-file detail:
 *       text files (HTML/CSS/JS/JSON/XML/VTT) → unified line diff
 *       binary files                          → size + sha256 change
 *
 * Use it for content PR review (treat SCORM as a reviewable diff, not a
 * binary blob) or in CI to gate large unintended changes.
 *
 * Exit codes: 0 = no changes, 1 = changes present, 2 = error.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var os = require("os");
var crypto = require("crypto");
var { spawnSync } = require("child_process");
var verifyConfinement = require("../confine");

// ---------- args -----------------------------------------------------------

function parseArgs(argv) {
  var a = {
    before: "", after: "", json: false, noColor: false,
    maxTextDiffKB: 256, maxDiffLines: 200,
  };
  for (var i = 0; i < argv.length; i++) {
    var k = argv[i];
    if (k === "--json") a.json = true;
    else if (k === "--no-color") a.noColor = true;
    else if (k === "--max-text-kb") a.maxTextDiffKB = +argv[++i];
    else if (k === "--max-diff-lines") a.maxDiffLines = +argv[++i];
    else if (k === "-h" || k === "--help") { usage(); process.exit(0); }
    else if (k[0] === "-") { console.error("Unknown flag: " + k); process.exit(2); }
    else if (!a.before) a.before = k;
    else if (!a.after) a.after = k;
    else { console.error("Unexpected arg: " + k); process.exit(2); }
  }
  if (!a.before || !a.after) { usage(); process.exit(2); }
  return a;
}
function usage() {
  console.error("Usage: scorm-diff <before.zip|dir> <after.zip|dir> [options]");
  console.error("  --json                  emit JSON");
  console.error("  --no-color              disable ANSI colors");
  console.error("  --max-text-kb N         skip line-diff on text files > N KB (default 256)");
  console.error("  --max-diff-lines N      truncate per-file diff to N lines (default 200)");
}

// ---------- unpacking ------------------------------------------------------

function unpack(input) {
  var st = fs.statSync(input);
  if (st.isDirectory()) return { root: path.resolve(input), cleanup: function () {} };
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scorm-diff-"));
  var r = spawnSync("unzip", ["-q", "-o", input, "-d", tmp]);
  if (r.status !== 0) throw new Error("unzip " + input + ": " + r.stderr.toString());
  verifyConfinement(tmp);
  return { root: tmp, cleanup: function () { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} } };
}

function walk(dir, acc, prefix) {
  acc = acc || []; prefix = prefix || "";
  for (var name of fs.readdirSync(dir)) {
    var p = path.join(dir, name);
    var rel = prefix ? prefix + "/" + name : name;
    var st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc, rel);
    else acc.push({ rel: rel, abs: p, size: st.size });
  }
  return acc;
}

// ---------- manifest parsing -----------------------------------------------

function parseManifest(root) {
  var p = path.join(root, "imsmanifest.xml");
  if (!fs.existsSync(p)) return null;
  var xml = fs.readFileSync(p, "utf8");
  function pluck(re) { var m = re.exec(xml); return m ? m[1].trim() : null; }
  return {
    identifier: pluck(/<manifest\b[^>]*\bidentifier\s*=\s*["']([^"']+)["']/i),
    version: pluck(/<manifest\b[^>]*\bversion\s*=\s*["']([^"']+)["']/i),
    schema: pluck(/<schema>\s*([^<]+?)\s*<\/schema>/i),
    schemaversion: pluck(/<schemaversion>\s*([^<]+?)\s*<\/schemaversion>/i),
    title: pluck(/<title>\s*([^<]+?)\s*<\/title>/i),
    masteryscore: pluck(/<adlcp:masteryscore>\s*([^<]+?)\s*<\/adlcp:masteryscore>/i),
    launchHref: pluck(/<resource\b[^>]*\bscormtype\s*=\s*["']sco["'][^>]*\bhref\s*=\s*["']([^"']+)["']/i)
             || pluck(/<resource\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\bscormtype\s*=\s*["']sco["']/i)
             || pluck(/<resource\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i),
  };
}

function diffManifest(a, b) {
  var out = [];
  if (!a && !b) return out;
  if (!a) return [{ kind: "added", key: "manifest", value: "(no manifest before)" }];
  if (!b) return [{ kind: "removed", key: "manifest", value: "(no manifest after)" }];
  var keys = Object.keys(a).concat(Object.keys(b))
    .filter(function (k, i, arr) { return arr.indexOf(k) === i; });
  keys.sort();
  keys.forEach(function (k) {
    var x = a[k], y = b[k];
    if (x === y) return;
    if (x == null) out.push({ kind: "added", key: k, value: y });
    else if (y == null) out.push({ kind: "removed", key: k, value: x });
    else out.push({ kind: "changed", key: k, before: x, after: y });
  });
  return out;
}

// ---------- file hashing + classification ---------------------------------

var TEXT_EXT = new Set([".html", ".htm", ".css", ".js", ".json", ".xml", ".vtt", ".txt", ".md", ".srt"]);
function isText(rel) { return TEXT_EXT.has(path.extname(rel).toLowerCase()); }

function sha256(absPath) {
  var h = crypto.createHash("sha256");
  h.update(fs.readFileSync(absPath));
  return h.digest("hex");
}

function indexFiles(root) {
  var files = walk(root);
  // Manifest is reported in its own section.
  files = files.filter(function (f) { return f.rel !== "imsmanifest.xml"; });
  var byRel = new Map();
  files.forEach(function (f) {
    f.hash = sha256(f.abs);
    byRel.set(f.rel, f);
  });
  return byRel;
}

// ---------- text diff (shell out to `diff -u`) ----------------------------

function unifiedDiff(beforePath, afterPath, maxLines) {
  var r = spawnSync("diff", ["-u", "--label", "before", "--label", "after", beforePath, afterPath]);
  // diff exit code is 1 when files differ (not an error), 2 on real errors.
  if (r.status === 2) return ["(diff failed: " + r.stderr.toString().trim() + ")"];
  var text = r.stdout.toString();
  if (!text) {
    // Content hash differed but unified diff is empty — usually BOM, line
    // endings, or trailing-newline changes. Surface this instead of silently
    // showing nothing under the "modified" header.
    return ["(no line-level changes — likely encoding / line-ending / trailing-newline only)"];
  }
  var lines = text.split("\n");
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines).concat(["… (" + (text.split("\n").length - maxLines) + " more lines truncated)"]);
  }
  return lines;
}

// ---------- core diff ----------------------------------------------------

function compareAssets(aMap, bMap, args) {
  var changes = { added: [], removed: [], modified: [] };
  bMap.forEach(function (bf, rel) {
    var af = aMap.get(rel);
    if (!af) { changes.added.push({ rel: rel, size: bf.size }); return; }
    if (af.hash === bf.hash) return; // unchanged
    var mod = {
      rel: rel,
      beforeSize: af.size,
      afterSize: bf.size,
      beforeHash: af.hash.slice(0, 12),
      afterHash: bf.hash.slice(0, 12),
      text: isText(rel),
      diff: null,
    };
    if (mod.text && af.size <= args.maxTextDiffKB * 1024 && bf.size <= args.maxTextDiffKB * 1024) {
      mod.diff = unifiedDiff(af.abs, bf.abs, args.maxDiffLines);
    }
    changes.modified.push(mod);
  });
  aMap.forEach(function (af, rel) {
    if (!bMap.has(rel)) changes.removed.push({ rel: rel, size: af.size });
  });
  return changes;
}

// ---------- rendering ----------------------------------------------------

function color(s, code, on) { return on ? "\x1b[" + code + "m" + s + "\x1b[0m" : s; }
function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function renderText(report, useColor) {
  var out = [];
  // Manifest
  if (report.manifest.length) {
    out.push(color("=== Manifest ===", 1, useColor));
    report.manifest.forEach(function (m) {
      if (m.kind === "added")
        out.push(color("+ " + m.key + ": " + JSON.stringify(m.value), 32, useColor));
      else if (m.kind === "removed")
        out.push(color("- " + m.key + ": " + JSON.stringify(m.value), 31, useColor));
      else
        out.push(color("~ " + m.key + ": ", 33, useColor) +
                 JSON.stringify(m.before) + " → " + JSON.stringify(m.after));
    });
    out.push("");
  }
  // Assets
  var a = report.assets;
  if (a.added.length + a.removed.length + a.modified.length > 0) {
    out.push(color("=== Assets ===", 1, useColor));
    a.added.forEach(function (f) {
      out.push(color("+ " + f.rel.padEnd(40), 32, useColor) + "  " + fmtSize(f.size));
    });
    a.removed.forEach(function (f) {
      out.push(color("- " + f.rel.padEnd(40), 31, useColor) + "  " + fmtSize(f.size));
    });
    a.modified.forEach(function (f) {
      var sizeNote = (f.beforeSize === f.afterSize)
        ? fmtSize(f.afterSize)
        : fmtSize(f.beforeSize) + " → " + fmtSize(f.afterSize);
      var hashNote = " (" + f.beforeHash + " → " + f.afterHash + ")";
      out.push(color("~ " + f.rel.padEnd(40), 33, useColor) + "  " + sizeNote + hashNote);
      if (f.diff && f.diff.length > 0) {
        f.diff.forEach(function (line) {
          var c = line.startsWith("+") && !line.startsWith("+++") ? 32 :
                  line.startsWith("-") && !line.startsWith("---") ? 31 :
                  line.startsWith("@@") ? 36 : 0;
          out.push("    " + color(line, c, useColor));
        });
      }
    });
    out.push("");
  }
  // Summary
  out.push(color("=== Summary ===", 1, useColor));
  out.push("Manifest: " + report.manifest.length + " change(s)");
  out.push("Assets:   " + a.added.length + " added, " + a.removed.length + " removed, " + a.modified.length + " modified");
  return out.join("\n");
}

// ---------- main ---------------------------------------------------------

function main() {
  var args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.before)) { console.error("Not found: " + args.before); process.exit(2); }
  if (!fs.existsSync(args.after)) { console.error("Not found: " + args.after); process.exit(2); }

  var aBox = unpack(args.before), bBox = unpack(args.after);
  try {
    var manifestDiff = diffManifest(parseManifest(aBox.root), parseManifest(bBox.root));
    var assetDiff = compareAssets(indexFiles(aBox.root), indexFiles(bBox.root), args);
    var report = { manifest: manifestDiff, assets: assetDiff };

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      var useColor = !args.noColor && process.stdout.isTTY;
      console.log(renderText(report, useColor));
    }
    var changed = manifestDiff.length + assetDiff.added.length + assetDiff.removed.length + assetDiff.modified.length;
    process.exit(changed > 0 ? 1 : 0);
  } finally {
    aBox.cleanup(); bBox.cleanup();
  }
}

main();
