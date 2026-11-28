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

**No card to give Cloudflare?** Cloudflare Access cannot be created without payment
details, so take the other branch of step 3: the Mac serves noVNC itself and the tunnel
carries HTTP to it. Same domain, same tunnel, no Access, no card. Read step 3b.

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
| `knerd.tech` | already owned | Name.com |
| Cloudflare account + `knerd.tech` added as a zone | $0 | dash.cloudflare.com |
| Zero Trust organization (free plan, up to 50 users) | $0, **but card details are required at signup** | only for step 3a; step 3b needs no card |
| `cloudflared` | $0 | `brew install cloudflared` |

## Steps

### 0. Point the domain at Cloudflare

Everything below assumes `knerd.tech` is a zone in your Cloudflare account. While it is
still on Name.com's nameservers, the tunnel route and the Access application cannot be
created at all.

1. Cloudflare dashboard → **Add a site** → `knerd.tech` → **Free** plan. Cloudflare then
   shows you two nameservers, e.g. `ada.ns.cloudflare.com` and `bob.ns.cloudflare.com`.
2. Name.com → the domain → **Nameservers** → *Manage* → switch to custom nameservers and
   enter those two. Remove Name.com's own four. This is what Cloudflare calls a **full
   setup**, and it is the only free option; Cloudflare's partial (CNAME) setup needs a
   paid plan and is not used here.

Propagation is usually minutes and can take up to 24 hours. Confirm before continuing:

```sh
dig +short NS knerd.tech      # must list *.ns.cloudflare.com, not *.name.com
```

### 1. Make sure something is serving VNC on 5900

Exactly one of two Sharing services owns port 5900, and which one is irrelevant here:
**Screen Sharing** and **Remote Management** cannot both be on at once (enabling one
turns the other off), but both speak VNC on that port and both offer the same
"VNC viewers may control screen with password" option.

**If VNC already works on this Mac, including with Remote Management on, change
nothing.** Remote Management does not need to be off. It is a valid VNC server, just the
Apple Remote Desktop flavour of one, and the tunnel only cares that something answers on
5900.

If nothing is serving VNC yet: System Settings -> General -> Sharing -> **Screen Sharing**
-> the Info button -> enable "VNC viewers may control screen with password" and set a
password. Choose Remote Management instead only if you also want Apple Remote Desktop's
admin tooling (software installs, Remote Desktop reports).

Two hard limits on that password: it is **at most 8 characters** (classic VNC auth is DES
and silently truncates), and it must not be a macOS account password.

### 2. Create the tunnel in the dashboard

Use a **dashboard-managed** tunnel, not a locally-managed one. It is what Cloudflare's own
VNC guide assumes, the connector starts at boot by itself, and there is no config file or
UUID to fill in.

1. Dashboard → **Networking → Tunnels → Create a tunnel → Cloudflared** → name it
   `mac-remote` → Save.
2. Choose **macOS** and run the two commands it shows:

   ```sh
   brew install cloudflared
   sudo cloudflared service install <TOKEN-FROM-THE-DASHBOARD>
   ```

   The token is a credential for this tunnel: keep it out of git and out of chat. The
   second command registers a launch daemon, so the tunnel is running now and comes back
   after a reboot.
3. The tunnel should show **Healthy** in the dashboard within a minute.

<details>
<summary>Alternative: locally-managed tunnel (the config.yml in this repo)</summary>

`cloudflared/config.yml` and the LaunchAgent are for the other style:

```sh
cloudflared tunnel login
cloudflared tunnel create mac-remote          # prints the UUID
cloudflared tunnel route dns mac-remote vnc.knerd.tech
cp cloudflared/config.yml ~/.cloudflared/config.yml   # then fill in the UUID
cloudflared tunnel --config ~/.cloudflared/config.yml run mac-remote
```

Same result, but you maintain the ingress yourself. Only take this path if you want the
routing in version control.

</details>

### 3. Publish the route, and choose how it is protected

The tunnel itself is free and needs no payment method. Cloudflare **Access** does not:
creating a Zero Trust organization requires card details even on the Free plan
("You need to provide a payment method"). So there are two branches, and only the first
one uses Access.

#### 3a. With Access: Cloudflare renders the VNC client (card required)

1. **Networking -> Tunnels -> mac-remote -> Routes -> Add route -> Published
   application.** Pick `knerd.tech`, subdomain `vnc`, **Service: TCP**, address
   `localhost:5900`. `localhost` is correct because `cloudflared` runs on the same Mac as
   the VNC server; from another machine it would be that machine's IP.
