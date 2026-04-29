/**
 * Timezone utilities for the No Pong Logistics Dashboard.
 *
 * Single canonical business timezone (America/Toronto, Eastern). All order
 * bucketing — monthly, weekly, daily — happens in this zone, regardless of
 * which source the data came from.
 *
 * Background: Woo's site timezone is configured to Eastern on both stores
 * (Toronto for CA, New York for US — same DST rules), so its `date_created`
 * timestamps come back as Eastern-naive ISO strings (e.g. '2026-04-28T23:18:49').
 * Substring extraction at insert time gives the Eastern local date directly.
 * Amazon's SP-API returns `PurchaseDate` as UTC ISO with explicit offset
 * (e.g. '2026-04-29T03:18:49+00:00'), so converting to Eastern requires real
 * timezone arithmetic. `toBusinessLocalDate` handles that, with DST
 * auto-resolved by Workers' built-in Intl.DateTimeFormat.
 *
 * The single canonical bucketing column on every order/items table is
 * `local_date TEXT` (format YYYY-MM-DD in Eastern). All read queries use it.
 * Per-source ingest code populates it at insert time using the appropriate
 * conversion (substring for Woo, toBusinessLocalDate for Amazon).
 */

export const BUSINESS_TZ = 'America/Toronto';

// Earliest week-bucket start. Weekly views below this date don't render.
// Carried forward from the legacy backend/server.js convention.
export const WEEKLY_START_DATE = '2026-03-01';

// Cached at module load — Intl.DateTimeFormat instances are expensive to
// construct, cheap to reuse.
const _dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
});

const _yearMonthFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TZ,
  year: 'numeric', month: '2-digit',
});

/**
 * Convert an ISO 8601 timestamp to a YYYY-MM-DD string in BUSINESS_TZ.
 * The input must have an explicit offset marker ('Z' or '+HH:MM') for
 * unambiguous interpretation. Naive timestamps will be parsed as the
 * runtime's local time, which on Workers is UTC, so they'll convert
 * correctly only if they're actually UTC — Woo's Eastern-naive
 * date_created values should NOT be passed through this function;
 * substring them directly instead.
 *
 * Returns null for invalid input.
 *
 * Examples (in EDT, UTC-4):
 *   '2026-04-29T03:18:49+00:00' → '2026-04-28'  (Apr 29 03:18 UTC = Apr 28 23:18 ET)
 *   '2026-04-29T15:30:00Z'      → '2026-04-29'  (Apr 29 15:30 UTC = Apr 29 11:30 ET)
 */
export function toBusinessLocalDate(isoUtc) {
  if (!isoUtc) return null;
  const d = new Date(isoUtc);
  if (isNaN(d.getTime())) return null;
  return _dateFormatter.format(d);  // en-CA returns 'YYYY-MM-DD'
}

/**
 * Get today's date in BUSINESS_TZ as YYYY-MM-DD.
 */
export function getBusinessToday() {
  return _dateFormatter.format(new Date());
}

/**
 * Get the current year-month in BUSINESS_TZ as YYYY-MM.
 */
export function getBusinessYearMonth() {
  return _yearMonthFormatter.format(new Date());
}

/**
 * Build the rolling N-month window in BUSINESS_TZ.
 *
 * Returns:
 *   monthMap:  { 'YYYY-MM': index }  where index 0 is oldest, N-1 is newest
 *   labels:    [ 'Nov 2025', 'Dec 2025', ... ]  human readable, oldest first
 *   startYm:   'YYYY-MM' of the oldest month in the window
 *   startDate: 'YYYY-MM-01' string for the SQL filter floor
 *
 * Pure calendar arithmetic on the year/month integers — no Date math beyond
 * "what's the current Eastern year-month", so DST transitions can't slip the
 * window by an hour at month boundaries.
 */
export function buildMonthWindow(months = 6) {
  const currentYm = getBusinessYearMonth();
  const [y, m] = currentYm.split('-').map(Number);
  const monthMap = {};
  const labels = [];
  let startY = y, startM = m;
  for (let i = months - 1; i >= 0; i--) {
    let mm = m - i;
    let yy = y;
    while (mm <= 0) { mm += 12; yy -= 1; }
    const ym = `${yy}-${String(mm).padStart(2, '0')}`;
    monthMap[ym] = months - 1 - i;
    labels.push(new Date(yy, mm - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' }));
    if (i === months - 1) { startY = yy; startM = mm; }
  }
  const startYm   = `${startY}-${String(startM).padStart(2, '0')}`;
  const startDate = `${startYm}-01`;
  return { monthMap, labels, startYm, startDate };
}

/**
 * Compute the week-bucket key for a YYYY-MM-DD local date string.
 *
 * Weeks run Mon–Sun, but split at month boundaries — i.e. the last few days
 * of one month and the first few of the next are reported as separate weekly
 * buckets, so weekly and monthly views stay aligned.
 *
 * Returns null for dates earlier than WEEKLY_START_DATE or invalid input.
 *
 * Input is expected to already be in BUSINESS_TZ (i.e. it's a `local_date`
 * column value, not a UTC timestamp). No further timezone conversion.
 */
export function getWeekKey(localDate) {
  if (!localDate) return null;
  const m = String(localDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  // Plain new Date — only used for day-of-week arithmetic. JS treats this
  // constructor as midnight-local; on Workers (UTC) that's midnight UTC,
  // but getDay() returns the same value either way.
  const date = new Date(y, mo - 1, d);
  const dayOfWeek = date.getDay();
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(date);
  monday.setDate(date.getDate() + diffToMonday);
  if (monday.getMonth() !== date.getMonth() || monday.getFullYear() !== date.getFullYear()) {
    // Monday of this date's week falls in the previous month — bucket as
    // the first of the current month so monthly and weekly views align.
    const firstOfMonth = `${y}-${String(mo).padStart(2, '0')}-01`;
    return firstOfMonth >= WEEKLY_START_DATE ? firstOfMonth : null;
  }
  const key = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  return key >= WEEKLY_START_DATE ? key : null;
}
