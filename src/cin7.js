/**
 * CIN7 Omni connector + AU dashboard data routes.
 *
 * Phase 2 of the AU rollout — replaces the static `/au-data.js` snapshot for
 * Inventory (Phase 2a, v2.34) and Sales / Refunds / POs (Phase 2b, v2.35)
 * with live reads from CIN7 Omni.
 *
 *   GET /api/au/cin7/status
 *     Smallest possible proof-of-life. Hits /Branches with rows=1 and reports
 *     {connected, branchCount, error}. No KV cache. Useful for smoke-testing
 *     the Wrangler secrets after `npx wrangler secret put`.
 *
 *   GET /api/au/inventory
 *     Live inventory rows in the same shape as window.AU_DATA.inventory:
 *       { sku, name, category, kind, mult, soh, avail, incoming,
 *         warehouse_soh, warehouse_avail, warehouse_incoming,
 *         fba_cin7, fba_amz: null, discontinued }
 *     Built from CIN7 /Products + /Stock with the AU SKU normalisation rules
 *     codified in `AU Dashboard/au-sku-rules.md`. KV-cached at
 *     `au:inventory:v2` (15-min TTL); pass ?refresh=1 to bypass.
 *     Also returns `packaging` for the AU Packaging tab — SRT trays, outer
 *     cartons, envelopes and blank engraving tins, read straight off the
 *     unfiltered stock map (buildInventory's category whitelist drops them).
 *
 *   GET /api/au/sales?month=YYYY-MM
 *     One CIN7 /SalesOrders fetch services three views for the named month:
 *       channels  — Coles / Woolies / Distributors (Backend non-Coles).
 *                   Woo + Amazon channels are NOT here — those stay static
 *                   until Phase 3 wires the per-channel APIs (Woo + Amazon
 *                   are source-of-truth for their own sales; CIN7 is a
 *                   sync-mirror per the 2026-05-10 decision).
 *       refunds   — CIN7 'Cloud' channel rows, surfaced as a single negative
 *                   row at the bottom of Sales by Channel.
 *       skuSales  — per-base-SKU rollup of the CIN7-sourced channels (col,
 *                   woo2, dist columns only — woo + amz columns stay static).
 *     KV-cached at `au:sales:YYYY-MM:v1` (15-min TTL); ?refresh=1 to bypass.
 *
 *   GET /api/au/pos
 *     CIN7 /PurchaseOrders + derived `incomingBySku`. Adds the date + status
 *     fields the manual CSV export was missing (createdDate, deliveryDate,
 *     status), unlocking days-until-arrival + late-PO detection. Run rate
 *     for incomingBySku is a trailing 3-complete-month average per Melanie's
 *     pick (CA-style), computed by summing tins across the three most recent
 *     completed months and dividing by total days. Reads cached month-sales
 *     payloads from KV when available so PO refresh doesn't re-fetch sales.
 *     KV-cached at `au:pos:v1` (15-min TTL); ?refresh=1 to bypass.
 *
 * Auth model. CIN7 Omni uses HTTP Basic — API username + connection key — set
 * up in CIN7 → Integrations → API. Both go in as Wrangler secrets:
 *
 *   npx wrangler secret put CIN7_USERNAME
 *   npx wrangler secret put CIN7_CONNECTION_KEY
 *
 * Pagination. Omni's `/Products`, `/Stock`, `/SalesOrders`, `/PurchaseOrders`
 * use `page` (1-indexed) and `rows` (max 250). Bare-JSON-array responses;
 * stop when a page returns fewer rows than requested. We cap at 200 pages
 * (50,000 records) as a safety belt against a misbehaving upstream.
 *
 * Rate limits. CIN7 Omni is 3/sec, 60/min, 5,000/day. `cin7FetchAll` paces at
 * 400ms between pages; `cin7Fetch` retries 429s with backoff. **Never run
 * multiple endpoints concurrently via Promise.all** — Stock+Products in
 * parallel reliably trips the per-second cap. Always serialise.
 *
 * No `Buffer` on Workers — base64 the credential pair with `btoa()` instead.
 * Parked Express version of this client lives at `backend/server.js` in the
 * Drive project folder (Inventory only — SalesOrders/PurchaseOrders were
 * never wired there, this is the first implementation of those).
 */

import { Hono } from 'hono';

export const auRoutes = new Hono();

// ─── KV cache ───────────────────────────────────────────────────────────────

// v2 (2026-07-20): payload gained `packaging` for the AU Packaging tab. Bumped
// so a warm v1 entry can't serve a packaging-less payload for up to 15 minutes
// after deploy — the front end would render an empty tab and look broken.
const KV_INVENTORY_KEY = 'au:inventory:v2';
// au:pos:v4 (v2.2.16, 2026-05-16) — bumped because `expected_date` now falls
// back through CIN7's full date field chain (deliveryDate → estimatedDeliveryDate
// → estimatedArrivalDate → supplierAcceptanceDate). Payload shape gains
// expected_date_source + delivery_date / estimated_delivery_date /
// estimated_arrival_date / supplier_acceptance_date / invoice_date.
// au:pos:v3 (v2.2.15, 2026-05-16) — bumped alongside an isOpenPo rewrite.
// Previously the filter only checked `status` + `completedDate`, which left
// ~140 received-but-never-marked-Completed APPROVED POs leaking through
// (six months of inactive POs that CIN7 doesn't auto-close on the Status
// field). Now the filter also checks `fullyReceivedDate` (CIN7-auto-set
// when every line item is received), `cancellationDate`, `isVoid`, AND a
// line-item rollup fallback (every non-zero-qty line has `qtyShipped >= qty`)
// to catch legacy POs that CIN7 didn't backfill `fullyReceivedDate` on.
// au:pos:v2 (v2.2.14, 2026-05-15) — bumped from v1 to bust a stale snapshot
// observed showing all POs instead of just open ones. That fix added `'void'`
// to CLOSED_PO_STATUSES — see the comment on the set below for the history.
// au:pos:v5 (v2.2.67, 2026-07-02) — current_stock now INCLUDES Amazon FBA on
// base SKUs (was warehouse-only). Adds stock_fba to the incomingBySku breakdown.
// au:pos:v6 (v2.2.71, 2026-07-02) — incomingBySku rows gain empty_tins_soh /
// empty_tins_incoming (unfilled T-AU-… tin stock) so the forecast can flag a
// suggested finished PO that exceeds the empty tins available to fill it.
// au:pos:v9 (v2.2.82, 2026-07-20) — payload gains observedLeadTimes, median
// createdDate→fullyReceivedDate per supplier, for the Packaging tab's
// entered-vs-observed lead-time nudge.
// Future bumps: any time the response shape or filter logic changes.
const KV_POS_KEY       = 'au:pos:v9';
// Per-month sales: `au:sales:YYYY-MM:v4`. Helper below to build the key —
// kept versioned so a payload-shape bump invalidates cleanly. v2 (2026-05-11):
// `refunds` is now populated from /CreditNotes (was always 0 in v1 because
// /SalesOrders doesn't include credit notes); bump invalidates v1 caches that
// still have empty refunds for live months. v3 (2026-05-11): tightened SKU
// validation in credit-notes loop (excludes non-AU codes like CIN7's internal
// "196" placeholder) + dropped DRAFT credit notes from refund aggregation.
// Both changes shift refund tins/revenue numbers, so v2 caches are stale.
// v4 (v2.2.11, 2026-05-15): Phase C cutover — payload is now built from D1
// (`buildAuSalesPayloadFromD1`) instead of by fetching CIN7 directly per
// request. Shape is identical except `source` is `'cin7-d1'` and `counts`
// drops the upstream-fetch fields that no longer apply. v3 caches are stale.
// au:sales:YYYY-MM:v5 (v2.2.14, 2026-05-15) — bumped from v4 because the
// channels payload now includes a `woo` key sourced from D1's `orders` table
// (market='AU'), in addition to the existing col/woo2/dist (CIN7). Bumping
// invalidates v4 caches that don't have the woo channel populated.
// v8 (v2.2.47, 2026-06-02): Amazon AU hybrid source. Months >= 2026-05 read
// 'amz' from cin7_sales_orders (live, no manual CSV import needed). Months
// < 2026-05 keep reading 'amz' from amazon_orders (CSV-imported historical
// backfill — CIN7 sync only started capturing Amazon Seller orders mid-April).
// v7 (v2.2.20, 2026-05-17): channels.amz + skuSales rows gain an `amz` field
// + revenue includes Amazon revenue. Phase 3b-a finishes the Woo/Amazon
// symmetry — Amazon now sourced from amazon_orders + amazon_items (the
// historical CSV import is the seed; SP-API cron extension is Phase 3b-b).
// v6 (v2.2.18, 2026-05-16): skuSales rows gained a `woo` field. v5 → v6
// notes preserved in git history.
function kvSalesKey(month) { return `au:sales:${month}:v9`; }

// AU Amazon source cutover — months at-or-after this read 'amz' from CIN7
// sales orders (channel_attr='amz'); months before read 'amz' from
// amazon_orders (CSV-imported). String comparison works because YYYY-MM
// sorts lexicographically. See attributeCin7Order's Amazon branch.
//
// v2.2.49 (2026-06-02): moved cutover '2026-05' → '2026-06' after CIN7
// sales-orders cron stalled on a bulk-modification cluster at
// 2026-05-23T14:00:0XZ. The stall left May 24-31 Amazon orders unreached by
// the cron, so CIN7's May numbers under-counted vs amazon_orders' CSV-imported
// full backfill (e.g. AU-OG-NPO-35 read 269 vs CSV's 309). Keeping May on
// amazon_orders preserves accuracy; June onwards lives on CIN7 once the
// watermark is jumped past the cluster (commands/jump-cin7-watermark-to-june
// .command). Long-term cluster-aware cron in progress (next session).
const AU_AMAZON_CIN7_CUTOVER_MONTH = '2026-05';

// 15 min TTL — short enough that drift is bounded but long enough to absorb
// dashboard refreshes on the same minute. Bump the key suffix (v1 → v2) on
// any schema change so we don't return mismatched-shape cached payloads.
const INVENTORY_TTL_SECONDS = 15 * 60;
const SALES_TTL_SECONDS     = 15 * 60;
const POS_TTL_SECONDS       = 15 * 60;

// ─── CIN7 Omni client ──────────────────────────────────────────────────────

const CIN7_BASE = 'https://api.cin7.com/api/v1';
// Re-exported for src/cin7-sync.js (v2.36 Phase A) so the cron sync uses the
// same page-size + base-URL constants as the on-demand fetch helpers below.
// Exporting the constants rather than re-declaring keeps them DRY.
export const CIN7_PAGE_SIZE = 250;
export const CIN7_API_BASE  = CIN7_BASE;
const PAGE_SIZE = CIN7_PAGE_SIZE;
const MAX_PAGES = 200; // 50k records — soft cap

// CIN7 Omni rate limits: 3 calls/sec, 60 calls/min, 5000 calls/day.
// We pace pagination at ~2.5 calls/sec (400ms between pages) to stay safely
// under the per-second cap, and serialise Stock+Products instead of running
// them in parallel — running both concurrently doubles the rate and trips
// the 429. On 429 we retry with exponential backoff (1s, 2s, 4s) so a
// transient burst doesn't fail the whole inventory build.
const PAGE_DELAY_MS = 400;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cin7AuthHeader(env) {
  const user = (env.CIN7_USERNAME || '').trim();
  const key  = (env.CIN7_CONNECTION_KEY || '').trim();
  if (!user || !key) return null;
  return 'Basic ' + btoa(`${user}:${key}`);
}

function cin7Configured(env) {
  return !!cin7AuthHeader(env);
}

// Fetch a single CIN7 page. `endpoint` is the leaf path (e.g. 'Stock').
// Throws on non-200 with the upstream status + a truncated body for debugging.
// The credential pair is in the Authorization header — never in the URL —
// so a thrown error message can't leak it.
//
// Retries on 429 with exponential backoff (1s, 2s, 4s). Other 4xx/5xx are
// fatal — no point retrying a bad request or a server-side bug. We also
// retry once on a connection-level fetch() throw, since Workers→CIN7 is over
// the public internet and a transient blip shouldn't fail the whole build.
// Exported for src/cin7-sync.js so the cron sync reuses the same retry/429-
// backoff path as on-demand fetches. Behaviour is unchanged.
export async function cin7Fetch(env, endpoint, params = {}) {
  const auth = cin7AuthHeader(env);
  if (!auth) {
    throw new Error(
      'CIN7 not configured. Set CIN7_USERNAME and CIN7_CONNECTION_KEY ' +
      'with `npx wrangler secret put`.',
    );
  }
  const qs = new URLSearchParams({ page: 1, rows: PAGE_SIZE, ...params }).toString();
  const url = `${CIN7_BASE}/${endpoint}?${qs}`;
  const headers = {
    Authorization: auth,
    'Content-Type': 'application/json',
  };

  let lastErrBody = '';
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let resp;
    try {
      resp = await fetch(url, { headers });
    } catch (e) {
      // Network-level throw — retry once on the first attempt only.
      if (attempt === 0) {
        await sleep(RETRY_DELAYS_MS[0]);
        continue;
      }
      throw new Error(`CIN7 ${endpoint}: network error ${String(e?.message || e).slice(0, 200)}`);
    }
    if (resp.ok) return resp.json();

    lastErrBody = await resp.text().catch(() => '');
    if (resp.status === 429 && attempt < RETRY_DELAYS_MS.length) {
      // Rate-limited — back off and retry. CIN7 doesn't send Retry-After
      // headers we can rely on; use the schedule above.
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    // Non-retryable (or out of retries): throw with status + truncated body.
    throw new Error(`CIN7 ${endpoint}: ${resp.status} ${lastErrBody.slice(0, 200)}`);
  }
  throw new Error(`CIN7 ${endpoint}: exhausted retries; last body ${lastErrBody.slice(0, 200)}`);
}

// Paginate a CIN7 endpoint until a page comes back short. Returns the flat
// array of all records. `params` is merged into every request. Sleeps
// PAGE_DELAY_MS between pages (NOT before the first one) to stay under
// CIN7's 3 calls/sec rate limit.
export async function cin7FetchAll(env, endpoint, params = {}) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1) await sleep(PAGE_DELAY_MS);
    const items = await cin7Fetch(env, endpoint, { ...params, page, rows: PAGE_SIZE });
    if (!Array.isArray(items)) break;
    all.push(...items);
    if (items.length < PAGE_SIZE) break; // last page
  }
  return all;
}

// ─── AU SKU normalization (mirrors AU Dashboard/au-sku-rules.md) ───────────
//
// Returns [base_sku, multiplier_in_tins]. Pass-through for unknown patterns.
// Keep in sync with AU Dashboard/scripts/build_data.py:normalize_sku() — both
// implementations need the same rules or live and static numbers won't match.
// Exported for src/cin7-sync.js (v2.36 Phase A) so write-time derivation of
// base_sku + multiplier uses the same rules as the on-demand read path.
export function normalizeAuSku(sku) {
  const s = (sku || '').trim();
  if (!s) return [null, 1];
  // Wholesale carton (Woo): WC-AU-...-(NL|WC|nothing) = ×54
  let m = s.match(/^WC-(AU-.+?)(?:-(?:NL|WC))?$/);
  if (m) return [m[1], 54];
  // Retailer carton: AU-CTN-...-48 = ×48 → base is AU-...-35
  m = s.match(/^AU-CTN-(.+)-48$/);
  if (m) return [`AU-${m[1]}-35`, 48];
  // Mixed mega-tray: AU-CTN-SRT-MIX-... = ×72 (no rollup)
  if (s.startsWith('AU-CTN-SRT-MIX-')) return [s, 72];
  // Shelf-ready tray: AU-SRT-...x12 = ×12
  m = s.match(/^AU-SRT-(.+)x12$/);
  if (m) return [`AU-${m[1].replace(/-+$/, '')}`, 12];
  // Subscription -M = ×1
  m = s.match(/^(AU-.+)M$/);
  if (m) return [m[1], 1];
  return [s, 1];
}

// Cheap shape check — does `code` look like a real AU SKU? Real AU SKUs all
// start with `AU-`, `D-AU-` (rescue/discontinued mirrors), or `WC-AU-`
// (wholesale carton variants). Used to gate credit-note line aggregation:
// CIN7 occasionally puts internal placeholders in the `code` field of
// credit-note lines (e.g. `code: "196", name: "Credit Note"` on the
// Woolworths reconciliation credit notes — confirmed 2026-05-11 in the
// /CreditNotes diagnostic dump for CRN-72795 + CRN-72796). Those placeholder
// codes shouldn't get rolled up as if they were real product SKUs because
// their `qty` (e.g. -0.1775) is a fractional ratio, not a tin count, and
// `unitPrice` is enormous (e.g. $152,528.64). They DO contribute revenue
// (the credit note's `total` is the actual refund amount), so they're
// treated like empty-code "Amount" lines: revenue counts, tins/sku_lines
// don't. Keep this regex strict — adding a new prefix here is a deliberate
// product-rule change, not an accidental relax.
// Exported for src/cin7-sync.js (v2.36 Phase A) — same pattern for write-time
// `is_au_sku` flag on credit-note items as the on-demand read-side gating.
export function isAuSkuCode(code) {
  return /^(?:WC-|D-)?AU-/i.test(String(code || '').trim());
}

// Discontinued lines per Melanie 2026-05-10. Spicy Chai (SC) is end-of-life
// but stays as inventory rows so we can run down stock. Tagged + sunk to the
// bottom in the UI.
const DISCONTINUED_PATTERNS = [
  /^AU-(?:CTN-|B-)?SC-/,
  /^D-AU-SC-/,
];
function isDiscontinued(sku) {
  return DISCONTINUED_PATTERNS.some((re) => re.test(sku));
}

// ─── Stock + Products ingestion ────────────────────────────────────────────

// FBA branch detection. CIN7's actual branch name is "Amazon FBA" (with a
// space) — confirmed from CIN7's UI 2026-05-10. v2.34's strict equality
// against `'amazonfba'` (no space) failed silently, leaving `fba_cin7: 0`
// for every SKU. Switched to a whitespace-insensitive substring match so
// we tolerate "Amazon FBA", "AmazonFBA", "Amazon-FBA", etc. — and any
// "Amazon FBA AU" if CIN7 adds region-tagged branches later.
function isFbaBranchName(branchName) {
  return /amazon\s*fba/i.test(branchName || '');
}

