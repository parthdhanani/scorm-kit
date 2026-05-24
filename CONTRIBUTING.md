# Contributing to scorm-kit

Thanks for considering a contribution. scorm-kit is small and opinionated — the
bar for new code is that it solves a real production problem that the existing
subcommands don't already address.

## What's in scope

- New static-analysis rules for `lint`, `a11y`, `privacy`, or `cmi5 lint` that
  catch a specific class of LMS-side or compliance-review failure.
- New conversion targets for the `cmi5` subcommand (e.g. xAPI-only profiles,
  AICC import).
- Additional fixture packages (built with [Storycraft](https://github.com/parthdhanani/storycraft))
  that exercise edge cases.
- Bug fixes with a reproducing test case.

## What's out of scope

- New runtime dependencies. scorm-kit is intentionally zero-dep so it can be
  dropped into any CI pipeline without an install step.
- General-purpose XML / ZIP libraries. The hand-rolled parsers are deliberate —
  predictable, no upstream churn, easy to audit.
- Reformatting / refactoring without behaviour change.
- Authoring features. For that, see [Storycraft](https://github.com/parthdhanani/storycraft).

## How to propose a change

1. Open an issue first for anything larger than a one-line fix. State the
   production problem the change addresses.
2. Fork, branch, and submit a PR against `main`.
3. Every new rule or subcommand needs at least one test in `test/run.js` and a
   fixture in `fixtures/`.
4. The full suite must stay green on Node 18, 20, and 22 (the CI matrix runs
   all three).

## Running the test suite

```bash
npm test
```

No `npm install` is required to run — the runtime has zero dependencies. The
test runner is `node test/run.js`.

## Code style

- Plain CommonJS (`require`/`module.exports`). No transpilation step.
- No ES2022+ syntax that doesn't run on Node 18.
- Two-space indent, semicolons, double-quote strings, `var` for locals
  (existing style — match it).
- One file per subcommand under `src/<name>/`. Keep modules small; the audit
  surface matters.

## Reporting security issues

See [SECURITY.md](SECURITY.md).

## License

By contributing you agree your changes are released under the MIT license, the
same as the rest of the project.
