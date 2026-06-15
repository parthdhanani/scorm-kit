#!/usr/bin/env node
"use strict";

var path = require("path");
var { spawnSync } = require("child_process");

var SUBCOMMANDS = {
  lint:  "../src/lint/lint.js",
  a11y:  "../src/a11y/a11y.js",
  diff:  "../src/diff/diff.js",
  i18n:  "../src/i18n/i18n-cli.js",
  mock:  "../src/mock/mock.js",
  rum:   "../src/rum/rum-cli.js",
  privacy: "../src/privacy/privacy.js",
  cmi5: "../src/cmi5/cmi5.js",
  report: "../src/report/report.js",
};

var HELP = [
  "scorm-kit — opinionated SCORM 1.2 build pipeline",
  "",
  "Usage: scorm-kit <command> [args]",
  "",
  "Commands:",
  "  lint   <package>                static analysis (manifest, API, assets)",
  "  a11y   <package>                WCAG 2.2 AA static audit",
  "  diff   <before> <after>         structured diff of two packages",
  "  i18n   <package> --strings ...  bundle a translation pack + runtime",
  "  mock   <package> [--port N]     local LMS runtime for testing",
  "  rum    <package> --endpoint ... inject real-user-monitoring runtime",
  "  privacy <package>               PII / data-leak static audit",
  "  cmi5 validate|lint|convert ...  cmi5 package validator + SCORM→cmi5 wrapper",
  "  report <package>                one health-gate score (lint + a11y + privacy)",
  "",
  "Each command exits 0 on success, 1 on warnings, 2 on errors.",
  "Run `scorm-kit <command> --help` for command-specific options.",
].join("\n");

function main(argv) {
  var args = argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  if (args[0] === "--version" || args[0] === "-v") {
    var pkg = require("../package.json");
    console.log("scorm-kit " + pkg.version);
    process.exit(0);
  }
  var sub = args.shift();
  var script = SUBCOMMANDS[sub];
  if (!script) {
    console.error("scorm-kit: unknown command '" + sub + "'");
    console.error("Run `scorm-kit --help` for the list of commands.");
    process.exit(2);
  }
  var full = path.resolve(__dirname, script);
  var res = spawnSync(process.execPath, [full].concat(args), { stdio: "inherit" });
  process.exit(res.status == null ? 1 : res.status);
}

main(process.argv);
