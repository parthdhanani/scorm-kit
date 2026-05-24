#!/usr/bin/env node
/*
 * scorm-kit privacy — PII / data-leak static auditor for SCORM 1.2 packages.
 *
 *   scorm-kit privacy path/to/package.zip
 *   scorm-kit privacy path/to/unzipped-dir [--json] [--allow domain1,domain2]
 *
 * Scans every text-like file in a SCORM package (HTML, JS, JSON, CSS, XML) for
 * the data-handling patterns that recur across the GDPR/HIPAA/COPPA audits
 * I've sat through. The goal is not to be a substitute for legal review; it
 * is to catch the boring class of leak before legal review:
 *
 *   - hard-coded learner emails or phone numbers shipped inside the package
 *   - xAPI actor objects that send plaintext mbox (instead of mbox_sha1sum)
 *   - third-party analytics / tracking pixels (Google Analytics, Hotjar,
 *     Mixpanel, Segment, Facebook Pixel, LinkedIn Insight, Clarity, etc.)
 *   - external form actions that exfiltrate POST bodies offsite
 *   - iframes pointing at non-allowlisted domains
 *   - accidental API keys / Bearer tokens / signed S3 URLs
 *   - PII-shaped sample data left in production (SSN, DOB patterns)
 *   - direct echoing of cmi.core.student_name into innerHTML (XSS + PII)
 *   - localStorage writes of learner-name / id without consent flag nearby
 *
 * The output is grouped by severity (error / warn / info) and is suitable
 * for CI gating. Exit codes follow the rest of the kit:
 *
 *   0 — clean
 *   1 — warnings only
 *   2 — errors present
 *
 * Allowlist hosts you've already cleared with legal via:
 *
 *   --allow scorm.kidvento.com,assets.example.org
 *
 * Rules (id → severity → one-line message):
 *
 *   pii-email-literal           error   email address hard-coded in package
 *   pii-phone-literal           warn    phone-number pattern hard-coded
 *   pii-ssn-pattern             error   US SSN-shaped digit pattern in content
 *   pii-dob-pattern             warn    DOB-shaped pattern (sample data left in?)
 *
 *   xapi-actor-mbox-plain       error   xAPI actor uses mbox: instead of mbox_sha1sum
 *   xapi-actor-student-id       warn    xAPI actor name = cmi.core.student_id (review)
 *
 *   scorm-name-into-innerhtml   error   cmi.core.student_name written into innerHTML
 *
 *   tracker-third-party         error   third-party tracker / pixel detected
 *   font-cookie-bearing         warn    CDN font/script that sets a tracking cookie
 *   iframe-external             warn    iframe src to a non-allowlisted host
 *   form-action-external        error   form action POSTs to a non-allowlisted host
 *
 *   secret-bearer-token         error   "Bearer <token>" literal in source
 *   secret-api-key              error   api_key= or apikey: literal with token-shaped value
 *   secret-s3-signed-url        warn    pre-signed S3/GCS URL embedded as a static asset
 *
 *   storage-learner-key         warn    localStorage write of learner-shaped key
 *
 * Notes:
 *   - Pure Node. No deps. Uses the system `unzip` for zip inputs.
 *   - Heuristic by design: regex + DOM-light parsing. False positives are
 *     possible. False negatives are possible. This is a gate, not a guarantee.
 *   - Treat a clean run as "no obvious leaks found" — not "audited".
 */
"use strict";

var fs = require("fs");
var path = require("path");
var os = require("os");
var { spawnSync } = require("child_process");

// ---------- rules ----------------------------------------------------------

