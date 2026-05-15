#!/usr/bin/env python3
"""
Bulk-import WooCommerce AU sales from a Metorik CSV export into D1.

Created 2026-05-15 as Phase 3a of the v2.36 AU-data-into-D1 program. Mirrors
the CIN7 CSV-pivot work (scripts/import-cin7-csv.py) — one-shot CSV import
for the historical window, plus a simple `runBackfillChunk` cron tick for
ongoing changes once WOO_AU_* secrets are wired up.

Inputs. Metorik's Detailed Orders export, one row per line item. Same shape
across the export — order header columns repeat on every line of a given
order, but some (Customer ID, Customer Note, UTM fields, etc.) are blank on
continuation rows. The columns we care about (Order ID, Order Number,
Order Created At, Status, Currency, Total, Line Item *) are populated on
every row, so "first row per Order ID wins" for the header and every row
contributes its own line item.

Targets. The existing `orders` + `order_items` tables (migration 0001) with
market='AU'. Field semantics deliberately match what runBackfillChunk
(src/admin.js) writes from the Woo REST API so reads work uniformly across
both CSV-imported and cron-imported rows:

  orders.total           = "Total" (full pre-refund order total incl tax + shipping)
  orders.status          = lowercased "Status" (all values imported; reads filter)
  orders.local_date      = substr("Order Created At", 1, 10)  — Sydney-naive
  order_items.total      = "Line Item Total" (line total, excludes tax)
  order_items.quantity   = int("Line Item Quantity")
  order_items.sku        = raw Metorik "Line Item Sku" (no normalisation here —
                            normalisation belongs at read time, same as NA Woo)
  raw_json               = NULL (matches runBackfillChunk's backfill path)

Idempotent. INSERT OR REPLACE on orders + DELETE-then-INSERT scoped per
order_id on items. Re-running with the same CSV is a no-op.

SQL output size. Metorik's full export is ~70K orders / 166K line items —
about 50 MB of generated SQL. Past D1's `--file` 50 MB limit and well past
the wrangler-with-OAuth `/import` endpoint's known reliability ceiling.
The output is built for the chunked applier path
(scripts/apply-woo-au-import-chunked.py) — one statement per `--command`
invocation, no upper bound on total SQL size.

Usage:
    python3 scripts/import-woo-au-csv.py [PATH_TO_CSV] [--dry-run]

The default path is the shared-Drive Logistics Dashboard location. Pass an
explicit path to override. The script ONLY writes the SQL file; the
chunked applier does the wrangler push.
"""
import csv
import os
import re
import sys
from collections import defaultdict
from datetime import datetime

# ─── Config ───────────────────────────────────────────────────────────────

DEFAULT_CSV = os.path.expanduser(
    "~/Library/CloudStorage/GoogleDrive-admin@nopong.net/"
    "Shared drives/AI WORKSPACE/2. Shared Projects/Logistics Dashboard/"
    "AU Dashboard/Woo Export/269a70c6754e154dff7dc4880871a2dc.csv"
)
TMP_SQL = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".tmp-woo-au-import.sql")
D1_DATABASE = "logistics-db"
MARKET = "AU"
DEFAULT_CURRENCY = "AUD"

# Batch sizes for multi-row INSERT VALUES. Sized so each generated statement
# stays well under `execve()` ARG_MAX (typically ~256 KB on macOS) when the
# chunked applier passes the statement as a single --command= argument.
#   ~250 bytes/order × 400 = ~100 KB per statement
#   ~200 bytes/item  × 500 = ~100 KB per statement
ORDERS_PER_INSERT = 400
ITEMS_PER_INSERT = 500
DELETE_IDS_PER_STATEMENT = 1000


# ─── Date parsing ─────────────────────────────────────────────────────────

# Metorik exports `Order Created At` as 'YYYY-MM-DD HH:MM:SS' (naive Sydney
# local time — the WooCommerce store's configured TZ). We normalise to
# ISO-8601 'YYYY-MM-DDTHH:MM:SS' (still naive — no Z, no offset) so it sorts
# lexically and matches NA Woo's `date_created` shape (also naive ET).

