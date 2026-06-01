/**
 * AU Logistics tab — endpoint + helpers.
 *
 * Drives the warehouse TV (1920×1080, 16:9, no-scroll) for the AU
 * fulfilment team. Patterns mirror src/birthday.js (KV-cached 60s,
 * ShipStation snapshot reused as-is). v2.2.27g: SalesOrders are fetched
 * LIVE from CIN7 Omni v1 — bypassing the D1 cache because the v2.2.10
 * strict-greater-than watermark gets stuck on CIN7 bulk-modification tie
 * groups, and chasing them with manual watermark resets loses data. Two
 * CIN7 calls per dashboard refresh (SalesOrders + Stock), serialized,
 * KV-cached 60s — comfortably within CIN7's 3/sec, 60/min, 5000/day
 * limits.
 *
 * Surfaces:
 *   1. ShipStation snapshot — open queue, shipped-today counts, express/intl
 *      + wholesale alert lists. Reuses buildShipStationSnapshot() unchanged.
 *   2. Open distributor orders from CIN7 Omni v1, split into three groups
 *      (v2.2.43 — was two: colesWoolies + otherDistributors):
 *      • coles — Coles orders only, sorted by must-ship-by date ascending.
 *        Coles QLD (RedBank) + Coles VIC (Somerton) must ship the business
 *        day BEFORE deliveryDate; Coles NSW ships on deliveryDate itself.
 *      • woolies — Woolworths orders only, sorted by must-ship-by date
 *        ascending. All Woolies DCs ship on deliveryDate itself.
 *      • otherDistributors — every other CIN7 wholesale order (Momentum, AVO,
 *        etc.), sorted by order number ascending. Older order numbers are
 *        treated as more urgent (proxy for "longer waiting" since CIN7 IDs
 *        increment over time).
 *   3. Per-line-item stock check — for each line in each open distributor
 *      order, compare cartons ordered vs warehouse-available stock (CIN7
 *      Stock minus the Amazon FBA branch — FBA stock can't fulfil distributor
 *      orders). Frontend renders a green tick when fulfillable, or
 *      "X / Y cartons" when short.
 *
 * The DC → state mapping is hardcoded against the three known Coles DCs
 * (RedBank, Somerton, Kemps Creek) and two known Woolies DCs (Moorebank,
 * Erskine Park). New DC names will show with retailer label only (no state).
 *
 * Owned by Melanie. Introduced in v2.2.27.
 */

import { Hono } from 'hono';
import {
  fetchStockBySku,
  attributeCin7Order,
  normalizeAuSku,
  cin7FetchAll,
} from './cin7.js';
import { buildShipStationSnapshot } from './shipstation.js';
import { redactSecrets } from './redact.js';

export const logisticsRoutes = new Hono();

// ─── Config ────────────────────────────────────────────────────────────────

const KV_KEY = 'au:logistics:v1';
const KV_TTL_SECONDS = 60;

// DC → label + state + must-ship-by-business-day-before rule.
//
// Both Coles AND Woolies have a "Redbank" DC, so the matcher MUST run
// retailer attribution first (via attributeCin7Order → 'col' or 'woo2')
// before checking DC substrings. Within each retailer's table, the DC
// substring is matched case-insensitively against the order's `company`
// field.
//
// shipDayBefore: when true, must-ship-by is the previous business day
// (weekend-skipping). When false, must-ship-by IS the delivery date.
// Public holidays are NOT skipped in v1 — add when needed.
const COLES_DC_TABLE = [
  { match: 'redbank',     label: 'Coles QLD', state: 'QLD', shipDayBefore: true  },
  { match: 'red bank',    label: 'Coles QLD', state: 'QLD', shipDayBefore: true  },
  { match: 'somerton',    label: 'Coles VIC', state: 'VIC', shipDayBefore: true  },
  { match: 'kemps creek', label: 'Coles NSW', state: 'NSW', shipDayBefore: false },
];

