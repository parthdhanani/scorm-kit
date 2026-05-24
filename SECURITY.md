# Security policy

## Supported versions

The latest minor release receives security fixes. Older releases do not.

| Version | Supported |
|---------|-----------|
| 0.2.x   | ✅        |
| < 0.2   | ❌        |

## Reporting a vulnerability

Please report security issues privately rather than opening a public GitHub
issue.

Email: **parth1707ster@gmail.com**

Include:

- The version of scorm-kit affected
- A minimal SCORM / cmi5 package or input that reproduces the issue (if
  applicable)
- Your assessment of impact (e.g. arbitrary file write during `unzip`,
  command injection via filename, ReDoS in a static-analysis rule)

I aim to acknowledge within 72 hours and to ship a fix or mitigation within
14 days for confirmed issues.

## Threat model

scorm-kit is a developer tool that reads untrusted SCORM / cmi5 zip files
locally. The relevant threats to harden against:

- **Path traversal during extraction** — `convert` writes files extracted from
  user-supplied zips. Entries must be confined to the destination directory.
- **Denial-of-service via crafted inputs** — pathological XML or regex inputs
  should bound CPU and memory.
- **Command injection via filenames** — no subcommand should pass package
  paths to a shell.

Static-analysis output is informational; rules may produce false positives or
false negatives. Treat the output as guidance for human review, not as a
compliance certificate.
