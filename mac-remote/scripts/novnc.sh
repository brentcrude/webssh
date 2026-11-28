#!/usr/bin/env bash
# Serve noVNC in front of macOS Screen Sharing (port 5900), for the no-card path where
# Cloudflare Access is not available. websockify bridges browser WebSockets to the VNC
# port and also serves the noVNC client files, so one loopback port (6080) is enough.
#
#   ./scripts/novnc.sh setup           # create venv, download noVNC, generate password
#   ./scripts/novnc.sh start|stop|status
#   ./scripts/novnc.sh run             # foreground (what the LaunchAgent calls)
#   ./scripts/novnc.sh install-agent   # start at login via launchd
#   ./scripts/novnc.sh uninstall-agent
#
# Nothing here listens on anything but 127.0.0.1: cloudflared is the only thing that
# reaches it, over the tunnel.
set -euo pipefail

PORT="${NOVNC_PORT:-6080}"
BIND="${NOVNC_BIND:-127.0.0.1:${PORT}}"
VNC_TARGET="${VNC_TARGET:-localhost:5900}"
NOVNC_VERSION="${NOVNC_VERSION:-1.5.0}"

BASE="${HOME}/.local/share/mac-remote"
VENV="${BASE}/venv"
WEB="${BASE}/noVNC"
AUTH_FILE="${BASE}/novnc-auth"
PID_FILE="${BASE}/websockify.pid"
LOG_FILE="${BASE}/websockify.log"
AGENT_LABEL="com.macremote.novnc"
AGENT_PLIST="${HOME}/Library/LaunchAgents/${AGENT_LABEL}.plist"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
self_path() { cd "$(dirname "$0")" && pwd -P; }

setup() {
  have python3 || die "python3 is required (xcode-select --install provides it)"
  have curl || die "curl is required"
  mkdir -p "$BASE"

  if [ ! -x "${VENV}/bin/websockify" ]; then
    printf 'creating venv in %s\n' "$VENV"
    python3 -m venv "$VENV"
    "${VENV}/bin/pip" install --quiet --upgrade pip
    "${VENV}/bin/pip" install --quiet websockify
  fi

  if [ ! -f "${WEB}/vnc.html" ]; then
    printf 'downloading noVNC %s\n' "$NOVNC_VERSION"
    tmp="$(mktemp -d)"
    curl -fsSL \
      "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz" \
      -o "${tmp}/novnc.tgz" || die "could not download noVNC ${NOVNC_VERSION}"
    tar -xzf "${tmp}/novnc.tgz" -C "$tmp" || die "could not extract noVNC"
    rm -rf "$WEB"
    mv "${tmp}/noVNC-${NOVNC_VERSION}" "$WEB"
    rm -rf "$tmp"
  fi

  sync_web

  if [ ! -f "$AUTH_FILE" ]; then
    # Usernames and passwords here are only meaningful to websockify, so the macOS
    # account name is used as the username and the password is generated.
    user="${NOVNC_USER:-$(id -un)}"
    pass="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
    umask 077
    printf '%s:%s\n' "$user" "$pass" > "$AUTH_FILE"
    chmod 600 "$AUTH_FILE"
    printf '\nBasic auth created (username %s)\n' "$user"
    printf '  password: %s\n' "$pass"
    printf '  stored:   %s\n' "$AUTH_FILE"
    printf 'This is what the browser asks for first, before the VNC password.\n\n'
  fi
}

# Our own front-end (mac-remote/web/index.html) replaces the stock noVNC page: it has a
# labelled toolbar, a real fit/zoom model, and latching modifier keys. The stock
# vnc.html and vnc_lite.html stay available as fallbacks.
sync_web() {
  src="$(self_path)/../web/index.html"
  if [ ! -f "$src" ]; then
    printf 'warning: %s not found; / will serve the stock noVNC page\n' "$src" >&2
    return 0
  fi
  cp "$src" "${WEB}/index.html"
}

do_run() {
  setup
  [ -f "$AUTH_FILE" ] || die "missing $AUTH_FILE"
  [ -f "${WEB}/vnc.html" ] || die "noVNC is not installed in $WEB"
  creds="$(cat "$AUTH_FILE")"
  printf 'websockify %s -> %s (web root %s)\n' "$BIND" "$VNC_TARGET" "$WEB"
  printf 'open the tunnel URL at / (or /vnc.html for the stock client)\n'
  exec "${VENV}/bin/websockify" \
    --web "$WEB" \
    --web-auth \
    --auth-plugin BasicHTTPAuth \
    --auth-source "$creds" \
    --heartbeat 30 \
    "$BIND" "$VNC_TARGET"
}

is_running() {
  [ -f "$PID_FILE" ] || return 1
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "${pid:-}" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  printf 'websockify running (pid %s)\n' "$pid"
}

do_start() {
  if is_running; then return 0; fi
  setup
  : > "$LOG_FILE"
  nohup "${BASH_SOURCE[0]}" run >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    if is_running && (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
      printf 'listening on %s\n' "$BIND"
      return 0
    fi
  done
  printf 'did not come up; last lines of %s:\n' "$LOG_FILE"
  tail -n 20 "$LOG_FILE" || true
  return 1
}

do_stop() {
  if ! is_running; then printf 'not running\n'; return 0; fi
  pid="$(cat "$PID_FILE")"
  kill "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  printf 'stopped (pid %s)\n' "$pid"
}

do_install_agent() {
  setup
  mkdir -p "$(dirname "$AGENT_PLIST")"
  script="$(self_path)/$(basename "$0")"
  cat > "$AGENT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${script}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
</dict>
</plist>
PLIST
  launchctl unload "$AGENT_PLIST" 2>/dev/null || true
  launchctl load "$AGENT_PLIST"
  printf 'installed %s\n' "$AGENT_PLIST"
}

do_uninstall_agent() {
  launchctl unload "$AGENT_PLIST" 2>/dev/null || true
  rm -f "$AGENT_PLIST"
  printf 'removed %s\n' "$AGENT_PLIST"
}

case "${1:-}" in
  setup)           setup ;;
  run)             do_run ;;
  start)           do_start ;;
  stop)            do_stop ;;
  status)          is_running || { echo "not running"; exit 1; } ;;
  install-agent)   do_install_agent ;;
  uninstall-agent) do_uninstall_agent ;;
  *)
    printf 'usage: %s {setup|start|stop|status|run|install-agent|uninstall-agent}\n' "$0" >&2
    exit 2
    ;;
esac