const WOOLIES_DC_TABLE = [
  { match: 'moorebank',    label: 'Woolworths — Moorebank',    state: 'NSW', shipDayBefore: false },
  { match: 'erskine park', label: 'Woolworths — Erskine Park', state: 'NSW', shipDayBefore: false },
];

// ─── Sydney timezone helpers ───────────────────────────────────────────────
//
// Duplicated from src/birthday.js. A future refactor could extract these
// into a shared module (src/timezone.js is Toronto-flavoured for NA), but
// duplicating keeps this PR scoped to the new endpoint.

function sydneyOffsetMinutes(date = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Australia/Sydney',
      timeZoneName: 'shortOffset',
    });
    const parts = fmt.formatToParts(date);
    const tz = parts.find(p => p.type === 'timeZoneName')?.value;
    const m = tz?.match(/GMT([+-])(\d+)(?::(\d+))?/);
    if (m) {
      const sign = m[1] === '+' ? 1 : -1;
      return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10));
    }
  } catch (_) { /* fall through */ }
  // Fallback: Australian DST runs first-Sunday-of-October → first-Sunday-of-April.
  const year = date.getUTCFullYear();
  const oct = new Date(Date.UTC(year, 9, 1));
  const octFirstSunday = 1 + ((7 - oct.getUTCDay()) % 7);
  const apr = new Date(Date.UTC(year, 3, 1));
  const aprFirstSunday = 1 + ((7 - apr.getUTCDay()) % 7);
  const dstStart = Date.UTC(year, 9, octFirstSunday - 1, 16, 0, 0);
  const dstEnd   = Date.UTC(year, 3, aprFirstSunday - 1, 16, 0, 0);
  const t = date.getTime();
  return (t < dstEnd || t >= dstStart) ? 660 : 600;
}

function sydneyParts(date = new Date()) {
  const offset = sydneyOffsetMinutes(date);
  const shifted = new Date(date.getTime() + offset * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    year: y,
    month: m,
    day: d,
    localDate: `${y}-${pad(m)}-${pad(d)}`,
    tzOffsetMinutes: offset,
  };
}

// ─── Date / business-day helpers ───────────────────────────────────────────

/**
 * Parse a CIN7 deliveryDate (commonly "YYYY-MM-DDTHH:mm:ss" or "YYYY-MM-DD"
 * or null) into a calendar date 'YYYY-MM-DD' string. CIN7 stores delivery
 * dates as wall-clock dates without a timezone — we treat them as Sydney
 * local. Returns null for any unparseable input (frontend will display "no
 * date").
 */
function parseDeliveryDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // First 10 chars is the YYYY-MM-DD; tolerate either bare dates or full ISO.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || !mo || !d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Given a YYYY-MM-DD date, step back N calendar days (defaults to 1) skipping
 * Saturdays and Sundays. Returns YYYY-MM-DD. Used for the must-ship-by
 * rule on Coles QLD + VIC orders: the warehouse needs to ship the BUSINESS
 * day before the customer's delivery date so the freight arrives on time.
 *
 * v1 skips weekends only. AU public holidays would extend the skip set but
 * vary by state — left as a follow-up.
 */