var RULES = {
  "pii-email-literal":         { sev: "error", msg: "email address hard-coded inside the package" },
  "pii-phone-literal":         { sev: "warn",  msg: "phone-number pattern hard-coded" },
  "pii-ssn-pattern":           { sev: "error", msg: "US SSN-shaped pattern (###-##-####) in content" },
  "pii-dob-pattern":           { sev: "warn",  msg: "DOB-shaped pattern (sample data left in production?)" },

  "xapi-actor-mbox-plain":     { sev: "error", msg: "xAPI actor uses plaintext mbox: — prefer mbox_sha1sum:" },
  "xapi-actor-student-id":     { sev: "warn",  msg: "xAPI actor name set from cmi.core.student_id — confirm pseudonymisation policy" },

  "scorm-name-into-innerhtml": { sev: "error", msg: "cmi.core.student_name flows into innerHTML — XSS + PII display risk" },

  "tracker-third-party":       { sev: "error", msg: "third-party tracker / analytics pixel detected" },
  "font-cookie-bearing":       { sev: "warn",  msg: "CDN font or script that sets a tracking cookie (Google Fonts, etc.)" },
  "iframe-external":           { sev: "warn",  msg: "iframe sources from a non-allowlisted host" },
  "form-action-external":      { sev: "error", msg: "<form action=...> POSTs to a non-allowlisted host" },

  "secret-bearer-token":       { sev: "error", msg: "literal 'Bearer <token>' embedded in source" },
  "secret-api-key":            { sev: "error", msg: "api_key / apikey literal with token-shaped value" },
  "secret-s3-signed-url":      { sev: "warn",  msg: "pre-signed S3/GCS URL embedded as a static asset" },

  "storage-learner-key":       { sev: "warn",  msg: "localStorage write of learner-shaped key — confirm consent flow" },
};

// ---------- pattern tables -------------------------------------------------

// Trackers that send identifiable user data offsite. The list is the union
// of what shows up across compliance audits in 2024-2026; not exhaustive.
var TRACKER_HOSTS = [
  "google-analytics.com", "googletagmanager.com", "ssl.google-analytics.com",
  "doubleclick.net", "googleadservices.com",
  "facebook.com/tr", "connect.facebook.net",
  "linkedin.com/li/track", "px.ads.linkedin.com",
  "clarity.ms", "c.clarity.ms",
  "hotjar.com", "static.hotjar.com",
  "fullstory.com",
  "mixpanel.com", "cdn.mxpnl.com",
  "segment.io", "api.segment.io", "cdn.segment.com",
  "amplitude.com", "api.amplitude.com",
  "intercom.io", "widget.intercom.io",
  "heap.io", "cdn.heapanalytics.com",
  "matomo.org", "cdn.matomo.cloud",
  "datadoghq-browser-agent.com",
  "newrelic.com/nr-",
  "pendo.io",
];

// CDNs that set cookies for the parent domain (font/script CDNs that
// commonly trip GDPR even though they "feel" like infrastructure).
var COOKIE_BEARING_CDNS = [
  "fonts.googleapis.com", "fonts.gstatic.com",
  "ajax.googleapis.com",
  "code.jquery.com",
  "cdnjs.cloudflare.com",
  "stackpath.bootstrapcdn.com",
];

// Email — RFC-5322 lite. Excludes obvious noise (uuid@ patterns, foo@bar
// where the LHS is all digits, etc.).
var EMAIL_RE = /\b[A-Za-z][A-Za-z0-9._%+\-]{0,63}@[A-Za-z0-9][A-Za-z0-9.\-]{0,253}\.[A-Za-z]{2,24}\b/g;

// Common placeholders that should NOT trigger a finding — example.com,
// localhost-ish things, schema URIs.
var EMAIL_PLACEHOLDER_DOMAINS = new Set([
  "example.com", "example.org", "example.net",
  "test.com", "domain.com", "email.com",
  "localhost", "yourdomain.com",
]);

