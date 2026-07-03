#!/usr/bin/env bash
# One-command vajra demo: build, setcap if needed, launch the sandbox in the
# demo app. Run from anywhere: ./scripts/demo.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
vajra_bin="$repo_root/target/debug/vajra"

cargo build --manifest-path "$repo_root/Cargo.toml"

# setcap survives only until the binary is rebuilt; skip sudo when it's intact.
if ! getcap "$vajra_bin" | grep -q cap_sys_admin; then
    echo "vajra: granting cap_sys_admin to $vajra_bin (needs sudo)"
    sudo setcap cap_sys_admin+ep "$vajra_bin"
fi

cd "$repo_root/examples/demo-app"
rm -f .sample.env   # let vajra regenerate it, so the demo shows that too

echo
echo "Entering the vajra sandbox (press Enter twice to accept the env picker defaults)."
echo "Inside, try:  cat .env | cat .sample.env | vajra-run | vajra-run serve | vajra-run --stop | exit"
echo
exec "$vajra_bin" launch
