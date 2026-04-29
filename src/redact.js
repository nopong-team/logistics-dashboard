/**
 * redactSecrets — scrub credential-shaped substrings from any string before it
 * lands in a response body, log line, or transcript.
 *
 * Why centralised: the v2.13 security patch caught a credential leak when
 * native fetch() baked a Woo URL (with consumer_key/consumer_secret query
 * params) into err.message. The fix was a regex applied at TWO layers — the
 * source helper (wooFetch) and the global onError backstop in src/index.js.
 * As we add more connectors (Amazon LWA, Xero OAuth, etc.) the regex needs
 * to grow in lockstep across every layer that uses it. Extracting the
 * function here means a new credential prefix is one edit, not N edits.
 *
 * Patterns covered:
 *   - Query-param style:    consumer_key=…, consumer_secret=…, access_token=…,
 *                           refresh_token=…, api_key=…
 *   - WooCommerce key/secret bare tokens: ck_<hex>, cs_<hex>
 *   - Amazon LWA tokens (Atzr|… and Atza|…): the access token returned by
 *     /auth/o2/token and the refresh token both share this prefix shape.
 *     SP-API errors on retry can echo the x-amz-access-token header back into
 *     undici's error message — exactly the failure mode the Woo leak taught us
 *     to defend against.
 *   - Xero: bearer JWTs (eyJ...…) and the oauth_token=… query-param form a
 *     refresh-token failure can echo back. Xero's access tokens are JWTs ~1KB
 *     long — redact by prefix-match on the JWS header so we don't have to
 *     count length, and accept that some legitimately-encoded base64 values
 *     starting with "eyJ" might also get scrubbed. Acceptable trade.
 *
 * Add new connector token shapes here as they come online.
 */
export function redactSecrets(s) {
  return String(s || '')
    .replace(/(consumer_key|consumer_secret|access_token|refresh_token|api_key|client_secret|oauth_token|code|id_token)=[^&\s"']+/gi, '$1=[REDACTED]')
    .replace(/\b(ck|cs)_[a-f0-9]{20,}\b/gi, '$1_[REDACTED]')
    .replace(/\bAtz[ar]\|[A-Za-z0-9_\-+/=|]+/g, 'Atz_[REDACTED]')
    .replace(/\bamzn1\.oa2-cs\.v1\.[A-Za-z0-9]+/g, 'amzn1.oa2-cs.v1.[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g, 'eyJ[REDACTED]');
}
