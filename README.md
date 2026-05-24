# scorm-kit

**An opinionated SCORM / cmi5 / xAPI build pipeline for teams that ship.** One CLI, eight subcommands, written because the existing ecosystem stops at "publish from Storyline and pray."

```bash
npm install -g scorm-kit

scorm-kit lint     course.zip    # static analysis: manifest, API, asset refs
scorm-kit a11y     course.zip    # WCAG 2.2 AA static audit
scorm-kit diff     before.zip after.zip   # structured diff for PR review
scorm-kit i18n     course.zip --strings strings.json   # bundle a translation pack
scorm-kit mock     course.zip    # local LMS for testing without Moodle
scorm-kit rum      course.zip --endpoint https://rum.example.com/ingest   # inject RUM
scorm-kit privacy  course.zip    # PII / data-leak static audit
scorm-kit cmi5     validate|lint|convert ...   # cmi5 validator + SCORM→cmi5 wrapper
```

Exit codes are conventional: `0` clean, `1` warnings only, `2` errors. Every command supports `--json` for CI pipelines.

## Why this exists

A production SCORM course in 2026 still ships as an opaque zip you upload to an LMS and hope for the best. The packaging tools don't lint. The LMSs don't surface runtime errors. There is no `diff` for PR review. There is no local runtime for testing. Multi-language ships as N separate packages bloating the gradebook. Captions are an afterthought.

`scorm-kit` is the toolbelt I wanted while running the SCORM team at Kidvento (eight people, K-12, ~100 modules a year). Each subcommand was originally written to fix a real production incident or a real workflow gap; the unified CLI is the cleanup pass.

## Commands

### `scorm-kit lint <package>`

Static analysis. Catches the classes of bug that Storyline's own publish step silently misses and that surface as "the LMS is being weird" three weeks later. Rules cover manifest correctness, SCORM API wrapper discovery, `cmi.interactions` collisions, broken asset references, and asset-size warnings.

### `scorm-kit a11y <package>`

WCAG 2.2 AA static audit of every HTML file in the package. Flags missing `lang`, missing `alt`, filename-as-alt, video without `<track>`, audio without transcript, heading-level skips, low-contrast inline styles, missing form labels, ARIA misuse. Static-analysis level, not a replacement for a manual audit — but catches 80% of the cheap regressions.

### `scorm-kit diff <before> <after>`

Treats SCORM packages as reviewable artifacts, not binary blobs. Parses `imsmanifest.xml` semantically, hashes the asset list, and emits a unified line diff for text files (HTML/CSS/JS/JSON/XML/VTT). Drop it in CI to gate large unintended changes; use it in PR review to read what actually changed.

### `scorm-kit i18n <package> --strings strings.json`

Bundles a translation pack and a small runtime into a SCORM 1.2 package, turning it into **one package, N languages**, with the learner picking at launch. Authors annotate their HTML with `data-i18n` attributes; the runtime swaps text, media `<source>`s, and `<track>` captions on language change. Choice persists via `cmi.student_preference.language`. No re-publishing per language. No gradebook split.

### `scorm-kit mock <package>`

A local SCORM 1.2 runtime — tiny HTTP server, iframe shell, full `window.API` implementation, every method call recorded with timestamp and last-error code. Use it to develop and debug a SCORM package without uploading to Moodle every cycle. Inject failures (`--fail set`, `--fail init`) to test the course's error handling. Export the session log as JSON for regression tests.

### `scorm-kit rum <package> --endpoint <url>`

Injects a Real User Monitoring runtime. Captures navigation timing, resource-load failures, JS errors, long tasks, and slide transitions; batches and POSTs as JSON beacons. The signal an LMS has never offered. Pair with `cmi.core.student_id` as the actor (or pseudonymise upstream).

### `scorm-kit cmi5 <validate|lint|convert> <package>`

cmi5 is the 2016 ADL spec that replaces SCORM 1.2 for new builds — SCORM-style "launch and handshake" with xAPI-based tracking. Most enterprise LMS RFPs in 2026 require cmi5 support.

- `cmi5 validate <pkg>` — structural validation: `cmi5.xml` shape, root `courseStructure` + namespace, `<course>` and `<au>` required attributes, `launchMethod`/`moveOn` enums, `masteryScore` range, IRI shape on ids and `activityType`, AU launch URLs resolve inside the package.
- `cmi5 lint <pkg>` — validate plus interop checks: unique ids, no duplicate launch URLs, `en` langstring present (LMSs default to en and show blank otherwise), ISO-8601 `duration`, namespaced extension keys, `waivedMoveOnConditions` consistent with `moveOn`.
- `cmi5 convert <scorm.zip> --out <cmi5.zip>` — wraps a SCORM 1.2 package as cmi5 by generating `cmi5.xml` that references the SCORM SCO's launch HTML as the cmi5 AU. The SCORM API stays in place, so the package degrades gracefully if launched from a SCORM-only LMS. This is the **dual-stream** pattern most teams now use: SCORM for HR completion records, cmi5/xAPI for behavioural data.

### `scorm-kit privacy <package>`

Static PII / data-leak audit. Catches the leaks a procurement-grade compliance review would flag and your courseware vendors won't tell you about: hard-coded emails, phone numbers, SSN/DOB patterns, third-party trackers (GA/GTM/Hotjar/FullStory/Mixpanel/Segment/Amplitude/etc.), font CDNs that set cookies, off-package iframes and form actions, bearer tokens and API keys checked into the bundle, S3 signed URLs, plaintext xAPI `mbox`, learner-id keys used as `localStorage` keys, and the classic `cmi.core.student_name → innerHTML` XSS vector. Allowlist your own LMS/CDN with `--allow lms.example.com,cdn.example.com`. Pair with `lint` and `a11y` in CI for an opinionated three-pass build gate.

## What scorm-kit is not

- A SCORM authoring tool. For that, see **[Storycraft](../storycraft)** — the Markdown→SCORM compiler that this toolkit was built around.
- A full WCAG audit. `a11y` is static analysis; manual testing is still required for compliance signoff.
- A replacement for the LMS. `mock` is for development; production still ships to your real LMS.

## Building from source

```bash
git clone https://github.com/parthdhanani/scorm-kit
cd scorm-kit
npm install        # zero runtime deps; install is just to populate node_modules cache
npm test           # runs the test suite using fixture zips
```

## Tests

Each subcommand has 3–5 tests in `test/` that exercise it against the sample SCORM zips in `fixtures/` (built by Storycraft). Run them with `npm test`.

## License

MIT. See `LICENSE`.