// Stock comes back per (productOption × branch). The CSV pipeline (build_data.py)
// reads SKU-level totals from CIN7's stock-by-branch CSV, but the API gives us
// per-branch rows that we have to aggregate.
//
// We keep three buckets per SKU:
//   • total      — sum across all branches
//   • fba        — Amazon FBA branch only (drift detection vs SP-API truth)
//   • warehouse  — derived as total − fba (everything not at FBA)
//
// "Warehouse" is the operationally relevant number: physical stock we control
// and can fulfill Woo / wholesale / EDI orders from. FBA stock is one-way
// (Amazon-fulfilled only, replenished on its own cadence). Surfacing them
// separately matters because conflating them (v2.34 just summed total) hides
// the actionable bucket.
export async function fetchStockBySku(env) {
  const fields = [
    'productId', 'productOptionId', 'modifiedDate', 'styleCode', 'code', 'barcode',
    'branchId', 'branchName', 'productName',
    'option1', 'option2', 'option3',
    'available', 'stockOnHand', 'openSalesOrders', 'openPurchaseOrders',
    'virtual', 'holding',
  ].join(',');
  const stockRows = await cin7FetchAll(env, 'Stock', { fields });

  const bySku = new Map();
  for (const row of stockRows) {
    const code = (row.code || row.styleCode || '').trim();
    if (!code) continue;
    const acc = bySku.get(code) || {
      code,
      name: '',
      // Totals across all branches
      soh: 0,
      avail: 0,
      incoming: 0,
      // FBA branch only (Amazon FBA, isFbaBranchName-matched)
      fba_soh: 0,
      fba_avail: 0,
      fba_incoming: 0,
    };
    const stockOnHand        = Number(row.stockOnHand)        || 0;
    const available          = Number(row.available)          || 0;
    const openPurchaseOrders = Number(row.openPurchaseOrders) || 0;
    // Total accumulates across every branch
    acc.soh      += stockOnHand;
    acc.avail    += available;
    acc.incoming += openPurchaseOrders;
    // FBA branch is captured separately for drift detection + warehouse split
    if (isFbaBranchName(row.branchName)) {
      acc.fba_soh      += stockOnHand;
      acc.fba_avail    += available;
      acc.fba_incoming += openPurchaseOrders;
    }
    if (!acc.name && row.productName) {
      const opt = [row.option1, row.option2, row.option3].filter(Boolean).join(' / ');
      acc.name = (opt ? `${row.productName} — ${opt}` : row.productName).slice(0, 60);
    }
    bySku.set(code, acc);
  }
  return bySku;
}

// Empty (unfilled) tins live in CIN7 under a `T-` prefix on the finished SKU:
//   T-AU-OG-NPO-35   → AU-OG-NPO-35     (scent-specific, 1:1 with the finished good)
//   T-AU-B-MJ-BCF-35 → AU-B-MJ-BCF-35   (black tins keep the B-)
// A finished-goods run can only be FILLED if we hold enough empty tins for that
// scent, so the forecast surfaces empty-tin stock per base SKU as a supply
// check on the suggested PO. Empty tins run their own ~4-month lead and their
// own POs — the full tin-ordering plan lives in the (separate) AU Packaging
// forecast; here we only show on-hand + incoming so a short finished PO is
// visible. Excluded from the map:
//   • T-L-AU-…      — lids (a separate component; strip "T-" → "L-AU-…" which is
//                     not a finished SKU, so it never matches regardless)
//   • T-AU-BLANK-…  — unlabelled blank-tin pool (not scent-specific)
// Empty tins are never held at Amazon FBA, so the all-branches SOH is the
// fillable pool. Returns Map<finishedSku, { soh, incoming }>.
function buildEmptyTinsBySku(stockBySku) {
  const out = new Map();
  for (const [code, s] of stockBySku.entries()) {
    if (!code.startsWith('T-AU-')) continue;   // empty tins for AU finished goods
    const finished = code.slice(2);            // drop the leading "T-"
    if (!/^AU-.*-(35|85)$/.test(finished)) continue;  // finished base tins only
    if (/^AU-BLANK/.test(finished)) continue;         // unlabelled blank pool
    const cur = out.get(finished) || { soh: 0, incoming: 0 };
    cur.soh      += (s.soh || 0);
    cur.incoming += (s.incoming || 0);
    out.set(finished, cur);
  }
  return out;
}

// ── AU packaging stock (Packaging tab) ────────────────────────────────────
//
// CIN7 carries every packaging SKU with real SOH/incoming, but buildInventory()
// filters the payload down to Finished Products / Bicarb Based, so these rows
// never reach the front end. buildStockBySku() upstream applies no category
// filter at all, so we read straight off it — same trick buildEmptyTinsBySku
// uses — and no extra API call is needed.
//
// Four buckets, matching how AU actually reorders:
//   srt        P-AU-SRT-<scent>-<form>       12-tin shelf-ready trays (TC Printing)
//   cartons    P-OC-AU-CTN-<scent>-<form>-48 printed outers, 4 SRTs each (SPS)
//              P-AU-{BLANK,PRINTED}-*OUTERS  unbranded/generic outers
//   envelopes  P-ENV-A1, P-BOX-12x85         D2C mailers (Huizhou ZTJ)
//   blankTins  T-AU-BLANK-*                  engraving stock — NOT a sticker pool
//
// Deliberately excluded:
//   • T-L-AU-…          lids. Discontinued (Mel, 2026-07-20) — not going forward.
//                       Note classifyPoLineCode() still counts these as raw_tin
//                       via its `T-` catch-all; harmless while stock runs out.
//   • PCI               postcard inserts. Treated as a marketing expense and not
//                       stock-tracked in CIN7 — it exists only as a PO line, so
//                       there is no SOH to report. Left out until that changes.
//   • P-AU-BD-NPS-100   soap wrap. Belongs to the soap line, not this tab.
//
// SRT naming does NOT follow the finished-goods convention: trays carry no size
// suffix (P-AU-SRT-LL-BCF, not -35) because every AU tray is 12 × 35g. Black
// variants keep their B- infix (P-AU-SRT-B-MJ-BCF → AU-B-MJ-BCF-35). We rebuild
// the finished SKU by re-appending -35 so the tray can inherit that SKU's demand.
const SRT_TIN_CAPACITY   = 12;  // tins per shelf-ready tray
const CARTON_SRT_CAPACITY = 4;  // SRTs per printed outer carton (= 48 tins)

function buildAuPackagingBySku(stockBySku) {
  const srt = [], cartons = [], envelopes = [], blankTins = [];

  // A derived link is only real if that finished SKU still exists in CIN7.
  // Retired lines keep their packaging on the shelf long after the finished
  // good is delisted — Spicy Chai (SC) is the live example: P-OC-AU-CTN-SC-BCF-48
  // and its SRT trays still hold stock, but AU-CTN-SC-*-48 is gone from the
  // catalogue. Marking those rows discontinued keeps them visible as dead stock
  // to use up or write off, instead of showing a demand-less row that reads
  // like a supply problem.
  const linkOrNull = (sku) => (sku && stockBySku.has(sku)) ? sku : null;

  for (const [code, s] of stockBySku.entries()) {
    // Common shape — every bucket returns the same keys so the front end can
    // render any of them through one row renderer. Branches override as needed.
    const row = {
      sku:      code,
      name:     s.name || '',
      soh:      s.soh      || 0,
      avail:    s.avail    || 0,
      incoming: s.incoming || 0,
      linkedSku:    null,   // finished SKU whose sales drive this row's demand
      capacity:     null,   // tins per tray / SRTs per carton
      manualDemand: false,  // no derivable link — demand entered by hand
      discontinued: false,  // linked finished SKU no longer in the catalogue
    };

    if (code.startsWith('P-AU-SRT-')) {
      // Secret Scenta (P-AU-SRT-SS) has no scent/form pair, so it can't inherit
      // demand from a finished SKU. Mirrors the NA treatment — surfaced with
      // stock only and flagged for manual demand.
      const tail = code.slice('P-AU-SRT-'.length);
      const derived = /^[A-Z0-9]+-[A-Z0-9]+(-[A-Z0-9]+)?$/.test(tail) && tail !== 'SS'
        ? `AU-${tail}-35`
        : null;
      const linked = linkOrNull(derived);
      srt.push({ ...row, linkedSku: linked, capacity: SRT_TIN_CAPACITY,
                 // No scent/form pair at all (Secret Scenta) → demand typed by hand.
                 manualDemand: derived === null,
                 // Had a valid-looking link, but that finished SKU is gone.
                 discontinued: derived !== null && linked === null });
      continue;
    }

    if (code.startsWith('P-OC-AU-CTN-')) {
      // Printed outer — strip the P-OC- prefix to get the finished carton SKU
      // (P-OC-AU-CTN-EF-BCF-48 → AU-CTN-EF-BCF-48), whose sales drive demand.
      const derived = code.slice('P-OC-'.length);
      const linked = linkOrNull(derived);
      cartons.push({ ...row, linkedSku: linked, capacity: CARTON_SRT_CAPACITY,
                     blank: false, discontinued: linked === null });
      continue;
    }

    if (/^P-AU-(BLANK|PRINTED)-.*OUTERS$/.test(code)) {
      // Generic outers aren't tied to a scent, so there's no sales series to
      // forecast from. Stock-only with a low-stock flag (Mel: "hard to
      // forecast, so probably more flag if stock is getting low").
      cartons.push({ ...row, blank: true, manualDemand: true });
      continue;
    }

    // Envelope stock. NOTE the bare `ENVELOPES` code — it carries no P- prefix,
    // so an earlier prefix-only rule dropped it silently and understated the
    // envelope position by 22,680 units (Mel spotted the missing SKU,
    // 2026-07-20). Match on an explicit list rather than a prefix so a
    // similarly odd code can't slip through unnoticed again.
    //
    // ENVELOPES ("Perforated Envelopes") and P-ENV-A1 ("Large Perforated
    // Envelope") are both D2C mailers drawing on the same order stream, so the
    // front end pools their supply against one demand figure rather than giving
    // each the full rate (which would double-count demand). P-BOX-12x85 is a
    // 12 × 85g shipping box, not a mailer — it has no derivable driver and
    // stays on the watch list.
    if (code === 'ENVELOPES' || code === 'P-ENV-A1' || code === 'P-BOX-12x85') {
      envelopes.push({ ...row });
      continue;
    }

    if (code.startsWith('T-AU-BLANK-')) {
      // Engraving stock. AU does not sticker blanks onto branded runs, so this
      // is a standalone line with its own reorder point — none of the NA blank
      // -pool allocation applies. Bases and lids are stocked separately
      // (T-AU-BLANK-BASE-35 / -LID-35) alongside complete blanks.
      blankTins.push({ ...row, manualDemand: true });
      continue;
    }
  }

  const bySku = (a, b) => String(a.sku).localeCompare(String(b.sku));
  return {
    srt:       srt.sort(bySku),
    cartons:   cartons.sort(bySku),
    envelopes: envelopes.sort(bySku),
    blankTins: blankTins.sort(bySku),
  };
}

// Products gives us category / status. We need this to filter the inventory
// rows down to Finished Products + Bicarb Based + uncategorised (which is how
// build_data.py does it). Returns Map<sku, { category, status }>.
async function fetchProductMeta(env) {
  const fields = [
    'id', 'styleCode', 'name', 'status',
    'category', 'productType', 'productOptions',
  ].join(',');
  const products = await cin7FetchAll(env, 'Products', { fields });

  const meta = new Map();
  for (const p of products) {
    const opts = Array.isArray(p.productOptions) && p.productOptions.length ? p.productOptions : null;
    if (opts) {
      for (const o of opts) {
        const code = (o.code || p.styleCode || '').trim();
        if (!code) continue;
        meta.set(code, {
          category: p.category || '',
          status: o.status || p.status || '',
        });
      }
    } else {
      const code = (p.styleCode || '').trim();
      if (code) meta.set(code, { category: p.category || '', status: p.status || '' });
    }
  }
  return meta;
}

// True for the soap product family — AU-{scent}-NPS-100. NPS = "No Pong Soap"
// formula, -100 = 100 g bar. Detected by SKU suffix so we don't depend on the
// CIN7 product category string (which sits in its own category and gets
// filtered out by the default whitelist below). v2.2.47: added so soap stock
// surfaces on the Inventory tab. Soap is deliberately excluded from the
// Incoming-stock-by-SKU PO table — the only soap SKU live today
// (AU-BD-NPS-100) is the birthday-only run, not coming back until next year,
// so a per-SKU run-rate / days-left view would be misleading.
function isAuSoapSku(code) {
  return /-NPS-100$/.test(String(code || ''));
}

// Build the inventory list in the shape window.AU_DATA.inventory has today.
// Mirrors AU Dashboard/scripts/build_data.py:build_inventory():
//   • Folds AU-SRT-...x12 rows into their base SKU as ×12 tins (SOH + avail).
//   • Drops AU-CTN-SRT-MIX-* (mixed mega-trays — handled in Packaging).
//   • Drops CANVAS / AU-BAG codes (apparel / merch).
//   • Filters to category in {Finished Products, Bicarb Based, ''} (uncategorised).
//     EXCEPTION: AU-{scent}-NPS-100 soap SKUs bypass the category filter — they
//     sit in their own CIN7 category, but we want them tracked on the dashboard.
//   • Tags AU-CTN-* as kind:'carton', AU-B-* as kind:'base-b',
//     AU-*-NPS-100 as kind:'soap', else kind:'base'.
//   • Marks Spicy Chai SKUs as discontinued.
function buildInventory(stockBySku, productMeta) {
  // First pass: SRT rollup — find AU-SRT-...x12 rows and accumulate their
  // contribution (×12 tins) onto the matching base SKU. Drop SRT rows that
  // don't have a base in stock (orphan trays — rare but possible). SRTs are
  // physical-warehouse-only (Amazon FBA never sees trays), so we only roll
  // them up into the warehouse buckets, not FBA.
  const srtExtraSoh   = new Map();
  const srtExtraAvail = new Map();
  for (const [code, s] of stockBySku.entries()) {
    if (!code.startsWith('AU-SRT-') || code.startsWith('AU-CTN-SRT-')) continue;
    const [base, mult] = normalizeAuSku(code);
    if (!base || !stockBySku.has(base)) continue;
    // Use warehouse component (total minus FBA) so we don't double-count FBA
    // tray stock. In practice FBA never holds trays, so this is just defensive.
    const sohWarehouse   = s.soh   - s.fba_soh;
    const availWarehouse = s.avail - s.fba_avail;
    srtExtraSoh.set(base,   (srtExtraSoh.get(base)   || 0) + (sohWarehouse   * mult));
    srtExtraAvail.set(base, (srtExtraAvail.get(base) || 0) + (availWarehouse * mult));
  }

  const out = [];
  for (const [code, s] of stockBySku.entries()) {
    if (!code.startsWith('AU-')) continue;
    if (code.includes('CANVAS') || code.startsWith('AU-BAG')) continue;
    if (code.startsWith('AU-SRT-') || code.startsWith('AU-CTN-SRT-')) continue;

    const meta = productMeta.get(code) || {};
    const cat = meta.category || '';
    const isSoap = isAuSoapSku(code);
    // Soap SKUs (AU-*-NPS-100) bypass the category whitelist — they sit in
    // their own CIN7 category but Mel wants them tracked on the dashboard.
    if (!isSoap && cat && cat !== 'Finished Products' && cat !== 'Bicarb Based') continue;

    let kind, mult;
    if (isSoap)                          { kind = 'soap';   mult = 1; }
    else if (code.startsWith('AU-CTN-')) { kind = 'carton'; mult = 48; }
    else if (code.startsWith('AU-B-'))   { kind = 'base-b'; mult = 1; }
    else                                  { kind = 'base';   mult = 1; }

    // SRT trays are warehouse-only (FBA never holds trays), so the rollup
    // contribution lands on the warehouse and total buckets but not FBA.
    const srtSoh   = srtExtraSoh.get(code)   || 0;
    const srtAvail = srtExtraAvail.get(code) || 0;
    const totalSoh      = s.soh      + srtSoh;
    const totalAvail    = s.avail    + srtAvail;
    const totalIncoming = s.incoming;
    const warehouseSoh      = totalSoh      - s.fba_soh;
    const warehouseAvail    = totalAvail    - s.fba_avail;
    const warehouseIncoming = totalIncoming - s.fba_incoming;

    out.push({
      sku:                code,
      name:               s.name,
      category:           cat,
      kind,
      mult,
      // Total across all branches — kept for backwards compat with callers
      // that previously used these fields, and for KPIs that want the global
      // headline number. Most UI now reads warehouse_* preferentially.
      soh:                totalSoh,
      avail:              totalAvail,
      incoming:           totalIncoming,
      // Warehouse-only — physical stock we control (Ingleburn + any non-FBA
      // branches). This is what the Inventory tab shows by default; status
      // thresholds (low stock < 100) and the on-hand KPIs run off this.
      warehouse_soh:      warehouseSoh,
      warehouse_avail:    warehouseAvail,
      warehouse_incoming: warehouseIncoming,
      // FBA branch only — CIN7's mirror of what Amazon FBA holds. Drift
      // detection vs `fba_amz` (Amazon SP-API truth, Phase 3) flags any
      // CIN7-side sync issue when `|fba_amz - fba_cin7| > 10`.
      fba_cin7:           s.fba_soh,
      fba_amz:            null,
      discontinued:       isDiscontinued(code),
    });
  }
  // Stable order: discontinued sink to bottom, otherwise warehouse SOH desc
  // (the operationally relevant number — what's reorderable).
  out.sort((a, b) => {
    if (a.discontinued !== b.discontinued) return a.discontinued ? 1 : -1;
    return (b.warehouse_soh || 0) - (a.warehouse_soh || 0);
  });
  return out;
}

// Single entry point. Pulls Stock then Products SERIALLY (not Promise.all)
// to stay under CIN7's per-second rate limit — running both concurrently
// roughly doubles the request rate and reliably trips the 3/sec cap.
// Combined with PAGE_DELAY_MS pacing in cin7FetchAll and the 429-backoff
// retry in cin7Fetch, this gives us a defence-in-depth against the limit.
// Total wall time on a cold cache is dominated by Stock pages × delay; for
// AU's catalogue size that's typically 2–4 seconds. Within Worker budget.
async function buildAuInventoryPayload(env) {
  const stockBySku  = await fetchStockBySku(env);
  const productMeta = await fetchProductMeta(env);
  const inventory = buildInventory(stockBySku, productMeta);
  // Empty-tin stock per finished base SKU (T-AU-… rows) — a fillability check
  // for the forecast's suggested PO. Plain object so it survives KV JSON.
  const emptyTins = Object.fromEntries(buildEmptyTinsBySku(stockBySku));
  // Packaging stock (SRTs / outer cartons / envelopes / blank engraving tins).
  // Same stockBySku source as emptyTins — buildInventory's category whitelist
  // would otherwise drop every one of these rows before the front end sees them.
  const packaging = buildAuPackagingBySku(stockBySku);
  return {
    inventory,
    emptyTins,
    packaging,
    lastSync: new Date().toISOString(),
    source:   'cin7-live',
    counts: {
      stockSkus:    stockBySku.size,
      productSkus:  productMeta.size,
      inventoryRows: inventory.length,
      emptyTinSkus:  Object.keys(emptyTins).length,
      packagingSkus: packaging.srt.length + packaging.cartons.length
                   + packaging.envelopes.length + packaging.blankTins.length,
    },
  };
}

