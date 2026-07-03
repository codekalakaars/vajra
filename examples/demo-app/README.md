# vajra demo app

A dependency-free Node app for testing vajra locally. The committed `.env`
contains fake values on purpose — it exists to exercise the masking.

Quickest way, from the repo root (builds, setcaps if needed, and launches):

```bash
make demo          # or: ./scripts/demo.sh
```

Or manually:

```bash
cd examples/demo-app
../../target/debug/vajra launch        # press Enter twice to accept defaults
```

Inside the sandboxed shell:

```bash
cat .env            # empty — masked
cat .sample.env     # generated, keys only
vajra-run           # runs `npm run dev`, prints the env the app received
vajra-run serve     # long-running server on :3123
vajra-run --stop    # stop it
exit
```
