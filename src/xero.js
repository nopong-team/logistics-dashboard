/**
 * Xero connector for the Logistics Dashboard.
 *
 * Direct REST against Xero's APIs — no SDK, since xero-node depends on Node-only
 * modules that don't run in Workers. Three pieces:
 *
 *   • OAuth2 auth-code flow (auth helpers under /auth/xero/*).
 *     /auth/xero            → redirect to Xero consent URL (CSRF state in KV)
 *     /auth/xero/callback   → exchange code for tokens, fetch tenant, save to D1
 *     /auth/xero/disconnect → DELETE FROM xero_tokens, redirect home
 *
 *   • Lazy token refresh (getXeroAccessToken). Tokens live in xero_tokens (D1,
 *     migration 0004, single-row CHECK id=1). Access tokens are 30 min; refresh
 *     when within REFRESH_BUFFER_S of expiry. Refresh tokens rotate — each
 *     refresh returns a new refresh_token that we MUST persist or the next
 *     refresh fails.
 *
 *   • Three API endpoints (/api/xero/*) that mirror legacy backend/server.js:
 *     /api/xero/test            — connectivity check.
 *     /api/xero/purchase-orders — paginated, filtered to upcoming POs, KV-cached.
 *     /api/xero/invoices        — last 6 months ACCREC, exclude Metorik/Amazon.
 *     /api/xero/org             — first organisation info.
 *
 *   All three API endpoints fall back to the KV-cached snapshot when Xero is
 *   offline (token expired, network error, or rate-limited) — same offline-
 *   tolerant pattern the legacy file cache provided. The dashboard's PO + sales
 *   tiles keep working through transient Xero issues.
 *
 * Secrets (Wrangler secrets, never in git):
 *   XERO_CLIENT_ID         — OAuth client ID from the Xero developer portal.
 *   XERO_CLIENT_SECRET     — OAuth client secret.
 *
 * Env-derived constants:
 *   XERO_REDIRECT_URI is built from the request's origin in the auth handler so
 *   the same code works for production (logistics.apps.nopong.com) and the
 *   workers.dev URL. Whichever origin you click "Connect" from must be in the
 *   Xero app's allowed redirect URIs list (Developer portal → app → Configuration).
 *
 * Bindings (in wrangler.jsonc):
 *   DB    — D1 database, holds xero_tokens.
 *   CACHE — KV namespace, used for OAuth state CSRF and PO/invoice response cache.
 */

import { Hono } from 'hono';
import { redactSecrets } from './redact.js';

export const xeroRoutes     = new Hono();   // mounted at /api/xero
export const xeroAuthRoutes = new Hono();   // mounted at /auth/xero

// ─── Constants ──────────────────────────────────────────────────────────────

const IDENTITY_HOST = 'identity.xero.com';
const API_HOST      = 'api.xero.com';

// Scopes match the legacy backend exactly so the consent screen is consistent.
const SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',                 // refresh tokens
  'accounting.invoices.read',       // invoices, purchase orders, quotes, items
  'accounting.settings.read',       // org info
  'accounting.contacts.read',       // suppliers
];

// Refresh access tokens this many seconds before expiry. Xero access tokens
// are ~30 min (1800s); a 60s buffer is plenty.
const REFRESH_BUFFER_S = 60;

// CSRF state TTL — long enough to reach the consent screen + come back, short
// enough that a stale state can't be replayed.
const STATE_TTL_S = 600; // 10 min
const STATE_KV_KEY = (state) => `xero:auth-state:${state}`;

// Response-cache TTLs. Xero data isn't real-time-critical for the dashboard.
const PO_CACHE_TTL_S       = 6 * 60 * 60;  // 6h
const PO_KV_KEY            = 'xero:purchase-orders';
const INVOICE_CACHE_TTL_S  = 6 * 60 * 60;  // 6h
const INVOICE_KV_KEY       = 'xero:invoices';
const ORG_CACHE_TTL_S      = 24 * 60 * 60; // 24h — org info is essentially static
const ORG_KV_KEY           = 'xero:org';

