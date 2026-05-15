#!/usr/bin/env python3
"""
Apply the preserved Woo AU import SQL to prod D1 in chunks, using wrangler's
`--command` path instead of `--file` (which routes to D1's /import API
endpoint and rejects OAuth tokens — see 2026-05-13 CIN7 import failure for
the diagnosis).

Reads `scripts/.tmp-woo-au-import.sql` (produced by import-woo-au-csv.py in
its previous run), splits it into logical statements at `;\\n` boundaries
that fall OUTSIDE string literals, strips comments + blank lines, and pushes
each statement via:

    npx wrangler d1 execute logistics-db --remote --command="<stmt>"

For the AU Woo backfill this is ~600 statements (a few hundred order
INSERTs, a few hundred item INSERTs, ~70 DELETEs, one watermark UPDATE).
Each wrangler call is 200–500 ms, so the full run is ~5–10 minutes. Each
statement is fully idempotent (INSERT OR REPLACE on orders + DELETE-then-
INSERT scoped per order_id on items + idempotent watermark UPDATE), so
re-running on failure resumes safely from the start.

Same script shape as scripts/apply-cin7-import-chunked.py — kept as a
separate file (different .tmp-*.sql source path) so the two imports can run
back-to-back without colliding. The polish-backlog item to refactor both
importers into one chunked applier covers the consolidation.

Usage:
    python3 scripts/apply-woo-au-import-chunked.py [--dry-run]
"""
import os
import subprocess
import sys

TMP_SQL = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".tmp-woo-au-import.sql")
D1_DATABASE = "logistics-db"


def split_statements(sql: str) -> list[str]:
    """Split SQL into individual statements, respecting single-quote string literals.

    SQLite/D1 uses `''` to escape a single quote inside a literal, so toggling
    on every unescaped `'` is sufficient. We only split on `;` that appears
    outside any string literal.
    """
    statements: list[str] = []
    buf: list[str] = []
    in_string = False
    i = 0
    while i < len(sql):
        ch = sql[i]
        if ch == "'":
            # Look ahead: '' is an escaped quote (still inside the string)
            if in_string and i + 1 < len(sql) and sql[i + 1] == "'":
                buf.append("''")
                i += 2
                continue
            in_string = not in_string
            buf.append(ch)
        elif ch == ";" and not in_string:
            stmt = "".join(buf).strip()
            if stmt:
                statements.append(stmt)
            buf = []
        else:
            buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        statements.append(tail)
    return statements


def strip_sql_comments(stmt: str) -> str:
    """Remove leading -- comment lines and blank lines from a statement."""
    out_lines = []
    in_leading_block = True
    for line in stmt.splitlines():
        stripped = line.strip()
        if in_leading_block:
            if stripped == "" or stripped.startswith("--"):
                continue
            in_leading_block = False
        out_lines.append(line)
    while out_lines and not out_lines[-1].strip():
        out_lines.pop()
    return "\n".join(out_lines).strip()


def label_for(stmt: str) -> str:
    """Short human label for a SQL statement, for progress logging."""
    head = stmt.lstrip().split("\n", 1)[0][:60]
    return head + ("…" if len(stmt) > 60 else "")


def run_one(stmt: str, repo_root: str) -> int:
    result = subprocess.run(
        [
            "npx", "wrangler", "d1", "execute", D1_DATABASE,
            "--remote", f"--command={stmt}",
        ],
        cwd=repo_root,
    )
    return result.returncode


def main() -> int:
    dry_run = "--dry-run" in sys.argv

    if not os.path.exists(TMP_SQL):
        print(f"❌ Preserved SQL not found: {TMP_SQL}", file=sys.stderr)
        print("   Re-run scripts/import-woo-au-csv.py first to generate it.", file=sys.stderr)
        return 2

    with open(TMP_SQL, "r", encoding="utf-8") as f:
        raw = f.read()

    raw_statements = split_statements(raw)
    statements = [s for s in (strip_sql_comments(s) for s in raw_statements) if s]

    print("================================================================")
    print(f"  Woo AU import — chunked --command apply")
    print("================================================================")
    print(f"  SQL file:    {TMP_SQL}")
    print(f"  Total size:  {len(raw):,} bytes ({len(raw) / (1024*1024):.1f} MB)")
    print(f"  Statements:  {len(statements)}")
    print()
    # For long runs print just a head + tail preview so the log isn't 1000 lines.
    preview_n = 8
    if len(statements) <= preview_n * 2:
        for i, s in enumerate(statements, 1):
            print(f"  [{i}/{len(statements)}] {len(s):>7,} bytes — {label_for(s)}")
    else:
        for i in range(preview_n):
            s = statements[i]
            print(f"  [{i+1}/{len(statements)}] {len(s):>7,} bytes — {label_for(s)}")
        print(f"  …{len(statements) - preview_n * 2} statements omitted from preview…")
        for i in range(len(statements) - preview_n, len(statements)):
            s = statements[i]
            print(f"  [{i+1}/{len(statements)}] {len(s):>7,} bytes — {label_for(s)}")
    print()

    if dry_run:
        print("🧪 --dry-run: not executing wrangler.")
        return 0

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    for i, stmt in enumerate(statements, 1):
        print(f"\n🚀 [{i}/{len(statements)}] Running: {label_for(stmt)}")
        rc = run_one(stmt, repo_root)
        if rc != 0:
            print(f"\n❌ Statement {i} failed with exit code {rc}.", file=sys.stderr)
            print(f"   SQL preserved at: {TMP_SQL}", file=sys.stderr)
            print(
                f"   Re-running the script will retry from the start; INSERT OR REPLACE\n"
                f"   + DELETE-then-INSERT make this safe.",
                file=sys.stderr,
            )
            return rc

    print()
    print("✅ All statements applied.")
    print("   Cron watermark advanced as part of the final UPDATE.")
    print("   Next: run Commands/verify-woo-au-import.command to confirm row counts.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
