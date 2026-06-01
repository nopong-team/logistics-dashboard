/* ════════════════════════════════════════════════════════════════════════
   11th Birthday launch tab (v2.2.21) — countdown + live Woo/ShipStation.
   Auto-refresh cadence: 2 min for the first 10 min after each drop hour,
   then 5 min until the next drop. Tab-visibility-aware (pauses when hidden).
   ════════════════════════════════════════════════════════════════════════ */
let _bdayLastPayload = null;
let _bdayRefreshTimer = null;
let _bdayCountdownTimer = null;
let _bdayChart = null;
// v2.2.26 — per-SKU previous stock for sell-out transition detection.
// `undefined` = not seen yet (first load — don't trigger on initial state).
const _bdayPrevStock = { soap: undefined, tin: undefined };

function bdayOnTabActivate() {
  _bdayLoadConfettiLib();  // kick off CDN load early so it's ready by sell-out time
  bdayLoad(); // fire immediately
  _scheduleBdayRefresh();
  if (_bdayCountdownTimer) clearInterval(_bdayCountdownTimer);
  _bdayCountdownTimer = setInterval(_bdayUpdateCountdown, 1000);
}

/**
 * Lazy-load canvas-confetti from jsdelivr the first time the bday tab is
 * activated. ~5KB minified, used only for sell-out celebrations. Becomes
 * available as `window.confetti(opts)` once loaded. If the load fails
 * (offline / CDN down / CSP), the sell-out banner still renders without
 * particles — graceful degrade.
 */
function _bdayLoadConfettiLib() {
  if (window.confetti || document.getElementById('bday-confetti-script')) return;
  const s = document.createElement('script');
  s.id = 'bday-confetti-script';
  s.src = 'https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js';
  s.async = true;
  document.head.appendChild(s);
}

function bdayOnTabDeactivate() {
  if (_bdayRefreshTimer)  { clearTimeout(_bdayRefreshTimer); _bdayRefreshTimer = null; }
  if (_bdayCountdownTimer){ clearInterval(_bdayCountdownTimer); _bdayCountdownTimer = null; }
}

/**
 * Compute next-refresh interval in ms based on current Sydney-local
 * minutes-past-hour:
 *   minutes 0–9   → 2 min cadence (capture the post-drop surge)
 *   minutes 10–59 → 5 min cadence (steady state)
 * This is intentionally stateless — derive from the wall clock so a missed
 * tick doesn't break the schedule.
 */
function _bdayNextRefreshMs() {
  const sydneyMin = _bdaySydneyMinutePastHour();
  return (sydneyMin < 10) ? (2 * 60 * 1000) : (5 * 60 * 1000);
}

function _bdaySydneyMinutePastHour() {
  // Use the last payload's tz offset if we've got one (most accurate); else
  // probe with Intl, falling back to a fixed +10:00.
  let offMin = 600;
  if (_bdayLastPayload?.sydney_now?.tz_offset_minutes != null) {
    offMin = _bdayLastPayload.sydney_now.tz_offset_minutes;
  } else {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone:'Australia/Sydney', timeZoneName:'shortOffset' });
      const tz = fmt.formatToParts(new Date()).find(p => p.type==='timeZoneName')?.value;
      const m = tz?.match(/GMT([+-])(\d+)(?::(\d+))?/);
      if (m) offMin = (m[1]==='+'?1:-1) * (parseInt(m[2],10)*60 + parseInt(m[3]||'0',10));
    } catch(_){}
  }
  const shifted = new Date(Date.now() + offMin*60*1000);
  return shifted.getUTCMinutes();
}

function _scheduleBdayRefresh() {
  if (_bdayRefreshTimer) clearTimeout(_bdayRefreshTimer);
  const ms = _bdayNextRefreshMs();
  const lbl = document.getElementById('bday-refresh-cadence');
  if (lbl) lbl.textContent = (ms === 120000) ? '2 min' : '5 min';
  _bdayRefreshTimer = setTimeout(() => {
    bdayLoad().finally(_scheduleBdayRefresh);
  }, ms);
}

function bdayRefreshNow() {
  const btn = document.getElementById('bday-refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
  bdayLoad({ force: true }).finally(() => {
    if (btn) { btn.disabled = false; btn.textContent = 'Refresh now'; }
    _scheduleBdayRefresh();
  });
}

async function bdayLoad({ force = false } = {}) {
  try {
    const url = '/api/au/birthday-launch' + (force ? '?refresh=1' : '');
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error + (data.detail ? `: ${data.detail}` : ''));
    _bdayLastPayload = data;
    _bdayRender(data);
    _hideBdayError();
  } catch (e) {
    _showBdayError(e.message || String(e));
  }
}

