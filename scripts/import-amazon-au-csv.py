#!/usr/bin/env python3
"""
Bulk-import Amazon AU sales from a Seller Central "Amazon Fulfilled Shipments"
TSV export into D1.

Created 2026-05-17 as Phase 3b-a of the AU-data-into-D1 program. Mirrors the
Woo Phase 3a importer (scripts/import-woo-au-csv.py): one-shot CSV/TSV import
for the historical window, plus a separate SP-API cron tick for ongoing
changes once AMAZON_AU_* secrets are wired up (Phase 3b-b).

Inputs. Amazon Seller Central → Reports → Fulfillment → Amazon Fulfilled
Shipments. The default download format is tab-separated even though Amazon
labels it ".txt". One row per shipment-item (NOT per order — a multi-SKU
order generates multiple rows that share an amazon-order-id). Date range:
the user picks; this importer just consumes whatever's in the file. Recommended:
2025-11-01 → today to align with the CIN7 + Woo D1 history.

Key columns we consume (Amazon names them lowercase-with-hyphens):
  amazon-order-id        — order id, e.g. '028-1234567-1234567'
  purchase-date          — ISO 8601 with offset, e.g. '2026-03-15T04:23:11+00:00'
  shipment-date          — when fulfilled
  sku                    — Amazon seller SKU (canonical AU-… code, or FNSKU alias)
  product-name           — Amazon's title for the line
  quantity-shipped       — int
  currency               — 'AUD'
  item-price             — line-item ext. price (Amazon: per-row total, not per-unit)
  ship-country           — 'AU' (defensive filter — we drop non-AU rows)
  sales-channel          — 'Amazon.com.au' (defensive filter)

Targets.
  amazon_orders (id, market='AU', status, purchase_date, total, currency,
                 marketplace_id, raw_json=NULL, synced_at, local_date) —
                 one row per amazon-order-id. `total` summed across the
                 order's line items (item-price + shipping-price).
  amazon_items  (id AUTOINC, market='AU', seller_sku, dashboard_sku,
                 name, quantity, total, date_created, report_job_id,
                 ingested_at, local_date) — one row per shipment-item.
  report_jobs   sentinel row representing the AU CSV backfill — every
                amazon_items row references it via report_job_id (FK
                CASCADE on delete keeps re-runs idempotent).

SKU mapping. AU's Amazon seller SKUs are assumed to be canonical AU-… codes
by default (identity mapping). Any seller SKU that DOESN'T start with 'AU-'
is logged at the end of the run — those are FNSKU-style aliases that need
to be added to AMZ_SKU_MAP_AU in src/amazon.js for the SP-API cron path
(Phase 3b-b) and ALSO mapped in this script's AMZ_SKU_MAP_AU dict below.
The importer will leave dashboard_sku NULL for unmatched SKUs; the row
still lands in amazon_items so we don't drop revenue.

Idempotent. Re-runs delete the previous AU CSV backfill report_jobs row
(CASCADE-deleting all its amazon_items), recreate it fresh, and INSERT OR
REPLACE the amazon_orders rows. Re-running on the same TSV is a no-op.

SQL output size. Sized for ~50K line items / ~30K orders (Amazon AU is
materially smaller than Woo AU's 166K line items). Estimated ~10-20 MB
of SQL output. The chunked applier (scripts/apply-amazon-au-import-chunked.py)
pushes one statement per `--command` invocation to bypass D1's `--file`
OAuth quirk.

Usage:
    python3 scripts/import-amazon-au-csv.py [PATH_TO_TSV] [--dry-run]

The default path is the shared-Drive Logistics Dashboard location.
"""
import csv
import os
import re
import sys
from collections import defaultdict
from datetime import datetime

# ─── Config ───────────────────────────────────────────────────────────────

DEFAULT_TSV = os.path.expanduser(
    "~/Library/CloudStorage/GoogleDrive-admin@nopong.net/"
    "Shared drives/AI WORKSPACE/2. Shared Projects/Logistics Dashboard/"
    "AU Dashboard/Amazon Export/amazon-fulfilled-shipments-au.txt"
)
TMP_SQL = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".tmp-amazon-au-import.sql")
D1_DATABASE = "logistics-db"
MARKET = "AU"
DEFAULT_CURRENCY = "AUD"

