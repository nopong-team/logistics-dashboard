# 11th Birthday Launch Tab — archived 2026-06-01

The 11th Birthday tab was a real-time launch-day dashboard for the
21 May 2026 product drop (birthday soap `AU-BD-NPS-100` + birthday tin
`AU-BD-NBF-35`). It was live on the AU dashboard from v2.2.21 through
v2.2.45, then removed in **v2.2.46** because the launch was over and
the polling (live Woo REST + ShipStation every 2-5 min) was running
unnecessarily.

Archived per Melanie 2026-06-01: *"I kind of like the setup — save the
details somewhere in the folder, then take it off the dashboard
because I don't want it pulling data unnecessarily."*

## What was on it

A TV-fit single-page view (1920×1080, no scroll) showing:

- **Countdown to the next hourly drop** + drop time stamp.
- **Open ShipStation queue** as the hero stat.
- **Per-channel KPI cards** with launch-product imagery and live stock:
  - Woo total orders today + orders containing launch products.
  - Soap units sold lifetime (stock-tracker mode — soap soft-launched
    the night before tins, so today-only would miss early sales).
  - Tin units sold today.
  - ShipStation open / shipped today (orders + items) / express+intl /
    wholesale.
- **Hourly chart** of orders-per-hour for the launch day (Chart.js).
- **Alert cards** — express/intl + wholesale orders still open, with
  per-row SKU pills.
- **Sell-out celebration** — confetti burst the moment soap or tin
  stock hits zero (idempotent against page reloads; one fire per
  product per launch).
- **Order-count milestone celebrations** — fire-emoji sweep at 500,
  hammer at 1,000, lightning at 2,500, bullseye at 5,000, mic-drop at
  10,000, rocket at 25,000. Already-passed thresholds get silently
  marked as fired so opening the dashboard mid-day at 1,200 orders
  doesn't fire 500 + 1,000 instantly.

## What's in this archive

| File | What it is |
|---|---|
| `tab-panel.html` | The `<div class="tab-panel" id="tab-au-birthday">` block — HTML structure + all `#tab-au-birthday`-scoped CSS. Drop into `public/index.html` between the Packaging and Logistics tab panels to restore. Original lines 1968-2503. |
| `tab.js` | All `bday*` / `_bday*` JS — countdown, refresh scheduling, render functions, sell-out + milestone detection, hourly chart. Drop into `public/index.html` inside the `<script>` block, right before the Logistics JS block (`/* ════ Logistics tab ... */`). Original lines 7491-8055. |
| `birthday.backend.js` | The `/api/au/birthday` Hono routes — combined Woo (live REST, not D1) + ShipStation snapshot, KV-cached 60s at `au:birthday-launch:v1`. Drop back into `src/birthday.js`. |

## How to re-integrate (next birthday, or a similar launch)

1. Copy the three files back into the repo:
   - `archive/11th-birthday-tab/birthday.backend.js` → `src/birthday.js`
   - `archive/11th-birthday-tab/tab-panel.html` → insert into
     `public/index.html` between the Packaging tab panel and the
     `<!-- ═══════ TAB: LOGISTICS ═══════ -->` comment.
   - `archive/11th-birthday-tab/tab.js` → insert into
     `public/index.html` inside the `<script>` block, right before
     the `/* ════ Logistics tab ... ════ */` comment.

2. Re-add the tab button to the AU tabs row in `public/index.html`
   (between the Packaging and Logistics buttons):

   ```html
   <button class="tab-btn" data-tab="au-birthday" onclick="switchAuTab('au-birthday')"
           style="background:#FF578A;color:#fff;font-weight:700;">🎂 11th Birthday</button>
   ```

3. Re-add the activation hooks inside `switchAuTab(t)` in
   `public/index.html`:

   ```js
   if (t === 'au-birthday' && typeof bdayOnTabActivate === 'function') bdayOnTabActivate();
   if (t !== 'au-birthday' && typeof bdayOnTabDeactivate === 'function') bdayOnTabDeactivate();
   ```

4. Re-add the import + route mount in `src/index.js`:

   ```js
   import { birthdayRoutes } from './birthday.js';
   // ...
   app.route('/api/au', birthdayRoutes);
   ```

5. Update the SKU constants in `src/birthday.js` for whatever the new
   launch product SKUs are — currently hardcoded to `AU-BD-NPS-100`
   (soap) and `AU-BD-NBF-35` (tin), plus the `11th birthday` Woo
   category names.

6. Update the per-drop hourly schedule in `src/birthday.js` if the
   drop cadence differs from the original (hourly drops on the day).

## Why we kept the design

- **TV-fit layout pattern** — `#tab-au-birthday.active { height: 100vh; overflow: hidden; }`
  is the same pattern the Logistics tab inherited. Worth keeping the
  reference.
- **Sell-out + milestone celebration UX** — confetti + sweep animations
  with idempotent fire-once-per-day persistence (`localStorage`-backed
  `_bdayLoadFiredMilestones`). Re-usable for any "moment-based" launch.
- **Live Woo + ShipStation in parallel with KV cache** — the pattern
  for "real-time enough for ops, gentle on rate limits" lives in
  `birthday.backend.js`. The logistics tab uses the same shape.

## Dependencies that stayed in the repo

The backend module imports `buildShipStationSnapshot` from
`src/shipstation.js` and `redactSecrets` from `src/redact.js`. Both
files are still used by `src/logistics.js`, so they stay put.
