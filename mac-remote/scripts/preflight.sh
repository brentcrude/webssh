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
echo "VNC server (expected: LISTEN on 5900)"
if command -v lsof >/dev/null 2>&1 && lsof -iTCP:5900 -sTCP:LISTEN -nP 2>/dev/null | grep -q LISTEN; then
  ok "something is listening on 5900"
else
  bad "nothing listening on 5900: enable Screen Sharing or Remote Management in System Settings > General > Sharing"
fi

echo
echo "VNC flavour (Screen Sharing or Remote Management: either is fine, not both)"
if pgrep -x ARDAgent >/dev/null 2>&1; then
  ok "Remote Management (ARDAgent) is serving VNC: leave it alone, keep the VNC password set"
else
  ok "Remote Management not running: Screen Sharing should be the one on 5900"
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
echo "noVNC (only needed on the no-card path, step 3b)"
if lsof -iTCP:6080 -sTCP:LISTEN -nP 2>/dev/null | grep -q LISTEN; then
  ok "websockify is listening on 6080"
elif [ -f "$HOME/.local/share/mac-remote/venv/bin/websockify" ]; then
  warn "websockify installed but not running: ./scripts/novnc.sh start"
else
  warn "noVNC not set up (expected if you are using Cloudflare Access instead)"
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
echo "  - with Access: the application uses only Allow or Block policies (no Bypass)"
echo "  - with Access: the tunnel route service is TCP to localhost:5900"
echo "  - without Access: the tunnel route service is HTTP to localhost:6080"

echo
if [ "$fail" -ne 0 ]; then
  echo "Some checks failed."
  exit 1
fi
echo "Checks passed."