// ─── Sales orders (Phase 2b) ───────────────────────────────────────────────
//
// CIN7 sales-order attribution. Returns one of:
//   'col'    — Coles (EDI direct OR via Coles parent co/DC)
//   'woo2'   — Woolworths (EDI direct OR via Woolworths warehouse)
//   'dist'   — Distributors / wholesale (real-business orders not Coles/Woolies)
//   'refund' — Cloud channel (defensive — Omni v1 doesn't actually populate
//              this field; real refunds live in /CreditNotes which this PR
//              doesn't fetch yet)
//   null     — exclude (Stock Adjustments, VOID, Amazon mirror, Woo retail
//              mirror, personal/single-name orders)
//
// Key learning from v2.35.2 diagnostic dump (2026-05-11): on Omni v1's
// /SalesOrders endpoint, `channel` and `posRegister` are EMPTY for ALL
// orders. The static side's "Channel = 'Backend' / 'Cloud'" attribution
// rules from build_data.py:attribute_cin7() can't replicate against the
// API. Instead, attribution has to inspect the `company` field, which
// holds the SHIPPING ADDRESS company name:
//
//   "WOOLWORTHS - Moorebank - NDC"          → woo2 (Woolies warehouse)
//   "Coles"                                 → col (rare — EDI direct)
//   "Grocery Holdings Pty Ltd - RedBank"    → col (Coles parent co)
//   "Grocery Holdings Pty Ltd - NDC SOMERTON" → col (Coles DC)
//   "Kemps Creek"                           → col (known Coles DC name)
//   "Amazon Seller No Pong Natural Products" → null (Amazon mirror)
//   "Amazon FBA"                            → null (Amazon FBA replenishment)
//   "Stock Adjustments"                     → null
//   "" / "[Redacted]"                       → null (Woo retail mirror)
//   "Mr" / "Mrs" / "Ms" / "Private"         → null (personal orders)
//   anything else with a real company name  → 'dist' (wholesale)
//
// VOID-status orders are filtered upstream (in buildAuSalesPayload) so they
// never reach this function.
const _COLES_PERSONAL_MARKERS = new Set(['mr', 'mrs', 'ms', 'private']);
const _COLES_DC_NAMES = new Set([
  'kemps creek',           // Coles DC at Kemps Creek NSW
]);

// Exported for src/cin7-sync.js (v2.36 Phase A) — caches channel_attr on
// `cin7_sales_orders` at write time so read-side aggregates are simple
// GROUP BY queries without per-row attribution logic.
export function attributeCin7Order(order) {
  // Defensive: even though the diagnostic showed channel always empty,
  // accept it if some account does populate it (e.g. Cloud refunds in
  // future Omni versions).
  const channel = String(order?.channel || '').trim();
  if (channel === 'Cloud') return 'refund';

  const company = String(order?.company   || '').trim();
  const first   = String(order?.firstName || '').trim();
  const cl      = company.toLowerCase();

  // Stock Adjustments — inventory movements, not sales
  if (company === 'Stock Adjustments' || first === 'Stock Adjustments') return null;

  // Amazon sales by ORDER-ID REFERENCE — the reliable signal. CIN7 records
  // SOME Amazon orders with the customer/company redacted (company='[Redacted]'
  // or blank), so keying off the company string alone undercounts them.
  // Verified 2026-06-30: 273 May orders carried Amazon-format references + AU
  // SKUs but were dropped to NULL by the company rule below (the [Redacted]
  // surge began late May; June had none). The Amazon order-ID format
  // (NNN-NNNNNNN-NNNNNNN) is distinctive and stable — cross-checked against all
  // June Amazon-ref orders with zero false positives (no Coles/Woolies/dist
  // order uses this shape). This runs before the retailer/company rules so a
  // redacted Amazon sale is caught regardless of how CIN7 labelled the customer.
  const reference = String(order?.reference || '').trim();
  if (/^\d{3}-\d{7}-\d{7}$/.test(reference)) return 'amz';

  // Coles / Woolies pattern matching
  if (cl.includes('woolworths'))        return 'woo2';
  if (cl === 'coles')                   return 'col';
  if (cl.includes('grocery holdings'))  return 'col';   // Coles parent co
  if (_COLES_DC_NAMES.has(cl))          return 'col';

  // Amazon orders. CIN7 mirrors them from Seller Central for fulfilment.
  // v2.2.47 (2026-06-02): Amazon Seller orders now attribute to 'amz' and
  // count toward the Amazon channel on the dashboard for months >= the
  // AU_AMAZON_CIN7_CUTOVER_MONTH (see buildAuSalesPayloadFromD1). Pre-cutover
  // months still read from amazon_orders (CSV-imported, full backfill).
  // Amazon FBA is REPLENISHMENT (warehouse restock), not a sale — keep null.
  if (cl.startsWith('amazon seller')) return 'amz';
  if (cl.startsWith('amazon'))        return null;  // FBA, other Amazon flavours

  // No company OR redacted personal customer → likely Woo retail mirror.
  // Don't count as CIN7-sourced sales (Phase 3 wires Woo direct).
  if (!company || company === '[Redacted]') return null;

  // Personal-name single tokens → individual retail orders
  if (_COLES_PERSONAL_MARKERS.has(cl)) return null;

  // Anything else with a real company name → distributor / wholesale.
  // This is broader than the static side's "Backend channel only" filter
  // (the API doesn't expose channel) — it'll over-count distributors vs
  // static for months that have small wholesale orders, which is more
  // honest than the static under-reporting them.
  return 'dist';
}

// Backwards-compat shim — old attributeCin7Channel signature is no longer
// used by buildAuSalesPayload but kept for any external callers (none in
// the current codebase). New code should call attributeCin7Order(order).
function attributeCin7Channel(channelRaw, customerRaw) {
  return attributeCin7Order({ channel: channelRaw, company: customerRaw });
}

// Pull SalesOrders for a single calendar month. CIN7 Omni's `/SalesOrders`
// supports a `where` clause filter; we use createdDate so an order created
// on the last day of the month but dispatched in the next month still
// belongs to its origination month (matches what the static CSV pivot does).
//
// Returns the raw rows, NOT aggregated — `buildAuSalesPayload` does the
// channel attribution + SKU rollup. Field selection is conservative; we
// capture line items via `lineItems` (default expansion in Omni), and pull
// the channel/POS register fields under both names since some Omni accounts
// expose them differently.
async function fetchSalesOrdersForMonth(env, month /* 'YYYY-MM' */) {
  const [y, m] = month.split('-').map(Number);
  // First day of month (inclusive) → first day of next month (exclusive).
  // CIN7 createdDate is an ISO-8601 timestamp; range comparisons work.
  const dateFrom = `${month}-01T00:00:00Z`;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const dateTo = `${nextY}-${String(nextM).padStart(2, '0')}-01T00:00:00Z`;
  const where = `CreatedDate>='${dateFrom}' AND CreatedDate<'${dateTo}'`;

  // Omni `fields` selection. Includes channel + posRegister (one or both
  // populated depending on account config), customer fields, and lineItems
  // for the per-SKU breakdown.
  const fields = [
    'id', 'reference', 'createdDate', 'dispatchedDate',
    'channel', 'posRegister', 'branchName',
    'memberId', 'memberEmail', 'firstName', 'lastName', 'company',
    'status', 'invoiceStatus',
    'total', 'subTotal', 'productTotal',
    'lineItems',
  ].join(',');

  return cin7FetchAll(env, 'SalesOrders', { fields, where });
}

// Pull CreditNotes for a single calendar month. CIN7 Omni v1 splits credit
// notes onto a separate endpoint from SalesOrders — the static pivot CSV
// combined them but the API doesn't, so v2.35.3 attribution returned 0
// refunds for live months. Same pagination + where-clause shape as
// fetchSalesOrdersForMonth so the line-item handling in buildAuSalesPayload
// can reuse the v2.35.4 rules unchanged.
//
// Field selection mirrors the SalesOrders shape — credit notes have the
// same lineItems schema (code, qty, uomSize, parentId, total) so the
// parent/child + Alt UOM rules apply identically. We don't need
// channel/posRegister here (those were empty anyway and refunds are
// aggregated as a single global pool, not per-channel).
async function fetchCreditNotesForMonth(env, month /* 'YYYY-MM' */) {
  const [y, m] = month.split('-').map(Number);
  const dateFrom = `${month}-01T00:00:00Z`;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const dateTo = `${nextY}-${String(nextM).padStart(2, '0')}-01T00:00:00Z`;
  const where = `CreatedDate>='${dateFrom}' AND CreatedDate<'${dateTo}'`;

  const fields = [
    'id', 'reference', 'createdDate',
    'memberId', 'memberEmail', 'firstName', 'lastName', 'company',
    'status', 'invoiceStatus',
    'total', 'subTotal', 'productTotal',
    'lineItems',
  ].join(',');

  return cin7FetchAll(env, 'CreditNotes', { fields, where });
}

// Customer label — the Python script uses a single `customer` column from
// the pivot. The Omni API exposes it across `company` (B2B) and
// firstName+lastName (individuals). For attribution we only need to detect
// 'Coles', 'Woolworths', 'Stock Adjustments', so company is the field that
// matters for channel logic; the personName fallback is for refund-row
// display only.
function customerLabelFromOrder(order) {
  const company = (order?.company || '').trim();
  if (company) return company;
  const first = (order?.firstName || '').trim();
  const last  = (order?.lastName  || '').trim();
  return [first, last].filter(Boolean).join(' ') || '';
}

// Build the AU sales payload for one month. Aggregates raw SalesOrders into:
//   • channels  — { col, woo2, dist }: { tins, revenue, orders }
//   • refunds   — { tins, revenue, orders, sku_lines }
//   • skuSales  — [{ sku (base), name, col, woo2, dist, total_tins, revenue }]
// Same shape as the matching slices of static AU_DATA, with two intentional
// gaps: woo + amz channels are NOT here (they stay static until Phase 3),
// and the per-SKU rows only have col/woo2/dist columns populated for the
// same reason. Frontend merges with static woo/amz on the per-channel side.
async function buildAuSalesPayload(env, month) {
  // Serial fetch — never Promise.all'd, per CIN7's 3/sec rate-limit rule
  // (also documented in project_cin7_omni_constraints.md). SalesOrders
  // first, then CreditNotes; both share the cin7FetchAll pacing.
  const allOrders = await fetchSalesOrdersForMonth(env, month);
  const allCreditNotes = await fetchCreditNotesForMonth(env, month);

  // Drop VOID/CANCELLED orders before attribution — they're not sales.
  // CIN7 Omni v1 status values seen in the wild: APPROVED, VOID. Match
  // case-insensitively + future-proof against VOIDED/CANCELLED variants.
  const orders = allOrders.filter((o) => {
    const s = String(o?.status || '').trim().toUpperCase();
    return s !== 'VOID' && s !== 'VOIDED' && s !== 'CANCELLED';
  });
  const voidsDropped = allOrders.length - orders.length;

  // Drop VOID/CANCELLED AND DRAFT credit notes. v2.35.5 only filtered VOID
  // variants which let DRAFT slip through — and the April 2026 diagnostic
  // surfaced a single DRAFT Woolworths reconciliation credit note (CRN-72795,
  // -$29,781) that alone explained nearly all of the revenue overage vs the
  // static April snapshot. DRAFT means "not yet finalized in CIN7" — pending,
  // not booked — so it shouldn't count toward refund totals on the dashboard.
  // The static side excluded DRAFT implicitly (the pivot CSV only contained
  // posted documents). Match that.
  const creditNotes = allCreditNotes.filter((cn) => {
    const s = String(cn?.status || '').trim().toUpperCase();
    return s !== 'VOID' && s !== 'VOIDED' && s !== 'CANCELLED' && s !== 'DRAFT';
  });
  const creditVoidsDropped = allCreditNotes.length - creditNotes.length;

  // Per-channel aggregates
  const channels = {
    col:  { tins: 0, revenue: 0, orderRefs: new Set() },
    woo2: { tins: 0, revenue: 0, orderRefs: new Set() },
    dist: { tins: 0, revenue: 0, orderRefs: new Set() },
  };
  const refunds = {
    tins: 0, revenue: 0, orderRefs: new Set(),
    sku_lines: new Map(),    // baseSku → { tins, sales, name }
  };
  // Per-base-SKU rollup, keyed by base SKU. Each value tracks tins per
  // CIN7 channel (col/woo2/dist) plus a running revenue + name.
  const skuRollup = new Map();

  for (const order of orders) {
    const channelAttr = attributeCin7Order(order);
    if (channelAttr === null) continue; // Stock Adjustments, mirror, retail — skip

    const orderRef = String(order.reference || order.id || '');
    const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];

    for (const li of lineItems) {
      const code = String(li?.code || li?.sku || '').trim();
      if (!code) continue;

      // v2.35.4 — skip CHILD line items. CIN7 explodes bundled products
      // (e.g. AU-CTN-SRT-MIX-72-V3 "6-pack of trays") into a parent line
      // for the bundle + auto-generated child lines for each constituent
      // SKU. Children have parentId pointing at the parent's line ID;
      // standalone or parent lines have parentId === 0. Counting both
      // double-counts (the parent's mult already represents the children's
      // tin volume).
      const parentId = Number(li?.parentId ?? 0) || 0;
      if (parentId > 0) continue;

      const qty       = Number(li?.qty ?? li?.quantity ?? 0) || 0;
      const uomSize   = Number(li?.uomSize ?? 0) || 0;
      // Omni line item totals: prefer `total` (qty × unitPrice net),
      // fall back to qty × unitPrice if `total` not provided.
      const unitPrice = Number(li?.unitPrice ?? 0) || 0;
      const lineTotal = Number(li?.total ?? (qty * unitPrice)) || 0;
      const name      = String(li?.name || '').slice(0, 60);

      const [base, mult] = normalizeAuSku(code);
      const baseKey = base || code;

      // v2.35.4 — Alt UOM lines (e.g. WC-AU-OG-NPO-35 wholesale cartons)
      // have `uomSize > 1` and report qty already in BASE units (tins).
      // Standalone SKUs like AU-CTN-OG-NPO-48 have uomSize === 1 and
      // report qty in product units (cartons). Apply the SKU-pattern
      // multiplier only in the latter case — otherwise we'd 54x-over-count
      // every wholesale carton line.
      const tins = uomSize > 1 ? qty : qty * mult;

      if (channelAttr === 'refund') {
        refunds.tins    += tins;
        refunds.revenue += lineTotal;
        refunds.orderRefs.add(orderRef);
        const acc = refunds.sku_lines.get(baseKey) || { tins: 0, sales: 0, name: '' };
        acc.tins  += tins;
        acc.sales += lineTotal;
        if (!acc.name && name) acc.name = name;
        refunds.sku_lines.set(baseKey, acc);
        continue;
      }

      const ch = channels[channelAttr];
      ch.tins    += tins;
      ch.revenue += lineTotal;
      ch.orderRefs.add(orderRef);

      // Per-SKU rollup row
      const row = skuRollup.get(baseKey) || {
        sku: baseKey, name: '',
        col: 0, woo2: 0, dist: 0,
        revenue: 0,
      };
      row[channelAttr] += tins;
      row.revenue      += lineTotal;
      if (!row.name && name) row.name = name;
      skuRollup.set(baseKey, row);
    }
  }

  // Credit notes — aggregate as a single global refund pool, ALWAYS negative.
  // We don't attribute per-channel (matches the static side's single negative
  // refunds row); per-channel refund attribution is a Phase 3 polish item once
  // Cloud-channel data lands. Math.abs() + negation makes us robust to CIN7's
  // sign convention regardless of whether qty/total come back positive on the
  // credit-note document or already-negated.
  //
  // Three line shapes seen in /CreditNotes (confirmed via the debug dump
  // 2026-05-11):
  //   • Real-SKU line (code matches isAuSkuCode, e.g. "AU-CL-VLB-35", qty: -2,
  //     unitPrice: 6.895) — actual product return. Contributes both tins and
  //     revenue. Skip-children + Alt UOM rules apply same as sales orders.
  //   • Empty-code "Amount" line (code: "", qty: -1, unitPrice: 5.82,
  //     name: "Amount" or a long descriptive note) — $-only adjustment for
  //     things like Amazon GST, shipping refunds, MOTO discount, etc.
  //     Contributes revenue but NOT tins (no SKU = no tin movement).
  //     ~62 of 73 April credit notes were entirely or partially empty-code
  //     "Amount" refunds.
  //   • Non-AU placeholder line (e.g. code: "196", name: "Credit Note",
  //     qty: -0.1775, unitPrice: $13,866.24 — Woolworths reconciliation
  //     credit notes CRN-72795, CRN-72796, etc.). Treated like empty-code
  //     "Amount" lines: revenue contributes, but tins/sku_lines do NOT
  //     (the qty is a fractional ratio, not a tin count, and the code
  //     isn't a real product). Gate via isAuSkuCode below.
  for (const cn of creditNotes) {
    const cnRef = String(cn.reference || cn.id || '');
    const lineItems = Array.isArray(cn.lineItems) ? cn.lineItems : [];

    let cnContributedAny = false;
    for (const li of lineItems) {
      // Defensive: skip child lines if any ever appear on a credit note. None
      // observed in the April dump but the v2.35.4 rule is cheap to keep.
      const parentId = Number(li?.parentId ?? 0) || 0;
      if (parentId > 0) continue;

      const code      = String(li?.code || li?.sku || '').trim();
      const qty       = Number(li?.qty ?? li?.quantity ?? 0) || 0;
      const uomSize   = Number(li?.uomSize ?? 0) || 0;
      const unitPrice = Number(li?.unitPrice ?? 0) || 0;
      const lineTotal = Number(li?.total ?? (qty * unitPrice)) || 0;
      const name      = String(li?.name || '').slice(0, 60);

      // Revenue contribution — every line contributes (including empty-code
      // "Amount" lines for Amazon GST, shipping refunds, etc.). Always negative.
      const revenueNeg = -Math.abs(lineTotal);
      refunds.revenue += revenueNeg;

      // Tin contribution + sku_lines rollup — only REAL AU SKU lines.
      // Empty-code "Amount" lines AND non-AU placeholder codes (like CIN7's
      // "196" Woolworths reconciliation) are $-only adjustments and shouldn't
      // move the tin counter (no product was returned).
      let tinsNeg = 0;
      if (isAuSkuCode(code)) {
        const [base, mult] = normalizeAuSku(code);
        const baseKey = base || code;
        const tinsRaw = uomSize > 1 ? qty : qty * mult;
        tinsNeg = -Math.abs(tinsRaw);
        refunds.tins += tinsNeg;

        const acc = refunds.sku_lines.get(baseKey) || { tins: 0, sales: 0, name: '' };
        acc.tins  += tinsNeg;
        acc.sales += revenueNeg;
        if (!acc.name && name) acc.name = name;
        refunds.sku_lines.set(baseKey, acc);
      }

      // Count the credit note in orderRefs if any line contributed either
      // revenue or tin movement. Empty-revenue + empty-tin lines are weird
      // CIN7 placeholders and don't justify a refund order count.
      if (revenueNeg !== 0 || tinsNeg !== 0) cnContributedAny = true;
    }
    if (cnContributedAny) refunds.orderRefs.add(cnRef);
  }

  // Materialise — sets → counts, maps → arrays/objects
  const channelsOut = {};
  for (const [k, v] of Object.entries(channels)) {
    channelsOut[k] = {
      tins:    v.tins,
      revenue: v.revenue,
      orders:  v.orderRefs.size,
    };
  }
  const refundsOut = {
    tins:    refunds.tins,
    revenue: refunds.revenue,
    orders:  refunds.orderRefs.size,
    sku_lines: Object.fromEntries(refunds.sku_lines),
  };
  // Per-SKU rows: compute total_tins (CIN7-channels-only sum), drop empties,
  // sort high → low.
  const skuSales = [];
  for (const row of skuRollup.values()) {
    const total = row.col + row.woo2 + row.dist;
    if (total === 0 && row.revenue === 0) continue;
    skuSales.push({
      sku: row.sku,
      name: row.name,
      col: row.col,
      woo2: row.woo2,
      dist: row.dist,
      total_tins: total,
      revenue: row.revenue,
    });
  }
  skuSales.sort((a, b) => b.total_tins - a.total_tins);

  return {
    month,
    channels: channelsOut,
    refunds:  refundsOut,
    skuSales,
    lastSync: new Date().toISOString(),
    source:   'cin7-live',
    counts: {
      ordersFetched:  allOrders.length,
      voidsDropped:   voidsDropped,
      ordersConsidered: orders.length,
      attributedRefs: Object.values(channels).reduce((a, c) => a + c.orderRefs.size, 0)
                    + refunds.orderRefs.size,
      creditNotesFetched: allCreditNotes.length,
      creditNotesNonFinalDropped: creditVoidsDropped,  // VOID/VOIDED/CANCELLED/DRAFT
      creditNotesConsidered: creditNotes.length,
      skuRows: skuSales.length,
    },
    // NOTE: woo + amz channels intentionally absent. They live on the Woo
    // and Amazon channel APIs (Phase 3). Frontend merges this with static
    // window.AU_DATA.salesByMonth[month] for those two channels.
    //
    // NOTE 2: refunds are populated as a SINGLE GLOBAL POOL from /CreditNotes
    // (v2.35.5+). CIN7 Omni v1 splits sales and credit notes across two
    // endpoints — we fetch both serially and merge here. Per-channel refund
    // attribution (Coles refund / Woolies refund / dist refund) is a Phase 3
    // polish item once Cloud-channel data lands; the static side also kept
    // refunds as a single negative row, so frontend behaviour is unchanged.
  };
}