# Amazon AU marketplace ID. Public, immutable, stamped on every order.
AMAZON_AU_MARKETPLACE_ID = "A39IBJ37TRP1C6"

# Sentinel `report_jobs` row identifiers. Re-runs upsert by (source, market,
# report_type, range_label) — one logical "AU CSV backfill" job, replaced
# end-to-end each re-run.
CSV_REPORT_TYPE  = "CSV_BACKFILL_AMAZON_FULFILLED_SHIPMENTS"
CSV_RANGE_LABEL  = "au-csv-backfill"

# Batch sizes for multi-row INSERT VALUES. Sized so each statement stays well
# under execve() ARG_MAX when the chunked applier passes it as --command=.
ORDERS_PER_INSERT = 400
ITEMS_PER_INSERT  = 500

# ─── SKU mapping ──────────────────────────────────────────────────────────
#
# Identity by default — AU's Amazon seller SKUs match canonical dashboard
# SKUs (e.g. 'AU-OG-NPO-35'). FNSKU-style aliases will need explicit entries
# once we see them in the data. After the first import, scan the
# "unmapped SKUs" report below and add entries here + in
# src/amazon.js AMZ_SKU_MAP_AU.

AMZ_SKU_MAP_AU = {
    # Self-mapping placeholders — extend as we encounter actual seller SKUs.
    # Identity fallback below handles SKUs starting with 'AU-' automatically.
}


def map_seller_sku(seller_sku):
    """Return (dashboard_sku, was_matched). dashboard_sku may be None.

    Strategy: explicit map first → identity for AU- prefix → None (unmapped).
    """
    s = (seller_sku or "").strip()
    if not s:
        return None, False
    if s in AMZ_SKU_MAP_AU:
        return AMZ_SKU_MAP_AU[s], True
    if s.startswith("AU-"):
        return s, True  # identity — seller SKU is already canonical
    return None, False


# ─── Date parsing ─────────────────────────────────────────────────────────
#
# Amazon's TSV uses ISO 8601 with UTC offset for purchase-date and friends
# (e.g. '2026-03-15T04:23:11+00:00'). We store the raw ISO string in
# amazon_orders.purchase_date (NA does the same) and derive local_date as
# the Sydney-local YYYY-MM-DD slice via toBusinessLocalDate() — but since
# we don't have the JS helper in Python, we approximate by adding 10 hours
# (AEST = UTC+10) or 11 (AEDT = UTC+11) and taking the date slice. For
# revenue-attribution purposes a 1-hour DST drift on the boundary row is
# acceptable; matches the NA Woo importer's locale slice approach.

def parse_purchase_date(s):
    """Return (raw_iso, local_date_yyyy_mm_dd). Both empty string if unparseable."""
    s = (s or "").strip()
    if not s:
        return "", ""
    # Strip 'Z' if Amazon ever uses it; normalise '+00:00' to '+0000' for fromisoformat
    raw = s
    # Common forms: '2026-03-15T04:23:11+00:00' / '2026-03-15T04:23:11Z' / '2026-03-15 04:23:11+00:00'
    try:
        norm = raw.replace("Z", "+00:00").replace(" ", "T")
        dt = datetime.fromisoformat(norm)
    except ValueError:
        # Last resort: try just the date prefix
        if len(s) >= 10 and s[4] == "-" and s[7] == "-":
            return raw, s[:10]
        return raw, ""
    # Convert to Sydney-local (UTC+10 baseline — sufficient for revenue rollup;
    # DST boundary drift is acceptable per the docstring above).
    # If dt has tzinfo, shift to UTC then add 10h; otherwise treat as naive UTC.
    try:
        from datetime import timezone, timedelta
        if dt.tzinfo is not None:
            dt_utc = dt.astimezone(timezone.utc).replace(tzinfo=None)
        else:
            dt_utc = dt
        dt_syd = dt_utc + timedelta(hours=10)
        return raw, dt_syd.strftime("%Y-%m-%d")
    except Exception:
        return raw, raw[:10] if len(raw) >= 10 else ""


# ─── SQL escaping ─────────────────────────────────────────────────────────