function previousBusinessDay(yyyyMmDd) {
  if (!yyyyMmDd) return null;
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  // Use UTC arithmetic so day-stepping doesn't drift across DST boundaries.
  const t = new Date(Date.UTC(y, m - 1, d));
  do {
    t.setUTCDate(t.getUTCDate() - 1);
  } while (t.getUTCDay() === 0 || t.getUTCDay() === 6);
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Strict 'YYYY-MM-DD' comparison: returns true if `a` is before `b`. */
function dateBefore(a, b) {
  if (!a || !b) return false;
  return a < b;
}

// ─── DC / distributor classification ───────────────────────────────────────

/**
 * Classify a CIN7 SalesOrder into a presentable distributor record.
 *
 * Returns:
 *   {
 *     group: 'coles' | 'woolies' | 'otherDistributors',
 *     retailer: 'col' | 'woo2' | 'dist',
 *     label: 'Coles QLD' | 'Woolworths — Moorebank' | <company name>,
 *     state: 'QLD' | null,
 *     shipDayBefore: boolean,
 *   }
 *
 * Or null if the order shouldn't appear on the warehouse TV (e.g. Stock
 * Adjustments, Amazon mirrors, redacted retail orders).
 *
 * v2.2.43 — group split from 'colesWoolies' into separate 'coles' and
 * 'woolies' so the Logistics tab can render thirds (Coles | Woolies |
 * Distributors).
 */
function classifyDistributor(order) {
  const attr = attributeCin7Order(order);
  if (attr === null || attr === 'refund') return null;

  const company = String(order?.company || '').trim();
  const cl = company.toLowerCase();

  if (attr === 'col') {
    const dc = COLES_DC_TABLE.find(row => cl.includes(row.match));
    if (dc) {
      return {
        group: 'coles',
        retailer: 'col',
        label: dc.label,
        state: dc.state,
        shipDayBefore: dc.shipDayBefore,
      };
    }
    // Coles order against an unknown DC — show with generic label, no
    // must-ship-by-business-day-before rule (safe default).
    return {
      group: 'coles',
      retailer: 'col',
      label: 'Coles',
      state: null,
      shipDayBefore: false,
    };
  }

  if (attr === 'woo2') {
    const dc = WOOLIES_DC_TABLE.find(row => cl.includes(row.match));
    if (dc) {
      return {
        group: 'woolies',
        retailer: 'woo2',
        label: dc.label,
        state: dc.state,
        shipDayBefore: dc.shipDayBefore,
      };
    }
    return {
      group: 'woolies',
      retailer: 'woo2',
      label: 'Woolworths',
      state: null,
      shipDayBefore: false,
    };
  }

  // attr === 'dist' — other wholesale customers (Momentum, AVO, indie
  // pharmacies, etc.). Show the company name as the label.
  return {
    group: 'otherDistributors',
    retailer: 'dist',
    label: company || 'Distributor',
    state: null,
    shipDayBefore: false,
  };
}

// ─── Line-item math (cartons + stock comparison) ───────────────────────────

/**
 * Compute carton + stock-fulfillment data for a single line item.
 *
 * "Cartons" semantics:
 *   • Carton SKU (multiplier > 1): qty IS the carton count.
 *     e.g. AU-CTN-OG-NPO-48 qty=100 → 100 cartons of 48 tins each.
 *   • Alt UOM line (uomSize > 1): qty is in tins; divide by uomSize.
 *     e.g. AU-OG-NPO-35 qty=4800 uomSize=48 → 100 cartons.
 *   • Tin SKU (multiplier=1, uomSize≤1): qty is tins — display as units.
 *
 * Stock comes from the warehouse-available bucket = avail − fba_avail
 * (FBA stock can't fulfil distributor orders). We look it up by both the
 * line's SKU and the baseSku (in case stock is held against the rolled-up
 * base only). For Alt UOM lines we always check by the line code.
 */
function analyseLineItem(item, stockBySku) {
  const code = String(item?.code || '').trim();
  const qty = Number(item?.qty ?? item?.quantity ?? 0) || 0;
  const uomSize = Number(item?.uomSize ?? 0) || 0;
  const name = String(item?.name || '').trim();

  // Decompose carton vs base.
  let baseSku = code;
  let multiplier = 1;
  if (code) {
    const [b, m] = normalizeAuSku(code);
    baseSku = b || code;
    multiplier = Number(m) || 1;
  }

  // Pick the "tins per carton" for the unit math:
  //   • Alt UOM line: tinsPerCarton = uomSize (qty already in tins)
  //   • Carton SKU:   tinsPerCarton = multiplier (qty already in cartons)
  //   • Tin SKU:      tinsPerCarton = 1 → treat qty as "tins / units"
  const altUom = uomSize > 1;
  const tinsPerCarton = altUom ? uomSize : multiplier;
  const isCartonish = tinsPerCarton > 1;

  // cartonsNeeded: how many cartons (or units, for tin-level lines)
  const cartonsNeeded = altUom ? (qty / uomSize) : qty;
  // tinsNeeded: total tins this line equates to.
  const tinsNeeded = altUom ? qty : qty * multiplier;

  // Stock lookup: try the exact code first, then the baseSku.
  let stockRow = stockBySku.get(code) || stockBySku.get(baseSku);
  const tinsAvailWarehouse = stockRow
    ? Math.max(0, (Number(stockRow.avail) || 0) - (Number(stockRow.fba_avail) || 0))
    : 0;

  // Convert warehouse-available tins → cartons of the line's UoM. For tin
  // SKUs (tinsPerCarton=1), this is just the tin count.
  const cartonsAvailable = isCartonish
    ? Math.floor(tinsAvailWarehouse / tinsPerCarton)
    : tinsAvailWarehouse;

  const isFulfillable = cartonsAvailable >= cartonsNeeded && cartonsNeeded > 0;
  // Display: "60 / 100 cartons" when short, else just the needed count.
  const unitLabel = isCartonish ? 'cartons' : 'units';
  const gapDisplay = isFulfillable
    ? `${cartonsNeeded} ${unitLabel}`
    : `${cartonsAvailable} / ${cartonsNeeded} ${unitLabel}`;

  return {
    sku: code || null,
    base_sku: baseSku || null,
    name: name || null,
    qty_raw: qty,
    uom_size: uomSize || 1,
    cartons_needed: cartonsNeeded,
    cartons_available: cartonsAvailable,
    tins_needed: tinsNeeded,
    tins_available: tinsAvailWarehouse,
    unit_label: unitLabel,
    is_fulfillable: isFulfillable,
    gap_display: gapDisplay,
  };
}

// ─── Live CIN7 fetcher: open SalesOrders ──────────────────────────────────

/**
 * Fetch open AU SalesOrders directly from CIN7 Omni v1 — bypassing the D1
 * cache entirely.
 *
 * Why live (v2.2.27g): the cron's incremental sync uses a strict-greater-
 * than watermark (v2.2.10) that gets stuck on bulk-modification tie groups
 * — we hit one at 2026-04-11T14:00:06Z and another at 2026-05-16T14:00:03Z
 * in the v2.2.27a–f iterations. Trying to catch up to today's data via
 * D1 means manually advancing the watermark past each tie group, which
 * loses any in-tie orders we'd want to see. For the warehouse-TV use case
 * we only need a small set of currently-open orders (typically <20 across
 * EDI + non-EDI), and a single CIN7 call per dashboard refresh is well
 * within rate limits (60s KV cache caps us at ~60 calls/hour for this
 * endpoint, vs CIN7's 60/min limit).
 *
 * Filter:
 *   • Server-side `where`: createdDate >= today − 30 days AND status =
 *     'APPROVED' — narrows the response to the right window. CIN7's
 *     where syntax doesn't reliably support IS NULL on dispatchedDate
 *     across all account configs, so we filter that in JS.
 *   • Client-side: dispatchedDate IS NULL — the canonical "still needs
 *     warehouse action" check. An order moves to dispatchedDate=<timestamp>
 *     the moment it ships.
 *   • Client-side: status NOT IN (VOID/VOIDED/CANCELLED) — defensive,
 *     even though the server-side filter already specifies APPROVED.
 *
 * Stage is captured in the returned objects (CIN7 returns it when the
 * `fields` whitelist includes it) but not used to filter; dispatchedDate
 * is the more reliable signal. The 0007 migration columns (stage,
 * dispatched_date, delivery_date) get populated on every cron tick now,
 * so other endpoints can use them; just this one bypasses D1.
 */
async function fetchOpenSalesOrdersLive(env, todayLocalDate) {
  // Per Melanie 2026-05-19: "just look for orders with an estimated due
  // date of today or in the future". Much simpler than chasing
  // workflow-state semantics across createdDate + status + stage +
  // dispatchedDate. If the warehouse hasn't acted on an order whose ETD
  // has already passed, that's a separate ops conversation — the TV
  // surfaces what's actionable from today onwards.
  //
  // Server-side where: EstimatedDeliveryDate >= today (Sydney) AND
  // Status='APPROVED'. Client-side: drop rows with dispatchedDate set
  // (already in transit, no warehouse action needed).
  const fields = [
    'id', 'reference', 'createdDate', 'modifiedDate', 'dispatchedDate',
    'channel', 'branchName',
    'memberId', 'memberEmail', 'firstName', 'lastName', 'company',
    'status', 'stage', 'invoiceStatus',
    'estimatedDeliveryDate',
    'total', 'subTotal', 'productTotal',
    'lineItems',
  ].join(',');

  // CIN7 Omni v1 requires full ISO 8601 timestamps in `where` clauses —
  // bare YYYY-MM-DD returns a 400 "not a valid date time" error. Sydney
  // midnight today, expressed as UTC, captures "ETD on or after today".
  const where = `EstimatedDeliveryDate>='${todayLocalDate}T00:00:00Z' AND Status='APPROVED'`;

  // cin7FetchAll paginates internally with 400ms inter-page sleep. For a
  // 30-day window with No Pong AU volume the response is typically 1-2
  // pages (≤500 orders) so the call completes in under a second.
  const allOrders = await cin7FetchAll(env, 'SalesOrders', { fields, where });

  // Filter to truly-open: no dispatchedDate, not voided. Pre-classifier so
  // downstream aggregator only sees actionable orders.
  return allOrders
    .filter((o) => !o?.dispatchedDate)
    .filter((o) => {
      const status = String(o?.status || '').toUpperCase();
      return !['VOID', 'VOIDED', 'CANCELLED'].includes(status);
    })
    // Reshape so deliveryDate flows from estimatedDeliveryDate (the actual
    // ETD field per v2.2.27e probe). createdDate/dispatchedDate/lineItems
    // are passed through as-is.
    .map((o) => ({
      id: o.id,
      reference: o.reference,
      status: o.status,
      stage: o.stage,
      company: o.company,
      firstName: o.firstName,
      lastName: o.lastName,
      createdDate: o.createdDate,
      dispatchedDate: o.dispatchedDate, // null by filter above
      deliveryDate: o.estimatedDeliveryDate || null,
      lineItems: Array.isArray(o.lineItems) ? o.lineItems : [],
    }));
}

// ─── Aggregator ────────────────────────────────────────────────────────────

/**
 * Turn an array of raw open SalesOrders + a stock Map into the shape the
 * frontend will render.
 *
 * Returns (v2.2.43 — three groups instead of two):
 *   {
 *     coles:             [orderRecord, ...]  // sorted by must-ship-by ascending
 *     woolies:           [orderRecord, ...]  // sorted by must-ship-by ascending
 *     otherDistributors: [orderRecord, ...]  // sorted by reference ascending
 *     totals: { open_orders, coles_count, woolies_count, other_count, past_due_count },
 *   }
 */
function aggregateDistributorOrders(rawOrders, stockBySku, todayLocalDate) {
  const coles = [];
  const woolies = [];
  const otherDistributors = [];
  let pastDueCount = 0;

  for (const o of rawOrders) {
    const cls = classifyDistributor(o);
    if (!cls) continue;

    // Delivery date comes from CIN7's `estimatedDeliveryDate` API field
    // (mapped to `deliveryDate` in fetchOpenSalesOrdersLive's reshape).
    // This is the "Delivery Date (ETD)" shown in the CIN7 Sales Order
    // edit UI. Fallback to createdDate only if estimatedDeliveryDate is
    // missing (some non-EDI distributor orders don't set it).
    const deliveryDate = parseDeliveryDate(o?.deliveryDate || o?.createdDate);
    const mustShipBy = (cls.shipDayBefore && deliveryDate)
      ? previousBusinessDay(deliveryDate)
      : deliveryDate;

    // past-due = must-ship-by date strictly BEFORE today. Same-day still
    // counts as actionable (warehouse can still ship), so it's not red.
    const isPastDue = mustShipBy ? dateBefore(mustShipBy, todayLocalDate) : false;
    if (isPastDue) pastDueCount++;

    // Line items: filter children (parentId > 0) and zero-qty rows (zeroed-
    // out by the retailer post-confirmation — they're not real picks and
    // would render as "0 / 0 cartons" on the TV), then analyse each.
    const rawLines = Array.isArray(o?.lineItems) ? o.lineItems : [];
    const lines = rawLines
      .filter((li) => (Number(li?.parentId) || 0) === 0)
      .filter((li) => (Number(li?.qty ?? li?.quantity ?? 0) || 0) > 0)
      .map((li) => analyseLineItem(li, stockBySku));

    const allFulfillable = lines.length > 0 && lines.every((l) => l.is_fulfillable);

    const record = {
      id: o?.id ?? null,
      reference: o?.reference || null,
      created_date: o?.createdDate || null,
      delivery_date: deliveryDate,
      must_ship_by: mustShipBy,
      is_past_due: isPastDue,
      all_fulfillable: allFulfillable,
      group: cls.group,
      retailer: cls.retailer,
      distributor_label: cls.label,
      state: cls.state,
      company: o?.company || null,
      line_items: lines,
    };

    if (cls.group === 'coles') coles.push(record);
    else if (cls.group === 'woolies') woolies.push(record);
    else otherDistributors.push(record);
  }

  // Sort. Coles + Woolies: must-ship-by ascending (nulls to the end).
  const sortByMustShipBy = (a, b) => {
    const aKey = a.must_ship_by || '9999-12-31';
    const bKey = b.must_ship_by || '9999-12-31';
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  };
  coles.sort(sortByMustShipBy);
  woolies.sort(sortByMustShipBy);
  // Other distributors: by CIN7 reference ascending (older reference =
  // longer wait = more urgent). Numeric-aware comparison so SO-1009 sorts
  // before SO-1010.
  otherDistributors.sort((a, b) => {
    const ar = String(a.reference || '');
    const br = String(b.reference || '');
    return ar.localeCompare(br, undefined, { numeric: true, sensitivity: 'base' });
  });

  return {
    coles,
    woolies,
    otherDistributors,
    totals: {
      open_orders: coles.length + woolies.length + otherDistributors.length,
      coles_count: coles.length,
      woolies_count: woolies.length,
      other_count: otherDistributors.length,
      past_due_count: pastDueCount,
    },
  };
}

// ─── Endpoint ──────────────────────────────────────────────────────────────

logisticsRoutes.get('/logistics', async (c) => {
  const env = c.env;
  const forceRefresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true';
  // v2.2.43 — preview mode: ?test_waiva=1 forces the Waiva Clark flag on so
  // Melanie can see what the warehouse TV looks like when an order from that
  // customer is open, even when nothing real is open. Bypasses KV cache so
  // the override applies immediately. Remove the query param to clear.
  const testWaivaRaw = c.req.query('test_waiva');
  const testWaiva = testWaivaRaw && testWaivaRaw !== '0' && testWaivaRaw !== 'false';
  const testWaivaCount = testWaiva ? (Number(testWaivaRaw) > 1 ? Number(testWaivaRaw) : 1) : 0;
  const cache = env.CACHE;

  if (!forceRefresh && !testWaiva && cache) {
    const cached = await cache.get(KV_KEY, 'json');
    if (cached?.generated_at_iso) {
      return c.json({ ...cached, cached: true });
    }
  }

  const now = new Date();
  const syd = sydneyParts(now);

  // ShipStation runs in parallel with the CIN7+D1 work (separate API). The
  // SalesOrders side now reads from D1 (no CIN7 call) — see memory note
  // `project_cin7_omni_constraints.md`. Stock is the only remaining live
  // CIN7 hit: a single endpoint with internal pagination, comfortably
  // within rate limits even when the cron is running.
  const shipstationPromise = buildShipStationSnapshot(env, {
    localDate: syd.localDate,
    tzOffsetMinutes: syd.tzOffsetMinutes,
  });

  let openOrdersValue = null;
  let openOrdersError = null;
  let stockValue = null;
  let stockError = null;

  // v2.2.27g: live CIN7 fetch for SalesOrders instead of D1. See the
  // fetchOpenSalesOrdersLive() docstring for the rationale. Two CIN7 calls
  // per request total (SalesOrders + Stock), serialized to stay under the
  // 3-calls-per-second cap. KV cache (60s) keeps total volume well under
  // CIN7's 60-per-minute and 5000-per-day budgets.
  try {
    openOrdersValue = await fetchOpenSalesOrdersLive(env, syd.localDate);
  } catch (e) {
    openOrdersError = redactSecrets(e?.message || String(e));
  }
  try {
    stockValue = await fetchStockBySku(env);
  } catch (e) {
    stockError = redactSecrets(e?.message || String(e));
  }

  const shipstationSettled = await shipstationPromise.then(
    (v) => ({ status: 'fulfilled', value: v }),
    (e) => ({ status: 'rejected', reason: e }),
  );
  const shipstation = shipstationSettled.status === 'fulfilled'
    ? shipstationSettled.value
    : { connected: false, error: 'ShipStation aggregator threw.' };

  // ─── Waiva Clark flag ───────────────────────────────────────────────────
  //
  // Per Melanie 2026-05-19: when a Waiva Clark wholesale order is open, the
  // warehouse needs a visual flag on the Wholesale KPI card. Detection runs
  // over the wholesale summaries already produced by buildShipStationSnapshot
  // and matches on company name, case-insensitive, with whitespace tolerance.
  // Waiva Clark is a company name (not a person) so we only check the
  // company field — billTo.company first, shipTo.company fallback, surfaced
  // as `summary.company` by the snapshot.
  const waivaClarkRegex = /waiva\s*clark/i;
  const waivaClarkSummaries = Array.isArray(shipstation?.wholesaleOpenOrders)
    ? shipstation.wholesaleOpenOrders.filter(
        (s) => s?.company && waivaClarkRegex.test(String(s.company)),
      )
    : [];
  shipstation.waiva_clark_open = waivaClarkSummaries.length > 0;
  shipstation.waiva_clark_open_count = waivaClarkSummaries.length;

  // Preview override — see top of handler. Forces the flag on so Melanie can
  // see the visual on the live dashboard without waiting for a real order.
  if (testWaiva) {
    shipstation.waiva_clark_open = true;
    shipstation.waiva_clark_open_count = testWaivaCount;
    shipstation.waiva_clark_preview = true;
  }

  // CIN7 fetches: if either fails, surface the error inside the distributors
  // block so the rest of the tab (ShipStation + KPIs) still renders. The
  // warehouse can still work off ShipStation alone if CIN7 hiccups.
  let distributors = { coles: [], woolies: [], otherDistributors: [], totals: { open_orders: 0, coles_count: 0, woolies_count: 0, other_count: 0, past_due_count: 0 } };
  let distributorsError = null;

  if (openOrdersError) {
    distributorsError = `CIN7 SalesOrders fetch failed: ${openOrdersError}`;
  } else if (stockError) {
    distributorsError = `CIN7 Stock fetch failed: ${stockError}`;
  } else {
    distributors = aggregateDistributorOrders(
      openOrdersValue,
      stockValue,
      syd.localDate,
    );
  }

  const payload = {
    generated_at_iso: now.toISOString(),
    sydney_now: {
      local_date: syd.localDate,
      tz_offset_minutes: syd.tzOffsetMinutes,
    },
    shipstation,
    distributors: {
      ...distributors,
      error: distributorsError,
    },
  };

  // v2.2.43 — don't write the preview payload to KV; otherwise a normal
  // (non-preview) request would read back the forged Waiva Clark flag for
  // up to 60s.
  if (cache && !testWaiva) {
    c.executionCtx?.waitUntil?.(
      cache.put(KV_KEY, JSON.stringify(payload), { expirationTtl: KV_TTL_SECONDS }),
    );
  }

  return c.json({ ...payload, cached: false });
});
