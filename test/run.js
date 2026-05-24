#!/usr/bin/env node
"use strict";

/*
 * scorm-kit test suite. Plain Node, no test framework.
 *
 *   node test/run.js
 *
 * Each test invokes the scorm-kit CLI as a subprocess against a fixture zip
 * and asserts on exit code + stdout. Fixtures are SCORM packages built by
 * Storycraft; they are byte-stable thanks to Storycraft's deterministic-build
 * fix, so output should match across runs.
 */

var assert = require("assert");
var path = require("path");
var fs = require("fs");
var os = require("os");
var { spawnSync } = require("child_process");

var CLI = path.resolve(__dirname, "../bin/scorm-kit.js");
var FIX = path.resolve(__dirname, "../fixtures");

var ZIP_EN = path.join(FIX, "posh-awareness.zip");
var ZIP_HI = path.join(FIX, "posh-awareness-hi.zip");
var ZIP_2  = path.join(FIX, "the-first-page.zip");

function run(args, opts) {
  opts = opts || {};
  var res = spawnSync(process.execPath, [CLI].concat(args), {
    encoding: "utf8",
    timeout: opts.timeout || 15000,
  });
  return { code: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ---------- dispatcher ----------

test("dispatcher: --help exits 0 and lists all subcommands", function () {
  var r = run(["--help"]);
  assert.strictEqual(r.code, 0);
  ["lint", "a11y", "diff", "i18n", "mock", "rum", "privacy"].forEach(function (cmd) {
    assert.ok(r.stdout.indexOf(cmd) !== -1, "help missing " + cmd);
  });
});

test("dispatcher: no args exits 2 with help text", function () {
  var r = run([]);
  assert.strictEqual(r.code, 2);
  assert.ok(/Usage/.test(r.stdout + r.stderr));
});

test("dispatcher: unknown command exits 2", function () {
  var r = run(["does-not-exist"]);
  assert.strictEqual(r.code, 2);
});

// ---------- lint ----------

test("lint: storycraft-built package is clean", function () {
  var r = run(["lint", ZIP_EN]);
  assert.strictEqual(r.code, 0, "expected 0, got " + r.code + ": " + r.stderr);
  assert.ok(/0 issues/.test(r.stdout));
});

test("lint: --json output is parseable", function () {
  var r = run(["lint", ZIP_EN, "--json"]);
  assert.strictEqual(r.code, 0);
  var data = JSON.parse(r.stdout);
  assert.ok(Array.isArray(data.findings), "findings should be an array");
  assert.ok(data.counts && typeof data.counts.error === "number");
});

test("lint: missing manifest produces error exit 2", function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kit-lint-"));
  fs.writeFileSync(path.join(tmp, "index.html"), "<html></html>");
  var r = run(["lint", tmp]);
  assert.strictEqual(r.code, 2);
  assert.ok(/manifest/i.test(r.stdout));
});

// ---------- a11y ----------

test("a11y: storycraft-built package is WCAG-clean", function () {
  var r = run(["a11y", ZIP_EN]);
  assert.strictEqual(r.code, 0, "expected 0, got " + r.code + ": " + r.stderr);
  assert.ok(/0 error/.test(r.stdout));
});

test("a11y: Hindi build sets lang correctly", function () {
  var r = run(["a11y", ZIP_HI]);
  assert.strictEqual(r.code, 0);
});

test("a11y: HTML without lang produces doc-no-lang", function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kit-a11y-"));
  fs.writeFileSync(path.join(tmp, "imsmanifest.xml"),
    '<?xml version="1.0"?><manifest><resources><resource href="x.html"/></resources></manifest>');
  fs.writeFileSync(path.join(tmp, "x.html"),
    "<html><head><title>x</title></head><body><h1>x</h1></body></html>");
  var r = run(["a11y", tmp]);
  assert.ok(/doc-no-lang/.test(r.stdout), "expected doc-no-lang rule, got: " + r.stdout);
});

// ---------- diff ----------

test("diff: identical packages produce no changes (exit 0)", function () {
  var r = run(["diff", ZIP_EN, ZIP_EN]);
  assert.strictEqual(r.code, 0);
});

test("diff: en vs hi produces manifest + asset changes (exit 1)", function () {
  var r = run(["diff", ZIP_EN, ZIP_HI]);
  assert.strictEqual(r.code, 1);
  assert.ok(/title/i.test(r.stdout), "expected title diff");
});

test("diff: --json output is parseable and structured", function () {
  var r = run(["diff", ZIP_EN, ZIP_HI, "--json"]);
  var data = JSON.parse(r.stdout);
  assert.ok(data.manifest, "json should include manifest section");
  assert.ok(Array.isArray(data.assets) || typeof data.assets === "object",
    "json should include assets section");
});

// ---------- i18n (smoke only — no real strings.json) ----------

test("i18n: --help works without crashing", function () {
  var r = run(["i18n", "--help"]);
  // tool may exit 0 or 2 — we just want it not to throw a stack trace
  assert.ok(!/TypeError|ReferenceError/.test(r.stderr),
    "should not throw: " + r.stderr);
});

test("i18n: missing --strings argument fails gracefully", function () {
  var r = run(["i18n", ZIP_EN]);
  assert.notStrictEqual(r.code, 0);
  assert.ok(!/TypeError|ReferenceError/.test(r.stderr));
});

