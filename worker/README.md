# Worker relay

An alternative to the Go proxy in `../proxy` for hosts that cannot run a
long-lived process: a Cloudflare Worker plus one Durable Object per SSH
session, which bridges the browser's WebSocket to a raw TCP socket.

The client is unchanged. `web/main.go` dials `wss://<host>/p`, sends
`{"Host":"…","Port":…}` as the first frame, expects a single frame back with
`{"status":"ok"}` or `{"status":"error","error":…}`, then pipes raw bytes.
This Worker speaks exactly that.

```
browser (wasm client) --wss /p--> Worker --WS--> Durable Object --connect()--> host:port
```

## Why not the Docker image

The nginx + Go-proxy stack needs a process that stays alive per connection.
A Worker cannot be one, so this replaces `proxy/` rather than wrapping it.
Static client files are served from the same Worker via the `ASSETS` binding.

## Deploy

Build the client first — the wasm is not in the repository:

```sh
cd ../web
GOOS=js GOARCH=wasm go build -o main.wasm .
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" ../web/html/wasm_exec.js
cp main.wasm ../web/html/main.wasm
```

Then:

```sh
cd ../worker
npm install
npx wrangler secret put RELAY_PASSWORD   # the shared password for /login
npx wrangler secret put AUTH_SECRET      # any long random string
npx wrangler deploy
```

Open the deployed URL, visit `/login`, sign in, then use the client normally.
`npx wrangler tail` streams logs.

## Local development

```sh
npm run dev      # http://127.0.0.1:8787
npm run check    # tsc --noEmit
```

Without `RELAY_PASSWORD` and `AUTH_SECRET` the relay is **open** — convenient
locally, never correct on a public hostname. To exercise the gate:

```sh
npx wrangler dev --var RELAY_PASSWORD:testpass --var AUTH_SECRET:s3cret
```

## What it refuses

`validateTarget()` in `src/relay.ts` rejects, per connection:

- ports outside 1–65535, and port 25 (SMTP abuse)
- loopback, RFC1918, link-local, CGNAT and multicast IPv4 literals
- IPv6 loopback, ULA, link-local and v4-mapped forms of the above
- `localhost`, `*.local`, `*.internal`

Cloudflare additionally blocks its own IP ranges and outbound port 25.

This is a **relay**: anyone who can sign in can reach any host and port the
Worker can. If that is too broad, add an allowlist of destinations to
`validateTarget` before exposing it.

## Known limits

- **Idle sessions can be evicted.** An open outbound socket keeps the Durable
  Object in memory for up to 15 minutes; after that the standard 70–140 second
  idle-eviction rules resume and a quiet session may be dropped. Typing keeps
  it alive, and the client's reconnect prompt handles the rest.
- **One socket per Durable Object.** Each connection gets its own instance, so
  the per-invocation six-connection limit never applies here.
- No rate limiting, per-user accounts or audit log — the Go proxy has the
  audit log (`connections.log`), this does not.

## Deployment note

Freebuff Sites' managed deployer does not accept custom Durable Object
classes, so this ships with `wrangler deploy` against your own Cloudflare
account rather than through that pipeline. `[assets]` points at `../web/html`,
under Workers' 25 MiB per-file limit (the wasm is ~15 MiB, which is why it
does not fit Sites' 10 MiB limit either).
