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
  ["lint", "a11y", "diff", "i18n", "mock", "rum", "privacy", "cmi5"].forEach(function (cmd) {
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

// ---------- cmi5 ----------

test("cmi5: --help exits 0", function () {
  var r = run(["cmi5", "--help"]);
  assert.strictEqual(r.code, 0);
  assert.ok(/validate.*lint.*convert/s.test(r.stdout));
});

test("cmi5 convert: wraps SCORM package and emits valid cmi5", function () {
  var outZip = path.join(os.tmpdir(), "kit-cmi5-conv-" + process.pid + ".zip");
  try { fs.unlinkSync(outZip); } catch (e) {}
  var r = run(["cmi5", "convert", ZIP_EN, "--out", outZip]);
  assert.strictEqual(r.code, 0, "convert failed: " + r.stderr);
  assert.ok(fs.existsSync(outZip), "cmi5 zip not produced");
  // validate the converted package
  var v = run(["cmi5", "validate", outZip]);
  assert.strictEqual(v.code, 0, "converted package failed validate: " + v.stdout);
  try { fs.unlinkSync(outZip); } catch (e) {}
});

test("cmi5 validate: missing cmi5.xml fires cmi5-missing error", function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kit-cmi5-empty-"));
  fs.writeFileSync(path.join(tmp, "index.html"), "<html></html>");
  var r = run(["cmi5", "validate", tmp, "--json"]);
  assert.strictEqual(r.code, 2);
  var data = JSON.parse(r.stdout);
  assert.strictEqual(data.findings[0].rule, "cmi5-missing");
});

test("cmi5 validate: catches bad launchMethod, bad moveOn, bad IRI, bad masteryScore, missing URL target", function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kit-cmi5-bad-"));
  fs.writeFileSync(path.join(tmp, "cmi5.xml"),
    '<?xml version="1.0"?>\n' +
    '<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1">\n' +
    '  <course id="not-an-iri">\n' +
    '    <title><langstring lang="en">x</langstring></title>\n' +
    '  </course>\n' +
    '  <au id="urn:test:1" launchMethod="Wrong" moveOn="Maybe" masteryScore="2.0">\n' +
    '    <title><langstring lang="en">m</langstring></title>\n' +
    '    <url>missing.html</url>\n' +
    '  </au>\n' +
    '</courseStructure>\n');
  var r = run(["cmi5", "validate", tmp, "--json"]);
  assert.strictEqual(r.code, 2);
  var data = JSON.parse(r.stdout);
  var rules = data.findings.map(function (f) { return f.rule; });
  ["course-id-not-iri", "au-bad-launchmethod", "au-bad-moveon",
   "au-mastery-out-of-range", "au-url-not-found"].forEach(function (rule) {
    assert.ok(rules.indexOf(rule) !== -1, "missing rule " + rule + ": " + rules.join(","));
  });
});

test("cmi5 lint: duplicate AU id fires lint-id-duplicate", function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kit-cmi5-dup-"));
  fs.writeFileSync(path.join(tmp, "x.html"), "<html></html>");
  fs.writeFileSync(path.join(tmp, "cmi5.xml"),
    '<?xml version="1.0"?>\n' +
    '<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1">\n' +
    '  <course id="urn:test:c">\n' +
    '    <title><langstring lang="en">c</langstring></title>\n' +
    '  </course>\n' +
    '  <au id="urn:test:a" launchMethod="AnyWindow" moveOn="Passed">\n' +
    '    <title><langstring lang="en">m</langstring></title>\n' +
    '    <url>x.html</url>\n' +
    '  </au>\n' +
    '  <au id="urn:test:a" launchMethod="AnyWindow" moveOn="Passed">\n' +
    '    <title><langstring lang="en">m2</langstring></title>\n' +
    '    <url>x.html</url>\n' +
    '  </au>\n' +
    '</courseStructure>\n');
  var r = run(["cmi5", "lint", tmp, "--json"]);
  var data = JSON.parse(r.stdout);
  var rules = data.findings.map(function (f) { return f.rule; });
  assert.ok(rules.indexOf("lint-id-duplicate") !== -1, "missing lint-id-duplicate: " + rules.join(","));
});

// ---------- report ----------

test("report: --help exits 0 with usage", function () {
  var r = run(["report", "--help"]);
  assert.strictEqual(r.code, 0);
  assert.ok(/health gate/.test(r.stdout), "help missing description");
});

test("report: missing package exits 2", function () {
  var r = run(["report"]);
  assert.strictEqual(r.code, 2);
});

test("report: clean fixture scores 100 and ships", function () {
  var r = run(["report", ZIP_EN]);
  assert.strictEqual(r.code, 0);
  assert.ok(/100\/100/.test(r.stdout), "expected 100/100, got: " + r.stdout);
  assert.ok(/ship-ready/.test(r.stdout));
});

test("report: --json aggregates the three gates with a score", function () {
  var r = run(["report", ZIP_EN, "--json"]);
  var d = JSON.parse(r.stdout);
  assert.strictEqual(d.score, 100);
  assert.strictEqual(d.verdict, "ship-ready");
  ["lint", "a11y", "privacy"].forEach(function (g) {
    assert.ok(d.passes[g], "missing gate " + g + " in passes");
  });
  assert.deepStrictEqual(d.totals, { error: 0, warn: 0, info: 0 });
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
