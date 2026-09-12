# Vajra sandbox — generated profile
set -o ignoreeof

# Strip dangerous dirs from PATH
export PATH="/home/mrugesh/.local/bin:/home/mrugesh/flutter/bin:/home/mrugesh/.local/bin:/home/mrugesh/.opencode/bin:/home/mrugesh/.pyenv/shims:/home/mrugesh/.pyenv/bin:/home/mrugesh/.local/bin:/home/mrugesh/flutter/bin:/home/mrugesh/.opencode/bin:/home/mrugesh/.pyenv/bin:/home/mrugesh/Flutter/flutter/bin:/home/mrugesh/.local/share/pnpm/bin:/home/mrugesh/.nvm/versions/node/v24.16.0/bin:/home/mrugesh/.cargo/bin:/usr/local/bin:/usr/bin:/bin:/usr/games:/usr/local/games:/snap/bin:/usr/lib/android-sdk/cmdline-tools/latest/bin:/usr/lib/android-sdk/platform-tools:/usr/local/go/bin:/usr/lib/android-sdk/cmdline-tools/latest/bin:/usr/lib/android-sdk/platform-tools:/usr/local/go/bin"

# Logging function
_vajra_log() { echo "[VAJRA BLOCKED] $1 — $2" >&2; }

# Extract the base command from a command string
_vajra_base_cmd() {
  local cmd="$1"
  # Strip leading env/path prefixes
  cmd="${cmd#env }"
  cmd="${cmd##*/}"
  # Strip leading sudo/ignore/sudo\-n
  cmd="${cmd#sudo}"
  cmd="${cmd#sudo-}"
  cmd="${cmd#ignore}"
  cmd="${cmd## }"
  echo "$cmd"
}

# Master block list — checked by trap DEBUG before every command
_vajra_blocklist="^(curl|wget|git|ssh|scp|rsync|nc|ncat|socat|nmap|telnet|ftp|sftp|python|python3|node|nodejs|ruby|perl|php|lua|docker|podman|lxc|qemu|rsh|rexec|gdb|strace|ltrace|lsof|netstat|ss|ip|iptables|nft)$"

# trap DEBUG — intercepts every command before execution
trap '
  _vajra_line="$BASH_COMMAND"
  _vajra_first_word="${_vajra_line%% *}"
  _vajra_cmd="$(_vajra_base_cmd "$_vajra_first_word")"
  if echo "$_vajra_cmd" | grep -qE "$_vajra_blocklist"; then
    case "$_vajra_cmd" in
      curl|wget) _vajra_log "$_vajra_cmd" "Use read_file or list_files tools instead" ;;
      git) _vajra_log "$_vajra_cmd" "File operations are done through the sandbox tools" ;;
      ssh|scp|rsync|nc|ncat|socat|telnet|ftp|sftp|nmap) _vajra_log "$_vajra_cmd" "Network access is restricted" ;;
      python*|node*|ruby|perl|php*|lua) _vajra_log "$_vajra_cmd" "Interpreter access is restricted" ;;
      docker|podman|lxc|qemu) _vajra_log "$_vajra_cmd" "Container access is restricted" ;;
      gdb|strace|ltrace|lsof|netstat|ss|ip|iptables|nft) _vajra_log "$_vajra_cmd" "System inspection tools are restricted" ;;
      *) _vajra_log "$_vajra_cmd" "This command is not available in the sandbox" ;;
    esac
    # Prevent execution by redefining the command as a no-op for this line
    BASH_COMMAND="true"
    return 0 2>/dev/null || true
  fi
  # Block sudo/su at any position in the pipeline
  if echo "$_vajra_line" | grep -qE "(^|[|;&])\s*(sudo|su)\b"; then
    _vajra_log "sudo/su" "Privilege escalation is not allowed"
    BASH_COMMAND="true"
    return 0 2>/dev/null || true
  fi
  # Block exec with blocked commands
  if echo "$_vajra_line" | grep -qE "^exec\s+.*($_vajra_blocklist)"; then
    _vajra_log "exec" "Cannot exec restricted commands"
    BASH_COMMAND="true"
    return 0 2>/dev/null || true
  fi
  # Block direct path invocations like /usr/bin/curl
  if echo "$_vajra_first_word" | grep -qE "^/.*($_vajra_blocklist)$"; then
    _vajra_cmd="$(_vajra_base_cmd "$_vajra_first_word")"
    _vajra_log "$_vajra_cmd" "Direct path invocation is blocked"
    BASH_COMMAND="true"
    return 0 2>/dev/null || true
  fi
' DEBUG

# Force all bash sub-invocations through this profile
export BASH_ENV="$VAJRA_PROFILE"

# Override bash to always use this profile
bash() { builtin bash --rcfile "$VAJRA_PROFILE" --norc=ignore "$@"; }

# Block exit completely
exit() { echo "Cannot exit — close the terminal"; }
alias exit=exit

# Block Ctrl+C
trap "" SIGINT

# Custom prompt
export PS1="\[\033[32m\]🔒 \[\033[0m\]$ "

# Welcome message
echo ""
echo "Sandboxed shell — confined to: /mnt/data/Repos/vajra/packages/sandbox"
echo "Close terminal tab to leave."
echo ""