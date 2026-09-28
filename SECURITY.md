# Security Policy

## Scope

Vajra is mid-rewrite. The native core (`vajra-core`) now enforces filesystem
confinement on Linux (Landlock), and provides output redaction. **Vajra supports
Linux only** — on any other platform, including macOS and Windows, the CLI
refuses to start rather than running unconfined.

In scope, and welcome:

- escaping the filesystem policy on Linux — reaching a path the policy
  should deny
- a permission config that is accepted but not correctly enforced
- secret values surviving `redact`
- path traversal, unintended file destruction, or command injection through
  `runShell`

Not in scope:

- unsupported platforms, including macOS and Windows — there is no build, no CI
  run and no package published for them, and a start attempt is rejected outright
- `.env` files being readable inside a sandboxed project — masking is not
  ported yet and the README says so

## Reporting a Vulnerability

Email **codekalakaars@gmail.com**. Do not file a public issue.

You should receive a response within **6 business days**.

## Disclaimer

Vajra is experimental, pre-release software provided "as is," without
warranty of any kind (see [LICENSE](LICENSE), Apache 2.0 Section 7). You run
it at your own risk — the maintainers are not responsible for data loss, a
sandbox escape, an agent doing something unwanted, or any other consequence
of using it.
