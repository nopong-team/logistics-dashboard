/**
 * AU Logistics tab — endpoint + helpers.
 *
 * Drives the warehouse TV (1920×1080, 16:9, no-scroll) for the AU
 * fulfilment team. Patterns mirror src/birthday.js: live data only (no D1),
 * KV-cached 60s, ShipStation snapshot reused as-is.
 *
 * Surfaces:
 *   1. ShipStation snapshot — open queue, shipped-today counts, express/intl
 *      + wholesale alert lists. Reuses buildShipStationSnapshot() unchanged.
 *   2. Open distributor orders from CIN7 Omni v1, split into two groups:
 *      • colesWoolies — Coles + Woolies orders, sorted by must-ship-by date
 *        ascending. Coles QLD (RedBank) + Coles VIC (Somerton) must ship the
 *        business day BEFORE deliveryDate; Coles NSW + all Woolies ship on
 *        deliveryDate itself.
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
  cin7FetchAll,
  fetchStockBySku,
  attributeCin7Order,
  normalizeAuSku,
} from './cin7.js';
import { buildShipStationSnapshot } from './shipstation.js';
import { redactSecrets } from './redact.js';

export const logisticsRoutes = new Hono();

// ─── Config ────────────────────────────────────────────────────────────────

const KV_KEY = 'au:logistics:v1';
const KV_TTL_SECONDS = 60;

// How far back to look for open orders by createdDate. Anything older than
// 60 days that's still "open" in CIN7 is almost certainly stale data, not a
// live warehouse problem. Cap keeps the CIN7 page count small (No Pong AU
// volume is well under one page per week).
const OPEN_ORDER_LOOKBACK_DAYS = 60;

// CIN7 SalesOrder statuses considered "open" — i.e. not voided/cancelled.
// Anything despatched is filtered out separately via dispatchedDate.
const VOID_STATUSES = new Set(['VOID', 'VOIDED', 'CANCELLED']);

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
 *     group: 'colesWoolies' | 'otherDistributors',
 *     retailer: 'col' | 'woo2' | 'dist',
 *     label: 'Coles QLD' | 'Woolworths — Moorebank' | <company name>,
 *     state: 'QLD' | null,
 *     shipDayBefore: boolean,
 *   }
 *
 * Or null if the order shouldn't appear on the warehouse TV (e.g. Stock
 * Adjustments, Amazon mirrors, redacted retail orders).
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
        group: 'colesWoolies',
        retailer: 'col',
        label: dc.label,
        state: dc.state,
        shipDayBefore: dc.shipDayBefore,
      };
    }
    // Coles order against an unknown DC — show with generic label, no
    // must-ship-by-business-day-before rule (safe default).
    return {
      group: 'colesWoolies',
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
        group: 'colesWoolies',
        retailer: 'woo2',
        label: dc.label,
        state: dc.state,
        shipDayBefore: dc.shipDayBefore,
      };
    }
    return {
      group: 'colesWoolies',
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

// ─── CIN7 fetcher: open SalesOrders only ───────────────────────────────────

/**
 * Fetch CIN7 SalesOrders created in the last OPEN_ORDER_LOOKBACK_DAYS days,
 * filter in-memory to "open" (no dispatchedDate, not voided), and return
 * the raw rows. We filter post-fetch rather than via the `where` clause
 * because CIN7 Omni v1's where-clause IS NULL support is inconsistent across
 * accounts; in-memory filtering against a 60-day window is cheap.
 */
async function fetchOpenSalesOrders(env, { todayLocalDate }) {
  // Window start: today − OPEN_ORDER_LOOKBACK_DAYS, as a calendar date.
  const [y, m, d] = todayLocalDate.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  start.setUTCDate(start.getUTCDate() - OPEN_ORDER_LOOKBACK_DAYS);
  const pad = (n) => String(n).padStart(2, '0');
  const dateFrom = `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}T00:00:00Z`;
  const where = `CreatedDate>='${dateFrom}'`;

  const fields = [
    'id', 'reference', 'createdDate', 'dispatchedDate', 'deliveryDate',
    'channel', 'branchName',
    'firstName', 'lastName', 'company',
    'status', 'invoiceStatus',
    'total', 'subTotal',
    'lineItems',
  ].join(',');

  const rows = await cin7FetchAll(env, 'SalesOrders', { fields, where });

  return rows.filter((o) => {
    if (o?.dispatchedDate) return false;
    const status = String(o?.status || '').toUpperCase();
    if (VOID_STATUSES.has(status)) return false;
    return true;
  });
}

// ─── Aggregator ────────────────────────────────────────────────────────────

/**
 * Turn an array of raw open SalesOrders + a stock Map into the shape the
 * frontend will render.
 *
 * Returns:
 *   {
 *     colesWoolies: [orderRecord, ...]  // sorted by must-ship-by ascending
 *     otherDistributors: [orderRecord, ...]  // sorted by reference ascending
 *     totals: { open_orders, coles_woolies_count, other_count, past_due_count },
 *   }
 */