def parse_csv_datetime(s):
    """Parse Metorik date string. Returns 'YYYY-MM-DDTHH:MM:SS' or empty string."""
    s = (s or "").strip()
    if not s:
        return ""
    # Most rows are 'YYYY-MM-DD HH:MM:SS'. Some Metorik exports use 'YYYY-MM-DD'
    # only (rare — completion timestamps on some statuses).
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(s, fmt)
            return dt.strftime("%Y-%m-%dT%H:%M:%S")
        except ValueError:
            continue
    return s  # Last resort: keep raw — better than dropping the row.


def local_date_of(dt_str):
    """YYYY-MM-DD prefix of the date_created string. Matches NA's substr(date_created, 1, 10)."""
    return dt_str[:10] if dt_str else None


# ─── SQL escaping ─────────────────────────────────────────────────────────

def sql_str(v):
    """Quote a value for inclusion in a SQL literal. NULL for None/empty."""
    if v is None:
        return "NULL"
    s = str(v)
    if s == "":
        return "NULL"
    # Standard SQLite escape: single quote → doubled. Strip null bytes (D1 rejects).
    s = s.replace("\x00", "").replace("'", "''")
    return f"'{s}'"


def sql_num(v, default=0):
    """Coerce to number for SQL. Empty/None → default."""
    if v is None or v == "":
        return default
    try:
        f = float(v)
        if f == int(f):
            return int(f)
        return f
    except (ValueError, TypeError):
        return default


def sql_int(v, default=0):
    """Coerce to int. Empty/None → default."""
    if v is None or v == "":
        return default
    try:
        return int(float(v))
    except (ValueError, TypeError):
        return default


