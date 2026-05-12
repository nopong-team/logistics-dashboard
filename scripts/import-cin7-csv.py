#!/usr/bin/env python3
"""
Bulk-import CIN7 sales orders from a CSV export into D1.

Created 2026-05-12 as part of the v2.36 CSV-pivot work. Replaces the
unworkable incremental-sync backfill (CIN7 API silently drops `Id` filters
in `where` clauses, so no composite cursor strategy can walk past the Nov 8
2025 13:00:06Z cluster of 250+ records sharing one timestamp).

Reads the CSV produced by CIN7's full Sales Orders export ("backend" detail
report, not PivotGrid — confirmed format has separate Company / First Name /
Last Name columns), applies the same classifier as src/cin7.js
`attributeCin7Order` PLUS a channel='Backend' gate for 'dist' classification
(which the cron can't apply because CIN7's API doesn't expose the channel
field — see Melanie's 2026-05-12 transcript), filters to col/woo2/dist only,
aggregates per-order line items, and bulk-writes via `wrangler d1 execute
--remote --file`.

Field semantics match what src/cin7-sync.js writes from the API so reads on
cin7_sales_orders/cin7_sales_order_items work uniformly against both
CSV-imported and cron-imported rows.

Idempotent — re-running with the same CSV is a no-op (INSERT OR REPLACE on
orders + DELETE-then-INSERT on items, scoped per order_id).

Usage:
    python3 scripts/import-cin7-csv.py [PATH_TO_CSV]

The default path is the shared-Drive Logistics Dashboard location. Pass an
explicit path to override.
"""
import csv
import os
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime

# ─── Config ───────────────────────────────────────────────────────────────

DEFAULT_CSV = os.path.expanduser(
    "~/Library/CloudStorage/GoogleDrive-admin@nopong.net/"
    "Shared drives/AI WORKSPACE/2. Shared Projects/Logistics Dashboard/"
    "AU Dashboard/Cin7 Exports/OrdersExport-12-05-2026-3.csv"
)
TMP_SQL = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".tmp-cin7-import.sql")
D1_DATABASE = "logistics-db"
MARKET = "AU"

# Batch sizes for multi-row INSERT VALUES (D1 / SQLite handles much higher;
# 200 keeps individual statements well under the 50 KB per-statement limit).
ORDERS_PER_INSERT = 200
ITEMS_PER_INSERT = 200
DELETE_IDS_PER_STATEMENT = 500

# ─── SKU + classifier logic — mirrors src/cin7.js ─────────────────────────

def normalize_au_sku(sku):
    """Same rules as `normalizeAuSku` in src/cin7.js."""
    s = (sku or "").strip()
    if not s:
        return (None, 1)
    m = re.match(r"^WC-(AU-.+?)(?:-(?:NL|WC))?$", s)
    if m:
        return (m.group(1), 54)
    m = re.match(r"^AU-CTN-(.+)-48$", s)
    if m:
        return (f"AU-{m.group(1)}-35", 48)
    if s.startswith("AU-CTN-SRT-MIX-"):
        return (s, 72)
    m = re.match(r"^AU-SRT-(.+)x12$", s)
    if m:
        return (f"AU-{m.group(1).rstrip('-')}", 12)
    m = re.match(r"^(AU-.+)M$", s)
    if m:
        return (m.group(1), 1)
    return (s, 1)


def is_au_sku(code):
    """Same as `isAuSkuCode` in src/cin7.js — `/^(?:WC-|D-)?AU-/i`."""
    return bool(re.match(r"^(?:WC-|D-)?AU-", (code or "").strip(), re.IGNORECASE))


_PERSONAL_MARKERS = {"mr", "mrs", "ms", "private"}