function aggregateDistributorOrders(rawOrders, stockBySku, todayLocalDate) {
  const colesWoolies = [];
  const otherDistributors = [];
  let pastDueCount = 0;

  for (const o of rawOrders) {
    const cls = classifyDistributor(o);
    if (!cls) continue;

    const deliveryDate = parseDeliveryDate(o?.deliveryDate);
    const mustShipBy = (cls.shipDayBefore && deliveryDate)
      ? previousBusinessDay(deliveryDate)
      : deliveryDate;

    // past-due = must-ship-by date strictly BEFORE today. Same-day still
    // counts as actionable (warehouse can still ship), so it's not red.
    const isPastDue = mustShipBy ? dateBefore(mustShipBy, todayLocalDate) : false;
    if (isPastDue) pastDueCount++;

    // Line items: filter children (parentId > 0), then analyse each.
    const rawLines = Array.isArray(o?.lineItems) ? o.lineItems : [];
    const lines = rawLines
      .filter((li) => (Number(li?.parentId) || 0) === 0)
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

    if (cls.group === 'colesWoolies') colesWoolies.push(record);
    else otherDistributors.push(record);
  }

  // Sort. Coles+Woolies: must-ship-by ascending (nulls to the end).
  colesWoolies.sort((a, b) => {
    const aKey = a.must_ship_by || '9999-12-31';
    const bKey = b.must_ship_by || '9999-12-31';
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  // Other distributors: by CIN7 reference ascending (older reference =
  // longer wait = more urgent). Numeric-aware comparison so SO-1009 sorts
  // before SO-1010.
  otherDistributors.sort((a, b) => {
    const ar = String(a.reference || '');
    const br = String(b.reference || '');
    return ar.localeCompare(br, undefined, { numeric: true, sensitivity: 'base' });
  });

  return {
    colesWoolies,
    otherDistributors,
    totals: {
      open_orders: colesWoolies.length + otherDistributors.length,
      coles_woolies_count: colesWoolies.length,
      other_count: otherDistributors.length,
      past_due_count: pastDueCount,
    },
  };
}

// ─── Endpoint ──────────────────────────────────────────────────────────────

logisticsRoutes.get('/logistics', async (c) => {
  const env = c.env;
  const forceRefresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true';
  const cache = env.CACHE;

  if (!forceRefresh && cache) {
    const cached = await cache.get(KV_KEY, 'json');
    if (cached?.generated_at_iso) {
      return c.json({ ...cached, cached: true });
    }
  }

  const now = new Date();
  const syd = sydneyParts(now);

  // ShipStation runs in parallel with the CIN7 work (separate API, no shared
  // rate budget). The two CIN7 calls themselves run STRICTLY SEQUENTIALLY:
  // CIN7 Omni v1 limits to 3 calls/sec, and each cin7FetchAll can paginate
  // internally, so firing SalesOrders + Stock concurrently easily blows past
  // the per-second budget and returns a 429 (observed empirically v2.2.27a).
  // See memory: project_cin7_omni_constraints.md.
  const shipstationPromise = buildShipStationSnapshot(env, {
    localDate: syd.localDate,
    tzOffsetMinutes: syd.tzOffsetMinutes,
  });

  let openOrdersValue = null;
  let openOrdersError = null;
  let stockValue = null;
  let stockError = null;

  try {
    openOrdersValue = await fetchOpenSalesOrders(env, { todayLocalDate: syd.localDate });
  } catch (e) {
    openOrdersError = redactSecrets(e?.message || String(e));
  }
  // Only attempt stock if the first call returned cleanly — back-to-back
  // failures usually mean a wider CIN7 outage and a second fetch will just
  // burn rate-limit budget for nothing.
  if (!openOrdersError) {
    try {
      stockValue = await fetchStockBySku(env);
    } catch (e) {
      stockError = redactSecrets(e?.message || String(e));
    }
  }

  const shipstationSettled = await shipstationPromise.then(
    (v) => ({ status: 'fulfilled', value: v }),
    (e) => ({ status: 'rejected', reason: e }),
  );
  const shipstation = shipstationSettled.status === 'fulfilled'
    ? shipstationSettled.value
    : { connected: false, error: 'ShipStation aggregator threw.' };

  // CIN7 fetches: if either fails, surface the error inside the distributors
  // block so the rest of the tab (ShipStation + KPIs) still renders. The
  // warehouse can still work off ShipStation alone if CIN7 hiccups.
  let distributors = { colesWoolies: [], otherDistributors: [], totals: { open_orders: 0, coles_woolies_count: 0, other_count: 0, past_due_count: 0 } };
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

  if (cache) {
    c.executionCtx?.waitUntil?.(
      cache.put(KV_KEY, JSON.stringify(payload), { expirationTtl: KV_TTL_SECONDS }),
    );
  }

  return c.json({ ...payload, cached: false });
});
