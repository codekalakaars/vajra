# vajra demo app

A dependency-free Node app for testing vajra locally. The committed `.env`
contains fake values on purpose — it exists to exercise the masking.

## Quick Start

From the repo root:

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
