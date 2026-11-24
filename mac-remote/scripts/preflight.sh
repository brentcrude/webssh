#!/usr/bin/env bash
# Read-only checks for the browser-rendered VNC setup. Changes nothing.
set -uo pipefail

fail=0
ok()   { printf '  ok    %s\n' "$1"; }
warn() { printf '  warn  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }

echo "macOS"
if [ "$(uname -s)" = "Darwin" ]; then
  ok "$(sw_vers -productVersion)"
else
  bad "not macOS: this script must run on the Mac being controlled"
fi

echo
echo "Screen Sharing (expected: LISTEN on 5900)"
if command -v lsof >/dev/null 2>&1 && lsof -iTCP:5900 -sTCP:LISTEN -nP 2>/dev/null | grep -q LISTEN; then
  ok "something is listening on 5900"
else
  bad "nothing listening on 5900: enable System Settings > General > Sharing > Screen Sharing"
fi

echo
echo "Remote Management (must be off, it conflicts with Screen Sharing)"
if pgrep -x ARDAgent >/dev/null 2>&1; then
  bad "ARDAgent is running: turn Remote Management off, then re-enable Screen Sharing"
else
  ok "Remote Management does not appear to be running"
fi

echo
echo "Sleep (Screen Sharing stops when the Mac sleeps)"
if command -v pmset >/dev/null 2>&1; then
  sleep_setting=$(pmset -g 2>/dev/null | awk '/^ *sleep /{print $2; exit}')
  if [ "${sleep_setting:-0}" = "0" ]; then
    ok "system sleep is disabled"
  else
    warn "system sleep is ${sleep_setting:-unknown} minutes: use caffeinate -s or Battery settings"
  fi
else
  warn "pmset not available"
fi

echo
echo "cloudflared"
if command -v cloudflared >/dev/null 2>&1; then
  ok "$(cloudflared --version 2>&1 | head -n 1)"
else
  bad "cloudflared not installed: brew install cloudflared"
fi

echo
echo "Reminders the script cannot check"
echo "  - the VNC password is at most 8 characters and is not a macOS account password"
echo "  - the Access application uses only Allow or Block policies (no Bypass, no Service Auth)"
echo "  - the tunnel route service is TCP to localhost:5900"

echo
if [ "$fail" -ne 0 ]; then
  echo "Some checks failed."
  exit 1
fi
echo "Checks passed."