def classify(company, first_name, channel):
    """
    Adapted from `attributeCin7Order` in src/cin7.js, with one CSV-only
    refinement: `dist` is gated to Channel='Backend' to exclude WooCommerce
    wholesale stockists (Sunshine Coast Health Products, Box Divvy, etc.)
    which the API-driven cron can't filter out (API doesn't expose channel).
    Those orders will be counted via Phase 3 Metorik instead, so importing
    them as 'dist' here would later double-count.

    Coles/Woolworths attribution is channel-agnostic — substring matching
    catches both pre-EDI manual entries (channel='Backend', company='Coles')
    and post-EDI integrated orders (channel=blank, company='Grocery Holdings
    Pty Ltd - RedBank' / 'WOOLWORTHS - Moorebank - NDC' / etc.).
    """
    cl = (company or "").lower().strip()
    ch = (channel or "").strip()
    fn = (first_name or "").strip()
    # Stock Adjustments — inventory movements, not sales
    if company == "Stock Adjustments" or fn == "Stock Adjustments":
        return None
    # Amazon mirrors — counted via SP-API in Phase 3
    if cl.startswith("amazon"):
        return None
    # Coles / Woolies — channel-agnostic
    if "woolworths" in cl:
        return "woo2"
    if cl == "coles":
        return "col"
    if "grocery holdings" in cl:
        return "col"
    if cl == "kemps creek":
        return "col"
    # Distributors — Backend channel only (exclude WooCommerce wholesale)
    if ch != "Backend":
        return None
    if not company or company == "[Redacted]":
        return None
    if cl in _PERSONAL_MARKERS:
        return None
    return "dist"


# ─── Date parsing ─────────────────────────────────────────────────────────

_DATE_FORMATS = ("%d %b %Y %I:%M %p", "%d %b %Y")


def parse_csv_date(s):
    """Parse CIN7 CSV date string. Returns ISO 8601 string with Z suffix, or None."""
    s = (s or "").strip()
    if not s:
        return None
    for fmt in _DATE_FORMATS:
        try:
            dt = datetime.strptime(s, fmt)
            return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            continue
    return None


def parse_to_dt(s):
    s = (s or "").strip()
    if not s:
        return None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


# ─── SQL escaping ─────────────────────────────────────────────────────────

def sql_str(v):
    """Quote a value for inclusion in a SQL literal. NULL for None/empty."""
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v)
    if s == "":
        return "NULL"
    # Standard SQL escape: single quote → doubled. Strip null bytes (D1 rejects).
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


