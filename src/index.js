/**
 * No Pong — Logistics Dashboard Worker
 *
 * Currently a hello-world placeholder. Real /api/* endpoints (Woo, Amazon, Xero,
 * SalesBinder, Logiwa, CIN7) will land here as the migration off the local
 * Node/Express server progresses.
 *
 * Domain:  https://logistics.apps.nopong.com
 * Auth:    Cloudflare Access (Google Workspace SSO, @nopong.net / @nopong.com)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/ping') {
      return Response.json({ hello: 'world' });
    }

    return new Response('Not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
