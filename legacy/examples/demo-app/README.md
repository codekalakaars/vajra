# vajra demo app (legacy)

A dependency-free Node app for testing the legacy vajra CLI. The committed
`.env` contains fake values on purpose — it exists to exercise the masking.

This drives the old sandbox under [`legacy/`](../../), which is no longer built
by default. See [`legacy/README.md`](../../README.md).

## Quick Start

From `legacy/`:

```bash
make build                    # build and set capabilities
cd examples/demo-app
../../target/debug/vajra launch   # press Enter twice to accept defaults
```

## Inside the Sandbox

```bash
cat .env            # shows security warning (values masked)
cat .sample.env     # generated, keys only
vajra-run           # runs `npm run dev`, prints the env the app received
vajra-run serve     # long-running server on :3123
vajra-run --stop    # stop it
exit
```
