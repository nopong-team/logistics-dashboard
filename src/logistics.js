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
import { buildShipStationSnapshot, listShipStationStores, onHoldStoreBreakdown } from './shipstation.js';
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

/**
 * Step a 'YYYY-MM-DD' date by `delta` calendar days (may be negative).
 * Weekend-agnostic — unlike previousBusinessDay(), this counts every day.
 * Used to widen the CIN7 fetch window and to compute "yesterday" for the
 * despatched-order retention rule. Returns YYYY-MM-DD, or null on bad input.
 */
function addCalendarDays(yyyyMmDd, delta) {
  if (!yyyyMmDd) return null;
  const [y, m, d] = String(yyyyMmDd).split('-').map(Number);
  if (!y || !m || !d) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + (Number(delta) || 0));
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * Convert a CIN7 dispatchedDate into a Sydney-local 'YYYY-MM-DD' calendar
 * date. CIN7 returns dispatchedDate as an ISO instant (often UTC with a
 * trailing Z, e.g. "2026-07-07T14:00:06Z"); at Sydney's +10/+11 offset that
 * instant can fall on the NEXT calendar day, so a naive first-10-chars slice
 * would be off by one near midnight. We resolve the true instant and read it
 * back in Sydney local time (via sydneyParts) so the despatch date matches
 * what the warehouse sees in CIN7. Bare 'YYYY-MM-DD' values (no time) parse
 * as UTC midnight and stay on the same Sydney day. Returns null when unset or
 * unparseable — the caller treats "no despatch date" as "not yet despatched".
 */
function dispatchedLocalDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) {
    return sydneyParts(dt).localDate;
  }
  // Fallback: pull the leading calendar date if Date parsing failed.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
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

  // Amazon retail orders are NOT distributors — they're individual Seller
  // Central / FBM sales that CIN7 mirrors for fulfilment, and they flow
  // through the ShipStation open-queue KPIs above, not the CIN7 distributor
  // panels. attributeCin7Order returns 'amz' for them (by company
  // "Amazon Seller …" OR by the NNN-NNNNNNN-NNNNNNN order-ID reference).
  //
  // This guard is load-bearing: before v2.2.47/v2.2.52 attributeCin7Order
  // returned null for Amazon, so the fall-through below never saw them. Once
  // Amazon attribution was added to power the Monthly SKU Sales tab, every
  // 'amz' order started falling straight through to the otherDistributors
  // bucket — the docstring always said "null for Amazon mirrors", but the
  // code no longer matched it. Drop them here explicitly.
  if (attr === 'amz') return null;

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

  if (attr === 'dist') {
    // Other wholesale customers (Momentum, AVO, indie pharmacies, etc.).
    // Show the company name as the label.
    return {
      group: 'otherDistributors',
      retailer: 'dist',
      label: company || 'Distributor',
      state: null,
      shipDayBefore: false,
    };
  }

  // Any other / future attribution value (e.g. a new retail channel) is not
  // a distributor order — don't surface it on the warehouse distributor
  // panels. Fail closed rather than mis-bucketing it into otherDistributors.
  return null;
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
function analyseLineItem(item, stockBySku, isDispatched = false) {
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

  const unitLabel = isCartonish ? 'cartons' : 'units';

  // v2.2.99: a DESPATCHED order is already picked and shipped OUT of CIN7 — its
  // stock has left on-hand, so running the packed/kit/short check against
  // current stock is meaningless. It wrongly read "kit N cartons" for an order
  // that's already complete (Mel 2026-07-30: "if it's dispatched, the cartons
  // are already picked; it shouldn't be pulling from existing stock"). Skip the
  // stock comparison entirely and mark the line complete — the order card
  // already carries the "✓ Despatched · awaiting pickup" badge.
  if (isDispatched) {
    return {
      sku: code || null,
      base_sku: baseSku || null,
      name: name || null,
      qty_raw: qty,
      uom_size: uomSize || 1,
      cartons_needed: cartonsNeeded,
      cartons_available: cartonsNeeded,
      kittable_cartons: 0,
      cartons_to_kit: 0,
      tins_needed: tinsNeeded,
      tins_available: tinsNeeded,
      unit_label: unitLabel,
      is_fulfillable: true,
      fulfil_state: 'dispatched',
      gap_display: `${cartonsNeeded} ${unitLabel}`,
    };
  }

  // ── Warehouse ON-HAND stock, in the LINE's own unit ───────────────────────
  //
  // fetchStockBySku returns one row per CIN7 product code, and CIN7 tracks
  // each product's stock in its OWN unit. A tin SKU's stock is in tins, but a
  // carton SKU (e.g. AU-CTN-OG-BCF-48) is a *separate* product whose stock is
  // counted in CARTONS — physically assembled and ready to ship.
  //
  // We use STOCK ON HAND, not "available". (Mel, 2026-07-29): CIN7 allocates
  // packed cartons to these very orders, which drops `available` to zero even
  // though the cartons are physically on the floor, packed and ready for the
  // order. On-hand reflects what's actually there. FBA branch stock is still
  // excluded — Amazon FBA stock can't fulfil a distributor order. On-hand is
  // reduced when an order is DISPATCHED, so a despatched order's stock is
  // already out of this figure (never double-counted into another order).
  const whOnHand = (row) => row
    ? Math.max(0, (Number(row?.soh) || 0) - (Number(row?.fba_soh) || 0))
    : 0;

  // A carton SKU is one whose multiplier came from the CODE itself (e.g. the
  // trailing -48), NOT from an Alt-UOM line — those keep multiplier 1 and
  // carry the pack size in uomSize instead.
  const isCartonSku = multiplier > 1 && !altUom;

  // cartonsAvailable = PACKED cartons ready to ship NOW (drives the green tick).
  // kittableCartons = extra cartons we could ASSEMBLE from loose tins — these
  // do NOT count as ready; they only tell the team kitting is possible.
  let cartonsAvailable;
  let kittableCartons = 0;
  let tinsAvailWarehouse;
  if (isCartonSku) {
    // The carton SKU's own on-hand is packed cartons. Loose tins on the base
    // SKU are NOT ready cartons — they must be kitted first — so they are
    // tracked separately, not folded into the packed count. (Mel, 2026-07-29:
    // green must mean real packed cartons; loose tins should flag the team to
    // kit, not read as done.)
    cartonsAvailable = whOnHand(stockBySku.get(code));
    const looseTins = (baseSku && baseSku !== code)
      ? whOnHand(stockBySku.get(baseSku))
      : 0;
    kittableCartons = tinsPerCarton > 0 ? Math.floor(looseTins / tinsPerCarton) : 0;
    tinsAvailWarehouse = cartonsAvailable * tinsPerCarton + looseTins;
  } else {
    // Alt-UOM or tin/unit line: the matched stock row is measured in tins.
    // Try the exact code first, then the baseSku.
    const tins = whOnHand(stockBySku.get(code) || stockBySku.get(baseSku));
    tinsAvailWarehouse = tins;
    cartonsAvailable = isCartonish ? Math.floor(tins / tinsPerCarton) : tins;
  }

  // Three fulfilment states:
  //   ready — enough PACKED cartons to ship now                → green tick
  //   kit   — short on packed, but packed + kittable covers it → amber KIT flag
  //   short — not enough even after kitting from loose tins    → red
  const hasNeed = cartonsNeeded > 0;
  const isFulfillable = hasNeed && cartonsAvailable >= cartonsNeeded;
  const canKit = hasNeed && !isFulfillable
    && (cartonsAvailable + kittableCartons) >= cartonsNeeded;
  const fulfilState = isFulfillable ? 'ready' : (canKit ? 'kit' : 'short');
  const cartonsToKit = Math.max(0, cartonsNeeded - cartonsAvailable);

  const gapDisplay =
    fulfilState === 'ready' ? `${cartonsNeeded} ${unitLabel}`
    : fulfilState === 'kit' ? `${cartonsAvailable}/${cartonsNeeded} packed · kit ${cartonsToKit}`
    : `${cartonsAvailable} / ${cartonsNeeded} ${unitLabel}`;

  return {
    sku: code || null,
    base_sku: baseSku || null,
    name: name || null,
    qty_raw: qty,
    uom_size: uomSize || 1,
    cartons_needed: cartonsNeeded,
    cartons_available: cartonsAvailable,   // PACKED cartons ready to ship now
    kittable_cartons: kittableCartons,     // extra cartons assemblable from loose tins
    cartons_to_kit: cartonsToKit,          // how many still need kitting for this line
    tins_needed: tinsNeeded,
    tins_available: tinsAvailWarehouse,
    unit_label: unitLabel,
    is_fulfillable: isFulfillable,         // true only when packed cartons cover the order
    fulfil_state: fulfilState,             // 'ready' | 'kit' | 'short'
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
 *   • Server-side `where`: EstimatedDeliveryDate >= today − 2 days AND
 *     status = 'APPROVED' — narrows the response to the right window. The
 *     −2-day floor (was: today) is deliberately loose so despatched orders
 *     we still want to show, whose ETD may sit a day or two back, aren't
 *     excluded at source; the precise keep/drop is done in JS.
 *   • Client-side: status NOT IN (VOID/VOIDED/CANCELLED) — defensive, even
 *     though the server-side filter already specifies APPROVED.
 *   • Client-side retention (Melanie 2026-07-29): the warehouse has to mark
 *     an order despatched in CIN7 BEFORE the freight is collected, so a
 *     despatched order still has stock on the dock. We therefore KEEP a
 *     despatched order (dispatchedDate set) until the day AFTER its despatch
 *     date, then drop it. Orders not yet despatched keep the original rule:
 *     ETD today or in the future.
 *
 * Stage is captured in the returned objects (CIN7 returns it when the
 * `fields` whitelist includes it) but not used to filter; dispatchedDate
 * now drives retention rather than an outright drop. The 0007 migration
 * columns (stage, dispatched_date, delivery_date) get populated on every
 * cron tick now, so other endpoints can use them; just this one bypasses D1.
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

  // Retention rule (Melanie 2026-07-29): the warehouse must mark orders
  // despatched in CIN7 BEFORE the freight is physically collected, which
  // used to make them vanish from the TV while the stock was still on the
  // dock waiting for pickup. We now KEEP a despatched order until the day
  // AFTER its despatch date, so the team knows it's ready-but-not-yet-gone.
  const yesterdayLocalDate = addCalendarDays(todayLocalDate, -1);

  // CIN7 Omni v1 requires full ISO 8601 timestamps in `where` clauses —
  // bare YYYY-MM-DD returns a 400 "not a valid date time" error.
  //
  // We widen the server-side ETD floor to today − 2 days (was: today). A
  // despatched order we still want to show can have an ETD as early as
  // "yesterday" (same-day-ship retailers despatched yesterday), and the
  // wall-clock-vs-Sydney offset on CIN7's stored ETD can nudge that another
  // day. Fetching the small extra window is cheap (AU volume is tiny) and
  // the precise keep/drop decision is made client-side below.
  const etdFloorLocalDate = addCalendarDays(todayLocalDate, -2);
  const where = `EstimatedDeliveryDate>='${etdFloorLocalDate}T00:00:00Z' AND Status='APPROVED'`;

  // cin7FetchAll paginates internally with 400ms inter-page sleep. For a
  // 30-day window with No Pong AU volume the response is typically 1-2
  // pages (≤500 orders) so the call completes in under a second.
  const allOrders = await cin7FetchAll(env, 'SalesOrders', { fields, where });

  // Keep/drop, per order:
  //   • Voided/cancelled → always drop (defensive; server already filters).
  //   • Despatched (dispatchedDate set) → keep until the day AFTER the
  //     despatch date, i.e. while dispatchedDay >= yesterday. This is the
  //     new retention behaviour — previously ANY dispatchedDate dropped it.
  //   • Not yet despatched → original rule: ETD is today or in the future.
  return allOrders
    .filter((o) => {
      const status = String(o?.status || '').toUpperCase();
      if (['VOID', 'VOIDED', 'CANCELLED'].includes(status)) return false;

      // v2.2.98: retention keys on the ETD (the must-ship-by / freight-
      // collection date), NOT the despatch-marking date. The warehouse marks
      // an order despatched in CIN7 when it's STAGED — often days before the
      // freight is actually collected (≈ the ETD). The old rule keyed retention
      // on the despatch date, so a staged order dropped off the TV while its
      // stock was still on the dock awaiting pickup — e.g. Coles R-50397940A:
      // ETD 2 Aug, marked despatched 28 Jul → vanished 30 Jul, ~5 days before
      // collection. Keep EVERY order — despatched or not — until the day AFTER
      // its ETD (etdDay >= yesterday), then drop. Despatched orders still get
      // the "awaiting pickup" badge + sink to the bottom (see the aggregator),
      // they just no longer disappear early. This also removes the old rule's
      // conflict with the server-side ETD floor (today−2): a despatched-but-
      // retained order whose ETD was future was fetched then wrongly dropped.
      const deliveryDay = parseDeliveryDate(o?.estimatedDeliveryDate);
      return !!deliveryDay && deliveryDay >= yesterdayLocalDate;
    })
    // Reshape so deliveryDate flows from estimatedDeliveryDate (the actual
    // ETD field per v2.2.27e probe). createdDate/lineItems pass through as-is.
    // dispatchedDay is the Sydney-local despatch date (null when still open) —
    // the aggregator turns it into the is_dispatched flag + display date.
    .map((o) => ({
      id: o.id,
      reference: o.reference,
      status: o.status,
      stage: o.stage,
      company: o.company,
      firstName: o.firstName,
      lastName: o.lastName,
      createdDate: o.createdDate,
      dispatchedDate: o.dispatchedDate || null,
      dispatchedDay: dispatchedLocalDate(o.dispatchedDate),
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

    // Despatched = marked shipped in CIN7 but retained on the TV until the
    // day after the despatch date (see fetchOpenSalesOrdersLive). These are
    // ready-and-waiting-for-pickup, not actionable picks.
    const isDispatched = !!o?.dispatchedDay;

    // past-due = must-ship-by date strictly BEFORE today. Same-day still
    // counts as actionable (warehouse can still ship), so it's not red.
    // A despatched order is done — never flag it past-due.
    const isPastDue = (!isDispatched && mustShipBy)
      ? dateBefore(mustShipBy, todayLocalDate)
      : false;
    if (isPastDue) pastDueCount++;

    // Line items: filter children (parentId > 0) and zero-qty rows (zeroed-
    // out by the retailer post-confirmation — they're not real picks and
    // would render as "0 / 0 cartons" on the TV), then analyse each.
    const rawLines = Array.isArray(o?.lineItems) ? o.lineItems : [];
    const lines = rawLines
      .filter((li) => (Number(li?.parentId) || 0) === 0)
      .filter((li) => (Number(li?.qty ?? li?.quantity ?? 0) || 0) > 0)
      .map((li) => analyseLineItem(li, stockBySku, isDispatched));

    const allFulfillable = lines.length > 0 && lines.every((l) => l.is_fulfillable);

    const record = {
      id: o?.id ?? null,
      reference: o?.reference || null,
      created_date: o?.createdDate || null,
      delivery_date: deliveryDate,
      must_ship_by: mustShipBy,
      is_past_due: isPastDue,
      is_dispatched: isDispatched,
      dispatched_date: o?.dispatchedDay || null,
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

  // Sort. Coles + Woolies: must-ship-by ascending (nulls to the end), with
  // despatched (ready-for-pickup) orders sunk below the still-to-pick ones
  // so active picks stay at the top of each column.
  const sortByMustShipBy = (a, b) => {
    if (!!a.is_dispatched !== !!b.is_dispatched) return a.is_dispatched ? 1 : -1;
    const aKey = a.must_ship_by || '9999-12-31';
    const bKey = b.must_ship_by || '9999-12-31';
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  };
  coles.sort(sortByMustShipBy);
  woolies.sort(sortByMustShipBy);
  // Other distributors: by CIN7 reference ascending (older reference =
  // longer wait = more urgent). Numeric-aware comparison so SO-1009 sorts
  // before SO-1010. Despatched orders sink to the bottom here too.
  otherDistributors.sort((a, b) => {
    if (!!a.is_dispatched !== !!b.is_dispatched) return a.is_dispatched ? 1 : -1;
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

// Read-only diagnostic: list ShipStation stores so we can identify which one
// is "Woo Live" (vs Woo Staging) for the on-hold KPI box. Behind SSO like
// everything else; returns no PII. Safe to leave in place.
logisticsRoutes.get('/logistics/ss-stores', async (c) => {
  try {
    const [stores, onHoldByStore] = await Promise.all([
      listShipStationStores(c.env),
      onHoldStoreBreakdown(c.env).catch(() => ({})),
    ]);
    return c.json({ ok: true, stores, onHoldByStore });
  } catch (e) {
    return c.json({ ok: false, error: redactSecrets(e?.message || String(e)) }, 500);
  }
});

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