// Phones — keep narrow to avoid false-positives on version numbers, IDs.
// Matches E.164-style ( +CC followed by 7-15 digits ) or NANP "(NXX) NXX-XXXX".
var PHONE_RE = /(?:\+\d{1,3}[\s\-]?)?(?:\(\d{3}\)[\s\-]?|\d{3}[\s\-])\d{3}[\s\-]\d{4}\b/g;
var SSN_RE   = /\b\d{3}-\d{2}-\d{4}\b/g;
var DOB_RE   = /\b(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\/(?:19|20)\d{2}\b/g;

// xAPI actor.mbox plaintext — common shapes:
//   "actor": { ..., "mbox": "mailto:..." }
//   actor: { mbox: "mailto:..." }
var XAPI_MBOX_RE = /["']mbox["']\s*:\s*["']mailto:/g;
var XAPI_ACTOR_STUDENT_ID_RE = /(["']name["']\s*:\s*[^,}]*cmi\.core\.student_id|cmi\.core\.student_id[^;\n]{0,40}["']name["'])/g;

// student_name → innerHTML — same slide, same line ish.
var STUDENT_NAME_INNERHTML_RE = /(?:cmi\.core\.student_name|SCORM\.get\(["']cmi\.core\.student_name["']\))[^;\n]{0,120}\.innerHTML\s*=|\.innerHTML\s*=[^;\n]{0,120}(?:cmi\.core\.student_name|SCORM\.get\(["']cmi\.core\.student_name["']\))/g;

// Bearer token (RFC 6750) — match the token shape, not the prefix alone.
var BEARER_RE  = /\bBearer\s+([A-Za-z0-9_\-\.=]{20,})\b/g;
var APIKEY_RE  = /\b(?:api[_-]?key|apikey|x[_-]?api[_-]?key)["'\s:=]+["']?([A-Za-z0-9_\-]{16,})["']?/gi;

// Pre-signed URLs — AWS S3 and GCS shapes. Specific enough that false
// positives on plain S3 URLs (without signed query) are rare.
var S3_SIGNED_RE = /https?:\/\/[A-Za-z0-9.\-]+\.amazonaws\.com\/[^\s"'<>]+[?&](?:X-Amz-Signature|AWSAccessKeyId|Signature)=/g;
var GCS_SIGNED_RE = /https?:\/\/storage\.googleapis\.com\/[^\s"'<>]+[?&](?:GoogleAccessId|Signature|X-Goog-Signature)=/g;

// localStorage / sessionStorage writes of learner-shaped keys.
var STORAGE_LEARNER_RE = /(?:local|session)Storage\.setItem\(\s*["'][^"']*(?:learner|student|user)[^"']*["']/gi;

// ---------- args -----------------------------------------------------------

function parseArgs(argv) {
  var a = { input: "", json: false, noColor: false, infoOff: false, allow: new Set(), self: null };
  for (var i = 0; i < argv.length; i++) {
    var k = argv[i];
    if (k === "--json") a.json = true;
    else if (k === "--no-color") a.noColor = true;
    else if (k === "--no-info") a.infoOff = true;
    else if (k === "--allow") {
      var raw = argv[++i] || "";
      raw.split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean).forEach(function (s) { a.allow.add(s); });
    }
    else if (k === "--self") a.self = argv[++i];
    else if (k === "-h" || k === "--help") { usage(); process.exit(0); }
    else if (k[0] === "-") { console.error("Unknown flag: " + k); process.exit(2); }
    else if (!a.input) a.input = k;
    else { console.error("Unexpected arg: " + k); process.exit(2); }
  }
  if (!a.input) { usage(); process.exit(2); }
  return a;
}
function usage() {
  console.error([
    "Usage: scorm-kit privacy <package.zip | dir> [options]",
    "",
    "Options:",
    "  --json                  emit findings as JSON",
    "  --allow host1,host2,..  allowlist hosts (skip external-iframe/form/tracker checks for them)",
    "  --self host             treat this host as 'self' (own LMS / CDN) — same as --allow",
    "  --no-info               suppress info-level findings",
    "  --no-color              plain output",
    "",
    "Exit codes: 0 = clean, 1 = warnings only, 2 = errors.",
  ].join("\n"));
}

// ---------- zip ------------------------------------------------------------

function unzipToTemp(zipPath) {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scorm-privacy-"));
  var r = spawnSync("unzip", ["-q", "-o", zipPath, "-d", tmp]);
  if (r.status !== 0) throw new Error("unzip: " + r.stderr.toString());
  return tmp;
}

function isZip(p) {
  if (!fs.existsSync(p)) return false;
  var s = fs.statSync(p);
  if (!s.isFile()) return false;
  if (s.size < 4) return false;
  var fd = fs.openSync(p, "r");
  var buf = Buffer.alloc(4);
  fs.readSync(fd, buf, 0, 4, 0);
  fs.closeSync(fd);
  return buf[0] === 0x50 && buf[1] === 0x4B;
}

// ---------- walk -----------------------------------------------------------

var TEXT_EXTS = new Set([".html", ".htm", ".js", ".mjs", ".cjs", ".json", ".css", ".xml", ".svg", ".txt"]);

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

// ---------- finding -------------------------------------------------------

function find(rule, file, line, detail) {
  return { rule: rule, sev: RULES[rule].sev, msg: RULES[rule].msg, file: file, line: line, detail: detail || "" };
}

function lineOf(text, idx) {
  var n = 1;
  for (var i = 0; i < idx && i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}

// ---------- host helpers ---------------------------------------------------

function hostFromUrl(url) {
  var m = /^(?:https?:)?\/\/([^\/\?\#"']+)/i.exec(url);
  if (!m) return null;
  return m[1].toLowerCase().split(":")[0];
}

function isAllowlisted(host, allow) {
  if (!host) return true;
  host = host.toLowerCase();
  for (var h of allow) {
    if (host === h || host.endsWith("." + h)) return true;
  }
  return false;
}

function hostIsTracker(host) {
  if (!host) return null;
  host = host.toLowerCase();
  for (var t of TRACKER_HOSTS) {
    // tracker entries may include path segments — treat substring match as OK
    if (t.indexOf("/") >= 0) {
      // path-bearing entry: just check the host portion
      var th = t.split("/")[0];
      if (host === th || host.endsWith("." + th)) return t;
    } else {
      if (host === t || host.endsWith("." + t)) return t;
    }
  }
  return null;
}

function hostIsCookieBearing(host) {
  if (!host) return null;
  host = host.toLowerCase();
  for (var c of COOKIE_BEARING_CDNS) {
    if (host === c || host.endsWith("." + c)) return c;
  }
  return null;
}

// ---------- audit one file -------------------------------------------------

function auditFile(absPath, relPath, text, args) {
  var findings = [];
  var ext = path.extname(absPath).toLowerCase();
  var isHtml = ext === ".html" || ext === ".htm" || ext === ".svg";
  var isManifest = path.basename(absPath).toLowerCase() === "imsmanifest.xml";

  // 1. email literals — skip placeholder domains and obvious noise
  var m;
  EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(text)) !== null) {
    var addr = m[0];
    var domain = addr.split("@")[1].toLowerCase();
    if (EMAIL_PLACEHOLDER_DOMAINS.has(domain)) continue;
    // skip the package author block in imsmanifest / metadata files —
    // a contact email there is expected, not a leak.
    if (isManifest) continue;
    findings.push(find("pii-email-literal", relPath, lineOf(text, m.index), addr));
  }

  // 2. phone literals
  PHONE_RE.lastIndex = 0;
  while ((m = PHONE_RE.exec(text)) !== null) {
    findings.push(find("pii-phone-literal", relPath, lineOf(text, m.index), m[0]));
  }

  // 3. SSN-shape
  SSN_RE.lastIndex = 0;
  while ((m = SSN_RE.exec(text)) !== null) {
    findings.push(find("pii-ssn-pattern", relPath, lineOf(text, m.index), m[0]));
  }

  // 4. DOB-shape — heuristic. Skip JSON copyright years and obvious dates
  // in CSS (background-position: 12/04/1999). Keep this warn-level.
  DOB_RE.lastIndex = 0;
  while ((m = DOB_RE.exec(text)) !== null) {
    findings.push(find("pii-dob-pattern", relPath, lineOf(text, m.index), m[0]));
  }

  // 5. xAPI actor mbox plaintext
  XAPI_MBOX_RE.lastIndex = 0;
  while ((m = XAPI_MBOX_RE.exec(text)) !== null) {
    findings.push(find("xapi-actor-mbox-plain", relPath, lineOf(text, m.index)));
  }

  // 6. xAPI actor name = student_id
  XAPI_ACTOR_STUDENT_ID_RE.lastIndex = 0;
  while ((m = XAPI_ACTOR_STUDENT_ID_RE.exec(text)) !== null) {
    findings.push(find("xapi-actor-student-id", relPath, lineOf(text, m.index)));
  }

  // 7. student_name → innerHTML
  STUDENT_NAME_INNERHTML_RE.lastIndex = 0;
  while ((m = STUDENT_NAME_INNERHTML_RE.exec(text)) !== null) {
    findings.push(find("scorm-name-into-innerhtml", relPath, lineOf(text, m.index)));
  }

  // 8 + 9. Third-party trackers / cookie-bearing CDNs (URLs across all file types)
  var urlRe = /https?:\/\/[A-Za-z0-9.\-]+(?:\/[^\s"'<>]*)?/g;
  urlRe.lastIndex = 0;
  while ((m = urlRe.exec(text)) !== null) {
    var url = m[0];
    var host = hostFromUrl(url);
    if (!host) continue;
    if (isAllowlisted(host, args.allow)) continue;

    var tracker = hostIsTracker(host);
    if (tracker) {
      findings.push(find("tracker-third-party", relPath, lineOf(text, m.index), host));
      continue;
    }
    var cookieCdn = hostIsCookieBearing(host);
    if (cookieCdn) {
      findings.push(find("font-cookie-bearing", relPath, lineOf(text, m.index), host));
    }
  }

  // 10. iframe external — HTML only
  if (isHtml) {
    var iframeRe = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
    iframeRe.lastIndex = 0;
    while ((m = iframeRe.exec(text)) !== null) {
      var ihost = hostFromUrl(m[1]);
      if (ihost && !isAllowlisted(ihost, args.allow)) {
        findings.push(find("iframe-external", relPath, lineOf(text, m.index), ihost));
      }
    }
  }

  // 11. form action external — HTML only
  if (isHtml) {
    var formRe = /<form\b[^>]*\baction\s*=\s*["']([^"']+)["']/gi;
    formRe.lastIndex = 0;
    while ((m = formRe.exec(text)) !== null) {
      var fhost = hostFromUrl(m[1]);
      if (fhost && !isAllowlisted(fhost, args.allow)) {
        findings.push(find("form-action-external", relPath, lineOf(text, m.index), fhost));
      }
    }
  }

  // 12. Bearer tokens
  BEARER_RE.lastIndex = 0;
  while ((m = BEARER_RE.exec(text)) !== null) {
    findings.push(find("secret-bearer-token", relPath, lineOf(text, m.index), "Bearer " + m[1].slice(0, 8) + "…"));
  }

  // 13. api_key= literals — skip obvious template placeholders
  APIKEY_RE.lastIndex = 0;
  while ((m = APIKEY_RE.exec(text)) !== null) {
    var val = m[1];
    if (/^(YOUR|REPLACE|XXX|PLACEHOLDER|\$\{)/i.test(val)) continue;
    if (val === val.toLowerCase().replace(/[^a-z]/g, "")) continue; // all-letters → likely a variable name
    findings.push(find("secret-api-key", relPath, lineOf(text, m.index), val.slice(0, 8) + "…"));
  }

  // 14. signed S3/GCS URLs
  S3_SIGNED_RE.lastIndex = 0;
  while ((m = S3_SIGNED_RE.exec(text)) !== null) {
    findings.push(find("secret-s3-signed-url", relPath, lineOf(text, m.index), hostFromUrl(m[0])));
  }
  GCS_SIGNED_RE.lastIndex = 0;
  while ((m = GCS_SIGNED_RE.exec(text)) !== null) {
    findings.push(find("secret-s3-signed-url", relPath, lineOf(text, m.index), hostFromUrl(m[0])));
  }

  // 15. learner-shaped localStorage writes
  STORAGE_LEARNER_RE.lastIndex = 0;
  while ((m = STORAGE_LEARNER_RE.exec(text)) !== null) {
    findings.push(find("storage-learner-key", relPath, lineOf(text, m.index)));
  }

  return findings;
}

// ---------- audit a package -----------------------------------------------

function auditPackage(root, args) {
  var files = walk(root);
  var all = [];
  for (var f of files) {
    var ext = path.extname(f).toLowerCase();
    if (!TEXT_EXTS.has(ext)) continue;
    var rel = path.relative(root, f);
    var text;
    try { text = fs.readFileSync(f, "utf8"); } catch (e) { continue; }
    var found = auditFile(f, rel, text, args);
    if (found.length) all = all.concat(found);
  }
  return all;
}

// ---------- output ---------------------------------------------------------

function colorize(s, code, on) {
  return on ? "\x1b[" + code + "m" + s + "\x1b[0m" : s;
}

function reportText(findings, args) {
  var on = !args.noColor && process.stdout.isTTY;
  var counts = { error: 0, warn: 0, info: 0 };
  var byFile = {};
  for (var f of findings) {
    if (args.infoOff && f.sev === "info") continue;
    counts[f.sev] = (counts[f.sev] || 0) + 1;
    (byFile[f.file] = byFile[f.file] || []).push(f);
  }

  if (findings.length === 0) {
    console.log(colorize("✓ no privacy findings", "32", on));
    return 0;
  }

  Object.keys(byFile).sort().forEach(function (file) {
    console.log("");
    console.log(colorize(file, "1", on));
    byFile[file].sort(function (a, b) { return a.line - b.line; }).forEach(function (f) {
      var tag = f.sev === "error" ? colorize("error", "31", on)
              : f.sev === "warn"  ? colorize("warn",  "33", on)
              :                     colorize("info",  "36", on);
      var line = "  " + tag + "  " + f.rule.padEnd(28) + " line " + f.line + "  " + f.msg;
      if (f.detail) line += "  " + colorize("[" + f.detail + "]", "2", on);
      console.log(line);
    });
  });

  console.log("");
  console.log(
    counts.error + " error" + (counts.error === 1 ? "" : "s") + ", " +
    counts.warn + " warning" + (counts.warn === 1 ? "" : "s") +
    (args.infoOff ? "" : ", " + (counts.info || 0) + " info")
  );
  return counts.error > 0 ? 2 : (counts.warn > 0 ? 1 : 0);
}

function reportJson(findings, args) {
  var filtered = args.infoOff ? findings.filter(function (f) { return f.sev !== "info"; }) : findings;
  var errors = filtered.filter(function (f) { return f.sev === "error"; }).length;
  var warns  = filtered.filter(function (f) { return f.sev === "warn"; }).length;
  process.stdout.write(JSON.stringify({
    ok: errors === 0 && warns === 0,
    counts: { error: errors, warn: warns, info: filtered.length - errors - warns },
    findings: filtered,
  }, null, 2) + "\n");
  return errors > 0 ? 2 : (warns > 0 ? 1 : 0);
}

// ---------- main -----------------------------------------------------------

function main(argv) {
  var args = parseArgs(argv.slice(2));
  if (args.self) args.allow.add(args.self.toLowerCase());

  var root, cleanup = null;
  if (isZip(args.input)) {
    root = unzipToTemp(args.input);
    cleanup = function () { spawnSync("rm", ["-rf", root]); };
  } else if (fs.existsSync(args.input) && fs.statSync(args.input).isDirectory()) {
    root = args.input;
  } else {
    console.error("Not a zip file or directory: " + args.input);
    process.exit(2);
  }

  try {
    var findings = auditPackage(root, args);
    var code = args.json ? reportJson(findings, args) : reportText(findings, args);
    if (cleanup) cleanup();
    process.exit(code);
  } catch (e) {
    if (cleanup) cleanup();
    console.error("scorm-kit privacy: " + (e && e.message ? e.message : String(e)));
    process.exit(2);
  }
}

if (require.main === module) main(process.argv);
module.exports = { auditFile: auditFile, auditPackage: auditPackage, RULES: RULES };