// ─── Token storage (D1) ─────────────────────────────────────────────────────

async function loadTokenRow(env) {
  return env.DB.prepare(
    `SELECT access_token, refresh_token, expires_at, tenant_id, tenant_name, scope, updated_at
     FROM xero_tokens WHERE id = 1`,
  ).first();
}

async function saveTokenRow(env, { accessToken, refreshToken, expiresAt, tenantId, tenantName, scope }) {
  // Single-row table (CHECK id = 1) — INSERT OR REPLACE keeps the contract.
  await env.DB.prepare(
    `INSERT OR REPLACE INTO xero_tokens
       (id, access_token, refresh_token, expires_at, tenant_id, tenant_name, scope, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
  ).bind(accessToken, refreshToken, expiresAt, tenantId, tenantName, scope).run();
}

async function deleteTokenRow(env) {
  await env.DB.prepare(`DELETE FROM xero_tokens WHERE id = 1`).run();
}

// ─── OAuth helpers ──────────────────────────────────────────────────────────

function basicAuthHeader(env) {
  if (!env.XERO_CLIENT_ID || !env.XERO_CLIENT_SECRET) {
    throw new Error('Xero not configured. Set XERO_CLIENT_ID and XERO_CLIENT_SECRET via scripts/load-secrets.sh.');
  }
  return 'Basic ' + btoa(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`);
}

function buildRedirectUri(c) {
  // Build from the inbound request's origin so production
  // (logistics.apps.nopong.com) and the workers.dev URL both work — whichever
  // one the user clicked "Connect" from. The chosen origin must be listed in
  // the Xero app's Configuration → Redirect URIs in Xero's developer portal.
  const url = new URL(c.req.url);
  return `${url.origin}/auth/xero/callback`;
}

