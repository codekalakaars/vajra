#!/usr/bin/env bash
# Install `vajra` as a command on this machine from this checkout, or remove it.
#
#   scripts/install-global.sh             build, remove any old version, install to ~/.local/bin/vajra
#   scripts/install-global.sh --prefix D  install to D/vajra instead
#   scripts/install-global.sh --uninstall remove it
#
# The command is a small launcher that runs this checkout's build, so rebuilding
# (pnpm build:all) updates it. Nothing is copied and nothing needs root.
#
# Old versions are removed after the build succeeds, so a failed build leaves the
# working command in place: Vajra launchers in any directory on PATH, and a copy
# installed with npm or pnpm -g. A `vajra` that is none of those is reported and left alone.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="${HOME}/.local/bin"
uninstall=0

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) dest="${2:?--prefix needs a directory}"; shift 2 ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

target="${dest}/vajra"
marker="# vajra-launcher"

if [ "$uninstall" = 1 ]; then
  if [ -f "$target" ] && grep -q "$marker" "$target"; then
    rm "$target"; echo "removed ${target}"
  else
    echo "nothing to remove: ${target} is not a Vajra launcher" >&2
  fi
  exit 0
fi

command -v node >/dev/null || { echo "node is required (22 or newer)" >&2; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || { echo "node 22 or newer is required" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required: https://pnpm.io/installation" >&2; exit 1; }
command -v cargo >/dev/null || { echo "a Rust toolchain is required to build the native addon: https://rustup.rs" >&2; exit 1; }

# Refuse to replace a file that is not ours, so a real program of the same name is never lost.
if [ -e "$target" ] && ! grep -q "$marker" "$target" 2>/dev/null; then
  echo "${target} exists and is not a Vajra launcher; not replacing it" >&2
  exit 1
fi

cd "$root"
pnpm install --frozen-lockfile
pnpm build:all

# Remove old versions, now that the new one is built.
echo "checking for an old version..."
removed=0
old_ifs=$IFS; IFS=:
for dir in $PATH "$dest"; do
  [ -n "$dir" ] || continue
  candidate="${dir}/vajra"
  if [ -f "$candidate" ] && grep -q "$marker" "$candidate" 2>/dev/null; then
    where="$(sed -n 's/^exec node "\(.*\)\/packages\/vajra\/dist\/cli\/index.js".*/\1/p' "$candidate")"
    rm -f "$candidate" && { echo "  removed old launcher ${candidate}${where:+ (ran ${where})}"; removed=1; }
  fi
done
IFS=$old_ifs
for manager in npm pnpm; do
  if command -v "$manager" >/dev/null && "$manager" ls -g --depth=0 2>/dev/null | grep -q -- '── @codekalakaars/vajra@'; then
    "$manager" uninstall -g @codekalakaars/vajra >/dev/null 2>&1 \
      && { echo "  removed the copy installed with $manager -g"; removed=1; } \
      || echo "  could not remove the $manager -g copy; run: $manager uninstall -g @codekalakaars/vajra" >&2
  fi
done
[ "$removed" = 1 ] || echo "  none found"

mkdir -p "$dest"
cat > "$target" <<LAUNCHER
#!/bin/sh
${marker}
exec node "${root}/packages/vajra/dist/cli/index.js" "\$@"
LAUNCHER
chmod +x "$target"
echo "installed ${target} (runs ${root})"

case ":${PATH}:" in
  *":${dest}:"*) ;;
  *) echo "note: ${dest} is not on your PATH; add it to your shell profile" >&2 ;;
esac
found="$(command -v vajra || true)"
if [ -n "$found" ] && [ "$found" != "$target" ]; then
  echo "note: 'vajra' resolves to ${found}, which is not a Vajra launcher and was left alone. Remove it, or put ${dest} before it on PATH" >&2
fi
hash -r 2>/dev/null || true
echo "next: cd into a project and run 'vajra doctor', then 'vajra'"