// Build the AU sales payload from D1 (Phase C — v2.2.11). Same payload shape
// as `buildAuSalesPayload` (which fetched /SalesOrders + /CreditNotes
// directly from CIN7 on every cold-cache miss), but reads the
// already-classified rows the cron has been writing to D1 since v2.2.7
// + the historical CSV-imported rows from v2.36 Phase A.
//
// Why the cutover. Live CIN7 fetches were ~50 paginated calls per cold-cache
// miss × 5 concurrent month tabs on the front-end pre-fetch = bursts that
// hit CIN7's 3-call/sec rate limit. Reads from D1 are 4 SQL queries on
// indexed columns — unconditional sub-second.
//
// What's pre-computed at write time (matches buildAuSalesPayload's logic):
//   • orders.channel_attr      ← attributeCin7Order(order)
//   • items.tins (signed)       ← uomSize>1 ? qty : qty*multiplier
//                                  (negative for credit-note AU SKUs)
//   • items.is_au_sku           ← isAuSkuCode(code)
//   • items.base_sku, mult      ← normalizeAuSku(code)
//   • credit-note items.revenue_signed ← -ABS(total)
// So the read path is mostly SUM + GROUP BY rather than line-by-line
// classification.
//
// Caveat on dist for current-month data (May 2026 onward). Cron-imported
// rows classify dist purely by company substring (CIN7's API doesn't expose
// the channel field). The CSV-import path applies the additional
// channel='Backend' filter, which excludes WooCommerce wholesale stockists
// from dist. So historical months (Nov 2025 → 2026-05-12, all CSV) are
// clean — exact April parity. Months past the CSV cutoff include some
// over-counted dist rows. Per next-session-brief-v2.36-csv-pivot.md:
// "Phase C parity test should target Coles/Woolies exactly + accept the
// higher distributor number as the new truth."
// Woo AU channel from D1 (Phase 3a read-side cutover, v2.2.14).
//
// Sources `orders` + `order_items` for market='AU', status IN
// ('completed','processing'), in the named month. Applies AU SKU
// normalisation in JS (rather than at write time like the CIN7 cron does)
// because the Metorik import deliberately stores the raw SKU — there's no
// `base_sku`/`multiplier` column on order_items the way there is on
// cin7_sales_order_items. The runtime cost is modest (~10K rows per active
// month, single SUM-and-rollup pass).
//
// Returns the channel total + a per-base-SKU rollup of {units, tins,
// revenue}. `tins` = qty × normaliseAuSku-multiplier when the SKU matches
// the AU pattern, otherwise 0 (e.g. shipping line items don't contribute
// tins). `units` = raw quantity, unmodified.
//
// Status filter matches NA Woo's reads ('completed' + 'processing'). Failed
// / cancelled / refunded / pending / on-hold / duplicated orders sit in D1
// but never count toward the channel total — the v2.2.13 import preserved
// them for auditability + future refund reconciliation (Phase 3c).
// v2.2.20 (Phase 3b-a): Amazon AU per-month rollup from D1, sourced from
// amazon_orders + amazon_items (the same tables NA Amazon uses, scoped to
// market='AU'). Populated by scripts/import-amazon-au-csv.py for historical
// data; future SP-API cron extension (Phase 3b-b) will keep it fresh.
//
// amazon_orders and amazon_items aren't joined by order id (NA's Reports API
// doesn't return order ids per line — see migration 0002 comment). For the
// CSV-import case BOTH tables come from the same TSV, so they ARE related
// 1:1 via amazon-order-id at the source. We still query them separately to
// match NA's downstream code shape.
//
// Returns { channelTotal: { units, tins, revenue, orders }, bySku: { [sku]: { tins, units, revenue, name } } }
// Matches getAuWooSalesFromD1's shape so the per-channel merge logic in
// buildAuSalesPayloadFromD1 stays symmetric.
async function getAuAmazonSalesFromD1(env, month) {
  // Channel total — orders count + revenue come from amazon_orders.
  // (amazon_orders.total INCLUDES shipping; amazon_items.total is per-line
  //  item price only. We use orders.total for the channel-level revenue
  //  number on the dashboard.)
  const orderAgg = await env.DB.prepare(
    `SELECT COUNT(DISTINCT id) AS orders,
            COALESCE(SUM(total), 0) AS revenue
       FROM amazon_orders
      WHERE market = 'AU'
        AND substr(local_date, 1, 7) = ?`,
  ).bind(month).first();

  // Per-SKU breakdown — pull from amazon_items. Tin count = quantity (1:1
  // assumption — Amazon SKUs are per-tin listings in the AU catalog; FNSKU
  // aliases that point to canonical SKUs preserve the 1:1 relationship).
  // Line-item revenue (amazon_items.total) sums separately from order
  // revenue — the delta is shipping cost allocated at the order level,
  // which we attribute to the channel total but not to any individual SKU.
  const skuRows = await env.DB.prepare(
    `SELECT dashboard_sku AS sku,
            MAX(name)            AS name,
            COALESCE(SUM(quantity), 0) AS units,
            COALESCE(SUM(total), 0)    AS revenue
       FROM amazon_items
      WHERE market = 'AU'
        AND substr(local_date, 1, 7) = ?
        AND dashboard_sku IS NOT NULL
      GROUP BY dashboard_sku`,
  ).bind(month).all();

  // Total units / tins across all SKUs (including unmapped rows so the
  // channel total tin count is honest even when dashboard_sku is NULL).
  const unitAgg = await env.DB.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS units
       FROM amazon_items
      WHERE market = 'AU'
        AND substr(local_date, 1, 7) = ?`,
  ).bind(month).first();

  const bySku = {};
  for (const r of (skuRows.results || [])) {
    if (!r.sku) continue;
    bySku[r.sku] = {
      tins:    Number(r.units)   || 0, // 1:1 — Amazon AU SKUs are per-tin listings
      units:   Number(r.units)   || 0,
      revenue: Number(r.revenue) || 0,
      name:    r.name || '',
    };
  }

  return {
    channelTotal: {
      units:   Number(unitAgg?.units)    || 0,
      tins:    Number(unitAgg?.units)    || 0,  // 1:1 — see note above
      revenue: Number(orderAgg?.revenue) || 0,
      orders:  Number(orderAgg?.orders)  || 0,
    },
    bySku,
  };
}

async function getAuWooSalesFromD1(env, month) {
  const rows = await env.DB.prepare(
    `SELECT
        o.id           AS order_id,
        i.sku          AS sku,
        i.quantity     AS quantity,
        i.total        AS line_total,
        i.name         AS name
       FROM orders o
       JOIN order_items i ON i.order_id = o.id
      WHERE o.market = 'AU'
        AND o.status IN ('completed', 'processing')
        AND substr(i.local_date, 1, 7) = ?`,
  ).bind(month).all();

  let units = 0;
  let tins = 0;
  let revenue = 0;
  const orderIds = new Set();
  const bySku = {};

  for (const r of (rows.results || [])) {
    const sku = String(r.sku || '').trim();
    const qty = Number(r.quantity) || 0;
    const lineTotal = Number(r.line_total) || 0;

    orderIds.add(r.order_id);
    units += qty;
    revenue += lineTotal;

    const isAu = sku && isAuSkuCode(sku);
    let baseSku = null;
    let mult = 1;
    if (sku) {
      const [b, m] = normalizeAuSku(sku);
      baseSku = b || null;
      mult = Number(m) || 1;
    }
    const tinsThisLine = isAu ? qty * mult : 0;
    tins += tinsThisLine;

    if (isAu && baseSku) {
      if (!bySku[baseSku]) {
        bySku[baseSku] = { tins: 0, revenue: 0, units: 0, name: r.name || '' };
      }
      bySku[baseSku].tins    += tinsThisLine;
      bySku[baseSku].revenue += lineTotal;
      bySku[baseSku].units   += qty;
      if (!bySku[baseSku].name && r.name) bySku[baseSku].name = r.name;
    }
  }

  return {
    channelTotal: {
      units,
      tins,
      revenue,
      orders: orderIds.size,
    },
    bySku,
  };
}

async function buildAuSalesPayloadFromD1(env, month) {
  if (!env.DB) {
    throw new Error('Phase C: env.DB binding not configured (logistics-db)');
  }

  // v2.2.47 hybrid Amazon source: months >= cutover read 'amz' from CIN7,
  // months before read 'amz' from amazon_orders below. The SQL channel filter
  // includes 'amz' only when the CIN7 source is active for this month, so
  // pre-cutover months don't pick up partial CIN7 Amazon data (April had 14
  // Amazon orders in CIN7 — those would understate vs amazon_orders' 1,370).
  const useCin7ForAmazon = month >= AU_AMAZON_CIN7_CUTOVER_MONTH;
  const channelFilter = useCin7ForAmazon
    ? "('col','woo2','dist','amz')"
    : "('col','woo2','dist')";

  // Sales channels aggregate. parent_id = 0 to skip CIN7's auto-generated
  // bundle-child line items (otherwise we double-count — the parent row's
  // multiplier already represents the children's tin volume). Status filter
  // matches the CIN7 build's drop of VOID/VOIDED/CANCELLED orders.
  const channelsRows = await env.DB.prepare(
    `SELECT
        o.channel_attr       AS channel,
        SUM(i.tins)          AS tins,
        SUM(i.total)         AS revenue,
        COUNT(DISTINCT o.id) AS orders
       FROM cin7_sales_orders o
       JOIN cin7_sales_order_items i ON i.order_id = o.id
      WHERE o.market = 'AU'
        AND o.status NOT IN ('VOID','VOIDED','CANCELLED')
        AND o.channel_attr IN ${channelFilter}
        AND substr(o.created_date, 1, 7) = ?
        AND i.parent_id = 0
      GROUP BY o.channel_attr`,
  ).bind(month).all();

  // Sales per-SKU rollup. Drop rows with no base_sku — CIN7 occasionally
  // ships items with non-AU codes (placeholders, freight, etc.) that don't
  // belong in the per-SKU view, mirroring the CIN7 build's behaviour.
  // The `amz` pivot returns 0 for pre-cutover months because the channel
  // filter excludes 'amz' rows entirely — those months get Amazon from the
  // amazon_orders read further down.
  const skuRows = await env.DB.prepare(
    `SELECT
        i.base_sku                                                     AS sku,
        MAX(i.name)                                                    AS name,
        SUM(CASE WHEN o.channel_attr = 'col'  THEN i.tins  ELSE 0 END) AS col,
        SUM(CASE WHEN o.channel_attr = 'woo2' THEN i.tins  ELSE 0 END) AS woo2,
        SUM(CASE WHEN o.channel_attr = 'dist' THEN i.tins  ELSE 0 END) AS dist,
        SUM(CASE WHEN o.channel_attr = 'amz'  THEN i.tins  ELSE 0 END) AS amz,
        SUM(CASE WHEN o.channel_attr = 'amz'  THEN i.total ELSE 0 END) AS amz_revenue,
        SUM(CASE WHEN o.channel_attr IN ('col','woo2','dist') THEN i.total ELSE 0 END) AS revenue
       FROM cin7_sales_orders o
       JOIN cin7_sales_order_items i ON i.order_id = o.id
      WHERE o.market = 'AU'
        AND o.status NOT IN ('VOID','VOIDED','CANCELLED')
        AND o.channel_attr IN ${channelFilter}
        AND substr(o.created_date, 1, 7) = ?
        AND i.parent_id = 0
        AND i.base_sku IS NOT NULL
      GROUP BY i.base_sku`,
  ).bind(month).all();

  // Refunds aggregate — single global pool, ALWAYS negative. tins is
  // pre-signed (negative for AU SKUs, 0 for empty-code "Amount" lines and
  // non-AU placeholder codes like CIN7's "196" Woolies reconciliation lines).
  // revenue_signed is always -ABS(total). Drop VOID/VOIDED/CANCELLED + DRAFT
  // (DRAFT means "not yet finalized in CIN7" — pending, not booked).
  // The orders count uses CASE-conditional COUNT DISTINCT to mirror the
  // CIN7 build's rule: only count credit notes that contributed something.
  const refundsAgg = await env.DB.prepare(
    `SELECT
        COALESCE(SUM(i.tins), 0)            AS tins,
        COALESCE(SUM(i.revenue_signed), 0)  AS revenue,
        COUNT(DISTINCT CASE WHEN i.tins != 0 OR i.revenue_signed != 0
                            THEN cn.id END) AS orders
       FROM cin7_credit_notes cn
       JOIN cin7_credit_note_items i ON i.credit_note_id = cn.id
      WHERE cn.market = 'AU'
        AND cn.status NOT IN ('VOID','VOIDED','CANCELLED','DRAFT')
        AND substr(cn.created_date, 1, 7) = ?
        AND i.parent_id = 0`,
  ).bind(month).first();

  // Refunds per-SKU lines — only AU-SKU lines contribute (empty-code +
  // non-AU placeholder lines are revenue-only, no tin movement).
  const refundSkuRows = await env.DB.prepare(
    `SELECT
        i.base_sku             AS sku,
        SUM(i.tins)            AS tins,
        SUM(i.revenue_signed)  AS sales,
        MAX(i.name)            AS name
       FROM cin7_credit_notes cn
       JOIN cin7_credit_note_items i ON i.credit_note_id = cn.id
      WHERE cn.market = 'AU'
        AND cn.status NOT IN ('VOID','VOIDED','CANCELLED','DRAFT')
        AND substr(cn.created_date, 1, 7) = ?
        AND i.parent_id = 0
        AND i.is_au_sku = 1
        AND i.base_sku IS NOT NULL
      GROUP BY i.base_sku`,
  ).bind(month).all();

  // Woo channel from D1. Sourced from orders + order_items where market='AU'
  // — populated by the Metorik CSV import (Phase 3a, v2.2.13) and kept fresh
  // by runWooCronSync.
  //
  // v2.2.14 wired the channel-level totals (channels.woo). v2.2.18 finishes
  // the job: `bySku` is now folded into `skuSales` below, so per-SKU Woo tin
  // counts AND per-SKU revenue come from D1 across ALL months instead of
  // showing from static au-data.js (April only) and 0 elsewhere.
  const wooFromD1 = await getAuWooSalesFromD1(env, month);

  // Amazon channel — hybrid source (v2.2.47):
  //  • months >= AU_AMAZON_CIN7_CUTOVER_MONTH ('2026-05') → CIN7's 'amz'
  //    channel rows already aggregated above (channelsRows / skuRows)
  //  • months < cutover → amazon_orders + amazon_items (CSV-imported
  //    historical backfill, populated via Fulfilled Shipments TSV import)
  // We only call getAuAmazonSalesFromD1 in the pre-cutover branch — for
  // current/future months CIN7 owns the column and we skip the legacy read
  // to avoid double-counting.
  const amzFromD1 = useCin7ForAmazon
    ? null
    : await getAuAmazonSalesFromD1(env, month);

  // Materialise — match the shape buildAuSalesPayload produces so the
  // frontend doesn't need to know which path served the data.
  const channelsOut = {
    col:  { tins: 0, revenue: 0, orders: 0 },
    woo2: { tins: 0, revenue: 0, orders: 0 },
    dist: { tins: 0, revenue: 0, orders: 0 },
    woo:  { tins: 0, revenue: 0, orders: 0, units: 0 },
    amz:  { tins: 0, revenue: 0, orders: 0, units: 0 },
  };
  for (const r of (channelsRows.results || [])) {
    if (!channelsOut[r.channel]) continue;
    channelsOut[r.channel] = {
      tins:    Number(r.tins)    || 0,
      revenue: Number(r.revenue) || 0,
      orders:  Number(r.orders)  || 0,
    };
  }
  channelsOut.woo = wooFromD1.channelTotal;
  // v2.2.47 hybrid: post-cutover months already have channels.amz populated
  // by the channelsRows loop above (from CIN7). Pre-cutover months read from
  // amazon_orders via amzFromD1.
  if (amzFromD1) {
    channelsOut.amz = amzFromD1.channelTotal;
  }

  const refundsOut = {
    tins:      Number(refundsAgg?.tins)    || 0,
    revenue:   Number(refundsAgg?.revenue) || 0,
    orders:    Number(refundsAgg?.orders)  || 0,
    sku_lines: {},
  };
  for (const r of (refundSkuRows.results || [])) {
    refundsOut.sku_lines[r.sku] = {
      tins:  Number(r.tins)  || 0,
      sales: Number(r.sales) || 0,
      name:  r.name || '',
    };
  }

  // v2.2.18 + v2.2.20: merge CIN7 per-SKU rollup with Woo and Amazon
  // per-SKU rollups. All three are keyed by AU base SKU:
  //   - CIN7 emits `base_sku` pre-normalised at write time
  //   - Woo applies normalizeAuSku() inside getAuWooSalesFromD1
  //   - Amazon applies map_seller_sku() at CSV import time, storing the
  //     canonical SKU in amazon_items.dashboard_sku (default identity for
  //     AU- seller SKUs; explicit map for FNSKU aliases)
  // The merged row has tin counts per channel (col / woo2 / dist / woo / amz),
  // total_tins summing all five, and revenue = CIN7 + Woo + Amazon revenue.
  // SKUs that appear in any one channel get a row; columns they don't
  // appear in stay 0.
  const skuMap = new Map(); // base_sku → merged row in-progress
  for (const r of (skuRows.results || [])) {
    skuMap.set(r.sku, {
      sku:           r.sku,
      name:          r.name || '',
      col:           Number(r.col)  || 0,
      woo2:          Number(r.woo2) || 0,
      dist:          Number(r.dist) || 0,
      woo:           0,
      // v2.2.47 hybrid: r.amz / r.amz_revenue are populated by the SQL pivot
      // ONLY for post-cutover months (when channelFilter included 'amz').
      // For pre-cutover months these columns return 0 from the SQL and the
      // amzFromD1 merge loop below fills them in from amazon_orders.
      amz:           Number(r.amz)         || 0,
      cin7_revenue:  Number(r.revenue)     || 0,
      woo_revenue:   0,
      amz_revenue:   Number(r.amz_revenue) || 0,
    });
  }
  for (const [baseSku, w] of Object.entries(wooFromD1.bySku || {})) {
    const existing = skuMap.get(baseSku) || {
      sku:           baseSku,
      name:          w.name || '',
      col: 0, woo2: 0, dist: 0, woo: 0, amz: 0,
      cin7_revenue:  0,
      woo_revenue:   0,
      amz_revenue:   0,
    };
    existing.woo         += Number(w.tins)    || 0;
    existing.woo_revenue += Number(w.revenue) || 0;
    if (!existing.name && w.name) existing.name = w.name;
    skuMap.set(baseSku, existing);
  }
  // Pre-cutover months: merge amazon_orders bySku. Post-cutover skips this
  // (amzFromD1 is null) because CIN7's 'amz' pivot already populated the
  // per-SKU amz / amz_revenue fields above.
  if (amzFromD1) {
    for (const [baseSku, a] of Object.entries(amzFromD1.bySku || {})) {
      const existing = skuMap.get(baseSku) || {
        sku:           baseSku,
        name:          a.name || '',
        col: 0, woo2: 0, dist: 0, woo: 0, amz: 0,
        cin7_revenue:  0,
        woo_revenue:   0,
        amz_revenue:   0,
      };
      existing.amz         += Number(a.tins)    || 0;
      existing.amz_revenue += Number(a.revenue) || 0;
      if (!existing.name && a.name) existing.name = a.name;
      skuMap.set(baseSku, existing);
    }
  }

  const skuSales = [];
  for (const m of skuMap.values()) {
    const total = m.col + m.woo2 + m.dist + m.woo + m.amz;
    const revenue = m.cin7_revenue + m.woo_revenue + m.amz_revenue;
    if (total === 0 && revenue === 0) continue;
    skuSales.push({
      sku:        m.sku,
      name:       m.name,
      col:        m.col,
      woo2:       m.woo2,
      dist:       m.dist,
      woo:        m.woo,
      amz:        m.amz,
      total_tins: total,
      revenue,
    });
  }
  skuSales.sort((a, b) => b.total_tins - a.total_tins);

  // ordersConsidered counts CIN7 sales orders attributed to a channel. v2.2.47
  // adds channelsOut.amz.orders to the post-cutover total — pre-cutover the
  // amz orders come from amazon_orders so they're already in channelsOut.amz
  // but didn't come through CIN7's sales-orders pipeline.
  const cin7OrdersConsidered = channelsOut.col.orders
                             + channelsOut.woo2.orders
                             + channelsOut.dist.orders
                             + (useCin7ForAmazon ? channelsOut.amz.orders : 0);
  return {
    month,
    channels: channelsOut,
    refunds:  refundsOut,
    skuSales,
    lastSync: new Date().toISOString(),
    source:   useCin7ForAmazon ? 'cin7-d1+amz-from-cin7' : 'cin7-d1+amz-from-csv',
    counts: {
      // ordersConsidered + attributedRefs + skuRows match the keys
      // buildAuSalesPayload returned. ordersFetched / voidsDropped /
      // creditNotesFetched are upstream-fetch metrics that no longer
      // apply — D1 only stores the post-cron set.
      ordersConsidered:      cin7OrdersConsidered,
      attributedRefs:        cin7OrdersConsidered + refundsOut.orders,
      creditNotesConsidered: refundsOut.orders,
      skuRows:               skuSales.length,
    },
  };
}

// KV-cache wrapper for monthly sales. Used both by the /sales route and by
// the /pos route's run-rate derivation (which needs the trailing 3 complete
// months). Behaviour:
//   • Cache hit → return cached payload tagged { cached: true }.
//   • Cache miss / forceRefresh → fetch fresh, write to KV, return tagged
//     { cached: false }.
//   • Upstream throw with usable cache → return cached payload tagged
//     { cached: true, staleFallback: true, error }.
async function getMonthSales(env, month, { forceRefresh = false } = {}) {
  const cache = env.CACHE;
  const key = kvSalesKey(month);

  if (!forceRefresh && cache) {
    const cached = await cache.get(key, 'json');
    if (cached?.channels) return { ...cached, cached: true };
  }

  try {
    // v2.2.11: Phase C cutover — read from D1 instead of fetching CIN7
    // directly. The cron + the v2.36 CSV import keep D1 current. The
    // legacy buildAuSalesPayload (CIN7 path) is left in place for now
    // as a reference; will be removed in a future cleanup.
    const payload = await buildAuSalesPayloadFromD1(env, month);
    if (cache) {
      await cache.put(key, JSON.stringify(payload), { expirationTtl: SALES_TTL_SECONDS });
    }
    return { ...payload, cached: false };
  } catch (e) {
    if (cache) {
      const cached = await cache.get(key, 'json');
      if (cached?.channels) {
        return {
          ...cached,
          cached: true,
          staleFallback: true,
          error: 'Upstream CIN7 error — serving cached snapshot.',
        };
      }
    }
    throw e;
  }
}

// ─── Purchase orders (Phase 2b) ────────────────────────────────────────────
//
// Mirrors scripts/build_data.py:parse_cin7_pos() + classify_line() rules:
//   freight/shipping/postage/kittingfee → 'fees'
//   T-AU-... or T-...                   → 'raw_tin'
//   AU-BD-...                           → 'soap'
//   AU-CTN-... or AU-SRT-...            → 'carton_tray' (rolled into finished
//                                          via SKU normalisation downstream)
//   AU-...                              → 'finished'
//   P-..., P-OC-..., P-BOX-..., P-ENV-..→ 'packaging'
//   else                                → 'other'
function classifyPoLineCode(code) {
  if (!code) return 'other';
  const c = String(code).trim();
  const cl = c.toLowerCase();
  if (cl === 'freight' || cl === 'shipping' || cl === 'postage' || cl === 'kittingfee') return 'fees';
  if (c.startsWith('T-AU-') || c.startsWith('T-')) return 'raw_tin';
  if (c.startsWith('AU-BD-')) return 'soap';
  if (c.startsWith('AU-CTN-') || c.startsWith('AU-SRT-')) return 'carton_tray';
  if (c.startsWith('AU-')) return 'finished';
  if (c.startsWith('P-') || c.startsWith('P-OC-') || c.startsWith('P-BOX-') || c.startsWith('P-ENV-')) return 'packaging';
  return 'other';
}

// Pull all Purchase Orders + filter to "open" client-side. Originally tried
// a server-side `where Status<>'FULLY RECEIVED' AND Status<>'VOIDED'` filter
// in v2.35 but that returned the full PO history (136 rows vs the static
// CSV's 26) — root cause was twofold: (a) CIN7 Omni's actual PO `Status`
// values are `Draft` / `Approved` / `Completed` / `Voided` (capitalised, not
// all-caps as the v2.35 filter assumed), and (b) the `<>` SQL operator may
// not be supported by Omni's `where` clause syntax. Filtering client-side
// is more robust — we know exactly what statuses to drop, and the per-page
// payload is the same size whether we pre-filter or not (200ish total POs
// fits in 1 page at PAGE_SIZE=250).
async function fetchAllPurchaseOrders(env) {
  // v2.2.15: added fullyReceivedDate / cancellationDate / isVoid / stage /
  // modifiedDate so isOpenPo can use the actual closure signals CIN7 sets
  // automatically. Previously we only saw `status` + `completedDate`, both
  // of which CIN7 only writes when a human manually marks the PO Completed
  // in the UI — many old POs are received against stock but never get that
  // manual step, so they sit APPROVED indefinitely and leaked through the
  // open filter. `fullyReceivedDate` is the auto-set field; the line-item
  // `qtyShipped` totals are the fallback when even that's not populated.
  //
  // v2.2.16: live AU data shows `deliveryDate` is null on every open PO. CIN7
  // has SEVERAL date fields on the PurchaseOrder model and No Pong's data
  // entry process clearly populates a different one. Pull the full set so
  // `shapePoRows` can fall back through them and `pos/debug` can surface
  // which one your suppliers actually use:
  //   • deliveryDate         — the "expected delivery date" field we used in v2.35
  //   • estimatedDeliveryDate — CIN7's documented Estimated Delivery Date
  //   • estimatedArrivalDate  — Estimated time of arrival (for Indent Order)
  //   • supplierAcceptanceDate — when supplier confirmed the PO
  //   • port                  — Port for Indent Order (useful diagnostic)
  //   • customFields          — anything stored in CIN7 custom fields
  const fields = [
    'id', 'reference', 'createdDate', 'modifiedDate',
    'deliveryDate', 'estimatedDeliveryDate', 'estimatedArrivalDate',
    'supplierAcceptanceDate', 'invoiceDate',
    'status', 'stage', 'completedDate', 'fullyReceivedDate', 'cancellationDate', 'isVoid',
    'company', 'firstName', 'lastName', 'memberEmail',
    'branchName', 'port',
    'total', 'subTotal',
    'lineItems',
    'customFields',
  ].join(',');
  return cin7FetchAll(env, 'PurchaseOrders', { fields });
}

// Open = none of CIN7's closure signals are set AND the line items aren't
// already fully received. Case-insensitive on status — belt-and-braces
// against CIN7 capitalising things differently across endpoints.
//
// v2.2.15 (2026-05-16): rewrote to use the actual closure signals from
// CIN7's documented PurchaseOrder model. Previously we only checked
// `status` + `completedDate`, both of which require a manual Complete
// click in the CIN7 UI. ~140 old APPROVED POs (PO-AU-T88 Sept 2025,
// PO-313 Oct 2025, PO-4806 Nov 2025, etc.) were received against stock
// months ago but never got that manual click, so they leaked through.
// Now we also check `fullyReceivedDate` (auto-set when every line item
// is received), `cancellationDate`, and `isVoid`, AND a line-item rollup
// fallback (`qtyShipped >= qty` on every non-zero line) for POs CIN7
// didn't backfill `fullyReceivedDate` on.
//
// v2.2.14 (2026-05-15): added 'void'. CIN7 Omni's /PurchaseOrders endpoint
// returns the status string as 'VOID' (4 chars), not 'Voided' / 'VOIDED'.
// Keep BOTH 'void' and 'voided' so the filter is resilient to CIN7 ever
// switching back. If a new closed-status value appears later (e.g.
// "Returned"), add it here.
const CLOSED_PO_STATUSES = new Set([
  'completed', 'void', 'voided', 'cancelled', 'closed',
]);

// A PO is "fully received" via its line items if every line with a positive
// `qty` has been received (`qtyShipped >= qty`). Lines with `qty <= 0` are
// freight / discount / fee rows and are ignored. Returns false if the PO has
// no non-zero qty lines (can't infer received from nothing). Tolerates a tiny
// floating-point epsilon — CIN7 returns qtys as decimals.
function isFullyReceivedByLines(po) {
  const lines = Array.isArray(po?.lineItems) ? po.lineItems : [];
  if (lines.length === 0) return false;
  let sawNonZeroLine = false;
  for (const li of lines) {
    const qty = Number(li?.qty ?? li?.quantity ?? 0) || 0;
    if (qty <= 0) continue; // freight / KittingFee / discount line
    sawNonZeroLine = true;
    // `qtyShipped` on a CIN7 Omni PurchaseOrderItem is the qty *received from
    // the supplier* (the shape is shared with SalesOrder line items, where
    // the same field means qty shipped to the customer — same field, opposite
    // direction of flow).
    const received = Number(li?.qtyShipped ?? li?.quantityShipped ?? 0) || 0;
    if (received + 0.001 < qty) return false;
  }
  return sawNonZeroLine;
}

function isOpenPo(po) {
  // Hard-closed signals from CIN7
  if (po?.isVoid === true) return false;
  if (po?.completedDate) return false;
  if (po?.fullyReceivedDate) return false;
  if (po?.cancellationDate) return false;

  // Status string (case-insensitive)
  const s = String(po?.status || '').trim().toLowerCase();
  if (s && CLOSED_PO_STATUSES.has(s)) return false;

  // Fallback: CIN7 didn't auto-set `fullyReceivedDate` (common on legacy
  // POs and on partial-receipts done outside the CIN7 UI), but the line
  // items themselves show every non-zero line is fully received.
  if (isFullyReceivedByLines(po)) return false;

  return true;
}

// ── Observed lead times (AU Packaging tab) ────────────────────────────────
//
// The entered lead time always drives the maths. This is the reality check
// beside it: what CIN7's own PO history says each supplier actually took,
// createdDate → fullyReceivedDate. Mel's call (2026-07-20) — "keep the entered
// value as a driver and show observed alongside as a nudge when they diverge"
// — so nothing here feeds a calculation; it only ever surfaces a discrepancy.
//
// Worked example that motivated this, TC Printing (SRT trays):
//   PO-5186   07 Nov 25 → 17 Dec 25   40d   ← Christmas run
//   PO-39463  22 Jan 26 → 19 Feb 26   28d
//   PO-53421  03 Mar 26 → 27 Mar 26   24d
//   PO-65474  01 Apr 26 → 28 Apr 26   27d
//   PO-80076  13 May 26 → 09 Jun 26   27d
// Median 27 days ≈ 4 weeks, against the 5 weeks in the lead-time doc. MEDIAN
// not mean, precisely so one Christmas run can't drag the figure out.
//
// Only POs carrying an explicit `fullyReceivedDate` count. isOpenPo() also
// treats a PO as closed when its line items all show qtyShipped >= qty, but
// that path gives no receipt DATE, so it can't be measured — those are skipped
// rather than guessed at. `samples` is returned so a figure resting on two POs
// is visibly weaker than one resting on ten.
const PACKAGING_SUPPLIER_FAMILIES = [
  { family: 'srt',       match: /tc\s*printing/i },
  { family: 'cartons',   match: /sps\s*packaging/i },
  { family: 'envelopes', match: /huizhou|ztj/i },
  { family: 'tins',      match: /guanqiao/i },
];

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function buildObservedLeadTimes(rawPos, { monthsBack = 18, maxSamples = 10 } = {}) {
  const cutoff = Date.now() - monthsBack * 30.44 * 86400000;
  const bySupplier = new Map();

  for (const po of rawPos) {
    const created  = po?.createdDate ? Date.parse(po.createdDate) : NaN;
    const received = po?.fullyReceivedDate ? Date.parse(po.fullyReceivedDate) : NaN;
    if (!Number.isFinite(created) || !Number.isFinite(received)) continue;
    if (received < cutoff) continue;

    const days = Math.round((received - created) / 86400000);
    // Guard against clock/data errors — a negative or year-plus lead is a
    // back-dated or mis-keyed PO, not a supplier signal.
    if (days < 0 || days > 365) continue;

    const company = String(po?.company || '').trim();
    if (!company) continue;
    const acc = bySupplier.get(company) || { company, samples: [] };
    acc.samples.push({ ref: String(po?.reference || po?.id || ''), days, received });
    bySupplier.set(company, acc);
  }

  const out = {};
  for (const acc of bySupplier.values()) {
    // Most recent first, then cap — old POs shouldn't outvote current performance.
    acc.samples.sort((a, b) => b.received - a.received);
    const used = acc.samples.slice(0, maxSamples);
    const days = used.map((s) => s.days);
    const fam = PACKAGING_SUPPLIER_FAMILIES.find((f) => f.match.test(acc.company));
    const entry = {
      supplier:   acc.company,
      medianDays: median(days),
      samples:    used.length,
      minDays:    Math.min(...days),
      maxDays:    Math.max(...days),
      latest:     used[0] ? { ref: used[0].ref, days: used[0].days } : null,
    };
    out[acc.company] = entry;
    // Also key by packaging family so the tab can look up "what does CIN7 say
    // SRTs actually take" without hardcoding a supplier name in the front end.
    if (fam) out[`family:${fam.family}`] = { ...entry, family: fam.family };
  }
  return out;
}

// Build the same `pos[]` shape the static au-data.js has, plus the new
// date/status fields. Each PO gets a derived `type` based on dominant bucket
// (matches build_data.py logic).
function shapePoRows(rawPos) {
  const out = [];
  for (const po of rawPos) {
    const company = String(po?.company || '').trim();
    const contact = [(po?.firstName || '').trim(), (po?.lastName || '').trim()]
      .filter(Boolean).join(' ');
    const lineItems = Array.isArray(po?.lineItems) ? po.lineItems : [];

    const buckets = { finished: 0, soap: 0, raw_tin: 0, packaging: 0, carton_tray: 0, fees: 0, other: 0 };
    const lines = [];
    for (const li of lineItems) {
      const code = String(li?.code || li?.sku || '').trim();
      const qty  = Number(li?.qty ?? li?.quantity ?? 0) || 0;
      const cls  = classifyPoLineCode(code);
      buckets[cls] = (buckets[cls] || 0) + qty;
      lines.push({ code, qty });
    }

    // PO type — soap takes precedence over packaging when a finished soap
    // unit is present (matches Python).
    let type;
    if (buckets.finished > 0) type = 'finished';
    else if (buckets.soap > 0) type = 'soap';
    else if (buckets.raw_tin > buckets.packaging) type = 'tins';
    else if (buckets.packaging > 0) type = 'packaging';
    else if (buckets.carton_tray > 0) type = 'finished'; // standalone carton-only PO
    else type = 'other';

    // Total units for the PO. A Finished (or Soap) PO from HFM lists the empty
    // tins (T-AU-… → raw_tin) alongside the finished good — that's the SAME
    // physical run in component form, so summing both double-counts. Count only
    // the PO's primary product bucket by type. Pure Tins / Packaging POs still
    // count their own product. (v2.2.77 — was: sum of every bucket.)
    let totalUnits;
    if (type === 'finished')       totalUnits = buckets.finished + buckets.carton_tray;
    else if (type === 'soap')      totalUnits = buckets.soap;
    else if (type === 'tins')      totalUnits = buckets.raw_tin;
    else if (type === 'packaging') totalUnits = buckets.packaging;
    else totalUnits = buckets.finished + buckets.soap + buckets.raw_tin
                    + buckets.packaging + buckets.carton_tray + buckets.other;

    // Distinct SKU count — matches the CA dashboard's "SKUs" column. Excludes
    // freight/KittingFee/discount rows (any line that classifies as 'fees').
    const skuSet = new Set();
    for (const li of lineItems) {
      const code = String(li?.code || li?.sku || '').trim();
      if (!code) continue;
      const cls = classifyPoLineCode(code);
      if (cls === 'fees') continue;
      skuSet.add(code);
    }

    // v2.2.16: live AU data shows `deliveryDate` is null on every open PO.
    // CIN7 lets users enter the expected date in several different fields
    // depending on their internal process. Fall back through the most-specific
    // → least-specific chain so the dashboard surfaces whichever date the
    // supplier or PO author actually populated.
    const expectedDate =
      po?.deliveryDate           ||
      po?.estimatedDeliveryDate  ||
      po?.estimatedArrivalDate   ||
      po?.supplierAcceptanceDate ||
      null;
    // Track WHERE the expected_date came from for the table tooltip + debug.
    const expectedDateSource =
      po?.deliveryDate           ? 'deliveryDate'           :
      po?.estimatedDeliveryDate  ? 'estimatedDeliveryDate'  :
      po?.estimatedArrivalDate   ? 'estimatedArrivalDate'   :
      po?.supplierAcceptanceDate ? 'supplierAcceptanceDate' :
      null;

    out.push({
      po:              String(po?.reference || po?.id || ''),
      company,
      contact,
      // New in v2.35 — these were null in the static export.
      created_date:    po?.createdDate || null,
      expected_date:   expectedDate,
      expected_date_source: expectedDateSource,
      // v2.2.16: keep all date sources accessible for the debug endpoint + a
      // potential per-row tooltip showing where each date came from.
      delivery_date:           po?.deliveryDate           || null,
      estimated_delivery_date: po?.estimatedDeliveryDate  || null,
      estimated_arrival_date:  po?.estimatedArrivalDate   || null,
      supplier_acceptance_date: po?.supplierAcceptanceDate || null,
      invoice_date:            po?.invoiceDate            || null,
      status:          po?.status || null,
      // v2.2.15: surface the closure signals so the table can render them
      // and so the front-end can compute days-until-arrival from a single
      // canonical expected_date.
      fully_received_date: po?.fullyReceivedDate || null,
      cancellation_date:   po?.cancellationDate  || null,
      is_void:             po?.isVoid === true,
      stage:               po?.stage  || null,
      // Existing static-shape fields
      line_count:      lines.length,
      sku_count:       skuSet.size,                // v2.2.15: CA-table parity
      finished_units:  buckets.finished + buckets.carton_tray, // carton-only POs count as finished
      soap_units:      buckets.soap,
      raw_tin_units:   buckets.raw_tin,
      packaging_units: buckets.packaging,
      fee_lines:       buckets.fees < 10 ? Math.round(buckets.fees) : 0,
      total_units:     totalUnits,
      type,
      lines,
    });
  }
  // Newest PO# first — matches the static side's sort.
  out.sort((a, b) => (b.po || '').localeCompare(a.po || ''));
  return out;
}

// Derive the `incomingBySku` view — per-base-SKU current stock + run rate +
// days left + incoming qty + risk badge. Matches static build_data.py:
// build_incoming_stock_by_sku() rule-for-rule, with one substantive change
// per Melanie's pick: run rate is now a TRAILING 3-COMPLETE-MONTH average
// instead of single-month-divided-by-30 (CA-style smoothing).
function buildIncomingBySku(inventory, posRows, monthSalesPayloads, emptyTins = {}) {
  // monthSalesPayloads is an array (newest → oldest) of { skuSales, month }
  // objects from getMonthSales(). v2.2.20: each skuSales row's total_tins
  // now sums col + woo2 + dist + woo + amz — i.e. all five AU channels
  // (CIN7 supermarket/distributor + Woo direct + Amazon). Run rate
  // denominator therefore reflects the full demand picture.
  //
  // History:
  //   v2.2.18 added Woo per-SKU (col+woo2+dist+woo); ~95% of true volume.
  //   v2.2.20 added Amazon per-SKU from D1; ~100% of true volume.

  // Sum tins per base SKU across the trailing window
  const tinsByBase = new Map();
  let totalDays = 0;
  for (const payload of monthSalesPayloads) {
    if (!payload?.month || !Array.isArray(payload.skuSales)) continue;
    const [y, m] = payload.month.split('-').map(Number);
    // Days in month
    const daysInMonth = new Date(y, m, 0).getDate();
    totalDays += daysInMonth;
    for (const row of payload.skuSales) {
      const cur = tinsByBase.get(row.sku) || 0;
      tinsByBase.set(row.sku, cur + (row.total_tins || 0));
    }
  }

  // Roll up carton stock into base-SKU tin equivalents (cartons of 48 each
  // contribute 48 tins to the base; SRTs are already folded into base in
  // buildInventory upstream).
  //
  // v2.2.42: track loose tins vs cartons separately on each base, so the
  // front-end can show a breakdown tooltip on the Current stock cell —
  // e.g. "5,123 loose + 551 cartons × 48 = 31,571 tins". Total stock is
  // still the sum of both; the breakdown is purely additional metadata.
  const baseStock = new Map(); // base → { loose, fromCartons, cartonCount, fba }
  function _bumpBase(sku, looseDelta, cartonDelta, fbaDelta = 0) {
    const cur = baseStock.get(sku) || { loose: 0, fromCartons: 0, cartonCount: 0, fba: 0 };
    cur.loose       += looseDelta;
    cur.fromCartons += cartonDelta;
    cur.fba         += fbaDelta;
    if (cartonDelta > 0) cur.cartonCount += cartonDelta / 48;
    baseStock.set(sku, cur);
  }
  for (const r of inventory) {
    if (r?.discontinued) continue;
    if (r.kind === 'base' || r.kind === 'base-b') {
      // v2.2.67: include Amazon FBA. FBA stock is sellable — it's just held at
      // Amazon's warehouse, not sold — so it counts toward on-hand. Warehouse
      // and FBA tracked separately for the front-end breakdown.
      const wh  = r.warehouse_soh ?? ((r.soh ?? 0) - (r.fba_cin7 ?? 0));
      const fba = r.fba_cin7 ?? 0;
      _bumpBase(r.sku, wh, 0, fba);
    } else if (r.kind === 'carton') {
      // Cartons live in our warehouse only (Amazon doesn't hold cartons).
      const wh = r.warehouse_soh ?? r.soh ?? 0;
      const m = /^AU-CTN-(.+)-48$/.exec(r.sku);
      if (m) _bumpBase(`AU-${m[1]}-35`, 0, wh * 48);
    }
  }

  // Sum incoming finished tins per base SKU. Raw tins (T-AU-XXX-NPO-35) and
  // packaging (P-...) are deliberately EXCLUDED — only fully-filled, ready-
  // to-sell stock counts.
  //
  // History: v2.2.36 briefly folded raw tins in with a 'raw' badge for the
  // end-to-end pipeline view. Reverted in v2.2.38 — Mel's reasoning: this
  // column means "ready-to-sell tins arriving"; raw tins still need filling
  // before they belong here, and the runway from current stock is already
  // captured by Days left. Same logic applies to deriveNextPo — only count
  // finished-tin POs when computing "Next PO (days)".
  //
  // Each PO contributes `{ ref, date }` to `pos[]` so the front-end can
  // compute next-PO-days (earliest future expected_date).
  const incoming = new Map(); // base → { qty, pos: [{ref,date}] }
  for (const p of posRows) {
    for (const line of p.lines) {
      const code = String(line?.code || '').trim();
      if (!code) continue;
      // Only finished AU-... tins and AU-CTN-/AU-SRT- cartons count. Raw
      // tins (T-AU-...), packaging (P-...), freight, kitting fees, and any
      // other line types are skipped.
      let base, qtyTins;
      if (code.startsWith('AU-CTN-') || code.startsWith('AU-SRT-')) {
        const [b, mult] = normalizeAuSku(code);
        if (!b) continue;
        base = b;
        qtyTins = (line.qty || 0) * mult;
      } else if (code.startsWith('AU-')) {
        base = code;
        qtyTins = line.qty || 0;
      } else {
        continue;
      }
      const acc = incoming.get(base) || { qty: 0, pos: [] };
      acc.qty += qtyTins;
      if (!acc.pos.some(x => x.ref === p.po)) {
        acc.pos.push({ ref: p.po, date: p.expected_date || null });
      }
      incoming.set(base, acc);
    }
  }

  // v2.2.36: derive next-PO arrival per base SKU. Pick the earliest open PO
  // whose expected_date is today-or-future. Negative-days (overdue) are
  // included separately so the UI can render them in red — overdue supply is
  // still information Mel needs to see. Returns { days: null, ref: null } if
  // no PO for this SKU has any dated expected_date set in CIN7 at all.
  const todayUtcMs = (() => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  })();
  function deriveNextPo(posList) {
    // The "next PO" is the earliest-dated open PO for this SKU — whether it's
    // overdue or upcoming. An overdue PO (stock that should already have landed)
    // is the NEXT expected arrival and the most urgent to surface, so it must
    // not be hidden behind a later future PO. Overdue shows as negative days
    // (rendered red). (v2.2.78 — previously a future PO always won, which hid
    // overdue supply whenever any future PO also existed for the SKU.)
    let bestTs = null;
    let bestRef = null;
    for (const p of posList) {
      if (!p.date) continue;
      const ts = Date.parse(String(p.date).slice(0, 10) + 'T00:00:00Z');
      if (!Number.isFinite(ts)) continue;
      if (bestTs == null || ts < bestTs) {
        bestTs = ts;
        bestRef = p.ref;
      }
    }
    if (bestTs == null) return { days: null, ref: null };
    return { days: Math.round((bestTs - todayUtcMs) / 86400000), ref: bestRef };
  }

  // Eligible universe: only finished-tin base SKUs that exist in inventory
  // (not packaging, not discontinued, not the mixed mega-tray).
  const allowed = new Set();
  for (const r of inventory) {
    if (r?.discontinued) continue;
    if (r.kind === 'base' || r.kind === 'base-b') allowed.add(r.sku);
  }
  const universe = new Set();
  for (const k of baseStock.keys())  if (allowed.has(k)) universe.add(k);
  for (const k of incoming.keys())   if (allowed.has(k)) universe.add(k);
  for (const k of tinsByBase.keys()) if (allowed.has(k)) universe.add(k);

  const out = [];
  for (const sku of universe) {
    const stockBreakdown = baseStock.get(sku) || { loose: 0, fromCartons: 0, cartonCount: 0, fba: 0 };
    const stock = stockBreakdown.loose + stockBreakdown.fromCartons + stockBreakdown.fba;
    const tins  = tinsByBase.get(sku) || 0;
    const rate  = totalDays > 0 ? tins / totalDays : 0;
    const daysLeft = rate > 0 ? stock / rate : null;
    const inc = incoming.get(sku) || { qty: 0, pos: [] };

    let risk;
    if (rate === 0 && stock === 0) risk = 'inactive';
    else if (rate === 0) risk = 'no-sales';
    else if (daysLeft !== null && daysLeft < 14) risk = inc.qty === 0 ? 'critical' : 'critical-incoming';
    else if (daysLeft !== null && daysLeft < 30) risk = inc.qty === 0 ? 'low'      : 'low-incoming';
    else if (daysLeft !== null && daysLeft < 60) risk = 'monitor';
    else risk = 'stable';

    const nextPo = deriveNextPo(inc.pos);
    // Empty-tin fillability: how many unfilled tins we hold for this scent (and
    // how many are on order). A finished-goods PO can't be filled beyond this.
    const et = emptyTins[sku] || { soh: 0, incoming: 0 };
    out.push({
      sku,
      current_stock:    Math.round(stock),
      empty_tins_soh:      Math.round(et.soh || 0),      // unfilled tins on hand
      empty_tins_incoming: Math.round(et.incoming || 0), // empty tins on order (~4mo lead)
      // v2.2.42: breakdown so the front-end can show a tooltip on the
      // Current stock cell — loose base-SKU tins vs cartons rolled up.
      stock_loose_tins:   Math.round(stockBreakdown.loose),   // singles in our warehouse
      stock_fba:          Math.round(stockBreakdown.fba),     // singles at Amazon (FBA)
      stock_from_cartons: Math.round(stockBreakdown.fromCartons),
      stock_carton_count: Math.round(stockBreakdown.cartonCount),
      run_rate_per_day: Math.round(rate * 10) / 10,
      days_left:        daysLeft !== null ? Math.round(daysLeft * 10) / 10 : null,
      next_po_days:     nextPo.days,
      next_po_ref:      nextPo.ref,
      incoming_qty:     Math.round(inc.qty),
      next_po_refs:     inc.pos.slice(0, 3).map(p => p.ref), // back-compat
      risk,
    });
  }
  const RISK_ORDER = {
    critical: 0, 'critical-incoming': 1, low: 2, 'low-incoming': 3,
    monitor: 4, stable: 5, 'no-sales': 6, inactive: 7,
  };
  out.sort((a, b) => {
    const r = (RISK_ORDER[a.risk] ?? 9) - (RISK_ORDER[b.risk] ?? 9);
    if (r) return r;
    return (a.days_left ?? 99999) - (b.days_left ?? 99999);
  });
  return out;
}

// Build the AU POs payload. Pulls inventory + 3 trailing months of sales
// (using cached month-sales when available) + open POs, then derives the
// incomingBySku view. All CIN7 calls are SERIAL — never Promise.all (per
// the rate-limit guidance in the file header).
//
// Subrequest budget: cold-cache worst case ≈ inventory(~6) + 3×sales(~5
// each) + POs(~3) = ~24 subrequests. Within Worker free-tier 50/req limit.
// Warm cache (15-min TTL on each piece) brings most subsequent loads down
// to a single PO fetch.
async function buildAuPosPayload(env) {
  // 1. Inventory — reuse the buildAuInventoryPayload path for shape parity
  //    with /api/au/inventory. We don't go through the cache wrapper here
  //    because we need the inventory rows even if /api/au/inventory hasn't
  //    been hit yet this TTL. (Could refactor to share the cached result;
  //    not worth the complexity for one extra Stock+Products fetch.)
  const inventoryPayload = await buildAuInventoryPayload(env);
  const inventory = inventoryPayload.inventory || [];
  const emptyTins = inventoryPayload.emptyTins || {};

  // 2. Trailing 3 complete calendar months for run rate. "Complete" means
  //    we exclude the current month (which is partial). E.g. on May 11,
  //    the trailing window is Feb / Mar / Apr.
  const now = new Date();
  // Step back to the first day of the current month, then back 1 month —
  // that's the most recent COMPLETE month. From there, two more months back.
  const monthList = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const yyyy = d.getUTCFullYear();
    const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
    monthList.push(`${yyyy}-${mm}`);
  }
  const monthPayloads = [];
  for (const month of monthList) {
    try {
      const payload = await getMonthSales(env, month);
      monthPayloads.push(payload);
    } catch (e) {
      // Don't fail the whole PO build because one month's sales are
      // unavailable — just log and continue with what we have. Run rate
      // will be lower than reality if a month is missing.
      console.warn(`AU POs: month-sales fetch failed for ${month}:`, e?.message || e);
    }
  }

  // 3. POs from CIN7 — fetch ALL, filter to "open" client-side. Server-side
  //    where-clause was unreliable (see fetchAllPurchaseOrders comment).
  const rawPos = await fetchAllPurchaseOrders(env);
  const openPos = rawPos.filter(isOpenPo);
  const pos = shapePoRows(openPos);
  // Lead-time reality check for the Packaging tab. Derived from the CLOSED POs
  // that isOpenPo just filtered out, so it has to read rawPos, not openPos.
  const observedLeadTimes = buildObservedLeadTimes(rawPos);

  // 4. Derive incoming-by-SKU
  const incomingBySku = buildIncomingBySku(inventory, pos, monthPayloads, emptyTins);

  return {
    pos,
    incomingBySku,
    observedLeadTimes,
    runRateBasis: {
      // Documents which months fed the run-rate average so the frontend
      // tooltip can show "trailing 3 months: Feb / Mar / Apr 2026".
      months: monthPayloads.map((p) => p.month),
      missingMonths: monthList.filter((m) => !monthPayloads.some((p) => p.month === m)),
      note: 'All 5 channels (Coles + Woolies + Distributors + Woo + Amazon). Full demand picture.',
    },
    lastSync: new Date().toISOString(),
    source:   'cin7-live',
    counts: {
      pos: pos.length,
      incomingBySku: incomingBySku.length,
      inventoryRows: inventory.length,
    },
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Smallest proof-of-life. Hits /Branches with rows=1 — cheapest call we can
// make against Omni — and returns whether creds work + how many branches the
// account has. Used for smoke-testing after `wrangler secret put`.
auRoutes.get('/cin7/status', async (c) => {
  if (!cin7Configured(c.env)) {
    return c.json({
      connected: false,
      reason: 'CIN7_USERNAME and/or CIN7_CONNECTION_KEY not set as Wrangler secrets',
    });
  }
  try {
    const branches = await cin7Fetch(c.env, 'Branches', { rows: 1 });
    return c.json({
      connected: true,
      branchCount: Array.isArray(branches) ? branches.length : 0,
    });
  } catch (e) {
    return c.json({ connected: false, reason: String(e?.message || e) });
  }
});

// Diagnostic-only endpoint — dumps a sample of raw CIN7 SalesOrders for the
// named month plus the set of unique values found in the channel-attribution
// fields (channel, posRegister, company). Lets us see what CIN7 actually
// returns on the wire so the attribution rules in attributeCin7Channel can
// be tuned to real data instead of assumptions about the field shape.
//
// Added 2026-05-11 because v2.35.1 returned only 6/36 expected attributions
// for April 2026 — the `company` field on most EDI/refund orders is
// apparently NOT populated with "Coles" / "Woolworths" / "Stock Adjustments"
// the way the static CIN7 pivot CSV's "Customer" column is. This endpoint
// will reveal where the customer info actually lives.
//
// PII note: order responses include customer name + email. Endpoint is gated
// behind the dashboard's Cloudflare Access SSO same as everything else under
// /api/au, so only Google-Workspace-authenticated team members can hit it.
auRoutes.get('/sales/debug', async (c) => {
  const month = c.req.query('month') || '2026-04';
  const sampleSize = Math.min(20, Number(c.req.query('sample')) || 10);
  const type = String(c.req.query('type') || 'sales-orders');

  // v2.35.5 — type=credit-notes variant. Same diagnostic shape as the default
  // sales-orders dump, scoped to /CreditNotes. Use this after granting the
  // CreditNotes Read permission in CIN7 to confirm the connection key picked
  // up the new permission. If this returns 401/403 ("CIN7 CreditNotes: 401
  // Forbidden"), the key needs to be regenerated in CIN7 and the new value
  // pasted into the Cloudflare CIN7_CONNECTION_KEY secret — granting the
  // permission alone doesn't propagate to existing keys.
  if (type === 'credit-notes') {
    const creditNotes = await fetchCreditNotesForMonth(c.env, month);
    const uniqStatuses  = new Map();
    const uniqCompanies = new Map();
    let lineItemsTotal = 0;
    let parentLines    = 0;
    let childLines     = 0;
    let altUomLines    = 0;
    for (const cn of creditNotes) {
      const st = String(cn.status  || '');
      const co = String(cn.company || '');
      uniqStatuses.set(st,  (uniqStatuses.get(st)  || 0) + 1);
      uniqCompanies.set(co, (uniqCompanies.get(co) || 0) + 1);
      const lines = Array.isArray(cn.lineItems) ? cn.lineItems : [];
      lineItemsTotal += lines.length;
      for (const li of lines) {
        if ((Number(li?.parentId) || 0) > 0) childLines++;
        else parentLines++;
        if ((Number(li?.uomSize)  || 0) > 1) altUomLines++;
      }
    }
    const topN = (m, n) => Array.from(m.entries()).sort((a,b) => b[1]-a[1]).slice(0, n);
    return c.json({
      month,
      type: 'credit-notes',
      totalCreditNotes: creditNotes.length,
      lineItemsTotal,
      parentLines,
      childLines,
      altUomLines,
      uniqueStatuses:  topN(uniqStatuses,  20),
      uniqueCompanies: topN(uniqCompanies, 30),
      sample: creditNotes.slice(0, sampleSize),  // raw — full field shape
      note: 'Diagnostic — /CreditNotes raw dump. If this 401/403s, regenerate CIN7 connection key and paste into the Cloudflare CIN7_CONNECTION_KEY secret.',
    });
  }

  const orders = await fetchSalesOrdersForMonth(c.env, month);

  // Collect unique values in the fields we use for attribution
  const uniqChannels    = new Map(); // value → count
  const uniqPosRegister = new Map();
  const uniqCompanies   = new Map();
  const uniqStatuses    = new Map();
  // Cross-tab: channel × company combinations (top 30)
  const channelByCompany = new Map(); // `${channel}|${company}` → count
  for (const o of orders) {
    const ch  = String(o.channel     || '');
    const pos = String(o.posRegister || '');
    const co  = String(o.company     || '');
    const st  = String(o.status      || '');
    uniqChannels.set(ch,    (uniqChannels.get(ch)    || 0) + 1);
    uniqPosRegister.set(pos,(uniqPosRegister.get(pos)|| 0) + 1);
    uniqCompanies.set(co,   (uniqCompanies.get(co)   || 0) + 1);
    uniqStatuses.set(st,    (uniqStatuses.get(st)    || 0) + 1);
    const key = `${ch || '(none)'} | ${co || '(none)'}`;
    channelByCompany.set(key, (channelByCompany.get(key) || 0) + 1);
  }

  // Find a few candidate orders that look like they MIGHT be Coles / Woolies
  // / refunds, in case the customer name lives in a field we're not reading
  // (e.g. member.* sub-object). Check by SKU pattern — Coles + Woolies orders
  // all line items are AU-CTN-...-48 cartons.
  const looksLikeBulkOrder = (o) => {
    const lines = Array.isArray(o.lineItems) ? o.lineItems : [];
    if (lines.length === 0) return false;
    return lines.some(li => String(li?.code || '').startsWith('AU-CTN-'));
  };
  const bulkOrders = orders.filter(looksLikeBulkOrder).slice(0, sampleSize);
  // Also: orders with negative-qty line items — those should be refunds
  const looksLikeRefund = (o) => {
    const lines = Array.isArray(o.lineItems) ? o.lineItems : [];
    return lines.some(li => Number(li?.qty ?? li?.quantity ?? 0) < 0);
  };
  const refundOrders = orders.filter(looksLikeRefund).slice(0, sampleSize);

  // Top-N tables, sorted by count desc
  const topN = (m, n) => Array.from(m.entries()).sort((a,b) => b[1]-a[1]).slice(0, n);

  return c.json({
    month,
    totalOrders: orders.length,
    uniqueChannels:    topN(uniqChannels,    20),
    uniquePosRegister: topN(uniqPosRegister, 20),
    uniqueStatuses:    topN(uniqStatuses,    20),
    uniqueCompanies:   topN(uniqCompanies,   30),
    channelByCompany:  topN(channelByCompany,30),
    bulkOrderSample:   bulkOrders,    // raw — shows full field shape
    refundOrderSample: refundOrders,
    note: 'Diagnostic endpoint. Dumps raw CIN7 SalesOrders fields so attribution rules can be tuned to real data. Safe to leave deployed — gated behind Cloudflare Access SSO.',
  });
});

// Live monthly sales — CIN7-sourced channels (Coles + Woolies + Distributors)
// + refunds + per-SKU rollup, all from one /SalesOrders fetch. Woo + Amazon
// channels stay static until Phase 3; the frontend merges per channel.
//
// Query: ?month=YYYY-MM (required), ?refresh=1 (optional — bypass cache).
// Cache key: `au:sales:YYYY-MM:v1`, 15-min TTL, stale-fallback on error.
auRoutes.get('/sales', async (c) => {
  const month = c.req.query('month');
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return c.json({ error: 'month query param required, format YYYY-MM' }, 400);
  }
  const forceRefresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true';
  try {
    const payload = await getMonthSales(c.env, month, { forceRefresh });
    return c.json(payload);
  } catch (e) {
    throw e; // global onError sanitises + returns 500
  }
});

// Live POs + derived incoming-by-SKU. Cache key `au:pos:v1`, 15-min TTL,
// stale-fallback on error. Cold-cache cost ≈ 24 CIN7 subrequests (inventory
// + 3 months of sales + POs); warm-cache hits go straight to the cached
// payload. ?refresh=1 to bypass.
auRoutes.get('/pos', async (c) => {
  const forceRefresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true';
  const cache = c.env.CACHE;

  if (!forceRefresh && cache) {
    const cached = await cache.get(KV_POS_KEY, 'json');
    if (cached?.pos?.length) {
      return c.json({ ...cached, cached: true });
    }
  }

  try {
    const payload = await buildAuPosPayload(c.env);
    if (cache) {
      await cache.put(KV_POS_KEY, JSON.stringify(payload), { expirationTtl: POS_TTL_SECONDS });
    }
    return c.json({ ...payload, cached: false });
  } catch (e) {
    if (cache) {
      const cached = await cache.get(KV_POS_KEY, 'json');
      if (cached?.pos?.length) {
        return c.json({
          ...cached,
          cached: true,
          staleFallback: true,
          error: 'Upstream CIN7 error — serving cached snapshot.',
        });
      }
    }
    throw e;
  }
});

// Diagnostic-only endpoint — dumps raw CIN7 /PurchaseOrders data so the
// open-vs-closed filter (`isOpenPo`) can be tuned to real CIN7 behaviour
// rather than assumed field shapes. Added 2026-05-16 (v2.2.15) while
// reworking the filter to use `fullyReceivedDate` + line-item rollup
// instead of just `status` + `completedDate`.
//
// Modes:
//   • No params (default) — frequency tables of status values, closure-signal
//     counts (how many POs have fullyReceivedDate / cancellationDate / isVoid
//     set vs not), and a sample of the OLDEST APPROVED POs (the ones most
//     likely to be received-but-never-closed). Use this to confirm the new
//     filter drops the right rows.
//   • ?ref=PO-AU-T88 — dump one specific PO by reference, with the raw fields
//     plus `isOpenByCurrentFilter` and `isFullyReceivedByLines` evaluations.
//
// PII note: PO responses include supplier company + contact name/email.
// Endpoint is gated behind Cloudflare Access SSO same as the rest of /api/au.
auRoutes.get('/pos/debug', async (c) => {
  const refQuery   = c.req.query('ref');
  const sampleSize = Math.min(20, Number(c.req.query('sample')) || 5);
  const rawPos     = await fetchAllPurchaseOrders(c.env);

  if (refQuery) {
    const needle = String(refQuery).trim().toLowerCase();
    const match  = rawPos.find((p) =>
      String(p?.reference || '').trim().toLowerCase() === needle,
    );
    return c.json({
      ref: refQuery,
      found: !!match,
      po: match || null,
      evaluation: match ? {
        isOpenByCurrentFilter:   isOpenPo(match),
        isFullyReceivedByLines:  isFullyReceivedByLines(match),
        status:                  match?.status || null,
        completedDate:           match?.completedDate     || null,
        fullyReceivedDate:       match?.fullyReceivedDate || null,
        cancellationDate:        match?.cancellationDate  || null,
        isVoid:                  match?.isVoid === true,
        // v2.2.16: surface every date field so we can see which one this
        // supplier actually populates for "expected delivery".
        dateFields: {
          createdDate:             match?.createdDate             || null,
          modifiedDate:             match?.modifiedDate            || null,
          deliveryDate:             match?.deliveryDate            || null,
          estimatedDeliveryDate:    match?.estimatedDeliveryDate   || null,
          estimatedArrivalDate:     match?.estimatedArrivalDate    || null,
          supplierAcceptanceDate:   match?.supplierAcceptanceDate  || null,
          invoiceDate:              match?.invoiceDate             || null,
          fullyReceivedDate:        match?.fullyReceivedDate       || null,
          cancellationDate:         match?.cancellationDate        || null,
          completedDate:            match?.completedDate           || null,
        },
        customFields:              match?.customFields            || null,
        lineQtyRollup:           (match.lineItems || []).map((li) => ({
          code:        li?.code,
          qty:         Number(li?.qty || 0),
          qtyShipped:  Number(li?.qtyShipped || 0),
          holdingQty:  Number(li?.holdingQty || 0),
          fullyReceived: (Number(li?.qty || 0) <= 0)
            ? 'n/a (zero qty)'
            : (Number(li?.qtyShipped || 0) + 0.001 >= Number(li?.qty || 0)),
        })),
      } : null,
    });
  }

  // Aggregate diagnostic across all POs
  const uniqStatuses = new Map();
  const closureSignals = {
    completedDate_set:           0,
    fullyReceivedDate_set:       0,
    cancellationDate_set:        0,
    isVoid_true:                 0,
    fully_received_by_lines:     0,
    open_by_v2_2_14_filter:      0, // status + completedDate only
    open_by_v2_2_15_filter:      0, // new logic
  };
  // v2.2.16: count how many OPEN POs have each date field populated. Tells us
  // which CIN7 date field your team actually populates for "expected delivery".
  const openDateFieldCoverage = {
    open_pos_total:               0,
    deliveryDate_set:             0,
    estimatedDeliveryDate_set:    0,
    estimatedArrivalDate_set:     0,
    supplierAcceptanceDate_set:   0,
    invoiceDate_set:              0,
    customFields_set:             0,
    no_date_at_all:               0,
  };
  const oldestApproved = [];
  for (const po of rawPos) {
    const st = String(po?.status || '');
    uniqStatuses.set(st, (uniqStatuses.get(st) || 0) + 1);
    if (po?.completedDate)        closureSignals.completedDate_set++;
    if (po?.fullyReceivedDate)    closureSignals.fullyReceivedDate_set++;
    if (po?.cancellationDate)     closureSignals.cancellationDate_set++;
    if (po?.isVoid === true)      closureSignals.isVoid_true++;
    if (isFullyReceivedByLines(po)) closureSignals.fully_received_by_lines++;
    // Old filter for comparison: closed iff completedDate set or status in set
    const sLower = st.trim().toLowerCase();
    const oldClosed = !!po?.completedDate || CLOSED_PO_STATUSES.has(sLower);
    if (!oldClosed) closureSignals.open_by_v2_2_14_filter++;
    if (isOpenPo(po)) {
      closureSignals.open_by_v2_2_15_filter++;
      // Track date-field coverage only on OPEN POs — closed ones already
      // have fullyReceivedDate, that's not the question we're answering.
      openDateFieldCoverage.open_pos_total++;
      if (po?.deliveryDate)            openDateFieldCoverage.deliveryDate_set++;
      if (po?.estimatedDeliveryDate)   openDateFieldCoverage.estimatedDeliveryDate_set++;
      if (po?.estimatedArrivalDate)    openDateFieldCoverage.estimatedArrivalDate_set++;
      if (po?.supplierAcceptanceDate)  openDateFieldCoverage.supplierAcceptanceDate_set++;
      if (po?.invoiceDate)             openDateFieldCoverage.invoiceDate_set++;
      if (po?.customFields && Object.keys(po.customFields).length > 0) {
        openDateFieldCoverage.customFields_set++;
      }
      const anyDate = po?.deliveryDate || po?.estimatedDeliveryDate ||
                      po?.estimatedArrivalDate || po?.supplierAcceptanceDate;
      if (!anyDate) openDateFieldCoverage.no_date_at_all++;
    }

    if (st.toLowerCase() === 'approved' && !isOpenPo(po)) {
      // POs that the new filter drops — most useful sample to inspect.
      oldestApproved.push(po);
    }
  }
  oldestApproved.sort((a, b) =>
    String(a?.createdDate || '').localeCompare(String(b?.createdDate || '')),
  );

  return c.json({
    totalPos: rawPos.length,
    uniqueStatuses: Array.from(uniqStatuses.entries())
      .sort((a, b) => b[1] - a[1]),
    closureSignals,
    delta_v2_2_14_to_v2_2_15:
      closureSignals.open_by_v2_2_14_filter - closureSignals.open_by_v2_2_15_filter,
    // v2.2.16: which date field do open POs actually have populated? Use this
    // to confirm whether the dashboard's empty Expected date / Days until
    // arrival columns mean (a) data is in CIN7 in a field we don't read, or
    // (b) the data simply isn't entered in CIN7 by your process.
    openDateFieldCoverage,
    sampleClosedByNewFilter: oldestApproved.slice(0, sampleSize),
    note: 'Diagnostic — to inspect one PO with full fields + filter eval: ?ref=PO-AU-T88',
  });
});

// ── Packaging demand (AU Packaging tab) ───────────────────────────────────
//
// Packaging demand does NOT follow finished-goods demand, because different
// channels consume different packaging. Mel's rules (2026-07-20):
//
//   Envelopes  one mailer per D2C Woo order — but NOT orders containing an SRT
//              or wholesale carton, since those ship in their own packaging.
//              (NA counts 1 per Woo order flat, which would over-order here.)
//              The three mailer SKUs are NOT interchangeable; which one an
//              order consumes depends on its composition (Mel, 2026-07-20):
//                P-BOX-12x85  >6 × 85g, OR >12 × 35g, OR mixed and >10 tins
//                P-ENV-A1     any order containing 85g, OR 7–12 × 35g
//                ENVELOPES    6 or fewer 35g tins, no 85g
//              Evaluated in that order — the box rule is the "too big for a
//              mailer" case and wins. The 7–12 × 35g band belongs to P-ENV-A1
//              (Mel, 2026-07-20): ENVELOPES stops at 6 and the box starts above
//              12, so the large envelope covers the middle. Every D2C order
//              therefore lands somewhere; `unassigned` below is a sanity
//              counter that should always read 0, kept so a future rule change
//              that leaves a hole shows up rather than silently under-counting.
//   SRT trays  supermarket + distributor volume, PLUS Woo tray sales — D2C
//              tray sales consume tray stock exactly like a Coles order does.
//              A carton also consumes 4 trays, so cartons contribute here too.
//   Cartons    printed outers, from carton sales across all channels.
//   Blank outers / blank tins  no forecast at all — flag when low.
//
// Pack-format UNIT counts, not tin-equivalents. skuSales can't serve this: it
// rolls every line up to base SKU with the multiplier already applied, so a
// 48-tin carton and 48 single tins are indistinguishable by the time it lands.
// Both raw sources below still carry the original code + qty:
//   Woo         order_items.sku    (AU-SRT-…x12 / AU-CTN-…-48 / WC-AU-…)
//   Supermarket cin7_sales_order_items.code + .qty, channel_attr-filtered
//
// WC-AU-… (×54) wholesale cartons are EXCLUDED outright, not unmapped: they
// ship direct from the manufacturer with no SRTs and no specialised carton
// (Mel, 2026-07-20), so they consume none of the packaging on this tab. They
// still suppress an envelope on the Woo side — a wholesale order isn't going
// out in an A1 mailer — which is why the envelope query still excludes them.
//
// AU-CTN-SRT-MIX-… (×72) genuinely IS unmapped: 72 = 6 trays, and the 6SRT
// outers in stock (P-AU-{BLANK,PRINTED}-6SRT-OUTERS) look like its packaging,
// but the trays inside are mixed scents so the demand can't be attributed to
// any single tray SKU. Surfaced under `unmapped` rather than guessed at; the
// 6SRT outers are flag-when-low anyway, which covers the practical need.
const CTN_TRAYS_PER_CARTON = 4;

async function buildAuPackagingDemand(env, monthsBack = 6) {
  const since = new Date(Date.now() - monthsBack * 30.44 * 86400000)
    .toISOString().slice(0, 10);

  const [envRes, wooRes, cin7Res] = await Promise.all([
    // A) Mailer demand. Per D2C order, count 35g and 85g tins, then bucket the
    //    order to the mailer its composition calls for. Tray/carton orders are
    //    excluded outright — they ship in their own packaging.
    //    `-M` suffixed SKUs are subscription variants of the same tin, so the
    //    size match allows an optional trailing M.
    env.DB.prepare(
      `WITH d2c AS (
         SELECT o.id                        AS oid,
                substr(o.local_date, 1, 7)  AS ym,
                SUM(CASE WHEN oi.sku LIKE '%-35' OR oi.sku LIKE '%-35M'
                         THEN oi.quantity ELSE 0 END) AS n35,
                SUM(CASE WHEN oi.sku LIKE '%-85' OR oi.sku LIKE '%-85M'
                         THEN oi.quantity ELSE 0 END) AS n85
           FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
          WHERE o.market = 'AU'
            AND o.status IN ('completed','processing')
            AND o.local_date >= ?
            AND NOT EXISTS (
                  SELECT 1 FROM order_items x
                   WHERE x.order_id = o.id
                     AND (x.sku LIKE 'AU-SRT-%'
                       OR x.sku LIKE 'AU-CTN-%'
                       OR x.sku LIKE 'WC-AU-%')
                )
          GROUP BY o.id
       ),
       tagged AS (
         SELECT ym, n35, n85,
                CASE WHEN n85 > 6 OR n35 > 12
                       OR (n85 > 0 AND n35 > 0 AND n85 + n35 > 10)
                     THEN 1 ELSE 0 END AS is_box
           FROM d2c
          WHERE n35 + n85 > 0
       )
       SELECT ym,
              SUM(is_box)                                                    AS box,
              -- Large envelope: anything with 85g in it, plus the 7–12 × 35g
              -- band (is_box already excluded >12, so n35 > 6 means 7–12).
              SUM(CASE WHEN is_box = 0 AND (n85 > 0 OR n35 > 6)
                       THEN 1 ELSE 0 END)                                    AS env_a1,
              SUM(CASE WHEN is_box = 0 AND n85 = 0 AND n35 <= 6
                       THEN 1 ELSE 0 END)                                    AS envelopes,
              -- Sanity counter: should always be 0 under the current rules.
              SUM(CASE WHEN is_box = 0
                        AND NOT (n85 > 0 OR n35 > 6)
                        AND NOT (n85 = 0 AND n35 <= 6)
                       THEN 1 ELSE 0 END)                                    AS unassigned,
              COUNT(*)                                                       AS total
         FROM tagged
        GROUP BY ym`,
    ).bind(since).all(),

    // B) Woo pack-format units (trays / cartons sold direct).
    env.DB.prepare(
      `SELECT substr(oi.local_date, 1, 7) AS ym,
              oi.sku                      AS code,
              SUM(oi.quantity)            AS units
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE oi.market = 'AU'
          AND o.status IN ('completed','processing')
          AND oi.local_date >= ?
          AND (oi.sku LIKE 'AU-SRT-%' OR oi.sku LIKE 'AU-CTN-%' OR oi.sku LIKE 'WC-AU-%')
        GROUP BY ym, oi.sku`,
    ).bind(since).all(),

    // C) Supermarket + distributor pack-format units, straight off CIN7 lines.
    env.DB.prepare(
      `SELECT substr(i.created_date, 1, 7) AS ym,
              i.code                       AS code,
              SUM(i.qty)                   AS units
         FROM cin7_sales_order_items i
         JOIN cin7_sales_orders o ON o.id = i.order_id
        WHERE i.market = 'AU'
          AND o.status = 'APPROVED'
          AND o.channel_attr IN ('col','woo2','dist')
          AND i.is_au_sku = 1
          AND i.created_date >= ?
          AND (i.code LIKE 'AU-SRT-%' OR i.code LIKE 'AU-CTN-%' OR i.code LIKE 'WC-AU-%')
        GROUP BY ym, i.code`,
    ).bind(since).all(),
  ]);

  // trays[pkgSku][ym] / cartons[pkgSku][ym] — packaging SKU → month → units.
  const trays = {}, cartons = {}, unmapped = {};
  const bump = (target, sku, ym, n) => {
    if (!sku || !n) return;
    (target[sku] = target[sku] || {});
    target[sku][ym] = (target[sku][ym] || 0) + n;
  };

  const foldPackRows = (rows, channel) => {
    for (const r of rows) {
      const code = String(r.code || '').trim();
      const ym = r.ym, units = Number(r.units) || 0;
      if (!code || !ym || units <= 0) continue;

      // Shelf-ready tray: AU-SRT-<scent>-<form>x12 → one tray each.
      let m = code.match(/^AU-SRT-(.+?)-*x12$/);
      if (m) { bump(trays, `P-AU-SRT-${m[1]}`, ym, units); continue; }

      // Retailer carton: AU-CTN-<scent>-<form>-48 → one printed outer, and
      // the 4 trays packed inside it.
      m = code.match(/^AU-CTN-(?!SRT-MIX)(.+)-48$/);
      if (m) {
        bump(cartons, `P-OC-AU-CTN-${m[1]}-48`, ym, units);
        bump(trays,   `P-AU-SRT-${m[1]}`,       ym, units * CTN_TRAYS_PER_CARTON);
        continue;
      }

      // Wholesale cartons: manufacturer-direct, no packaging consumed here.
      if (code.startsWith('WC-AU-')) continue;

      // Mixed mega-trays — real demand we can't attribute to a tray SKU.
      bump(unmapped, `${code} (${channel})`, ym, units);
    }
  };

  foldPackRows(wooRes.results  || [], 'woo');
  foldPackRows(cin7Res.results || [], 'supermarket');

  // Mailer demand keyed by the actual packaging SKU, so the front end can treat
  // each as its own line rather than one pooled envelope figure.
  const mailers = { 'P-BOX-12x85': {}, 'P-ENV-A1': {}, 'ENVELOPES': {} };
  const mailerUnassigned = {};  // ym → orders matching no rule (expect empty)
  const mailerOrders = {};      // ym → total D2C orders considered
  for (const r of (envRes.results || [])) {
    if (!r.ym) continue;
    mailers['P-BOX-12x85'][r.ym] = Number(r.box)       || 0;
    mailers['P-ENV-A1'][r.ym]    = Number(r.env_a1)    || 0;
    mailers['ENVELOPES'][r.ym]   = Number(r.envelopes) || 0;
    if (Number(r.unassigned)) mailerUnassigned[r.ym] = Number(r.unassigned);
    mailerOrders[r.ym] = Number(r.total) || 0;
  }

  return {
    since,
    monthsBack,
    mailers,            // packaging SKU → { ym: orders needing that mailer }
    mailerUnassigned,   // ym → orders matching no rule; expected to stay empty
    mailerOrders,       // ym → total D2C orders considered
    trays,            // P-AU-SRT-…      → { ym: units }
    cartons,          // P-OC-AU-CTN-…-48 → { ym: units }
    unmapped,         // pack formats with no packaging mapping (SRT-MIX)
    note: 'Trays include 4 per retailer carton. Mailers are bucketed per order '
        + 'by composition, not pooled — the three SKUs are not interchangeable.',
  };
}

auRoutes.get('/packaging-demand', async (c) => {
  const monthsBack = Math.min(24, Math.max(1, Number(c.req.query('months')) || 6));
  try {
    const payload = await buildAuPackagingDemand(c.env, monthsBack);
    return c.json({ ...payload, lastSync: new Date().toISOString(), source: 'd1' });
  } catch (e) {
    console.error('AU packaging-demand error:', e?.message || e);
    return c.json({ error: 'Failed to build packaging demand', detail: String(e?.message || e) }, 500);
  }
});

// Live inventory. KV-cached for 15 min; pass ?refresh=1 to bypass and force
// a fresh upstream pull. Falls back to cache (with `staleFallback: true`) on
// upstream error so the dashboard always has something usable to render.
auRoutes.get('/inventory', async (c) => {
  const forceRefresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true';
  const cache = c.env.CACHE;

  if (!forceRefresh && cache) {
    const cached = await cache.get(KV_INVENTORY_KEY, 'json');
    if (cached?.inventory?.length) {
      return c.json({ ...cached, cached: true });
    }
  }

  try {
    const payload = await buildAuInventoryPayload(c.env);
    if (cache) {
      await cache.put(KV_INVENTORY_KEY, JSON.stringify(payload), {
        expirationTtl: INVENTORY_TTL_SECONDS,
      });
    }
    return c.json({ ...payload, cached: false });
  } catch (e) {
    if (cache) {
      const cached = await cache.get(KV_INVENTORY_KEY, 'json');
      if (cached?.inventory?.length) {
        return c.json({
          ...cached,
          cached: true,
          staleFallback: true,
          error: 'Upstream CIN7 error — serving cached snapshot.',
        });
      }
    }
    throw e; // global onError sanitizes + returns 500
  }
});

// ════════════════════════════════════════════════════════════
//  HFM screenshot → CIN7 ETD update  (AU Purchase Orders tab)
//  POST /api/au/etd/scan  — upload a screenshot → vision parse → match each
//    Cust PO# to CIN7 reference (PO-<num>) → preview current vs new ETD.
//  POST /api/au/etd/apply — write estimatedDeliveryDate back to CIN7 for the
//    approved rows, with a KV audit entry per run.
//  CIN7 write validated 2026-07-08: PUT /PurchaseOrders [{id,estimatedDeliveryDate}]
//  is a partial update; needs the connection's PurchaseOrders→Update privilege.
// ════════════════════════════════════════════════════════════

const ETD_MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

// Resolve an HFM "fill date" cell to a single YYYY-MM-DD using the EARLIEST-date
// rule. Handles "1-2 Jul", "3-Jul", "17 & 24 Jul", "30-31 Jul", "29 Jul & 3 Aug".
function resolveFillDate(raw, refToday = new Date()) {
  if (!raw) return { date: null, note: 'empty' };
  const s = String(raw).toLowerCase().replace(/&/g, ' ').replace(/\s+/g, ' ').trim();
  const monthMatches = [];
  const mre = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/g;
  let m;
  while ((m = mre.exec(s)) !== null) monthMatches.push({ mon: ETD_MONTHS[m[1]], idx: m.index });
  if (!monthMatches.length) return { date: null, note: 'no month found' };
  const days = [];
  const dre = /\d{1,2}/g;
  while ((m = dre.exec(s)) !== null) {
    const d = parseInt(m[0], 10);
    if (d >= 1 && d <= 31) days.push({ day: d, idx: m.index });
  }
  if (!days.length) return { date: null, note: 'no day found' };
  const y0 = refToday.getFullYear();
  const dated = days.map(({ day, idx }) => {
    const mt = monthMatches.find((x) => x.idx >= idx) || monthMatches[monthMatches.length - 1];
    let dt = new Date(Date.UTC(y0, mt.mon, day));
    if ((refToday - dt) > 120 * 864e5) dt = new Date(Date.UTC(y0 + 1, mt.mon, day));
    return dt;
  });
  const earliest = dated.reduce((a, b) => (a < b ? a : b));
  const iso = earliest.toISOString().slice(0, 10);
  const note = days.length > 1 ? `earliest of ${days.map((d) => d.day).join(' / ')}` : '';
  return { date: iso, note };
}

// "2026-07-01" -> "2026-07-01T00:00:00Z" (= 10am AEST; never rolls a day back in AU)
function etdToIso(ymd) {
  const m = String(ymd).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T00:00:00Z` : null;
}
function etdDayOf(v) { return v ? String(v).slice(0, 10) : ''; }