function _showBdayError(msg) {
  const box = document.getElementById('bday-error-box');
  if (box) box.innerHTML = `<div class="bday-error">⚠️ Couldn't fetch launch data: ${_bdayEscape(msg)}</div>`;
}
function _hideBdayError() {
  const box = document.getElementById('bday-error-box');
  if (box) box.innerHTML = '';
}

function _bdayEscape(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function _bdayFmt(n) {
  if (n === null || n === undefined) return '--';
  return Number(n).toLocaleString();
}

function _bdayRenderStockLine(elId, quantity, manageStock, productLabel) {
  // Render the blue stock readout below the value, and report the
  // numeric state so the caller can drive the transition tracker.
  // States:
  //   manage_stock === false     → "Stock: not tracked" (grey, no confetti)
  //   manage_stock + quantity null → "Stock: ?" (grey, no confetti)
  //   quantity > 0               → "Stock left: N" (blue)
  //   quantity === 0             → "SOLD OUT" (red, pulsing)
  const el = document.getElementById(elId);
  if (!el) return null;
  el.classList.remove('sold-out', 'unmanaged');
  if (!manageStock) {
    el.textContent = `Stock: not tracked in Woo`;
    el.classList.add('unmanaged');
    return null;
  }
  if (quantity === null || quantity === undefined) {
    el.textContent = `Stock: —`;
    el.classList.add('unmanaged');
    return null;
  }
  const q = Number(quantity);
  if (q <= 0) {
    el.textContent = `🎉 SOLD OUT 🎉`;
    el.classList.add('sold-out');
    return 0;
  }
  el.textContent = `Stock left: ${_bdayFmt(q)}`;
  return q;
}

function _bdayCheckSellOutTransition(skuKey, currentStock, displayName) {
  // Fire confetti + banner when stock goes from positive to zero. Skip on
  // first-ever load (prev === undefined) so we don't celebrate a product
  // that was already at 0 when the tab opened.
  const prev = _bdayPrevStock[skuKey];
  if (prev !== undefined && prev !== null && prev > 0 && currentStock === 0) {
    _bdayCelebrateSellOut(displayName, skuKey === 'tin');
  }
  // Persist current as the new previous. null (untracked) overwrites prev
  // intentionally — if stock management is toggled off mid-launch, the next
  // toggle-on shouldn't auto-fire.
  _bdayPrevStock[skuKey] = currentStock;
}

function _bdayCelebrateSellOut(productName, isSecond) {
  // 1. Drop the centred banner.
  const banner = document.createElement('div');
  banner.className = 'bday-sellout-banner' + (isSecond ? ' second' : '');
  banner.textContent = `🎉 ${productName} SOLD OUT! 🎉`;
  document.body.appendChild(banner);
  setTimeout(() => banner.classList.add('fade-out'), 14000);
  setTimeout(() => banner.remove(), 15500);

  // 2. Fire confetti from both bottom corners for 15s. Burst rate is
  // intentionally modest so the warehouse TV doesn't melt.
  const duration = 15 * 1000;
  const end = Date.now() + duration;
  const colours = ['#FF578A', '#FF8FB3', '#FFD700', '#7B5DD3', '#1976D2', '#fff'];
  function frame() {
    if (typeof window.confetti !== 'function') return;  // CDN didn't load — silent skip
    window.confetti({ particleCount: 5, angle: 60,  spread: 60, origin: { x: 0, y: 0.8 }, colors: colours });
    window.confetti({ particleCount: 5, angle: 120, spread: 60, origin: { x: 1, y: 0.8 }, colors: colours });
    if (Date.now() < end) requestAnimationFrame(frame);
  }
  frame();
}

/* ════════════════════════════════════════════════════════════════════════
   Order-count milestones (v2.2.29) — Fires a 15-second celebration when
   total_orders_today crosses each of 500 / 1,000 / 1,500 / 1,733 for the
   first time today. Per-day localStorage persistence so a browser reload
   mid-day doesn't re-fire a celebration that already happened.
   ════════════════════════════════════════════════════════════════════════ */
let _bdayPrevOrderCount = undefined;  // undefined = first load, don't auto-fire

const _BDAY_MILESTONES = [
  {
    threshold: 500,
    klass: 'fire',
    emoji: '🔥',
    sweepClass: '',
    text: '🔥 500 ORDERS — YOU’RE ON FIRE! 🔥',
    confettiColours: ['#FF4500', '#FFA500', '#FFD700', '#FF6347', '#fff'],
  },
  {
    threshold: 1000,
    klass: 'hammer',
    emoji: '🔨',
    sweepClass: 'hammer-anim',
    text: '🔨 OVER 1,000 ORDERS — YOU’RE NAILING IT! 🔨',
    confettiColours: ['#7B5DD3', '#A78BFA', '#FFD700', '#fff', '#C0C0C0'],
  },
  {
    threshold: 1500,
    klass: 'lightning',
    emoji: '⚡',
    sweepClass: 'lightning-anim',
    text: '⚡ 1,500 ORDERS — YOU’RE ELECTRIFYING! ⚡',
    confettiColours: ['#FFD700', '#1E90FF', '#4B0082', '#fff', '#00FFFF'],
  },
  {
    threshold: 1733,
    klass: 'bullseye',
    emoji: '🎯',
    sweepClass: 'bullseye-anim',
    text: '🎯 OVER 1,733 ORDERS — YOU’VE HIT THE BULL’S-EYE! 🎯',
    confettiColours: ['#FF1744', '#FFD700', '#FF578A', '#fff', '#FFA500'],
  },
  {
    threshold: 2100,
    klass: 'mic-drop',
    emoji: '🎤',
    sweepClass: 'mic-drop-anim',
    text: '🎤 2,100 ORDERS — MIC DROP! 🎤',
    confettiColours: ['#4B0082', '#7B5DD3', '#FFD700', '#fff', '#2E0854'],
  },
  {
    threshold: 2500,
    klass: 'rocket',
    emoji: '🚀',
    sweepClass: 'rocket-anim',
    text: '🚀 2,500 ORDERS — WE’RE ROCKETING! 🚀',
    confettiColours: ['#FF578A', '#FFD700', '#1E90FF', '#fff', '#FF8FB3'],
  },
];

/**
 * Returns the date key used for the milestone-fired localStorage flag.
 * Use Sydney-local date (from the payload's tz_offset_minutes if available,
 * else the wall clock) so the flag resets at Sydney midnight. Otherwise a
 * dashboard opened just before midnight UTC would forget yesterday's fires.
 */
function _bdayMilestoneDateKey() {
  let offMin = 600;
  if (_bdayLastPayload?.sydney_now?.tz_offset_minutes != null) {
    offMin = _bdayLastPayload.sydney_now.tz_offset_minutes;
  }
  const shifted = new Date(Date.now() + offMin * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `bday-milestones-fired-${y}-${m}-${d}`;
}

function _bdayLoadFiredMilestones() {
  try {
    const raw = localStorage.getItem(_bdayMilestoneDateKey());
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function _bdaySaveFiredMilestone(threshold) {
  try {
    const key = _bdayMilestoneDateKey();
    const fired = _bdayLoadFiredMilestones();
    fired[String(threshold)] = true;
    localStorage.setItem(key, JSON.stringify(fired));
  } catch (_) { /* silent — celebration still fires, just won't persist across reloads */ }
}

function _bdayCheckMilestoneTransitions(currentCount) {
  if (typeof currentCount !== 'number' || !Number.isFinite(currentCount)) return;

  const prev = _bdayPrevOrderCount;
  const fired = _bdayLoadFiredMilestones();

  // First load: just record state, don't auto-celebrate. Same logic as
  // the sell-out detector — opening the tab partway through a launch
  // shouldn't fire all the milestones we've already crossed.
  if (prev === undefined) {
    _bdayPrevOrderCount = currentCount;
    // Also mark any already-crossed thresholds as fired today, so we
    // never accidentally fire them later in the day (e.g. after a
    // browser reload). This persists the "we've already passed this"
    // signal even if localStorage was empty before.
    for (const m of _BDAY_MILESTONES) {
      if (currentCount >= m.threshold && !fired[String(m.threshold)]) {
        _bdaySaveFiredMilestone(m.threshold);
      }
    }
    return;
  }

  // Walk thresholds low-to-high. Fire each one that we've crossed AND
  // haven't already fired today. If multiple cross in a single tick
  // (massive surge between refreshes), only the highest fires — keeps
  // the screen sane.
  let toFire = null;
  for (const m of _BDAY_MILESTONES) {
    const crossed = prev < m.threshold && currentCount >= m.threshold;
    const alreadyFired = !!fired[String(m.threshold)];
    if (crossed && !alreadyFired) {
      toFire = m;  // keep the latest match — highest threshold wins
    } else if (currentCount >= m.threshold && !alreadyFired) {
      // Edge case: count is past threshold but prev wasn't < threshold
      // (e.g. a refill or correction). Mark as fired so we don't fire
      // later when prev finally < threshold (which shouldn't happen,
      // but defence in depth).
      _bdaySaveFiredMilestone(m.threshold);
    }
  }
  if (toFire) {
    _bdayCelebrateMilestone(toFire);
    _bdaySaveFiredMilestone(toFire.threshold);
  }
  _bdayPrevOrderCount = currentCount;
}

function _bdayCelebrateMilestone(milestone) {
  // 1. Centred banner — bounce in, fade out at 14s, remove at 15.5s
  const banner = document.createElement('div');
  banner.className = `bday-milestone-banner ${milestone.klass}`;
  banner.textContent = milestone.text;
  document.body.appendChild(banner);
  setTimeout(() => banner.classList.add('fade-out'), 14000);
  setTimeout(() => banner.remove(), 15500);

  // 2. Giant emoji sweeping across the screen (loops for 15s)
  const sweep = document.createElement('div');
  sweep.className = `bday-milestone-sweep ${milestone.sweepClass}`.trim();
  sweep.textContent = milestone.emoji;
  document.body.appendChild(sweep);
  setTimeout(() => sweep.remove(), 15000);

  // 3. Themed confetti from both bottom corners for 15s (reuses the
  // already-loaded canvas-confetti library)
  const duration = 15 * 1000;
  const end = Date.now() + duration;
  const colours = milestone.confettiColours;
  function frame() {
    if (typeof window.confetti !== 'function') return;
    window.confetti({ particleCount: 5, angle: 60,  spread: 60, origin: { x: 0, y: 0.8 }, colors: colours });
    window.confetti({ particleCount: 5, angle: 120, spread: 60, origin: { x: 1, y: 0.8 }, colors: colours });
    if (Date.now() < end) requestAnimationFrame(frame);
  }
  frame();
}

function _bdaySetProductImg(imgId, url) {
  const img = document.getElementById(imgId);
  if (!img) return;
  if (url && typeof url === 'string') {
    img.src = url;
    img.classList.remove('empty');
    // If the image fails to load (404, CORS, etc.), fall back to the empty
    // placeholder rather than showing a broken-image icon.
    img.onerror = () => {
      img.removeAttribute('src');
      img.classList.add('empty');
      img.onerror = null;
    };
  } else {
    img.removeAttribute('src');
    img.classList.add('empty');
  }
}

function _bdayRenderAlertCard({ boxId, countId, listId, connected, error, count, summaries, emptyMsg, rowFor }) {
  const box   = document.getElementById(boxId);
  const countEl = document.getElementById(countId);
  const listEl  = document.getElementById(listId);
  if (!box || !countEl || !listEl) return;
  if (!connected) {
    countEl.textContent = '—';
    listEl.innerHTML = `<div style="font-size:12px;color:var(--text-secondary);font-style:italic;">
      ShipStation not connected${error ? ': ' + _bdayEscape(error) : ''}
    </div>`;
    box.classList.add('bday-disconnected');
    return;
  }
  box.classList.remove('bday-disconnected');
  countEl.textContent = _bdayFmt(count);
  if (!summaries || summaries.length === 0) {
    listEl.innerHTML = `<div style="font-size:12px;color:var(--text-secondary);">${emptyMsg}</div>`;
    return;
  }
  const rows = summaries.slice(0, 20).map(s => `<div class="bday-alert-row">${rowFor(s)}</div>`).join('');
  const more = summaries.length > 20 ? `<div class="bday-alert-row" style="opacity:0.7;">+${summaries.length - 20} more…</div>` : '';
  listEl.innerHTML = rows + more;
}

function _bdayRender(data) {
  // Hero — next drop time (strip the date prefix for the hero, keep just time)
  const dropLocal = data.drop?.next_drop_local || '';
  document.getElementById('bday-next-drop-time').textContent =
    dropLocal ? dropLocal.replace(/^\d{4}-\d{2}-\d{2} /, '') : '--';
  document.getElementById('bday-open-orders-big').textContent =
    data.shipstation?.connected ? _bdayFmt(data.shipstation.openOrders) : '—';
  const openSub = document.getElementById('bday-open-orders-sub');
  if (openSub) openSub.textContent = data.shipstation?.connected ? 'awaiting shipment' : 'ShipStation not connected';

  // Woo cards
  document.getElementById('bday-woo-total-orders').textContent  = _bdayFmt(data.woo?.total_orders_today);
  document.getElementById('bday-woo-launch-orders').textContent = _bdayFmt(data.woo?.orders_with_launch_products);
  document.getElementById('bday-soap-lifetime').textContent     = _bdayFmt(data.woo?.soap_units_lifetime);
  document.getElementById('bday-tin-today').textContent         = _bdayFmt(data.woo?.tin_units_today);
  if (data.woo?.soap_units_today != null) {
    document.getElementById('bday-soap-sub').textContent =
      `${data.woo.soap_sku} · all-time sold · ${_bdayFmt(data.woo.soap_units_today)} today`;
  }

  // ShipStation cards — dim ALL .bday-card--ss cards if disconnected by
  // toggling a class on the panel root (CSS does the rest). v2.2.25 dropped
  // the bday-ss-cards wrapper because the new TV layout flattens all KPI
  // cards into a single grid row.
  const panel = document.getElementById('tab-au-birthday');
  const ssConnected = !!data.shipstation?.connected;
  if (panel) panel.classList.toggle('bday-ss-down', !ssConnected);
  document.getElementById('bday-ss-open').textContent           = ssConnected ? _bdayFmt(data.shipstation.openOrders) : '—';
  document.getElementById('bday-ss-shipped-orders').textContent = ssConnected ? _bdayFmt(data.shipstation.shippedTodayOrders) : '—';
  document.getElementById('bday-ss-shipped-items').textContent  = ssConnected ? _bdayFmt(data.shipstation.shippedTodayItems)  : '—';

  // Product images — pulled live from Woo's /products?sku=... response (the
  // first item's images[0].src). Falls back to the pink-gradient placeholder
  // when the image URL is missing or the SKU doesn't exist yet.
  _bdaySetProductImg('bday-soap-img', data.woo?.soap_image_url);
  _bdaySetProductImg('bday-tin-img',  data.woo?.tin_image_url);

  // Stock readouts (v2.2.26) — blue line below the value. Returns the
  // numeric stock for the transition tracker, or null when untracked.
  const soapStock = _bdayRenderStockLine('bday-soap-stock', data.woo?.soap_stock_quantity, data.woo?.soap_manage_stock, 'Soap');
  const tinStock  = _bdayRenderStockLine('bday-tin-stock',  data.woo?.tin_stock_quantity,  data.woo?.tin_manage_stock,  'Tin');
  // Sell-out detection. Fires confetti + banner on the >0 → 0 transition.
  // Tin first so soap (if also dropping) renders as the second banner.
  _bdayCheckSellOutTransition('tin',  tinStock,  '11TH BIRTHDAY TIN');
  _bdayCheckSellOutTransition('soap', soapStock, 'BIRTHDAY SOAP');
  // Order-count milestones (v2.2.29) — fires 500 / 1000 / 1500 / 1733
  // celebrations off the All-orders-today counter. Independent of sell-out.
  _bdayCheckMilestoneTransitions(data.woo?.total_orders_today);

  // Alert cards — Express/Intl (left) and Wholesale (right). One helper
  // function handles both; per-card differences are passed in as args.
  _bdayRenderAlertCard({
    boxId: 'bday-alert-box',
    countId: 'bday-alert-count',
    listId: 'bday-alert-list',
    connected: ssConnected,
    error: data.shipstation?.error,
    count: data.shipstation?.expressIntlOpen,
    summaries: data.shipstation?.expressIntlOpenOrders || [],
    emptyMsg: 'No express or international open orders 🎉',
    rowFor: (s) => {
      const pills = (s.flags || []).map(f => `<span class="bday-pill ${f.toLowerCase()}">${f}</span>`).join('');
      const country = s.ship_to_country ? ` · ${_bdayEscape(s.ship_to_country)}` : '';
      const service = s.service ? ` · ${_bdayEscape(s.service)}` : '';
      return `${pills}<strong>#${_bdayEscape(s.order_number || '?')}</strong>${country}${service}`;
    },
  });
  _bdayRenderAlertCard({
    boxId: 'bday-alert-wholesale-box',
    countId: 'bday-alert-wholesale-count',
    listId: 'bday-alert-wholesale-list',
    connected: ssConnected,
    error: data.shipstation?.error,
    count: data.shipstation?.wholesaleOpen,
    summaries: data.shipstation?.wholesaleOpenOrders || [],
    emptyMsg: 'No wholesale open orders 🎉',
    rowFor: (s) => {
      const wsPill = `<span class="bday-pill wholesale">WHOLESALE</span>`;
      const skuPills = (s.wholesale_skus || []).slice(0, 3).map(k => `<span class="bday-pill sku">${_bdayEscape(k)}</span>`).join('');
      const extra = (s.wholesale_skus || []).length > 3 ? `<span class="bday-pill sku">+${s.wholesale_skus.length - 3}</span>` : '';
      const service = s.service ? ` · ${_bdayEscape(s.service)}` : '';
      return `${wsPill}${skuPills}${extra}<strong style="margin-left:4px;">#${_bdayEscape(s.order_number || '?')}</strong>${service}`;
    },
  });

  // Orders-per-hour chart
  _bdayRenderHourlyChart(data.woo?.orders_per_hour || []);

  // Meta bar
  const updated = data.generated_at_iso ? new Date(data.generated_at_iso) : new Date();
  document.getElementById('bday-last-updated').textContent =
    `Last updated: ${updated.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })}` +
    (data.cached ? ' (cached)' : '');

  // Kick the countdown once immediately so it reflects the new data.
  _bdayUpdateCountdown();
}

function _bdayUpdateCountdown() {
  const el = document.getElementById('bday-countdown');
  if (!el) return;
  if (!_bdayLastPayload?.drop?.next_drop_at_iso) { el.textContent = '--:--'; return; }
  const next = new Date(_bdayLastPayload.drop.next_drop_at_iso).getTime();
  const diff = Math.max(0, next - Date.now());
  if (diff === 0) { el.textContent = '00:00'; return; }
  const hh = Math.floor(diff / 3600000);
  const mm = Math.floor((diff % 3600000) / 60000);
  const ss = Math.floor((diff % 60000) / 1000);
  const pad = n => String(n).padStart(2, '0');
  el.textContent = hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

function _bdayRenderHourlyChart(hourlyBuckets) {
  const canvas = document.getElementById('bdayHourlyChart');
  if (!canvas || typeof Chart === 'undefined') return;
  // Narrow to the launch window — 7am through 7pm AEST (12 bars: hours
  // 7,8,...,18). Pre-7am and post-7pm orders still count toward
  // total_orders_today on the card; this chart is the launch-window view.
  // Backend still returns the full 24-bucket payload so we can widen the
  // window later without a Worker redeploy.
  const launchBuckets = hourlyBuckets.filter(b => b.hour >= 7 && b.hour <= 18);
  // Hour label formatter — "7am, 8am, 12pm, 1pm, 6pm" reads better than 7:00.
  const fmtHour = (h) => {
    if (h === 0)  return '12am';
    if (h === 12) return '12pm';
    return h < 12 ? `${h}am` : `${h - 12}pm`;
  };
  const labels = launchBuckets.map(b => fmtHour(b.hour));
  const data   = launchBuckets.map(b => b.count);
  // Drops happen 7am–5pm (hour 7 through hour 17 inclusive — bar 17 captures
  // 5–6pm orders, which is the last drop's window). Bar 18 (6–7pm) is the
  // post-drop tail and shows in grey.
  const colours = launchBuckets.map(b => (b.hour >= 7 && b.hour <= 17) ? '#FF578A' : '#D0D0D0');
  if (_bdayChart) {
    _bdayChart.data.labels = labels;
    _bdayChart.data.datasets[0].data = data;
    _bdayChart.data.datasets[0].backgroundColor = colours;
    _bdayChart.update();
    return;
  }
  _bdayChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Orders', data, backgroundColor: colours, borderWidth: 0, borderRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: ctx => `${ctx[0].label} AEST`, label: ctx => `${ctx.parsed.y} orders` } },
      },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#F0F0F0' } },
        x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0, font: { size: 10 } } },
      },
    },
  });
}