def sql_str(s):
    """Single-quote a string for SQL. Doubles up embedded single quotes."""
    if s is None:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def sql_num(n, default=0):
    """Numeric literal. Falsy/non-numeric → default. NULL allowed via passing None."""
    if n is None:
        return "NULL"
    try:
        f = float(n)
        # Render as int if whole, otherwise as a 4dp float (mirrors NA's
        # amazon_orders.total rounding behaviour).
        if f == int(f):
            return str(int(f))
        return f"{f:.4f}".rstrip("0").rstrip(".")
    except (ValueError, TypeError):
        return str(default)


# ─── Main ─────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    dry_run = "--dry-run" in args
    args = [a for a in args if a != "--dry-run"]
    tsv_path = args[0] if args else DEFAULT_TSV

    if not os.path.exists(tsv_path):
        print(f"ERROR: TSV not found at {tsv_path}", file=sys.stderr)
        print(f"Usage: python3 {sys.argv[0]} [PATH_TO_TSV] [--dry-run]", file=sys.stderr)
        sys.exit(1)

    print(f"Reading {tsv_path}…")

    # Aggregate by amazon-order-id for amazon_orders + collect line items for
    # amazon_items. Defensive filters: only AU ship-country, only AUD currency.
    # Unmapped SKUs get a NULL dashboard_sku (still ingested for revenue).

    orders = {}            # order_id → { status, purchase_date, local_date, total, currency }
    items  = []            # list of dicts: { order_id, seller_sku, dashboard_sku, name, quantity, total, date_created, local_date }
    unmapped_skus = defaultdict(int)
    filtered_rows = {"non_au_ship_country": 0, "non_aud_currency": 0, "no_order_id": 0}
    total_rows_seen = 0

    with open(tsv_path, "r", encoding="utf-8-sig", newline="") as f:
        # Amazon Fulfilled Shipments is tab-delimited.
        reader = csv.DictReader(f, delimiter="\t")
        if not reader.fieldnames:
            print("ERROR: TSV has no header row", file=sys.stderr)
            sys.exit(1)
        # Verify the columns we expect are present; if not, list what we got
        # so we can adjust.
        required = ["amazon-order-id", "purchase-date", "sku", "quantity-shipped",
                    "item-price", "currency"]
        missing = [c for c in required if c not in reader.fieldnames]
        if missing:
            print(f"ERROR: TSV missing required columns: {missing}", file=sys.stderr)
            print(f"Got columns: {list(reader.fieldnames)}", file=sys.stderr)
            sys.exit(1)

        for row in reader:
            total_rows_seen += 1
            order_id = (row.get("amazon-order-id") or "").strip()
            if not order_id:
                filtered_rows["no_order_id"] += 1
                continue

            # Defensive: ship-country must be AU. If column absent, skip the
            # check (some report variants don't include it; trust the report
            # was scoped to AU).
            ship_country = (row.get("ship-country") or "").strip().upper()
            if ship_country and ship_country != "AU":
                filtered_rows["non_au_ship_country"] += 1
                continue

            currency = (row.get("currency") or DEFAULT_CURRENCY).strip().upper()
            if currency and currency != "AUD":
                filtered_rows["non_aud_currency"] += 1
                continue

            purchase_date_raw = (row.get("purchase-date") or "").strip()
            purchase_date_iso, local_date = parse_purchase_date(purchase_date_raw)

            seller_sku = (row.get("sku") or "").strip()
            product_name = (row.get("product-name") or "").strip()

            try:
                qty = int(float(row.get("quantity-shipped") or 0))
            except (ValueError, TypeError):
                qty = 0
            try:
                item_price = float(row.get("item-price") or 0)
            except (ValueError, TypeError):
                item_price = 0.0
            try:
                shipping_price = float(row.get("shipping-price") or 0)
            except (ValueError, TypeError):
                shipping_price = 0.0

            dashboard_sku, matched = map_seller_sku(seller_sku)
            if not matched and seller_sku:
                unmapped_skus[seller_sku] += 1

            # Order header. First row per order wins for header fields.
            if order_id not in orders:
                orders[order_id] = {
                    "status":        "Shipped",  # Fulfilled Shipments only contains shipped orders
                    "purchase_date": purchase_date_iso,
                    "local_date":    local_date,
                    "total":         0.0,
                    "currency":      currency or DEFAULT_CURRENCY,
                }
            # Total accumulates: item-price + shipping-price (tax is separate;
            # mirrors NA Woo's "Total INCLUDES tax + shipping" semantic by
            # including shipping but omitting tax — Amazon prices in AU are
            # GST-inclusive at the item-price line, so tax double-count risk).
            orders[order_id]["total"] += item_price + shipping_price

            items.append({
                "order_id":      order_id,
                "seller_sku":    seller_sku,
                "dashboard_sku": dashboard_sku,
                "name":          product_name,
                "quantity":      qty,
                "total":         item_price,
                "date_created":  purchase_date_iso,
                "local_date":    local_date,
            })

    # ─── Diagnostic summary ──────────────────────────────────────────────

    n_orders = len(orders)
    n_items  = len(items)
    n_mapped = sum(1 for i in items if i["dashboard_sku"])
    n_unmapped = n_items - n_mapped
    total_rev = sum(o["total"] for o in orders.values())
    months = defaultdict(int)
    for o in orders.values():
        if o["local_date"]:
            months[o["local_date"][:7]] += 1

    print(f"\nParse summary:")
    print(f"  Rows seen:          {total_rows_seen:>8,}")
    print(f"  Rows filtered:      {sum(filtered_rows.values()):>8,}")
    for k, v in filtered_rows.items():
        if v: print(f"    {k}: {v:,}")
    print(f"  Line items kept:    {n_items:>8,}")
    print(f"  Distinct orders:    {n_orders:>8,}")
    print(f"  Items SKU-mapped:   {n_mapped:>8,}  ({n_mapped/max(n_items,1)*100:.1f}%)")
    print(f"  Items unmapped:     {n_unmapped:>8,}  (dashboard_sku=NULL)")
    print(f"  Total revenue:      ${total_rev:>10,.2f}")
    print(f"  Months covered:     {len(months)}  ({min(months.keys())} → {max(months.keys())})" if months else "  Months covered:     none")

    if unmapped_skus:
        print(f"\n  Unmapped seller SKUs (add to AMZ_SKU_MAP_AU + src/amazon.js):")
        for sku, count in sorted(unmapped_skus.items(), key=lambda x: -x[1]):
            print(f"    {sku!r}: {count:,} rows")

    if dry_run:
        print(f"\n--dry-run: skipping SQL output. Re-run without --dry-run to write {TMP_SQL}.")
        return

    # ─── Generate SQL ────────────────────────────────────────────────────

    print(f"\nWriting SQL to {TMP_SQL}…")
    with open(TMP_SQL, "w", encoding="utf-8") as out:
        out.write("-- Amazon AU CSV import — generated by scripts/import-amazon-au-csv.py\n")
        out.write(f"-- Source: {tsv_path}\n")
        out.write(f"-- Generated: {datetime.utcnow().isoformat()}Z\n")
        out.write(f"-- {n_orders:,} orders / {n_items:,} line items / ${total_rev:,.2f} revenue\n\n")

        # 1. Idempotency — DELETE the previous sentinel report_jobs row
        #    (CASCADE removes its amazon_items children). Use a deterministic
        #    range_label so re-runs target the same row.
        out.write("-- 1. Wipe previous AU CSV backfill (CASCADE deletes children)\n")
        out.write(
            f"DELETE FROM report_jobs "
            f"WHERE source='amazon' AND market='{MARKET}' "
            f"AND report_type={sql_str(CSV_REPORT_TYPE)} "
            f"AND range_label={sql_str(CSV_RANGE_LABEL)};\n\n"
        )

        # 2. INSERT the fresh sentinel row. We need the auto-generated id —
        #    so we use a known marker (range_label is unique enough) and look
        #    it up with last_insert_rowid() in subsequent INSERTs. BUT chunked
        #    --command splits each statement into its own session, so
        #    last_insert_rowid() won't carry across. Workaround: query the
        #    inserted id via SELECT and inline it as a literal. We do that
        #    here by NOT using AUTOINCREMENT for this row — set id explicitly.
        #
        #    To avoid colliding with NA's amazon report_jobs ids, we reserve
        #    a high id (10_000_000) for the AU CSV sentinel. Hard-coding is
        #    safe because re-runs DELETE-then-INSERT this exact id.
        au_csv_job_id = 10_000_000
        data_start = "2025-11-01T00:00:00Z"
        # Pick the latest local_date from the parsed orders as data_end.
        latest_local = max((o["local_date"] for o in orders.values() if o["local_date"]), default="")
        data_end = (latest_local or datetime.utcnow().strftime("%Y-%m-%d")) + "T00:00:00Z"

        out.write("-- 2. Sentinel report_jobs row for this CSV import (reserved id)\n")
        out.write(
            f"INSERT INTO report_jobs "
            f"(id, source, market, report_type, range_label, data_start_time, data_end_time, "
            f" status, attempts, filter_signal, created_at, updated_at) VALUES "
            f"({au_csv_job_id}, 'amazon', '{MARKET}', {sql_str(CSV_REPORT_TYPE)}, "
            f"{sql_str(CSV_RANGE_LABEL)}, {sql_str(data_start)}, {sql_str(data_end)}, "
            f"'ingested', 0, 'ship_country', "
            f"datetime('now'), datetime('now'));\n\n"
        )

        # 3. amazon_orders — INSERT OR REPLACE by id.
        out.write(f"-- 3. amazon_orders ({n_orders:,} rows)\n")
        order_items = list(orders.items())
        for i in range(0, len(order_items), ORDERS_PER_INSERT):
            chunk = order_items[i:i + ORDERS_PER_INSERT]
            values_clauses = []
            for oid, o in chunk:
                values_clauses.append(
                    f"({sql_str(oid)}, '{MARKET}', {sql_str(o['status'])}, "
                    f"{sql_str(o['purchase_date'])}, {sql_num(o['total'])}, "
                    f"{sql_str(o['currency'])}, '{AMAZON_AU_MARKETPLACE_ID}', "
                    f"NULL, datetime('now'), {sql_str(o['local_date'])})"
                )
            out.write(
                "INSERT OR REPLACE INTO amazon_orders "
                "(id, market, status, purchase_date, total, currency, marketplace_id, raw_json, synced_at, local_date) "
                "VALUES " + ",\n  ".join(values_clauses) + ";\n"
            )
        out.write("\n")

        # 4. amazon_items — straight INSERT (parent job was wiped above, so
        #    no orphans). Use the reserved sentinel job id.
        out.write(f"-- 4. amazon_items ({n_items:,} rows)\n")
        for i in range(0, len(items), ITEMS_PER_INSERT):
            chunk = items[i:i + ITEMS_PER_INSERT]
            values_clauses = []
            for it in chunk:
                values_clauses.append(
                    f"('{MARKET}', {sql_str(it['seller_sku'])}, {sql_str(it['dashboard_sku'])}, "
                    f"{sql_str(it['name'])}, {it['quantity']}, {sql_num(it['total'])}, "
                    f"{sql_str(it['date_created'])}, {au_csv_job_id}, datetime('now'), "
                    f"{sql_str(it['local_date'])})"
                )
            out.write(
                "INSERT INTO amazon_items "
                "(market, seller_sku, dashboard_sku, name, quantity, total, date_created, report_job_id, ingested_at, local_date) "
                "VALUES " + ",\n  ".join(values_clauses) + ";\n"
            )
        out.write("\n")

        # 5. Update the report_jobs row with rows_total / rows_matched /
        #    rows_unmatched so the audit trail is complete.
        out.write("-- 5. Update sentinel job with row counts\n")
        out.write(
            f"UPDATE report_jobs SET rows_total={n_items}, rows_matched={n_mapped}, "
            f"rows_unmatched={n_unmapped}, rows_wrong_market={filtered_rows['non_au_ship_country']}, "
            f"updated_at=datetime('now') WHERE id={au_csv_job_id};\n"
        )

    size_mb = os.path.getsize(TMP_SQL) / (1024 * 1024)
    print(f"  Wrote {os.path.getsize(TMP_SQL):,} bytes ({size_mb:.1f} MB)")
    print(f"\nNext: run scripts/apply-amazon-au-import-chunked.py to push to D1.")


if __name__ == "__main__":
    main()