async function exchangeCodeForTokens(env, code, redirectUri) {
  const body = new URLSearchParams({
    grant_type:   'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  let resp;
  try {
    resp = await fetch(`https://${IDENTITY_HOST}/connect/token`, {
      method:  'POST',
      headers: {
        'Authorization': basicAuthHeader(env),
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
  } catch (e) {
    throw new Error('Xero token exchange fetch failed: ' + redactSecrets(e?.message || e));
  }
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Xero token exchange ${resp.status}: ${redactSecrets(text).substring(0, 300)}`);
  }
  return JSON.parse(text);
}

async function refreshAccessToken(env, refreshToken) {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
  });
  let resp;
  try {
    resp = await fetch(`https://${IDENTITY_HOST}/connect/token`, {
      method:  'POST',
      headers: {
        'Authorization': basicAuthHeader(env),
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
  } catch (e) {
    throw new Error('Xero refresh fetch failed: ' + redactSecrets(e?.message || e));
  }
  const text = await resp.text();
  if (!resp.ok) {
    // 400 invalid_grant means the refresh token is no longer valid — the user
    // needs to re-auth. Surface a typed signal so the caller can wipe the row.
    if (resp.status === 400) {
      const e = new Error(`Xero refresh rejected: ${redactSecrets(text).substring(0, 300)}`);
      e.invalidGrant = true;
      throw e;
    }
    throw new Error(`Xero refresh ${resp.status}: ${redactSecrets(text).substring(0, 300)}`);
  }
  return JSON.parse(text);
}

async function fetchFirstTenant(env, accessToken) {
  // Returns whichever Xero org the user authorised. We pick the first
  // ORGANISATION-typed connection — No Pong has only one. If the user has
  // multiple orgs, the legacy code grabbed [0] too; preserve that behaviour.
  const resp = await fetch(`https://${API_HOST}/connections`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept':        'application/json',
    },
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Xero /connections ${resp.status}: ${redactSecrets(text).substring(0, 300)}`);
  }
  const conns = JSON.parse(text);
  const org = (conns || []).find((c) => c.tenantType === 'ORGANISATION') || conns?.[0];
  if (!org) throw new Error('Xero /connections returned no tenants');
  return { tenantId: org.tenantId, tenantName: org.tenantName };
}

// Lazy-refresh accessor. Returns the current access token + tenant_id, or
// throws an Error with .needsAuth=true if the user needs to re-authorize.
async function getXeroAuth(env) {
  const row = await loadTokenRow(env);
  if (!row || !row.access_token || !row.refresh_token) {
    const e = new Error('Xero not connected — visit /auth/xero to authorize.');
    e.needsAuth = true;
    throw e;
  }
  const now = Math.floor(Date.now() / 1000);
  if (!row.expires_at || row.expires_at - now <= REFRESH_BUFFER_S) {
    let fresh;
    try {
      fresh = await refreshAccessToken(env, row.refresh_token);
    } catch (e) {
      if (e.invalidGrant) {
        // Refresh token is dead — wipe the row so the next auth flow starts
        // clean instead of trying to use a broken refresh on every request.
        await deleteTokenRow(env);
        const ne = new Error('Xero refresh token rejected — re-authorise at /auth/xero.');
        ne.needsAuth = true;
        throw ne;
      }
      throw e;
    }
    const newExpiresAt = now + parseInt(fresh.expires_in || 1800, 10);
    await saveTokenRow(env, {
      accessToken:  fresh.access_token,
      refreshToken: fresh.refresh_token || row.refresh_token,  // defensive — Xero rotates
      expiresAt:    newExpiresAt,
      tenantId:     row.tenant_id,
      tenantName:   row.tenant_name,
      scope:        fresh.scope || row.scope,
    });
    return { accessToken: fresh.access_token, tenantId: row.tenant_id, tenantName: row.tenant_name };
  }
  return { accessToken: row.access_token, tenantId: row.tenant_id, tenantName: row.tenant_name };
}

// ─── Auth routes (under /auth/xero, not /api) ───────────────────────────────

xeroAuthRoutes.get('/', async (c) => {
  if (!c.env.XERO_CLIENT_ID || !c.env.XERO_CLIENT_SECRET) {
    return c.text(
      'Xero not configured. Set XERO_CLIENT_ID and XERO_CLIENT_SECRET via scripts/load-secrets.sh, then redeploy.',
      500,
    );
  }
  // CSRF state — random 32-char hex, stored in KV with 10-min TTL, validated on callback.
  const stateBytes = crypto.getRandomValues(new Uint8Array(16));
  const state = Array.from(stateBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  if (c.env.CACHE) {
    await c.env.CACHE.put(STATE_KV_KEY(state), '1', { expirationTtl: STATE_TTL_S });
  }
  const redirectUri = buildRedirectUri(c);
  const authUrl = new URL(`https://login.xero.com/identity/connect/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id',     c.env.XERO_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri',  redirectUri);
  authUrl.searchParams.set('scope',         SCOPES.join(' '));
  authUrl.searchParams.set('state',         state);
  return c.redirect(authUrl.toString(), 302);
});

xeroAuthRoutes.get('/callback', async (c) => {
  const code  = c.req.query('code');
  const state = c.req.query('state');
  const err   = c.req.query('error');

  if (err) {
    return c.text(`Xero auth error: ${err} (${c.req.query('error_description') || ''})`, 400);
  }
  if (!code || !state) {
    return c.text('Missing code or state from Xero callback.', 400);
  }
  // CSRF check — state must exist in KV (and is consumed on use).
  if (c.env.CACHE) {
    const seen = await c.env.CACHE.get(STATE_KV_KEY(state));
    if (!seen) {
      return c.text('Invalid or expired auth state. Restart from /auth/xero.', 400);
    }
    await c.env.CACHE.delete(STATE_KV_KEY(state));
  }

  try {
    const redirectUri = buildRedirectUri(c);
    const tokenSet = await exchangeCodeForTokens(c.env, code, redirectUri);
    const { tenantId, tenantName } = await fetchFirstTenant(c.env, tokenSet.access_token);
    const expiresAt = Math.floor(Date.now() / 1000) + parseInt(tokenSet.expires_in || 1800, 10);
    await saveTokenRow(c.env, {
      accessToken:  tokenSet.access_token,
      refreshToken: tokenSet.refresh_token,
      expiresAt,
      tenantId,
      tenantName,
      scope: tokenSet.scope || SCOPES.join(' '),
    });
    return c.redirect('/?xero=connected', 302);
  } catch (e) {
    console.error('Xero callback failed:', redactSecrets(e?.message || e));
    return c.text('Xero authorization failed: ' + redactSecrets(e?.message || String(e)), 500);
  }
});

xeroAuthRoutes.get('/disconnect', async (c) => {
  await deleteTokenRow(c.env);
  return c.redirect('/?xero=disconnected', 302);
});

// ─── Xero API helpers ───────────────────────────────────────────────────────

async function xeroApiGet(env, accessToken, tenantId, path, query = {}, extraHeaders = {}) {
  const url = new URL(`https://${API_HOST}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }
  let resp;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        'Authorization':   `Bearer ${accessToken}`,
        'xero-tenant-id':  tenantId,
        'Accept':          'application/json',
        ...extraHeaders,
      },
    });
  } catch (e) {
    throw new Error(`Xero ${path} fetch failed: ` + redactSecrets(e?.message || e));
  }
  const text = await resp.text();
  if (!resp.ok) {
    const error = new Error(`Xero ${path} ${resp.status}: ${redactSecrets(text).substring(0, 300)}`);
    error.status = resp.status;
    throw error;
  }
  try { return JSON.parse(text); } catch (e) {
    throw new Error(`Xero ${path} parse error: ${redactSecrets(text).substring(0, 200)}`);
  }
}

// ─── /api/xero/test ─────────────────────────────────────────────────────────

xeroRoutes.get('/test', async (c) => {
  try {
    const { accessToken, tenantId, tenantName } = await getXeroAuth(c.env);
    return c.json({
      connected: true,
      tenantId,
      tenantName,
      tokenPrefix: (accessToken || '').substring(0, 4),
    });
  } catch (e) {
    return c.json({
      connected: false,
      needsAuth: !!e.needsAuth,
      error:     redactSecrets(e?.message || String(e)),
    });
  }
});

// ─── /api/xero/purchase-orders ──────────────────────────────────────────────
//
// Filtered to upcoming POs: deliveryDate ≥ start of current month, exclude
// BILLED and DELETED. Strip tin packaging line items (T- prefix). Drop POs
// whose lines are all tins (after the strip).

async function fetchAllPurchaseOrders(env, accessToken, tenantId) {
  const all = [];
  let page = 1;
  const HARD_CAP = 20; // ~2000 POs is well past anything realistic
  while (page <= HARD_CAP) {
    const data = await xeroApiGet(env, accessToken, tenantId, '/api.xro/2.0/PurchaseOrders', { page });
    const batch = data?.PurchaseOrders || [];
    if (batch.length === 0) break;
    all.push(...batch);
    page++;
    // Politeness — Xero rate-limits at 60/min per tenant.
    if (batch.length >= 100) await new Promise((r) => setTimeout(r, 1500));
  }
  return all;
}

function shapePurchaseOrders(pos) {
  // Match legacy backend response shape verbatim so the dashboard's PO tile
  // reads it without modification.
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const filtered = pos.filter((po) => {
    const status = (po.Status || '').toUpperCase();
    if (status === 'BILLED' || status === 'DELETED') return false;
    if (!po.DeliveryDate) return false;
    // Xero dates come back as `/Date(unix-ms+offset)/` — parse once.
    const ms = parseXeroDate(po.DeliveryDate);
    if (!ms) return false;
    return ms >= startOfMonth.getTime();
  });

  return filtered.map((po) => {
    const expectedDate = po.DeliveryDate ? toIsoDate(parseXeroDate(po.DeliveryDate))
                       : po.Date         ? toIsoDate(parseXeroDate(po.Date))
                       : null;
    const lines = (po.LineItems || [])
      .filter((li) => !li.ItemCode || !String(li.ItemCode).startsWith('T-'))
      .map((li) => ({
        sku:         li.ItemCode || '',
        description: li.Description || '',
        qty:         li.Quantity   || 0,
        unitPrice:   li.UnitAmount || 0,
        lineTotal:   li.LineAmount || 0,
      }));
    return {
      po:           po.PurchaseOrderNumber || po.PurchaseOrderID,
      status:       (po.Status || 'unknown').toLowerCase(),
      expectedDate,
      supplier:     po.Contact?.Name || 'Unknown',
      notes:        po.Reference || '',
      total:        po.Total || 0,
      currency:     po.CurrencyCode || 'CAD',
      lines,
    };
  }).filter((po) => po.lines.length > 0);
}

xeroRoutes.get('/purchase-orders', async (c) => {
  // Try fresh fetch; fall back to KV cache on any failure (auth, network, rate limit).
  try {
    const { accessToken, tenantId } = await getXeroAuth(c.env);
    const all = await fetchAllPurchaseOrders(c.env, accessToken, tenantId);
    const purchaseOrders = shapePurchaseOrders(all);
    const result = {
      purchaseOrders,
      count:    purchaseOrders.length,
      source:   'xero',
      lastSync: new Date().toISOString(),
    };
    if (c.env.CACHE) {
      await c.env.CACHE.put(PO_KV_KEY, JSON.stringify(result), { expirationTtl: PO_CACHE_TTL_S });
    }
    return c.json({ ...result, cached: false });
  } catch (e) {
    if (c.env.CACHE) {
      const cached = await c.env.CACHE.get(PO_KV_KEY, 'json');
      if (cached) {
        return c.json({
          ...cached,
          cached:        true,
          staleFallback: true,
          error:         redactSecrets(e?.message || String(e)),
          needsAuth:     !!e.needsAuth,
        });
      }
    }
    return c.json(
      {
        error:     'xero_unavailable',
        detail:    redactSecrets(e?.message || String(e)),
        needsAuth: !!e.needsAuth,
      },
      e.needsAuth ? 401 : 502,
    );
  }
});

// ─── /api/xero/invoices ─────────────────────────────────────────────────────
//
// Last 6 months of ACCREC (sales) invoices, ordered by Date DESC, exclude
// WooCommerce Metorik + Amazon weekly-summary contacts (those come from the
// Woo + Amazon connectors directly so we'd double-count if we kept them).

const EXCLUDED_INVOICE_CONTACTS = ['metorik', 'amazon'];

xeroRoutes.get('/invoices', async (c) => {
  try {
    const { accessToken, tenantId } = await getXeroAuth(c.env);

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);

    const data = await xeroApiGet(
      c.env, accessToken, tenantId, '/api.xro/2.0/Invoices',
      {
        where: 'Type=="ACCREC"',
        order: 'Date DESC',
        page:  1,
      },
      { 'If-Modified-Since': sixMonthsAgo.toUTCString() },
    );

    const all = data?.Invoices || [];
    const filtered = all.filter((inv) => {
      const name = (inv.Contact?.Name || '').toLowerCase();
      return !EXCLUDED_INVOICE_CONTACTS.some((exc) => name.includes(exc));
    });

    const invoices = filtered.map((inv) => ({
      id:       inv.InvoiceID,
      number:   inv.InvoiceNumber,
      date:     inv.Date ? toIsoDate(parseXeroDate(inv.Date)) : null,
      status:   inv.Status,
      contact:  inv.Contact?.Name || 'Unknown',
      total:    inv.Total || 0,
      currency: inv.CurrencyCode || 'CAD',
      lines:    (inv.LineItems || [])
        .filter((li) => li.ItemCode)
        .map((li) => ({
          sku:       li.ItemCode,
          qty:       li.Quantity   || 0,
          lineTotal: li.LineAmount || 0,
        })),
    }));

    const result = {
      invoices,
      count:    invoices.length,
      source:   'xero',
      lastSync: new Date().toISOString(),
    };
    if (c.env.CACHE) {
      await c.env.CACHE.put(INVOICE_KV_KEY, JSON.stringify(result), { expirationTtl: INVOICE_CACHE_TTL_S });
    }
    return c.json({ ...result, cached: false });
  } catch (e) {
    if (c.env.CACHE) {
      const cached = await c.env.CACHE.get(INVOICE_KV_KEY, 'json');
      if (cached) {
        return c.json({
          ...cached,
          cached:        true,
          staleFallback: true,
          error:         redactSecrets(e?.message || String(e)),
          needsAuth:     !!e.needsAuth,
        });
      }
    }
    return c.json(
      {
        error:     'xero_unavailable',
        detail:    redactSecrets(e?.message || String(e)),
        needsAuth: !!e.needsAuth,
      },
      e.needsAuth ? 401 : 502,
    );
  }
});

// ─── /api/xero/org ──────────────────────────────────────────────────────────

xeroRoutes.get('/org', async (c) => {
  try {
    const { accessToken, tenantId } = await getXeroAuth(c.env);
    const data = await xeroApiGet(c.env, accessToken, tenantId, '/api.xro/2.0/Organisations');
    const o = data?.Organisations?.[0] || {};
    const result = {
      name:                  o.Name,
      legalName:             o.LegalName,
      baseCurrency:          o.BaseCurrency,
      countryCode:           o.CountryCode,
      financialYearEndDay:   o.FinancialYearEndDay,
      financialYearEndMonth: o.FinancialYearEndMonth,
      lastSync:              new Date().toISOString(),
    };
    if (c.env.CACHE) {
      await c.env.CACHE.put(ORG_KV_KEY, JSON.stringify(result), { expirationTtl: ORG_CACHE_TTL_S });
    }
    return c.json({ ...result, cached: false });
  } catch (e) {
    if (c.env.CACHE) {
      const cached = await c.env.CACHE.get(ORG_KV_KEY, 'json');
      if (cached) {
        return c.json({
          ...cached,
          cached:        true,
          staleFallback: true,
          error:         redactSecrets(e?.message || String(e)),
          needsAuth:     !!e.needsAuth,
        });
      }
    }
    return c.json(
      {
        error:     'xero_unavailable',
        detail:    redactSecrets(e?.message || String(e)),
        needsAuth: !!e.needsAuth,
      },
      e.needsAuth ? 401 : 502,
    );
  }
});

// ─── /api/status helper ─────────────────────────────────────────────────────
//
// Surfaced to src/index.js so /api/status can flip xero.connected without
// importing all of xero.js's internals.

export async function readXeroStatus(env) {
  if (!env.DB) return { connected: false, live: false, cached: false, org: null };
  const row = await loadTokenRow(env).catch(() => null);
  const cache = env.CACHE;
  let hasCachedPo = false;
  if (cache) {
    const cached = await cache.get(PO_KV_KEY, 'json').catch(() => null);
    hasCachedPo = !!cached;
  }
  const live = !!(row?.access_token && row?.refresh_token);
  return {
    connected: live || hasCachedPo,
    live,
    cached:    !live && hasCachedPo,
    org:       row ? { id: row.tenant_id, name: row.tenant_name } : null,
  };
}

// ─── Date helpers ───────────────────────────────────────────────────────────
//
// Xero JSON API serializes dates as `/Date(1690848000000+0000)/`. Parse the
// embedded unix-ms; ignore the offset (we treat all dates as UTC for bucketing).

function parseXeroDate(s) {
  if (!s) return null;
  const m = String(s).match(/\/Date\((-?\d+)/);
  if (m) return parseInt(m[1], 10);
  // Fallback: ISO 8601 (some endpoints return ISO; defensive).
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function toIsoDate(ms) {
  if (!ms || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().split('T')[0];
}