def sql_int(v, default=None):
    """Coerce to int. None/empty → default ('NULL' if None)."""
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

    print(f"📂 Reading CSV: {csv_path}")
    print(f"   Size: {os.path.getsize(csv_path):,} bytes")

    # ── Pass 1: parse + classify + aggregate per Order Id ─────────────────
    orders = {}   # order_id (int) → header dict
    items = defaultdict(list)  # order_id → list of line dicts
    skipped_by_reason = defaultdict(int)
    rows_total = 0
    rows_kept = 0

    with open(csv_path, encoding="latin-1", newline="") as f:
        rdr = csv.DictReader(f)
        for row in rdr:
            rows_total += 1
            attr = classify(row["Company"], row["First Name"], row["Channel"])
            if attr not in ("col", "woo2", "dist"):
                skipped_by_reason[attr or "null"] += 1
                continue

            try:
                order_id = int(row["Order Id"])
            except (ValueError, TypeError):
                skipped_by_reason["bad_order_id"] += 1
                continue

            rows_kept += 1

            # ── Order header (first row wins; consistent within an order) ─
            if order_id not in orders:
                created = parse_csv_date(row["Created Date"])
                # Modified-date proxy: latest of (Created, Invoice, Fully Dispatched).
                # Deliberately EXCLUDE ETD — it's a forward-looking estimated delivery
                # date set at order placement, not a "modification" timestamp. Including
                # it pushes the watermark into the future for orders with ETDs > today.
                # Cap at "now" so we never advance the cron watermark past actual time.
                now_dt = datetime.utcnow()
                modified_candidates = [
                    parse_to_dt(row["Created Date"]),
                    parse_to_dt(row["Invoice Date"]),
                    parse_to_dt(row["Fully Dispatched"]),
                ]
                modified_dts = [d for d in modified_candidates if d is not None and d <= now_dt]
                modified_iso = (
                    max(modified_dts).strftime("%Y-%m-%dT%H:%M:%SZ")
                    if modified_dts else created
                )

                # Status inference
                if (row["Cancellation Date"] or "").strip():
                    status = "VOID"
                elif (row["Fully Dispatched"] or "").strip():
                    status = "APPROVED"
                elif (row["Invoice Date"] or "").strip():
                    status = "APPROVED"
                else:
                    status = "OPEN"

                orders[order_id] = {
                    "id": order_id,
                    "reference": row["Order Ref"] or None,
                    "market": MARKET,
                    "status": status,
                    "channel_attr": attr,
                    "company": row["Company"] or None,
                    "first_name": row["First Name"] or None,
                    "last_name": row["Last Name"] or None,
                    "member_id": None,
                    "member_email": None,
                    "total": sql_num(row["Total Excl"], None),
                    "sub_total": sql_num(row["Total Excl"], None),
                    "product_total": sql_num(row["Product Total"], None),
                    "created_date": created,
                    "modified_date": modified_iso,
                    "raw_json": None,
                }

            # ── Line item ─────────────────────────────────────────────────
            code = (row["Item Code"] or "").strip() or None
            base_sku, multiplier = normalize_au_sku(code) if code else (None, 1)
            # Item Qty Moved (dispatched) preferred; fall back to Item Qty.
            qty_moved = sql_num(row["Item Qty Moved"], None)
            qty_ordered = sql_num(row["Item Qty"], 0)
            qty = qty_moved if qty_moved is not None else qty_ordered
            unit_price = sql_num(row["Item Price"], None)
            line_total = (qty or 0) * (unit_price or 0)
            is_au = 1 if (code and is_au_sku(code)) else 0
            # tins: in this CSV, Item Qty is already in selling-units (cartons for
            # AU-CTN-*-48, tins for AU-OG-*-35). cron's rule `uomSize>1 ? qty : qty*mult`
            # with uomSize=1 gives tins = qty × multiplier. Same here.
            tins = (qty or 0) * multiplier if is_au else 0

            items[order_id].append({
                "order_id": order_id,
                "market": MARKET,
                "parent_id": 0,
                "code": code,
                "base_sku": base_sku,
                "multiplier": multiplier,
                "uom_size": 1,
                "qty": qty or 0,
                "unit_price": unit_price,
                "total": line_total,
                "name": row["Item Name"] or None,
                "is_au_sku": is_au,
                "tins": tins,
                "created_date": orders[order_id]["created_date"],
            })

    # ── Summary ───────────────────────────────────────────────────────────
    print(f"\n📊 Parse summary")
    print(f"   Total CSV rows scanned:     {rows_total:>8,}")
    print(f"   Rows kept (col/woo2/dist):  {rows_kept:>8,}")
    print(f"   Distinct orders:            {len(orders):>8,}")
    print(f"   Total line items:           {sum(len(v) for v in items.values()):>8,}")
    print(f"\n   Skipped by classifier:")
    for reason, n in sorted(skipped_by_reason.items(), key=lambda x: -x[1]):
        print(f"     {reason:<14}  {n:>8,}")

    # Per-channel breakdown
    by_attr = defaultdict(lambda: {"orders": 0, "tins": 0, "items": 0})
    for oid, o in orders.items():
        by_attr[o["channel_attr"]]["orders"] += 1
    for oid, lines in items.items():
        attr = orders[oid]["channel_attr"]
        by_attr[attr]["items"] += len(lines)
        by_attr[attr]["tins"] += sum(li["tins"] for li in lines)
    print(f"\n   Per-channel breakdown:")
    for attr in ("col", "woo2", "dist"):
        d = by_attr[attr]
        print(f"     {attr:<6}  orders={d['orders']:>6,}  items={d['items']:>6,}  tins={d['tins']:>10,.0f}")

    # Compute the new watermark — max modified_date across imported orders.
    max_mod = max((o["modified_date"] for o in orders.values() if o["modified_date"]), default=None)
    print(f"\n   New cron watermark target: {max_mod}")

    # ── Build SQL ─────────────────────────────────────────────────────────
    print(f"\n🛠  Building SQL file: {TMP_SQL}")
    with open(TMP_SQL, "w") as out:
        out.write("-- CIN7 CSV bulk import\n")
        out.write(f"-- Generated: {datetime.utcnow().isoformat()}Z\n")
        out.write(f"-- Source: {csv_path}\n")
        out.write(f"-- Orders: {len(orders)}, items: {sum(len(v) for v in items.values())}\n\n")

        # ── Orders (INSERT OR REPLACE, batched multi-row VALUES) ──────────
        out.write("-- ─── Orders ────────────────────────────────────────────\n")
        order_cols = [
            "id", "reference", "market", "status", "channel_attr",
            "company", "first_name", "last_name", "member_id", "member_email",
            "total", "sub_total", "product_total",
            "created_date", "modified_date", "raw_json",
        ]
        order_list = sorted(orders.values(), key=lambda o: o["id"])
        NUMERIC_ORDER_COLS = {"id", "member_id", "total", "sub_total", "product_total"}
        for batch_start in range(0, len(order_list), ORDERS_PER_INSERT):
            batch = order_list[batch_start:batch_start + ORDERS_PER_INSERT]
            out.write(f"INSERT OR REPLACE INTO cin7_sales_orders ({', '.join(order_cols)}) VALUES\n")
            value_rows = []
            for o in batch:
                cells = []
                for c in order_cols:
                    v = o[c]
                    if c in NUMERIC_ORDER_COLS:
                        cells.append(str(v) if v is not None else "NULL")
                    else:
                        cells.append(sql_str(v))
                value_rows.append("(" + ", ".join(cells) + ")")
            out.write(",\n".join(value_rows))
            out.write(";\n\n")

        # ── Items: DELETE existing per-order, then bulk INSERT ────────────
        out.write("-- ─── Items: clear existing per-order ──────────────────\n")
        all_order_ids = sorted(orders.keys())
        for batch_start in range(0, len(all_order_ids), DELETE_IDS_PER_STATEMENT):
            batch_ids = all_order_ids[batch_start:batch_start + DELETE_IDS_PER_STATEMENT]
            out.write(
                "DELETE FROM cin7_sales_order_items WHERE order_id IN ("
                + ", ".join(str(i) for i in batch_ids)
                + ");\n"
            )
        out.write("\n")

        out.write("-- ─── Items: bulk INSERT ───────────────────────────────\n")
        item_cols = [
            "order_id", "market", "parent_id", "code", "base_sku", "multiplier",
            "uom_size", "qty", "unit_price", "total", "name",
            "is_au_sku", "tins", "created_date",
        ]
        # Flatten + chunk
        all_items = [li for oid in sorted(items.keys()) for li in items[oid]]
        for batch_start in range(0, len(all_items), ITEMS_PER_INSERT):
            batch = all_items[batch_start:batch_start + ITEMS_PER_INSERT]
            out.write(f"INSERT INTO cin7_sales_order_items ({', '.join(item_cols)}) VALUES\n")
            value_rows = []
            for li in batch:
                cells = []
                for c in item_cols:
                    v = li[c]
                    if c in ("order_id", "parent_id", "multiplier", "uom_size", "is_au_sku"):
                        cells.append(str(int(v) if v is not None else 0))
                    elif c in ("qty", "unit_price", "total", "tins"):
                        cells.append(str(v) if v is not None else "NULL")
                    else:
                        cells.append(sql_str(v))
                value_rows.append("(" + ", ".join(cells) + ")")
            out.write(",\n".join(value_rows))
            out.write(";\n\n")

        # ── Cron watermark reset ──────────────────────────────────────────
        if max_mod:
            out.write("-- ─── Reset cron watermark to MAX(modified_date) of imported orders ─\n")
            out.write(
                f"UPDATE sync_state SET watermark = '{max_mod}', watermark_id = 0 "
                f"WHERE source = 'cin7_sales_orders' AND market = 'AU';\n"
            )

    sql_size = os.path.getsize(TMP_SQL)
    print(f"   SQL file size: {sql_size:,} bytes")
    if sql_size > 50 * 1024 * 1024:
        print(f"   ⚠️  Exceeds D1's 50 MB per-file limit. Need to chunk.")
        return 2

    if dry_run:
        print(f"\n🧪 --dry-run: SQL file written, NOT executing wrangler.")
        print(f"   Inspect: {TMP_SQL}")
        return 0

    # ── Run wrangler ──────────────────────────────────────────────────────
    print(f"\n🚀 Running: npx wrangler d1 execute {D1_DATABASE} --remote --file={TMP_SQL}")
    print(f"   (this may prompt for browser authentication on first use)\n")

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    result = subprocess.run(
        ["npx", "wrangler", "d1", "execute", D1_DATABASE, "--remote", f"--file={TMP_SQL}"],
        cwd=repo_root,
    )

    if result.returncode != 0:
        print(f"\n❌ wrangler exited with code {result.returncode}", file=sys.stderr)
        print(f"   SQL preserved at: {TMP_SQL}", file=sys.stderr)
        return result.returncode

    print(f"\n✅ Import complete.")
    print(f"   Cron watermark advanced to: {max_mod}")
    print(f"   Next: ship v2.2.10 (simplified cron — drop composite cursor)")
    print(f"   Then: verify with check-cin7-sync.command + verify-cin7-import.command")
    return 0


if __name__ == "__main__":
    sys.exit(main())
