# Security Policy

## Scope

Vajra is mid-rewrite. The native core (`vajra-native`) now enforces filesystem
confinement on Linux (Landlock) and macOS (Seatbelt), and provides output
redaction. **Windows has no confinement at all** — that is a known and
documented limitation, not a vulnerability.

In scope, and welcome:

- escaping the filesystem policy on Linux or macOS — reaching a path the policy
  should deny
- a permission config that is accepted but not correctly enforced
- secret values surviving `redact`
- path traversal, unintended file destruction, or command injection through
  `runShell`

Not in scope:

- the absence of confinement on Windows
- `.env` files being readable inside a sandboxed project — masking is not
  ported yet and the README says so
- anything in [`legacy/`](legacy/), which is unmaintained reference code

## Reporting a Vulnerability

Email **codekalakaars@gmail.com**. Do not file a public issue.

You should receive a response within **6 business days**.

## Disclaimer

Vajra is experimental, pre-release software provided "as is," without
warranty of any kind (see [LICENSE](LICENSE), Apache 2.0 Section 7). You run
it at your own risk — the maintainers are not responsible for data loss, a
sandbox escape, an agent doing something unwanted, or any other consequence
of using it.
