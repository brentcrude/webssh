import { connect } from 'cloudflare:sockets';

type Socket = ReturnType<typeof connect>;

const MAX_HANDSHAKE_BYTES = 4096;
const BLOCKED_PORTS = new Set([25]); // SMTP: classic relay abuse target

// Ranges a public relay must never reach: they are the cloud's own plumbing.
function isPrivateHost(raw: string): boolean {
  const host = raw.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (host.startsWith('fc') || host.startsWith('fd')) return true; // ULA
    if (host.startsWith('fe80')) return true; // link-local
    if (host.startsWith('::ffff:')) return isPrivateHost(host.slice(7)); // v4-mapped
  }
  return false;
}

/** Returns a human-readable reason the target is refused, or null when allowed. */
export function validateTarget(host: string, port: number): string | null {
  if (!host) return 'missing host';
  if (host.length > 253) return 'host too long';
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'invalid port';
  if (BLOCKED_PORTS.has(port)) return `port ${port} is not allowed`;
  if (isPrivateHost(host)) return 'that address is not a permitted target';
  return null;
}

function toBytes(data: unknown): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data as ArrayBufferView)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return new Uint8Array(0);
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One Durable Object per WebSocket: it owns the TCP socket, so the two live and
 * die together. The handshake mirrors the Go client in web/main.go — the first
 * frame is {"Host":…,"Port":…}, and the reply is {"status":"ok"} or
 * {"status":"error","error":…}; everything after that is raw bytes.
 */
export class Relay {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    let socket: Socket | null = null;
    let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    let established = false;
    let finished = false;

    const shutdown = (code = 1000, text = '') => {
      if (finished) return;
      finished = true;
      try {
        server.close(code, text);
      } catch {}
      try {
        socket?.close();
      } catch {}
    };

    const fail = (message: string) => {
      try {
        server.send(JSON.stringify({ status: 'error', error: message }));
      } catch {}
      shutdown(1008, message);
    };

    server.addEventListener('message', event => {
      void (async () => {
        if (finished) return;

        if (!established) {
          const bytes = toBytes(event.data);
          if (bytes.byteLength > MAX_HANDSHAKE_BYTES) {
            fail('connection request too large');
            return;
          }

          let config: { Host?: unknown; Port?: unknown };
          try {
            config = JSON.parse(new TextDecoder().decode(bytes));
          } catch {
            fail('invalid connection request');
            return;
          }

          const host = String(config?.Host ?? '').trim();
          const port = Number(config?.Port ?? 0);
          const problem = validateTarget(host, port);
          if (problem) {
            fail(problem);
            return;
          }

          established = true;
          let tcp: Socket;
          try {
            tcp = connect({ hostname: host, port });
            socket = tcp;
            await tcp.opened;
            writer = tcp.writable.getWriter();
          } catch (err) {
            fail(`cannot connect to host: ${reason(err)}`);
            return;
          }

          try {
            server.send(JSON.stringify({ status: 'ok' }));
          } catch {
            shutdown(1011, 'client went away');
            return;
          }

          void this.pump(tcp, server, () => {
            finished = true;
          });
          return;
        }

        if (writer) {
          try {
            await writer.write(toBytes(event.data));
          } catch (err) {
            shutdown(1011, `write failed: ${reason(err)}`);
          }
        }
      })();
    });

    server.addEventListener('close', () => {
      finished = true;
      try {
        socket?.close();
      } catch {}
    });
    server.addEventListener('error', () => {
      finished = true;
      try {
        socket?.close();
      } catch {}
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /** TCP -> WebSocket, until either end goes away. */
  private async pump(socket: Socket, ws: WebSocket, onEnd: () => void): Promise<void> {
    const reader = socket.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) ws.send(value);
      }
      try {
        ws.close(1000, 'remote closed the connection');
      } catch {}
    } catch (err) {
      try {
        ws.close(1011, `connection lost: ${reason(err)}`);
      } catch {}
    } finally {
      onEnd();
      try {
        reader.releaseLock();
      } catch {}
      try {
        socket.close();
      } catch {}
    }
  }
}
