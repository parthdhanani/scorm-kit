#!/usr/bin/env node
"use strict";

/*
 * scorm-kit report — one pre-upload health gate.
 *
 *   scorm-kit report course.zip [--json]
 *
 * Runs the three static gates (lint, a11y, privacy) in --json mode, aggregates
 * their findings into a single Build Health score, and frames the result the
 * way it actually matters: every issue caught here is one a learner would
 * otherwise hit in production two weeks later. Pure composition — it shells out
 * to the existing subcommands and adds no new analysis of its own.
 *
 * Exit codes follow the suite convention: 0 clean, 1 warnings only, 2 errors.
 */

var path = require("path");
var { spawnSync } = require("child_process");

// Each gate is run as its own process, exactly like the dispatcher does.
var GATES = [
  { name: "lint",    script: "../lint/lint.js" },
  { name: "a11y",    script: "../a11y/a11y.js" },
  { name: "privacy", script: "../privacy/privacy.js" },
];

// Score model — deliberately simple and explainable:
//   each error costs 10, each warning costs 3, floored at 0.
var ERROR_COST = 10;
var WARN_COST = 3;

function verdict(score) {
  if (score >= 90) return "ship-ready";
  if (score >= 70) return "minor issues";
  if (score >= 40) return "needs work";
  return "blocked";
}

// Run one gate, return { error, warn, info, failed } counts.
function runGate(gate, pkg) {
  var script = path.resolve(__dirname, gate.script);
  var res = spawnSync(process.execPath, [script, pkg, "--json"], { encoding: "utf8", timeout: 30000 });
  var counts = { error: 0, warn: 0, info: 0, failed: false };
  var data;
  try {
    data = JSON.parse(res.stdout);
  } catch (e) {
    // Gate crashed or printed non-JSON — surface it instead of silently passing.
    counts.failed = true;
    counts.error = 1;
    counts.message = (res.stderr || "").trim().split("\n").pop() || "gate did not return JSON";
    return counts;
  }
  if (data.counts) {
    counts.error = data.counts.error || 0;
    counts.warn = data.counts.warn || 0;
    counts.info = data.counts.info || 0;
  } else {
    // a11y emits findings without a counts block — derive from finding severities.
    (data.findings || []).forEach(function (f) {
      if (f.sev === "error") counts.error++;
      else if (f.sev === "warn") counts.warn++;
      else counts.info++;
    });
  }
  return counts;
}

function parseArgs(argv) {
  var args = { json: false, input: null, help: false };
  argv.forEach(function (a) {
    if (a === "--json") args.json = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else if (!args.input) args.input = a;
  });
  return args;
}

var HELP = [
  "scorm-kit report — one pre-upload health gate (lint + a11y + privacy)",
  "",
  "Usage: scorm-kit report <package.zip|dir> [--json]",
  "",
  "Aggregates the three static gates into a single Build Health score (0-100)",
  "and reports how many issues were caught before upload.",
  "",
  "Exit codes: 0 clean, 1 warnings only, 2 errors.",
].join("\n");

function main(argv) {
  var args = parseArgs(argv.slice(2));
  if (args.help) { console.log(HELP); process.exit(0); }
  if (!args.input) { console.error("scorm-kit report: missing package.\nRun `scorm-kit report --help`."); process.exit(2); }

  var passes = {};
  var total = { error: 0, warn: 0, info: 0 };
  GATES.forEach(function (gate) {
    var c = runGate(gate, args.input);
    passes[gate.name] = c;
    total.error += c.error;
    total.warn += c.warn;
    total.info += c.info;
  });

  var score = Math.max(0, 100 - ERROR_COST * total.error - WARN_COST * total.warn);
  var caught = total.error + total.warn;
  var code = total.error > 0 ? 2 : (total.warn > 0 ? 1 : 0);

  if (args.json) {
    process.stdout.write(JSON.stringify({
      package: args.input,
      score: score,
      verdict: verdict(score),
      caught: caught,
      totals: total,
      passes: passes,
    }, null, 2) + "\n");
    process.exit(code);
  }

  console.log("");
  console.log("scorm-kit report — " + path.basename(args.input));
  console.log("");
  GATES.forEach(function (gate) {
    var c = passes[gate.name];
    var mark = c.error > 0 ? "✗" : (c.warn > 0 ? "!" : "✓");
    var line = "  " + (gate.name + "    ").slice(0, 8) + mark + "  " +
      c.error + " error" + (c.error === 1 ? "" : "s") + "  " +
      c.warn + " warning" + (c.warn === 1 ? "" : "s");
    if (c.failed) line += "  (gate failed: " + (c.message || "unknown") + ")";
    console.log(line);
  });
  console.log("");
  console.log("  Build health: " + score + "/100  (" + verdict(score) + ")");
  if (caught > 0) {
    console.log("  " + caught + " issue" + (caught === 1 ? "" : "s") +
      " caught before upload — each one a learner ticket you won't get in two weeks.");
    console.log("  Run a gate directly (e.g. `scorm-kit a11y " + path.basename(args.input) + "`) for line-level detail.");
  } else {
    console.log("  No issues across lint, a11y, or privacy. Ship it.");
  }
  console.log("");
  process.exit(code);
}

if (require.main === module) main(process.argv);
module.exports = { verdict: verdict, runGate: runGate };
