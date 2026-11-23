import { Relay } from './relay';
import { authRequired, handleLogin, handleLogout, isAuthenticated, type AuthEnv } from './auth';

export { Relay };

export interface Env extends AuthEnv {
  ASSETS: Fetcher;
  RELAY: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/p') {
      if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
        return new Response('expected a websocket upgrade', { status: 426 });
      }
      // A WebSocket is not covered by the same-origin policy, so check it here.
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) {
        return new Response('cross-origin websocket refused', { status: 403 });
      }
      if (!(await isAuthenticated(request, env))) {
        return new Response('not signed in: open /login first', { status: 401 });
      }
      const id = env.RELAY.idFromName(crypto.randomUUID());
      return env.RELAY.get(id).fetch(request);
    }

    if (url.pathname === '/login') return handleLogin(request, env);
    if (url.pathname === '/logout') return handleLogout();

    if (url.pathname === '/auth/state') {
      return Response.json(
        { required: authRequired(env), authenticated: await isAuthenticated(request, env) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    // Everything else is the static client (index.html handles unknown paths).
    return env.ASSETS.fetch(request);
  },
};