2. **Access controls -> Applications -> Create new application -> Self-hosted and
   private.** Add the same public hostname.
3. Turn on **"Allow access through browser-based RDP, SSH, or VNC sessions"** and choose
   **VNC**.
4. Add an **Allow** policy (e.g. your email address, verified by one-time PIN).

Only **Allow** and **Block** policies work for browser-rendered apps. **Bypass** and
**Service Auth** are silently unsupported.

#### 3b. Without Access: noVNC on the Mac, no card

Cloudflare renders nothing on this path. The Mac serves the browser client itself with
`scripts/novnc.sh` (noVNC + websockify), so the tunnel carries ordinary HTTP instead of
raw VNC. What stands in front of it is an HTTP Basic password and then the VNC password.

1. Start the web client on the Mac:

   ```sh
   ./scripts/novnc.sh start
   ```

   The first run creates a venv, downloads noVNC, generates a 24-character Basic
   password, and prints it once. It is stored in
   `~/.local/share/mac-remote/novnc-auth` (mode 600). Re-run `./scripts/novnc.sh status`
   to check it, `stop` to stop it, and `install-agent` to start it at login through
   launchd. It listens on `127.0.0.1:6080` only and forwards to `localhost:5900`.

2. Same route as 3a, but the service is HTTP:

   **Networking -> Tunnels -> mac-remote -> Routes -> Add route -> Published application**,
   domain `knerd.tech`, subdomain `vnc`, **Service: HTTP**, URL `localhost:6080`.

3. Open `https://vnc.knerd.tech/vnc.html`. Basic password first, then the VNC password.

This endpoint is public: the tunnel publishes it with no identity check, so the only
gates are those two passwords. Keep the generated 24-character Basic password, and
optionally add one Cloudflare **rate limiting** rule to blunt password guessing. The Free
plan allows exactly one rule and it is coarse: it always counts by IP, the period is fixed
at 10 seconds, the block lasts a fixed 10 seconds, and the expression can only test the
request path (host matching is a paid field). This zone serves only `vnc`, so match every
path and set the threshold well above a page load, e.g. 100 requests per 10 seconds. Nothing on the Mac listens beyond
loopback, so the tunnel remains the only way in.

### 4. Keep it running and keep the Mac awake

If you installed the connector with `sudo cloudflared service install` in step 2, it is
already a launch daemon — nothing to do. Confirm with:

```sh
sudo launchctl list | grep cloudflared     # should print a line
```

Only for the locally-managed variant, load the LaunchAgent instead:

```sh
cp cloudflared/com.cloudflare.macremote.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.cloudflare.macremote.plist
```

On the no-card path there is a second process to keep alive. `./scripts/novnc.sh
install-agent` writes `~/Library/LaunchAgents/com.macremote.novnc.plist` pointing at where
this checkout currently lives, so install it from the directory you intend to keep.

Screen Sharing dies when the Mac sleeps, so either stop it sleeping while plugged in
(System Settings → Battery → Options → "Prevent automatic sleeping on power adapter when
the display is off") or run `caffeinate -s` in a terminal.

### 5. Connect

With Access (3a): open `https://vnc.knerd.tech`, sign in through Access, then enter the
VNC password. The desktop renders in the page.

Without Access (3b): open `https://vnc.knerd.tech/vnc.html`, enter the Basic password
from `~/.local/share/mac-remote/novnc-auth`, then the VNC password.

## Preflight

```sh
./scripts/preflight.sh
```

Checks that this is macOS, that something is listening on 5900, which of the two Sharing
services (Screen Sharing or Remote Management) is serving it, whether the Mac is set to
sleep, and whether `cloudflared` is installed.

## Caveats worth knowing before you rely on this

- **Email prefix vs server username.** Cloudflare's docs state that for SSH and VNC "user
  email prefixes must match their username on the server". For macOS with the legacy VNC
  password enabled, authentication is password-only, so this normally does not bite. If
  Cloudflare insists on a username, create a macOS account whose short name equals the
  part of your email before the `@`.
- **Screen Sharing and Remote Management are the same job.** Only one can be on, so a
  working VNC setup can end up on the other flavour after a macOS update. Both listen on
  5900; only the VNC password handling differs. If a viewer accepts the password and then
  hangs, check which of the two is currently enabled.
- **The no-card path has no per-user identity.** Anyone who finds `vnc.knerd.tech` reaches
  the login form; it is a shared Basic password plus the VNC password, with no email
  verification, no session expiry tied to a person, and no audit log beyond 24 hours of
  HTTP logs. That is the cost of avoiding the card. Remove the published route
  (`cloudflared` tunnel route) when you do not need remote access.
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