// Parse a due-date cell like "10/7/2026" (d/m/y) -> YYYY-MM-DD for the anomaly check.
function parseEtdDueDate(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let [, d, mo, y] = m; y = y.length === 2 ? '20' + y : y;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function extractJsonArray(text) {
  let t = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();
  const s = t.indexOf('['), e = t.lastIndexOf(']');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  const arr = JSON.parse(t);
  if (!Array.isArray(arr)) throw new Error('AI response was not a JSON array');
  return arr;
}

const ETD_VISION_PROMPT =
  'You are reading a screenshot of a manufacturer\'s production-schedule table. Extract EVERY data row. ' +
  'Columns are typically: Cust PO#, Description, Size, Quantity, Due Date, Fill Date. ' +
  'Return ONLY a JSON array (no prose, no markdown fences), one object per row, each with these exact keys: ' +
  '"cust_po" (string, digits only), "description" (string), "size" (string), "quantity" (string), ' +
  '"due_date" (string exactly as written), "fill_date" (string exactly as written, e.g. "1-2 Jul" or "17 & 24 Jul"). ' +
  'Copy the dates EXACTLY as shown — do not normalise or interpret ranges. Skip fully empty rows.';

// Read the screenshot. Prefers Claude vision when ANTHROPIC_API_KEY is set
// (more reliable on dense tables); otherwise uses Cloudflare Workers AI (env.AI),
// which needs no external key.
async function extractEtdRowsFromImage(env, base64, mediaType) {
  const key = (env.ANTHROPIC_API_KEY || '').trim();
  if (key) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: (env.ANTHROPIC_MODEL || 'claude-sonnet-5').trim(),
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: ETD_VISION_PROMPT },
          ],
        }],
      }),
    });
    const txt = await resp.text();
    if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${txt.slice(0, 200)}`);
    const data = JSON.parse(txt);
    return extractJsonArray(data?.content?.[0]?.text || '');
  }
  if (env.AI) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const model = env.AU_ETD_VISION_MODEL || '@cf/meta/llama-3.2-11b-vision-instruct';
    const input = { image: [...bytes], prompt: ETD_VISION_PROMPT, max_tokens: 4096 };
    let out;
    try {
      out = await env.AI.run(model, input);
    } catch (e) {
      // Workers AI error 5016: the Llama vision model requires a one-time
      // Community-License acceptance ("submit the prompt 'agree'") before first
      // use. No Pong is an Australian company (not EU-domiciled), so accept it
      // once for the account, then retry the real request.
      const msg = String(e?.message || e);
      if (/\b5016\b/.test(msg) || /submit the prompt 'agree'/i.test(msg)) {
        try { await env.AI.run(model, { prompt: 'agree' }); } catch (_) {}
        out = await env.AI.run(model, input);
      } else {
        throw e;
      }
    }
    return extractJsonArray(out?.response || '');
  }
  throw new Error('No AI configured to read the screenshot — add the Workers AI binding (env.AI) or set ANTHROPIC_API_KEY.');
}

// CIN7 write. PUT /PurchaseOrders with an array of {id, ...fieldsToUpdate}.
async function cin7Put(env, endpoint, body) {
  const auth = cin7AuthHeader(env);
  if (!auth) throw new Error('CIN7 not configured.');
  const resp = await fetch(`${CIN7_BASE}/${endpoint}`, {
    method: 'PUT',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = null; }
  return { ok: resp.ok, status: resp.status, json, text };
}

// Upload a screenshot → parsed + matched preview rows. No writes.
auRoutes.post('/etd/scan', async (c) => {
  try {
    if (!cin7Configured(c.env)) return c.json({ error: 'CIN7 not configured.' }, 503);
    const body = await c.req.json().catch(() => ({}));
    let raw;
    if (Array.isArray(body?.rows)) {
      // Spreadsheet path (default) — rows already parsed client-side from the
      // uploaded Excel/CSV, so no AI is involved. Each row: { cust_po, fill_date, due_date? }.
      raw = body.rows;
    } else {
      // Image path (fallback only) — read a screenshot with vision. Requires an
      // AI provider to be configured (env.AI binding or ANTHROPIC_API_KEY).
      let { image, mediaType } = body || {};
      if (!image) return c.json({ error: 'No spreadsheet rows or image provided.' }, 400);
      const dm = /^data:([^;]+);base64,(.*)$/s.exec(image);
      if (dm) { mediaType = mediaType || dm[1]; image = dm[2]; }
      mediaType = mediaType || 'image/png';
      raw = await extractEtdRowsFromImage(c.env, image, mediaType);
    }
    const pos = await fetchAllPurchaseOrders(c.env);
    const byRef = new Map();
    for (const p of pos) if (p.reference) byRef.set(String(p.reference).toUpperCase(), p);
    const today = new Date();

    const rows = raw.map((r) => {
      const cust = String(r.cust_po || '').replace(/[^0-9]/g, '');
      const ref = cust ? ('PO-' + cust).toUpperCase() : '';
      const resolved = resolveFillDate(r.fill_date, today);
      const po = ref ? byRef.get(ref) : null;
      const currentDay = po ? etdDayOf(po.estimatedDeliveryDate) : '';
      const newDay = resolved.date || '';
      const flags = [];
      if (resolved.note && /earliest/.test(resolved.note)) flags.push(resolved.note);
      const due = parseEtdDueDate(r.due_date);
      if (due && newDay && newDay > due) flags.push('fill date is after the due date');
      let change = 'skip';
      if (!po) change = 'nomatch';
      else if (!newDay) change = 'baddate';
      else if (currentDay === newDay) change = 'same';
      else change = 'change';
      return {
        cust_po: cust, reference: ref, description: r.description || '', size: r.size || '',
        quantity: r.quantity || '', due_date: r.due_date || '', fill_raw: r.fill_date || '',
        po_id: po ? po.id : null, current_etd: currentDay, new_etd: newDay, change, flags,
      };
    });
    return c.json({ rows, parsed: raw.length });
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 500);
  }
});

// Write the approved ETDs to CIN7. Body: { changes: [{po_id, reference, current_etd, new_etd}] }
auRoutes.post('/etd/apply', async (c) => {
  try {
    if (!cin7Configured(c.env)) return c.json({ error: 'CIN7 not configured.' }, 503);
    const body = await c.req.json().catch(() => ({}));
    const changes = (body && body.changes) || [];
    if (!Array.isArray(changes) || !changes.length) return c.json({ error: 'No changes to apply.' }, 400);

    const results = [];
    for (const ch of changes) {
      const iso = etdToIso(ch.new_etd);
      if (!ch.po_id || !iso) { results.push({ reference: ch.reference, po_id: ch.po_id, success: false, error: 'missing PO id or bad date' }); continue; }
      const put = await cin7Put(c.env, 'PurchaseOrders', [{ id: Number(ch.po_id), estimatedDeliveryDate: iso }]);
      const ok = put.ok && Array.isArray(put.json) && put.json[0] && put.json[0].success;
      results.push({
        reference: ch.reference, po_id: ch.po_id,
        old_etd: etdDayOf(ch.current_etd), new_etd: etdDayOf(ch.new_etd),
        success: !!ok, http: put.status, error: ok ? '' : String(put.text).slice(0, 200),
      });
      await sleep(PAGE_DELAY_MS); // stay under CIN7's 3/sec rate limit
    }

    // Audit log to KV (180-day TTL) — old→new ETD per PO, for traceability.
    try {
      if (c.env.CACHE) {
        const stamp = new Date().toISOString();
        await c.env.CACHE.put(`au:etd:audit:${stamp}`, JSON.stringify({ stamp, results }), { expirationTtl: 60 * 60 * 24 * 180 });
      }
    } catch (_) {}

    const good = results.filter((r) => r.success).length;
    return c.json({ results, updated: good, total: changes.length });
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 500);
  }
});