# ─── Main pipeline ────────────────────────────────────────────────────────

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    dry_run = "--dry-run" in flags
    csv_path = args[0] if args else DEFAULT_CSV
    if not os.path.exists(csv_path):
        print(f"❌ CSV not found: {csv_path}", file=sys.stderr)
        return 1

    # Metorik embeds newlines inside the "Line Item Meta" column (e.g.
    # `_reduced_stock: 2`). csv module needs a generous field-size limit.
    csv.field_size_limit(min(sys.maxsize, 2**31 - 1))

    print(f"📂 Reading CSV: {csv_path}")
    print(f"   Size: {os.path.getsize(csv_path):,} bytes")

    # ── Pass 1: parse + aggregate per Order ID ─────────────────────────────
    orders = {}   # order_id (int) → header dict
    items = defaultdict(list)  # order_id → list of line dicts
    skipped = defaultdict(int)
    rows_total = 0
    rows_kept = 0

    with open(csv_path, encoding="utf-8", errors="replace", newline="") as f:
        rdr = csv.DictReader(f)
        for row in rdr:
            rows_total += 1

            order_id = sql_int(row.get("Order ID"), 0)
            if not order_id:
                skipped["bad_order_id"] += 1
                continue

            rows_kept += 1

            # ── Order header (first row per Order ID wins) ────────────────
            if order_id not in orders:
                date_created = parse_csv_datetime(row.get("Order Created At"))
                local_date   = local_date_of(date_created)
                status_raw   = (row.get("Status") or "unknown").strip().lower() or "unknown"
                number       = (row.get("Order Number") or str(order_id)).strip().lstrip("#")
                currency     = (row.get("Currency") or DEFAULT_CURRENCY).strip() or DEFAULT_CURRENCY
                total        = sql_num(row.get("Total"), 0)

                orders[order_id] = {
                    "id": order_id,
                    "market": MARKET,
                    "number": number,
                    "status": status_raw,
                    "date_created": date_created,
                    "local_date": local_date,
                    "total": total,
                    "currency": currency,
                }

            # ── Line item ─────────────────────────────────────────────────
            sku       = (row.get("Line Item Sku") or "").strip() or None
            name      = (row.get("Line Item Name") or "").strip() or None
            quantity  = sql_int(row.get("Line Item Quantity"), 0)
            line_tot  = sql_num(row.get("Line Item Total"), 0)

            items[order_id].append({
                "order_id": order_id,
                "market": MARKET,
                "sku": sku,
                "name": name,
                "quantity": quantity,
                "total": line_tot,
                "date_created": orders[order_id]["date_created"],
                "local_date": orders[order_id]["local_date"],
            })

    # ── Summary ───────────────────────────────────────────────────────────
    print(f"\n📊 Parse summary")
    print(f"   Total CSV rows scanned:     {rows_total:>9,}")
    print(f"   Rows kept:                  {rows_kept:>9,}")
    print(f"   Distinct orders:            {len(orders):>9,}")
    print(f"   Total line items:           {sum(len(v) for v in items.values()):>9,}")
    if skipped:
        print(f"\n   Skipped by reason:")
        for reason, n in sorted(skipped.items(), key=lambda x: -x[1]):
            print(f"     {reason:<14}  {n:>9,}")

    # Per-status breakdown — matches what NA reconcile prints.
    by_status = defaultdict(lambda: {"orders": 0, "items": 0, "revenue": 0.0})
    for oid, o in orders.items():
        by_status[o["status"]]["orders"] += 1
        by_status[o["status"]]["revenue"] += float(o["total"] or 0)
    for oid, lines in items.items():
        by_status[orders[oid]["status"]]["items"] += len(lines)
    print(f"\n   Per-status breakdown (all imported; reads filter at query time):")
    for status in sorted(by_status.keys(), key=lambda s: -by_status[s]["orders"]):
        d = by_status[status]
        print(f"     {status:<12}  orders={d['orders']:>7,}  items={d['items']:>7,}  revenue=${d['revenue']:>13,.2f}")

    # Per-month breakdown — sanity-check the date range matches what Melanie
    # exported (e.g. Nov 2025 → May 2026, mirroring the CIN7 export).
    by_month = defaultdict(lambda: {"orders": 0, "revenue": 0.0})
    for o in orders.values():
        ym = (o["local_date"] or "")[:7]
        if ym:
            by_month[ym]["orders"] += 1
            by_month[ym]["revenue"] += float(o["total"] or 0)
    if by_month:
        print(f"\n   Per-month breakdown (local_date YYYY-MM, all statuses):")
        for ym in sorted(by_month.keys()):
            d = by_month[ym]
            print(f"     {ym}    orders={d['orders']:>6,}  revenue=${d['revenue']:>13,.2f}")

    # Compute new watermark — MAX(date_created) of imported orders. The cron
    # uses strict `after=watermark` (NA pattern), so this advances the cron
    # past every row we just imported.
    max_date = max(
        (o["date_created"] for o in orders.values() if o["date_created"]),
        default=None,
    )
    print(f"\n   New cron watermark target: {max_date}")

    # ── Build SQL ─────────────────────────────────────────────────────────
    print(f"\n🛠  Building SQL file: {TMP_SQL}")
    with open(TMP_SQL, "w", encoding="utf-8") as out:
        out.write("-- Woo AU CSV bulk import (Phase 3a of v2.36 AU→D1)\n")
        out.write(f"-- Generated: {datetime.utcnow().isoformat()}Z\n")
        out.write(f"-- Source:    {csv_path}\n")
        out.write(f"-- Orders:    {len(orders):,}\n")
        out.write(f"-- Items:     {sum(len(v) for v in items.values()):,}\n\n")

        # ── Orders (INSERT OR REPLACE, batched multi-row VALUES) ──────────
        out.write("-- ─── Orders ────────────────────────────────────────────\n")
        # Column order matches `runBackfillChunk` in src/admin.js so a sql diff
        # against an API-ingested order is column-aligned.
        order_cols = [
            "id", "market", "number", "status",
            "date_created", "local_date",
            "total", "currency",
            "raw_json", "synced_at",
        ]
        NUMERIC_ORDER_COLS = {"id", "total"}
        order_list = sorted(orders.values(), key=lambda o: o["id"])
        for batch_start in range(0, len(order_list), ORDERS_PER_INSERT):
            batch = order_list[batch_start:batch_start + ORDERS_PER_INSERT]
            out.write(
                f"INSERT OR REPLACE INTO orders ({', '.join(order_cols)}) VALUES\n"
            )
            value_rows = []
            for o in batch:
                cells = [
                    str(o["id"]),
                    sql_str(o["market"]),
                    sql_str(o["number"]),
                    sql_str(o["status"]),
                    sql_str(o["date_created"]),
                    sql_str(o["local_date"]),
                    str(o["total"]) if o["total"] is not None else "NULL",
                    sql_str(o["currency"]),
                    "NULL",  # raw_json — matches runBackfillChunk's backfill path
                    "strftime('%Y-%m-%dT%H:%M:%SZ','now')",  # synced_at
                ]
                value_rows.append("(" + ", ".join(cells) + ")")
            out.write(",\n".join(value_rows))
            out.write(";\n\n")

        # ── Items: DELETE existing per-order, then bulk INSERT ────────────
        out.write("-- ─── Items: clear existing per-order ──────────────────\n")
        all_order_ids = sorted(orders.keys())
        for batch_start in range(0, len(all_order_ids), DELETE_IDS_PER_STATEMENT):
            batch_ids = all_order_ids[batch_start:batch_start + DELETE_IDS_PER_STATEMENT]
            out.write(
                "DELETE FROM order_items WHERE market = 'AU' AND order_id IN ("
                + ", ".join(str(i) for i in batch_ids)
                + ");\n"
            )
        out.write("\n")

        out.write("-- ─── Items: bulk INSERT ───────────────────────────────\n")
        # Same column order as runBackfillChunk's INSERT in src/admin.js.
        item_cols = [
            "order_id", "market",
            "sku", "name",
            "quantity", "total",
            "date_created", "local_date",
        ]
        all_items = [li for oid in sorted(items.keys()) for li in items[oid]]
        for batch_start in range(0, len(all_items), ITEMS_PER_INSERT):
            batch = all_items[batch_start:batch_start + ITEMS_PER_INSERT]
            out.write(f"INSERT INTO order_items ({', '.join(item_cols)}) VALUES\n")
            value_rows = []
            for li in batch:
                cells = [
                    str(li["order_id"]),
                    sql_str(li["market"]),
                    sql_str(li["sku"]),
                    sql_str(li["name"]),
                    str(int(li["quantity"] or 0)),
                    str(li["total"]) if li["total"] is not None else "NULL",
                    sql_str(li["date_created"]),
                    sql_str(li["local_date"]),
                ]
                value_rows.append("(" + ", ".join(cells) + ")")
            out.write(",\n".join(value_rows))
            out.write(";\n\n")

        # ── Cron watermark advance ────────────────────────────────────────
        if max_date:
            out.write("-- ─── Reset cron watermark to MAX(date_created) of imported orders ─\n")
            out.write(
                "INSERT OR IGNORE INTO sync_state (source, market) VALUES ('woo', 'AU');\n"
            )
            out.write(
                f"UPDATE sync_state SET watermark = '{max_date}' "
                f"WHERE source = 'woo' AND market = 'AU';\n"
            )

    sql_size = os.path.getsize(TMP_SQL)
    print(f"   SQL file size: {sql_size:,} bytes ({sql_size / (1024*1024):.1f} MB)")
    if sql_size > 50 * 1024 * 1024:
        print(f"   ℹ️  Over D1's --file 50 MB limit. Push via the chunked applier:")
        print(f"      scripts/apply-woo-au-import-chunked.py")

    if dry_run:
        print(f"\n🧪 --dry-run: SQL file written, NOT executing wrangler.")
        print(f"   Inspect: {TMP_SQL}")
        return 0

    print(f"\n✅ Parse + SQL build complete.")
    print(f"   Next: run scripts/apply-woo-au-import-chunked.py to push to prod D1.")
    print(f"   (or double-click Commands/apply-woo-au-import-chunked.command)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
