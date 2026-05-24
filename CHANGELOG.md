# Changelog

All notable changes to scorm-kit are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `scorm-kit cmi5 <validate|lint|convert>` — cmi5 v1 (ADL, 2016) package validator, linter, and SCORM 1.2 → cmi5 wrapper. Validates `cmi5.xml` shape, namespace, `<course>`/`<au>` required attributes, `launchMethod`/`moveOn` enums, `masteryScore` range, IRI shape, and AU launch URL resolution inside the package. Lint mode adds: unique-id check, duplicate-URL warning, `en` langstring check, ISO-8601 `duration`, namespaced extension keys, and `waivedMoveOnConditions` consistency. Convert mode emits `cmi5.xml` referencing the SCORM SCO as the cmi5 AU (dual-stream pattern). 5 new tests; suite now 27/27 green.
- `scorm-kit privacy <package>` — static PII / data-leak audit. 16 rules across PII literals (email, phone, SSN, DOB), third-party trackers (GA/GTM/FB pixel/Hotjar/FullStory/Mixpanel/Segment/Amplitude/Intercom/Heap/Matomo/Datadog/NewRelic/Pendo), off-package iframes and form actions, cookie-bearing font CDNs, bearer tokens, API keys, S3 signed URLs, plaintext xAPI `mbox`, learner-id `localStorage` keys, and the `cmi.core.student_name → innerHTML` XSS pattern. `--allow host1,host2` allowlists own LMS/CDN.
- 5 new privacy tests; suite now 22/22 green.

## [0.1.0] — 2026-05-20

Initial public release. Six subcommands extracted from a production SCORM
toolchain (Kidvento, 100+ K-12 modules/year), unified into one CLI.

### Added
- `scorm-kit lint <package>` — static analysis: manifest correctness, SCORM API wrapper discovery, `cmi.interactions` collisions, broken asset references, asset-size warnings.
- `scorm-kit a11y <package>` — WCAG 2.2 AA static audit across every HTML file in the package: missing `lang`/`alt`, filename-as-alt, video without `<track>`, audio without transcript, heading-level skips, low-contrast inline styles, missing form labels, ARIA misuse.
- `scorm-kit diff <before> <after>` — semantic diff of `imsmanifest.xml` + asset hash + unified line diff for text files. Drop into CI to gate large unintended changes.
- `scorm-kit i18n <package> --strings strings.json` — bundles a translation pack and a small runtime into a SCORM 1.2 package. One package, N languages, learner picks at launch via `cmi.student_preference.language`.
- `scorm-kit mock <package>` — local SCORM 1.2 runtime: tiny HTTP server, iframe shell, full `window.API` implementation, every method call recorded with timestamp and last-error code. Inject failures with `--fail set` / `--fail init`. Export session log as JSON.
- `scorm-kit rum <package> --endpoint <url>` — injects a real-user-monitoring runtime: navigation timing, resource-load failures, JS errors, long tasks, slide transitions. Batched JSON beacons.
- Conventional exit codes across every subcommand: `0` clean, `1` warnings only, `2` errors.
- `--json` flag on every subcommand for CI pipelines.
- Test suite: 17 tests exercising every subcommand against fixture SCORM zips built by [Storycraft](https://github.com/parthdhanani/storycraft).

### Notes
- Zero runtime dependencies. Pure Node, no `npm install` needed to run.
- Node ≥18.
