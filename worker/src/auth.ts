export const SESSION_COOKIE = 'ssheasy_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface AuthEnv {
  AUTH_SECRET?: string;
  RELAY_PASSWORD?: string;
}

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sign(env: AuthEnv, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.AUTH_SECRET ?? ''),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

/** Constant-time-ish comparison, so a wrong password leaks no timing signal. */
async function matches(env: AuthEnv, given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sign(env, given), sign(env, expected)]);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/** Login is only enforced once a password secret exists, so `wrangler dev` stays usable. */
export function authRequired(env: AuthEnv): boolean {
  return Boolean(env.RELAY_PASSWORD && env.AUTH_SECRET);
}

export async function isAuthenticated(request: Request, env: AuthEnv): Promise<boolean> {
  if (!authRequired(env)) return true;
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return false;
  const [expires, signature] = raw.split('.');
  if (!expires || !signature) return false;
  const deadline = Number(expires);
  if (!Number.isFinite(deadline) || deadline < Date.now()) return false;
  const expected = await sign(env, expires);
  let diff = expected.length === signature.length ? 0 : 1;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (signature.charCodeAt(i) || 0);
  return diff === 0;
}

const page = (body: string, message = ''): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>ssheasy — sign in</title>
    <style>
      :root { --line:#dde1e7; --muted:#6a7484; --accent:#2563eb; --bad:#b42318; }
      * { box-sizing: border-box; }
      body { margin:0; min-height:100vh; display:grid; place-items:center; background:#eef0f3;
        color:#171b21; font:14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
      .card { width:100%; max-width:360px; padding:24px; background:#fff; border:1px solid var(--line);
        border-radius:14px; box-shadow:0 12px 32px rgba(16,24,40,.10); }
      h1 { margin:0 0 4px; font-size:16.5px; font-weight:640; letter-spacing:-.01em; }
      p { margin:0 0 16px; font-size:12.5px; color:var(--muted); }
      label { display:block; margin:0 0 5px; font-size:12px; font-weight:520; color:var(--muted); }
      input { width:100%; min-height:36px; padding:8px 10px; border:1px solid var(--line); border-radius:8px;
        font:inherit; font-size:13px; }
      input:focus { outline:2px solid #e8f0fe; border-color:#b9cdf5; }
      button { width:100%; height:36px; margin-top:14px; border:0; border-radius:8px; background:var(--accent);
        color:#fff; font:inherit; font-size:13px; font-weight:560; cursor:pointer; }
      button:hover { background:#1d54d0; }
      .error { margin:0 0 12px; font-size:12.5px; color:var(--bad); }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Sign in</h1>
      <p>This relay is private. Enter the relay password to open SSH sessions.</p>
      ${message ? `<p class="error">${message}</p>` : ''}
      <form method="POST" action="/login">
        <label for="password">Relay password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
        <button type="submit">Sign in</button>
      </form>
    </div>
  </body>
</html>`;

export async function handleLogin(request: Request, env: AuthEnv): Promise<Response> {
  if (!authRequired(env)) {
    return new Response(null, { status: 302, headers: { Location: '/' } });
  }

  if (request.method === 'GET') {
    if (await isAuthenticated(request, env)) {
      return new Response(null, { status: 302, headers: { Location: '/' } });
    }
    return new Response(page(''), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  const form = await request.formData();
  const password = String(form.get('password') ?? '');
  if (!(await matches(env, password, env.RELAY_PASSWORD ?? ''))) {
    return new Response(page('', 'That password was not accepted.'), {
      status: 401,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const expires = Date.now() + SESSION_TTL_SECONDS * 1000;
  const signature = await sign(env, String(expires));
  const cookie = [
    `${SESSION_COOKIE}=${expires}.${signature}`,
    'Path=/',
    `Max-Age=${SESSION_TTL_SECONDS}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
  return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': cookie } });
}

export function handleLogout(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/',
      'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
