#!/bin/bash
# Manual end-to-end integration test for vajra sandbox functionality.
# This script requires:
# - CAP_SYS_ADMIN set on the vajra binary (run `make build` first)
# - Node.js and npm installed
# - Linux kernel 5.13+ with Landlock support
#
# Usage: ./scripts/integration-test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VAJRA_BIN="$PROJECT_ROOT/target/debug/vajra"

echo "=== Vajra Integration Test ==="
echo

# Check if vajra binary exists
if [[ ! -x "$VAJRA_BIN" ]]; then
    echo "ERROR: vajra binary not found at $VAJRA_BIN"
    echo "Run 'make build' first to build the binary."
    exit 1
fi

# Check if CAP_SYS_ADMIN is set
if ! getcap "$VAJRA_BIN" | grep -q cap_sys_admin; then
    echo "ERROR: CAP_SYS_ADMIN not set on $VAJRA_BIN"
    echo "Run 'make build' to set capabilities."
    exit 1
fi

echo "✓ vajra binary found with CAP_SYS_ADMIN"
echo

# Test 1: Validate demo app config
echo "Test 1: Validating demo app configuration..."
cd "$PROJECT_ROOT/examples/demo-app"
"$VAJRA_BIN" validate
echo "✓ Configuration validation passed"
echo

# Test 2: Dry-run launch
echo "Test 2: Testing dry-run launch..."
"$VAJRA_BIN" launch --dry-run --env .env --sample .sample.env | tee /tmp/vajra-dry-run.txt
if grep -q "DRY RUN SUMMARY" /tmp/vajra-dry-run.txt && \
   grep -q "No sandbox was launched" /tmp/vajra-dry-run.txt; then
    echo "✓ Dry-run summary displayed correctly"
else
    echo "ERROR: Dry-run output missing expected content"
    exit 1
fi
echo

# Test 3: Status check (should fail outside sandbox)
echo "Test 3: Checking status outside sandbox..."
if "$VAJRA_BIN" status 2>&1 | grep -q "not running inside sandbox"; then
    echo "✓ Status correctly reports not in sandbox"
else
    echo "ERROR: Status check failed"
    exit 1
fi
echo

# Test 4: Launch sandbox and verify env masking
echo "Test 4: Launching sandbox and verifying env masking..."
echo "This will launch an interactive sandbox. Press Ctrl+C when done."
echo "Inside the sandbox, try:"
echo "  - cat .env          (should show masked warning)"
echo "  - cat .sample.env   (should show variable names)"
echo "  - vajra-run         (should run the demo app)"
echo "  - exit              (to leave the sandbox)"
echo
"$VAJRA_BIN" launch --env .env --sample .sample.env

echo
echo "=== Integration Test Complete ==="
echo "All automated checks passed."
