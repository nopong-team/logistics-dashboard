/**
 * AU Logistics tab — endpoint + helpers.
 *
 * Drives the warehouse TV (1920×1080, 16:9, no-scroll) for the AU
 * fulfilment team. Patterns mirror src/birthday.js (KV-cached 60s,
 * ShipStation snapshot reused as-is), with one difference: SalesOrders
 * come from the D1 cache (cron-refreshed every 15 min) rather than live
 * CIN7. The birthday tab bypassed D1 for launch-day real-time signal;
 * the logistics tab is permanent ops where 15-min lag is acceptable and
 * the daily 5000-call CIN7 budget gets crowded otherwise. Stock is still
 * live (single endpoint, one call, current-moment numbers for the
 * green-tick fulfilment check).
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

// ─── D1 fetcher: open SalesOrders ──────────────────────────────────────────

/**
 * Read open AU SalesOrders from D1's `cin7_sales_orders` cache rather than
 * hitting CIN7 Omni live. v2.2.27 and v2.2.27a tried to fetch live but kept
 * hitting CIN7's 429 (most likely the 5000-calls-per-day budget — the
 * `*/15 *` cron plus the existing on-demand tabs eat most of it). D1 is
 * refreshed every 15 minutes by `runCin7SalesOrdersChunk`, which is
 * acceptable lag for warehouse-TV ops (vs the launch-day birthday tab where
 * we deliberately bypassed D1 for real-time signal).
 *
 * `dispatchedDate` and `deliveryDate` aren't promoted to first-class columns
 * — they live inside `raw_json`. SQLite's `json_extract` handles the
 * filter and projection without a schema migration.
 *
 * Stock comes from the live `fetchStockBySku()` (a single Stock endpoint
 * call) — the warehouse green-tick needs current-moment stock, and one
 * endpoint per request stays well within rate limits.
 *
 * Returns an array of objects matching the shape `aggregateDistributorOrders`
 * expects: `{ id, reference, createdDate, dispatchedDate, deliveryDate,
 * company, status, lineItems: [...] }`.
 */
async function fetchOpenSalesOrdersFromD1(env) {
  if (!env.DB) {
    throw new Error('D1 binding (env.DB) not available — cannot read cached SalesOrders.');
  }

  // Pull the order rows. The `channel_attr IS NOT NULL` filter drops the
  // rows the cron flagged as "not a distributor sale" (Stock Adjustments,
  // Amazon mirrors, redacted retail) so we don't even attribute-classify
  // them downstream.
  const ordersStmt = env.DB.prepare(
    `SELECT id, reference, status, channel_attr, company,
            first_name, last_name, created_date,
            json_extract(raw_json, '$.deliveryDate')   AS delivery_date,
            json_extract(raw_json, '$.dispatchedDate') AS dispatched_date
       FROM cin7_sales_orders
      WHERE market = 'AU'
        AND status NOT IN ('VOID', 'VOIDED', 'CANCELLED')
        AND json_extract(raw_json, '$.dispatchedDate') IS NULL
        AND channel_attr IS NOT NULL
      ORDER BY created_date DESC`,
  );
  const { results: orderRows } = await ordersStmt.all();
  if (!orderRows || orderRows.length === 0) return [];

  // Pull the matching line items in a single follow-up query. parent_id = 0
  // filter happens at the SQL layer for efficiency (the read-side rule).
  const ids = orderRows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const itemsStmt = env.DB.prepare(
    `SELECT order_id, parent_id, code, base_sku, multiplier, uom_size,
            qty, unit_price, total, name
       FROM cin7_sales_order_items
      WHERE order_id IN (${placeholders})
        AND parent_id = 0
      ORDER BY order_id`,
  ).bind(...ids);
  const { results: itemRows } = await itemsStmt.all();

  // Bucket items by order_id.
  const itemsByOrder = new Map();
  for (const it of (itemRows || [])) {
    const arr = itemsByOrder.get(it.order_id) || [];
    arr.push({
      code: it.code,
      name: it.name,
      qty: Number(it.qty) || 0,
      uomSize: Number(it.uom_size) || 1,
      parentId: Number(it.parent_id) || 0,
      unitPrice: Number(it.unit_price) || 0,
      total: Number(it.total) || 0,
    });
    itemsByOrder.set(it.order_id, arr);
  }

  // Reshape to the same shape the live CIN7 path returned, so the rest of
  // the pipeline (classifyDistributor + aggregateDistributorOrders) doesn't
  // change.
  return orderRows.map((o) => ({
    id: o.id,
    reference: o.reference,
    status: o.status,
    company: o.company,
    firstName: o.first_name,
    lastName: o.last_name,
    createdDate: o.created_date,
    dispatchedDate: o.dispatched_date, // null by construction (filter above)
    deliveryDate: o.delivery_date,
    lineItems: itemsByOrder.get(o.id) || [],
  }));
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

  // SalesOrders comes from D1 (cron-refreshed every 15 minutes). Stock is
  // a single live CIN7 endpoint call — one /Stock fetch with internal
  // pagination, well within rate limits.
  try {
    openOrdersValue = await fetchOpenSalesOrdersFromD1(env);
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
