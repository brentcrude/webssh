# Controlling a Mac desktop from any browser, for $0

Goal: from a browser on a device with **nothing installed** (no Tailscale, no VNC client,
no agent), see and control a Mac that stays on the tailnet.

The answer is **Cloudflare's browser-rendered VNC**. Cloudflare renders the VNC client
itself, so there is no noVNC, no websockify, no Guacamole, and no VPS:

```
browser (bare: no Tailscale, no client)
   │  HTTPS, Cloudflare Access login (email OTP / IdP)
   ▼
Cloudflare edge ── renders the VNC client ──► cloudflared tunnel (outbound only, no open ports)
                                                    │
                                                    ▼
                                            127.0.0.1:5900
                                            macOS Screen Sharing
```

Nothing is published inbound on the Mac. `cloudflared` dials out to Cloudflare and the
only reachable address is loopback.

## Why this and not a tailnet gateway

- **DigitalOcean's $200 student credit no longer exists.** It left the GitHub Student
  Pack and all pack credits expired 31 July 2026. Any tutorial recommending it is stale.
- **Tailscale Funnel can't be used on the Mac** unless you replace the normal Tailscale
  app with the CLI-only open-source `tailscaled`: Funnel is supported on the open-source
  variant and *not* on the Standalone or Mac App Store variants. It is also bandwidth
  capped (no published figure, not configurable) and strips identity headers.
- **Cloudflare Tunnel has no bandwidth cap on the free plan**, supports WebSockets on all
  plans, and Access is free for up to 50 users.

If you later need to control *several* machines that are all on the tailnet, that changes:
put a small gateway host in the tailnet (an Azure B1s fits inside the $100 student credit)
and run Guacamole there. For one Mac, this is strictly less work.

## What you need

| Thing | Cost | Where |
|---|---|---|
| `.me` domain, 1 year | $0 | Namecheap student offer via the GitHub Student Pack |
| Cloudflare account + the domain added as a zone | $0 | dash.cloudflare.com |
| `cloudflared` | $0 | `brew install cloudflared` |

## Steps

### 1. Turn on Screen Sharing on the Mac

System Settings → General → Sharing:

1. **Turn Remote Management OFF first.** macOS will not run Screen Sharing and Remote
   Management together, and on recent macOS re-enabling one can silently flip the other.
2. Turn **Screen Sharing** on.
3. Click the ⓘ / **Computer Settings** and enable **"VNC viewers may control screen with
   password"**, then set a password.

Two hard limits on that password: it is **at most 8 characters** (classic VNC auth is DES
and silently truncates), and it must not be a macOS account password.

Verify the server is listening:

```sh
sudo lsof -iTCP:5900 -sTCP:LISTEN -nP
```

You want a LISTEN line on `5900`. No output means Screen Sharing is not on.

### 2. Create the tunnel

```sh
cloudflared tunnel login
cloudflared tunnel create mac-remote
cloudflared tunnel route dns mac-remote vnc.example.me
```

Copy `cloudflared/config.yml` into place and fill in the tunnel UUID and your paths, then
run it in the foreground once to confirm it starts:

```sh
cloudflared tunnel --config ./cloudflared/config.yml run mac-remote
```

### 3. Publish the route and put Access in front

In the dashboard:

1. **Networking → Tunnels → mac-remote → Routes → Add route → Published application.**
   Pick your domain, subdomain `vnc`, **Service: TCP**, address `localhost:5900`.
2. **Zero Trust → Access controls → Applications → Create new application →
   Self-hosted and private.** Add the same public hostname.
3. Turn on **"Allow access through browser-based RDP, SSH, or VNC sessions"** and choose
   **VNC**.
4. Add an **Allow** policy (e.g. your email address, verified by one-time PIN).

Only **Allow** and **Block** policies work for browser-rendered apps. **Bypass** and
**Service Auth** are silently unsupported.

### 4. Keep it running and keep the Mac awake

```sh
cp cloudflared/com.cloudflare.macremote.plist ~/Library/LaunchAgents/
# edit the USER placeholders first
launchctl load ~/Library/LaunchAgents/com.cloudflare.macremote.plist
```

Screen Sharing dies when the Mac sleeps, so either stop it sleeping while plugged in
(System Settings → Battery → Options → "Prevent automatic sleeping on power adapter when
the display is off") or run `caffeinate -s` in a terminal.

### 5. Connect

Open `https://vnc.example.me` in any browser, sign in through Access, then enter the VNC
password. The desktop renders in the page.

## Preflight

```sh
./scripts/preflight.sh
```

Checks that this is macOS, that something is listening on 5900, whether Remote Management
is running (which breaks Screen Sharing), whether the Mac is set to sleep, and whether
`cloudflared` is installed.

## Caveats worth knowing before you rely on this

- **Email prefix vs server username.** Cloudflare's docs state that for SSH and VNC "user
  email prefixes must match their username on the server". For macOS with the legacy VNC
  password enabled, authentication is password-only, so this normally does not bite. If
  Cloudflare insists on a username, create a macOS account whose short name equals the
  part of your email before the `@`.
- **Legacy VNC is unencrypted on the wire.** Here the only unencrypted hop is
  `cloudflared` → `127.0.0.1:5900`. Browser to edge is TLS, and edge to `cloudflared` is a
  TLS tunnel, so nothing crosses the internet in the clear. Do not expose 5900 directly
  instead.
- **The Mac must be awake and logged in** (a logged-out Mac shows the login window, which
  you can still use).
- **Bandwidth.** macOS at Retina/5K resolutions produces a lot of pixels. Set a lower
  scaled resolution when you expect to work over a poor connection.
- Cloudflare does not limit how long a VNC session stays open; the Access *application
  session duration* limits when you must re-authenticate.

## What was verified when this was written

- Cloudflare's VNC browser rendering, the TCP service route, and the Access toggle are
  from Cloudflare's own docs (`Render a VNC client in the browser`, June 2026).
- WebSocket support on all plans and tunnel support for TCP: Cloudflare docs.
- The macOS Screen Sharing / "VNC viewers may control screen with password" path and the
  8-character limit: Apple's Remote Desktop docs.
- **Not verified:** none of this has been executed here. There is no macOS, no Cloudflare
  account, and no domain in the environment where this file was written. Steps 1–5 are
  untested.
