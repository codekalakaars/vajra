# Security Policy

## Scope

Vajra is mid-rewrite. The current native core (`vajra-native`) provides
cross-platform file, process, environment and path primitives — it does **not**
sandbox anything. Landlock confinement, `.env` masking and output redaction
exist only in the unmaintained [`legacy/`](legacy/) CLI and have not been
ported.

So please do not report a "sandbox escape" against this branch: there is no
sandbox to escape yet. Reports about the native core — path traversal,
unintended file destruction, command injection through `runShell`, leaking
environment values — are in scope and welcome.

## Reporting a Vulnerability

Email **codekalakaars@gmail.com**. Do not file a public issue.

You should receive a response within **6 business days**.

## Disclaimer

Vajra is experimental, pre-release software provided "as is," without
warranty of any kind (see [LICENSE](LICENSE), Apache 2.0 Section 7). You run
it at your own risk — the maintainers are not responsible for data loss, a
sandbox escape, an agent doing something unwanted, or any other consequence
of using it.