// ---------- mock (smoke only — don't start an actual server) ----------

test("mock: --help works without binding a port", function () {
  var r = run(["mock", "--help"]);
  assert.ok(!/TypeError|ReferenceError/.test(r.stderr));
});

// ---------- rum (smoke + dry run) ----------

test("rum: missing --endpoint fails gracefully", function () {
  var r = run(["rum", ZIP_EN]);
  assert.notStrictEqual(r.code, 0);
  assert.ok(!/TypeError|ReferenceError/.test(r.stderr));
});

test("rum: --dry-run with endpoint succeeds", function () {
  var r = run(["rum", ZIP_EN, "--endpoint", "https://example.com/ingest", "--dry-run"]);
  // dry-run should not error; either prints a plan or exits 0
  assert.ok(!/TypeError|ReferenceError/.test(r.stderr));
});

// ---------- privacy ----------

test("privacy: storycraft-built package is clean", function () {
  var r = run(["privacy", ZIP_EN]);
  assert.strictEqual(r.code, 0, "expected 0, got " + r.code + ": " + r.stderr);
  assert.ok(/no privacy findings|0 error/.test(r.stdout));
});

test("privacy: --json output is parseable", function () {
  var r = run(["privacy", ZIP_EN, "--json"]);
  assert.strictEqual(r.code, 0);
  var data = JSON.parse(r.stdout);
  assert.ok(Array.isArray(data.findings));
  assert.ok(data.counts && typeof data.counts.error === "number");
});

test("privacy: detects tracker, email, name-into-innerHTML, external form", function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kit-priv-"));
  fs.writeFileSync(path.join(tmp, "imsmanifest.xml"),
    '<?xml version="1.0"?><manifest><resources><resource href="x.html"/></resources></manifest>');
  fs.writeFileSync(path.join(tmp, "x.html"),
    "<html><head><title>x</title>\n" +
    '<script src="https://www.googletagmanager.com/gtag/js?id=GA-X"></script>\n' +
    "</head><body>\n" +
    "<p>contact alice@acme-corp.io</p>\n" +
    '<form action="https://forms.example.org/submit"></form>\n' +
    "<script>document.body.innerHTML = cmi.core.student_name;</script>\n" +
    "</body></html>");
  var r = run(["privacy", tmp, "--json"]);
  assert.strictEqual(r.code, 2, "expected exit 2 for error findings");
  var data = JSON.parse(r.stdout);
  var rules = data.findings.map(function (f) { return f.rule; });
  assert.ok(rules.indexOf("tracker-third-party") !== -1, "missing tracker-third-party: " + rules);
  assert.ok(rules.indexOf("pii-email-literal") !== -1, "missing pii-email-literal: " + rules);
  assert.ok(rules.indexOf("scorm-name-into-innerhtml") !== -1, "missing scorm-name-into-innerhtml: " + rules);
  assert.ok(rules.indexOf("form-action-external") !== -1, "missing form-action-external: " + rules);
});

test("privacy: --allow suppresses external-host findings for allowed hosts", function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kit-priv-allow-"));
  fs.writeFileSync(path.join(tmp, "imsmanifest.xml"),
    '<?xml version="1.0"?><manifest><resources><resource href="x.html"/></resources></manifest>');
  fs.writeFileSync(path.join(tmp, "x.html"),
    '<html><head><title>x</title></head><body>' +
    '<iframe src="https://cdn.example.com/widget"></iframe>' +
    '</body></html>');
  var r = run(["privacy", tmp, "--allow", "cdn.example.com", "--json"]);
  var data = JSON.parse(r.stdout);
  var rules = data.findings.map(function (f) { return f.rule; });
  assert.ok(rules.indexOf("iframe-external") === -1,
    "iframe-external should be suppressed by --allow: " + rules.join(","));
});

test("privacy: detects xAPI plaintext mbox", function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kit-priv-xapi-"));
  fs.writeFileSync(path.join(tmp, "imsmanifest.xml"),
    '<?xml version="1.0"?><manifest><resources><resource href="x.html"/></resources></manifest>');
  fs.writeFileSync(path.join(tmp, "x.html"),
    '<html><head><title>x</title></head><body>' +
    '<script>var actor = { "mbox": "mailto:learner@acme-corp.io" };</script>' +
    '</body></html>');
  var r = run(["privacy", tmp, "--json"]);
  var data = JSON.parse(r.stdout);
  var rules = data.findings.map(function (f) { return f.rule; });
  assert.ok(rules.indexOf("xapi-actor-mbox-plain") !== -1,
    "missing xapi-actor-mbox-plain: " + rules.join(","));
});

// ---------- runner ----------

var pass = 0, fail = 0;
var failures = [];
tests.forEach(function (t) {
  try {
    t.fn();
    pass++;
    console.log("  ✓ " + t.name);
  } catch (e) {
    fail++;
    failures.push({ name: t.name, err: e });
    console.log("  ✗ " + t.name);
  }
});

console.log("\n" + pass + " passed, " + fail + " failed (" + tests.length + " total)");

if (fail > 0) {
  console.log("\nFailures:");
  failures.forEach(function (f) {
    console.log("\n  " + f.name);
    console.log("    " + (f.err.message || f.err));
  });
  process.exit(1);
}
process.exit(0);
