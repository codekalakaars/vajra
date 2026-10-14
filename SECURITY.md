# Security Policy

## Scope

Vajra is a CLI that confines a command, or a shell, to a project directory. The
core is the `vajra` shell, which uses Landlock through the native addon
(`vajra-native`) and the policy in `.vajra.json`. **Vajra supports Linux only**:
on any other platform, including macOS and Windows, the CLI refuses to start
rather than running unconfined.

In scope, and welcome:

- escaping the filesystem policy of `vajra` on Linux — reaching a path the
  policy or the built-in rules should deny
- a `.vajra.json` that is accepted but not enforced as written
- secret values surviving `redact`
- path traversal or command injection through `runShell`

Not in scope:

- unsupported platforms, including macOS and Windows — there is no build, no CI
  run and no package published for them, and a start attempt is rejected outright
- files inside the project being readable by the confined command by default:
  the project starts read-only, not unreadable. The README says so, and
  `.vajra.json` can restrict reads per path

## Reporting a Vulnerability

Email **codekalakaars@gmail.com**. Do not file a public issue.

You should receive a response within **6 business days**.

## Disclaimer

Vajra is experimental, pre-release software provided "as is," without
warranty of any kind (see [LICENSE](LICENSE), Apache 2.0 Section 7). You run
it at your own risk — the maintainers are not responsible for data loss, a
sandbox escape, an agent doing something unwanted, or any other consequence
of using it.
