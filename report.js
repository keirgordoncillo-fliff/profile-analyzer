/**
 * report.js — controller for the full-page IMS report.
 */

import {
  PROFILE_PATH, TX_PATH, CATEGORIES, TYPE_META, GAME_TYPES,
  DEPOSIT_CURRENCY_IDS, WITHDRAWAL_REQUESTED_CURRENCY_IDS, WITHDRAWAL_PAID_CURRENCY_IDS,
  CASH_CHAIN, CASH_SETTLEMENT_IDS, FC_CHAIN, CONFIDENCE,
  currencyMeta, typeMeta, normalizeAll, applyFilters, aggregate, riskSignals, normalizePlayerId, parseCSV,
  fmtMoney, fmtNum, fmtPct, fmtByKind, isoDate, formatDateTime, daysBetween, toCSV, toNumber,
} from './lib/core.js';
import { fetchProfile, fetchTransactions } from './lib/fetcher.js';
import { barChart, donutChart, columnChart, lineChart, sparkline, heatmap, esc, PALETTE, shortNum, shortMoney } from './lib/charts.js';

/* ================================================================ *
 * State
 * ================================================================ */
const state = {
  userId: null,
  profile: null,
  records: [],
  filtered: [],
  agg: null,
  meta: {},
  filters: { from: '', to: '', search: '', categories: [], types: [], currencies: [], minAmount: '', maxAmount: '' },
  trendGrain: 'day',
  tab: 'summary',
  controller: null,
  tableState: {},
};

let bannerTimer = null;

const $ = (id) => document.getElementById(id);
const qa = (sel) => Array.from(document.querySelectorAll(sel));

const CAT_COLOR = {
  deposit: PALETTE[0], withdrawal_requested: PALETTE[2], withdrawal_paid: PALETTE[3],
  wager: PALETTE[4], settlement_win: PALETTE[1], settlement_loss: PALETTE[9],
  settlement_push: PALETTE[6], settlement_void: PALETTE[7], bonus_claim: PALETTE[2],
  xp_grant: PALETTE[5], xp_redeem: PALETTE[8], reversal: PALETTE[9], manual_admin: PALETTE[9],
  setup: PALETTE[6], other: PALETTE[9],
};

const SB_CASH_CHAIN = [5011, 5012, 5013];
const FAN_CASH_CHAIN = [8011, 8012, 8013];
const TOKEN_WAGER_IDS = [5008, 5005];
const SETTLEMENT_CATS = ['settlement_win', 'settlement_loss', 'settlement_push', 'settlement_void'];
// "Superstars" is Fliff's own name for the Fantasy product — it's what the
// admin's profile panel is labelled, so it's what's shown here.
const PRODUCT_LABEL = { sportsbook: 'Sportsbook', fantasy: 'Superstars', mixed: 'Mixed', unknown: '—' };

/* ================================================================ *
 * Boot
 * ================================================================ */
function init() {
  restoreTheme();
  buildCategoryFilter();
  wireTopbar();
  wireFilters();
  wireTabs();
  setTab(state.tab); // sync the DOM with the default active tab — every .tab
                      // section starts with a static "hidden" class in the
                      // HTML, so without this the Summary panel stays hidden
                      // (despite being rendered) until a tab is clicked once
  renderRecentList();

  const preset = new URLSearchParams(location.search).get('userId');
  if (preset) { $('userIdInput').value = preset; loadPlayer(preset); }
  else $('userIdInput').focus();
}

/* ---------------- Theme ---------------- */
function restoreTheme() {
  const saved = localStorage.getItem('fliff.theme');
  if (saved) document.documentElement.dataset.theme = saved;
  else if (window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('fliff.theme', next);
  if (state.records.length) renderAll();
}

/* ---------------- Recent players ---------------- */
function getRecents() {
  try { return JSON.parse(localStorage.getItem('fliff.recent') || '[]'); } catch { return []; }
}
function pushRecent(userId, label) {
  const list = getRecents().filter((r) => r.id !== String(userId));
  list.unshift({ id: String(userId), label: label || '', at: Date.now() });
  localStorage.setItem('fliff.recent', JSON.stringify(list.slice(0, 12)));
  renderRecentList();
}
function renderRecentList() {
  const list = getRecents();
  const el = $('recentList');
  if (!list.length) { el.innerHTML = '<li class="dd-empty">No recent lookups</li>'; return; }
  el.innerHTML = list.map((r) =>
    `<li><button type="button" data-id="${esc(r.id)}">
       <span>${esc(r.label || r.id)}</span>
       <span class="dd-sub">${esc(r.id)}</span>
     </button></li>`).join('');
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    el.classList.add('hidden');
    $('userIdInput').value = b.dataset.id;
    loadPlayer(b.dataset.id);
  }));
}

/* ---------------- Wiring ---------------- */
function wireTopbar() {
  $('lookupForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('userIdInput').value.trim();
    if (id) loadPlayer(id);
  });
  $('cancelBtn').addEventListener('click', () => { state.controller?.abort(); });
  $('themeBtn').addEventListener('click', toggleTheme);
  $('printBtn').addEventListener('click', () => window.print());
  $('recentBtn').addEventListener('click', (e) => { e.stopPropagation(); $('recentList').classList.toggle('hidden'); });
  document.addEventListener('click', () => $('recentList').classList.add('hidden'));

  // Manual CSV escape hatch — see loadFromCsvFile().
  $('csvImportBtn').addEventListener('click', () => $('csvImportInput').click());
  $('csvImportInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be picked again after a fix
    loadFromCsvFile(file);
  });
}

function buildCategoryFilter() {
  const sel = $('fCategory');
  Object.entries(CATEGORIES).forEach(([k, v]) => {
    const o = document.createElement('option');
    o.value = k; o.textContent = v.label;
    sel.appendChild(o);
  });
}

function wireFilters() {
  const rerun = debounce(() => { readFilters(); applyAndRender(); }, 200);
  ['fFrom', 'fTo', 'fCategory', 'fType', 'fCurrency', 'fMin', 'fMax'].forEach((id) =>
    $(id).addEventListener('change', () => { readFilters(); applyAndRender(); }));
  $('fSearch').addEventListener('input', rerun);

  qa('#rangeSeg button').forEach((b) => b.addEventListener('click', () => {
    qa('#rangeSeg button').forEach((x) => x.classList.toggle('active', x === b));
    applyQuickRange(b.dataset.range);
  }));

  qa('#trendGrain button').forEach((b) => b.addEventListener('click', () => {
    qa('#trendGrain button').forEach((x) => x.classList.toggle('active', x === b));
    state.trendGrain = b.dataset.grain;
    renderSummary();
  }));

  $('resetFilters').addEventListener('click', () => {
    ['fFrom', 'fTo', 'fSearch', 'fMin', 'fMax'].forEach((id) => ($(id).value = ''));
    ['fCategory', 'fType', 'fCurrency'].forEach((id) => ($(id).value = ''));
    qa('#rangeSeg button').forEach((x) => x.classList.toggle('active', x.dataset.range === 'all'));
    readFilters(); applyAndRender();
  });

  $('exportCsv').addEventListener('click', exportCSV);
  $('exportJson').addEventListener('click', exportJSON);

  $('txShowRaw').addEventListener('change', renderTransactions);
  $('txPageSize').addEventListener('change', () => {
    state.tableState.tx = { ...(state.tableState.tx || {}), page: 0 };
    renderTransactions();
  });
  $('profileFieldSearch').addEventListener('input', debounce(renderAllProfileFields, 150));
}

function wireTabs() {
  qa('.rail-item').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
}

function setTab(tab) {
  state.tab = tab;
  qa('.rail-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  qa('.tab').forEach((s) => s.classList.toggle('hidden', s.dataset.panel !== tab));
  $('main').scrollTop = 0;
}

function applyQuickRange(range) {
  if (range === 'all') { $('fFrom').value = ''; $('fTo').value = ''; }
  else {
    const days = Number(range);
    const anchor = state.agg?.lastSeen ? new Date(state.agg.lastSeen) : new Date();
    const from = new Date(anchor); from.setDate(from.getDate() - days + 1);
    $('fFrom').value = isoDate(from);
    $('fTo').value = isoDate(anchor);
  }
  readFilters(); applyAndRender();
}

function readFilters() {
  const multi = (id) => { const v = $(id).value; return v ? [v] : []; };
  state.filters = {
    from: $('fFrom').value, to: $('fTo').value,
    search: $('fSearch').value,
    categories: multi('fCategory'), types: multi('fType'), currencies: multi('fCurrency'),
    minAmount: $('fMin').value, maxAmount: $('fMax').value,
  };
}

/* ================================================================ *
 * Load
 * ================================================================ */
async function loadPlayer(userId) {
  // Single validation chokepoint for every entry path (lookup form, Recent
  // dropdown, ?userId= preset from init()) — reject outright rather than
  // sanitize-and-continue, per the security review.
  try { userId = normalizePlayerId(userId); }
  catch { return banner('error', `"${userId}" is not a valid player ID — expected 4-10 digits.`, 5000); }

  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  state.userId = String(userId);

  setBusy(true);
  banner('info', `Loading player ${userId}…`);
  $('emptyState').classList.add('hidden');
  $('railAdminLink').href = PROFILE_PATH(userId);

  const errors = [];

  let profile = null;
  try {
    profile = await fetchProfile(userId, { signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') return abortDone();
    errors.push(`Profile: ${e.message}`);
  }
  state.profile = profile;
  updateRailPlayer(profile, userId);

  let tx = { rows: [], columns: [], method: '—', complete: false, reported: null };
  try {
    tx = await fetchTransactions(userId, {
      signal: controller.signal,
      onProgress: (p) => { banner('info', p.message); setProgress(p.pct); },
    });
  } catch (e) {
    if (e.name === 'AbortError') return abortDone();
    errors.push(`Transactions: ${e.message}`);
  }

  state.meta = {
    method: tx.method, complete: tx.complete, reported: tx.reported,
    columns: tx.columns || [], fetchedAt: new Date(), rowCount: tx.rows.length,
    exportSkipped: tx.exportSkipped || null,
  };
  state.records = normalizeAll(tx.rows);

  // Only the CSV export carries the per-currency `d_<id>_<name>` delta
  // columns. The changelist fallbacks don't, so every cash figure would
  // aggregate to a real-looking $0.00 off zero currency entries — which reads
  // as "this player never deposited or withdrew", not as "we couldn't see the
  // data". Detect that and mark the whole load degraded so no monetary figure
  // is presented as fact.
  state.meta.hasCurrencyData = state.records.some((r) => r.entries.length > 0);
  state.meta.degraded = state.records.length > 0 && !state.meta.hasCurrencyData;

  setBusy(false);

  if (!state.records.length && errors.length) {
    banner('error', errors.join('  •  '));
    $('emptyState').classList.remove('hidden');
    return;
  }

  populateDynamicFilters();
  readFilters();
  applyAndRender();

  pushRecent(userId, profile?.username || null);

  $('railMethod').textContent = state.meta.method || '—';
  $('railFetched').textContent = state.meta.fetchedAt.toLocaleTimeString();

  // A degraded load takes priority over every other banner: it's the one case
  // where the numbers on screen are not just incomplete but actively
  // misleading, so it must not auto-hide and must say what to do about it.
  if (state.meta.degraded) {
    banner('error',
      `No currency data in this fetch — every monetary figure below is unavailable, not zero. `
      + `Fetched via ${state.meta.method}, which only exposes the columns the admin list view renders. `
      + (state.meta.exportSkipped || '')
      + ` Use “Load CSV…” with a transaction export from Django admin to get the real figures.`);
  } else if (errors.length) banner('warn', `Loaded with warnings — ${errors.join('  •  ')}`);
  else if (!state.meta.complete) banner('warn', `Loaded ${state.records.length} records, but the server reported ${state.meta.reported ?? 'more'}. Results may be partial.`);
  else banner('ok', `Loaded ${state.records.length} transactions via ${state.meta.method}.`, 4500);
}

/**
 * Load the ledger from a CSV the operator exported from Django admin by hand.
 *
 * Deliberate escape hatch. The automatic export can be blocked by things this
 * extension can't fix from the client side (Django's CSRF policy on a
 * cross-origin POST being the case that prompted it), and when that happens
 * every monetary figure is unavailable. Django's own "export as CSV" action
 * always works from inside the admin UI, so accepting that file means a
 * blocked export degrades to one extra manual step rather than to no analysis
 * at all.
 *
 * The file is parsed in-page and never uploaded anywhere — same as every other
 * path in this tool.
 */
async function loadFromCsvFile(file) {
  if (!file) return;
  const MAX = 60 * 1024 * 1024;
  if (file.size > MAX) {
    return banner('error', `That file is ${Math.round(file.size / 1e6)}MB, over the ${Math.round(MAX / 1e6)}MB limit for client-side parsing.`);
  }

  setBusy(true);
  banner('info', `Reading ${file.name}…`);
  let rows;
  try {
    rows = parseCSV(await file.text());
  } catch (e) {
    setBusy(false);
    return banner('error', `Could not parse that file as CSV: ${e.message}`);
  }

  if (!rows.length) {
    setBusy(false);
    return banner('error', 'That CSV parsed to zero rows.');
  }

  state.records = normalizeAll(rows);
  state.meta = {
    method: `manual CSV (${file.name})`,
    complete: true,
    reported: rows.length,
    columns: Object.keys(rows[0] || {}),
    fetchedAt: new Date(),
    rowCount: rows.length,
    exportSkipped: null,
  };
  state.meta.hasCurrencyData = state.records.some((r) => r.entries.length > 0);
  state.meta.degraded = state.records.length > 0 && !state.meta.hasCurrencyData;

  // If the operator's own export also lacks the delta columns, say so plainly
  // rather than silently showing zeros — the same guard as a degraded fetch.
  if (state.meta.degraded) {
    setBusy(false);
    populateDynamicFilters(); readFilters(); applyAndRender();
    return banner('error',
      'That CSV has no per-currency columns (no `d_<id>_<name>` fields), so every monetary figure is '
      + 'unavailable, not zero. It looks like a list-view export rather than the full transaction export.');
  }

  // A manual CSV can't tell us who it's for, so keep whatever player context
  // is already on screen and make the mismatch risk explicit. Records don't
  // carry a user id of their own, so look for one in the raw columns — if the
  // export has such a column and it holds more than one value, the file
  // probably isn't scoped to a single player.
  const userIdKey = Object.keys(state.records[0]?.raw || {})
    .find((key) => /^(user|account|player)[_ ]?id$/i.test(key.trim()));
  const seen = userIdKey
    ? new Set(state.records.map((r) => String(r.raw?.[userIdKey] ?? '').trim()).filter(Boolean))
    : new Set();
  const idNote = state.userId
    ? ` Player context stays as ${state.userId} — make sure the file is for that player.`
    : '';

  setBusy(false);
  $('emptyState').classList.add('hidden');
  populateDynamicFilters();
  readFilters();
  applyAndRender();

  $('railMethod').textContent = state.meta.method;
  $('railFetched').textContent = state.meta.fetchedAt.toLocaleTimeString();
  banner('ok', `Loaded ${state.records.length} transactions from ${file.name}.${idNote}`, 8000);
  if (seen.size > 1) {
    banner('warn', `That CSV contains ${seen.size} different user ids — it may be an unfiltered export covering more than one player.`);
  }
}

function abortDone() {
  setBusy(false);
  banner('warn', 'Load cancelled.', 3000);
}

function populateDynamicFilters() {
  const typeCodes = [...new Set(state.records.map((r) => r.type).filter((t) => t != null))].sort((a, b) => a - b);
  const currencyIds = [...new Set(state.records.flatMap((r) => r.entries.map((e) => e.currencyId)))].sort((a, b) => a - b);

  const fillPreserving = (id, values, labelFn) => {
    const sel = $(id);
    const current = sel.value;
    const first = sel.querySelector('option');
    sel.innerHTML = '';
    sel.appendChild(first);
    values.forEach((v) => {
      const o = document.createElement('option');
      o.value = String(v); o.textContent = labelFn(v);
      sel.appendChild(o);
    });
    if (values.some((v) => String(v) === current)) sel.value = current;
  };

  fillPreserving('fType', typeCodes, (t) => { const m = typeMeta(t); return `${t} — ${m.label}${m.matched === false ? ' (unmapped)' : ''}`; });
  fillPreserving('fCurrency', currencyIds, (c) => { const m = currencyMeta(c); return `${m.label}${m.inferred ? ' (unclassified)' : ''} · ${m.kind}`; });
}

/* ---------------- UI status helpers ---------------- */
function banner(kind, message, autoHideMs) {
  const el = $('banner');
  el.className = `banner ${kind}`;
  el.innerHTML = `<span>${esc(message)}</span><button type="button" class="b-close" aria-label="Dismiss">×</button>`;
  el.querySelector('.b-close').addEventListener('click', () => el.classList.add('hidden'));
  clearTimeout(bannerTimer);
  if (autoHideMs) bannerTimer = setTimeout(() => el.classList.add('hidden'), autoHideMs);
}

function setProgress(pct) {
  const bar = $('progressBar'), fill = $('progressFill');
  bar.classList.remove('hidden');
  if (pct == null || !Number.isFinite(pct)) { fill.classList.add('indeterminate'); return; }
  fill.classList.remove('indeterminate');
  fill.style.width = `${Math.max(3, Math.min(100, pct))}%`;
}

function setBusy(busy) {
  $('loadBtn').disabled = busy;
  $('loadBtn').textContent = busy ? 'Loading…' : 'Load Report';
  $('cancelBtn').classList.toggle('hidden', !busy);
  if (busy) setProgress(null);
  else setTimeout(() => { $('progressBar').classList.add('hidden'); $('progressFill').style.width = '0'; }, 400);
}

function updateRailPlayer(profile, userId) {
  const name = profile?.username || `Player ${userId}`;
  $('rpName').textContent = name;
  $('rpName').title = name;
  $('rpId').textContent = `ID ${userId}`;
  $('rpAvatar').textContent = (profile?.username || String(userId)).trim().slice(0, 2).toUpperCase();
  document.title = `${name} — Fliff IMS Report`;
}

/* ================================================================ *
 * Apply + render
 * ================================================================ */
function applyAndRender() {
  state.filtered = applyFilters(state.records, state.filters);
  state.agg = aggregate(state.filtered);
  state.tableState = {};
  renderAll();
}

function renderAll() {
  updateFilterSummary();
  updateCounts();
  renderSummary();
  renderDetails();
  renderTransactions();
  renderDeposits();
  renderWithdrawals();
  renderGameStats();
  renderBonuses();
  renderWallet();
  renderRisk();
  renderRaw();
}

function updateFilterSummary() {
  const a = state.agg, total = state.records.length;
  const shown = state.filtered.length;
  const span = a.firstSeen && a.lastSeen
    ? `${isoDate(a.firstSeen)} → ${isoDate(a.lastSeen)} (${daysBetween(a.firstSeen, a.lastSeen) + 1} days)`
    : 'no dated records';
  $('filterSummary').innerHTML =
    `Showing <b>${fmtNum(shown)}</b> of <b>${fmtNum(total)}</b> transactions · ${esc(span)}` +
    (state.meta.reported && state.meta.reported !== total ? ` · <span class="warn-text">server reported ${fmtNum(state.meta.reported)}</span>` : '');
}

function updateCounts() {
  const k = state.agg.kpis;
  $('cntTx').textContent = fmtNum(state.filtered.length);
  $('cntDep').textContent = k.depositCount ? fmtNum(k.depositCount) : '';
  $('cntWdl').textContent = (k.withdrawalRequestedCount + k.withdrawalPaidCount) ? fmtNum(k.withdrawalRequestedCount + k.withdrawalPaidCount) : '';
  $('cntBon').textContent = k.bonusCount ? fmtNum(k.bonusCount) : '';
  const flags = riskSignals(state.agg).filter((r) => r.level === 'high' || r.level === 'med');
  const rc = $('cntRisk');
  rc.textContent = flags.length ? String(flags.length) : '';
  rc.classList.toggle('flag', flags.some((f) => f.level === 'high'));
}

/* ---------------- KPI helper ---------------- */

/**
 * Guard for any money/currency-derived KPI value.
 *
 * On a degraded fetch (no currency columns — see state.meta.degraded) every
 * such figure aggregates to zero, which on screen is indistinguishable from a
 * genuine zero. Route those through here so they render as an explicit
 * "unavailable" dash instead of a number somebody might act on.
 */
function money(renderFn) {
  return state.meta?.degraded ? '—' : renderFn();
}
/** Sub-line variant: replaced with an explanation on a degraded fetch. */
function moneySub(renderFn) {
  return state.meta?.degraded ? '<span class="muted">currency data not in this fetch</span>' : renderFn();
}

function kpi({ label, value, sub, tone = '', spark, valueClass = '' }) {
  return `<div class="kpi ${tone}">
    <div class="kpi-label">${esc(label)}</div>
    <div class="kpi-value ${valueClass}">${esc(value)}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
    ${spark ? `<div class="kpi-spark">${spark}</div>` : ''}
  </div>`;
}

function dayKeys() { return Object.keys(state.agg.byDay).sort(); }

/** Read a per-day (or per-month) delta series for one category+currency pair, in the source's raw units. */
function daySeries(keys, grain, category, currencyId) {
  const src = grain === 'month' ? state.agg.byMonth : state.agg.byDay;
  const k = `${category}:${currencyId}`;
  return keys.map((day) => src[day]?.[k] || 0);
}
/** Sum one category's series across several currency ids (e.g. deposit across both wallets), signed. */
function catSeries(keys, grain, category, ids) {
  return keys.map((_, i) => ids.reduce((s, cid) => s + daySeries(keys, grain, category, cid)[i], 0));
}
/** Same, but absolute value — for "amount moved" style series (e.g. wagered) where the source sign is a debit. */
function catSeriesAbs(keys, grain, category, ids) {
  return keys.map((_, i) => ids.reduce((s, cid) => s + Math.abs(daySeries(keys, grain, category, cid)[i]), 0));
}
/** Sum specific currency ids on a single record (e.g. a withdrawal that could be either wallet). */
function entrySum(record, ids) {
  return record.entries.filter((e) => ids.includes(e.currencyId)).reduce((s, e) => s + e.delta, 0);
}

/* ================================================================ *
 * TAB: Summary
 * ================================================================ */
function renderSummary() {
  if (!state.agg) return;
  const k = state.agg.kpis;
  const days = dayKeys();

  // Balance is a live profile-page snapshot (not part of the filtered
  // ledger), so it's the same regardless of the date-range filter — folded
  // into Global Value below per request, but sourced from state.profile
  // rather than state.agg.
  const p = state.profile || {};
  const hasBalance = Number.isFinite(p.combinedBalanceNum);
  const balanceCents = hasBalance ? Math.round(p.combinedBalanceNum * 100) : 0;
  const netCashAdj = k.netCash - balanceCents;

  // Every tile below except Balance is derived from the ledger's per-currency
  // delta columns, so all of them are routed through money()/moneySub() —
  // on a degraded fetch those columns are absent and the underlying figure is
  // a meaningless zero. Balance is the exception: it's scraped straight off
  // the profile page and stays trustworthy either way.
  $('kpiGrid').innerHTML = [
    kpi({ label: 'Deposits', value: money(() => fmtMoney(k.depositTotal)), tone: 'pos',
      sub: moneySub(() => `<span class="badge">${fmtNum(k.depositCount)} tx</span> avg ${fmtMoney(k.depositAvg)}` +
        (k.depositFantasy > 0 ? ` <span class="badge neu">incl. ${fmtMoney(k.depositFantasy)} superstars</span>` : '')),
      spark: state.meta?.degraded ? '' : sparkline(catSeries(days, 'day', 'deposit', DEPOSIT_CURRENCY_IDS), { color: PALETTE[0] }) }),
    kpi({ label: 'Withdrawals Paid', value: money(() => fmtMoney(k.withdrawalPaidTotal)), tone: 'neg',
      sub: moneySub(() => (k.withdrawalPendingTotal > 0.5 ? `<span class="badge warn">${fmtMoney(k.withdrawalPendingTotal)} pending</span>` : `<span class="badge">${fmtNum(k.withdrawalPaidCount)} tx</span>`) +
        (k.withdrawalPaidFantasy > 0 ? ` <span class="badge neu">incl. ${fmtMoney(k.withdrawalPaidFantasy)} superstars</span>` : '')),
      spark: state.meta?.degraded ? '' : sparkline(catSeries(days, 'day', 'withdrawal_paid', WITHDRAWAL_PAID_CURRENCY_IDS), { color: PALETTE[3] }) }),
    // The sportsbook balance is Fliff Cash and the Superstars balance is real
    // dollars; both render as $ here (Fliff Cash redeems 1:1). Note the admin
    // page labels the sportsbook one with a trailing FC unit, so a small
    // formatting difference against that page is expected, not a discrepancy.
    kpi({ label: 'Balance', value: hasBalance ? fmtDollars(p.combinedBalanceNum) : '—', tone: 'teal', valueClass: 'sm',
      sub: Number.isFinite(p.sportsbookBalanceNum) || Number.isFinite(p.fantasyBalanceNum)
        ? `${Number.isFinite(p.sportsbookBalanceNum) ? `<span class="badge">${fmtDollars(p.sportsbookBalanceNum)} sportsbook</span>` : ''}` +
          (Number.isFinite(p.fantasyBalanceNum) ? ` <span class="badge neu">${fmtDollars(p.fantasyBalanceNum)} superstars</span>` : '') +
          ' <span class="badge">live, not date-filtered</span>'
        : '<span class="muted">not on profile page</span>' }),
    kpi({ label: 'Global Value', value: money(() => fmtMoney(netCashAdj)),
      tone: state.meta?.degraded ? '' : (netCashAdj >= 0 ? 'pos' : 'neg'),
      valueClass: state.meta?.degraded ? '' : (netCashAdj >= 0 ? 'pos-text' : 'neg-text'),
      sub: moneySub(() => (hasBalance ? 'Deposits − withdrawals paid − balance' : 'Deposits − withdrawals paid (balance not on profile page)')) }),
    // Combined headline stays in $ (FC redeems 1:1), with the split spelling
    // out which half is Fliff Cash and which is Superstars USD.
    kpi({ label: 'Cash Wagering Net', value: money(() => fmtMoney(k.cashNetResult)), tone: 'teal',
      valueClass: state.meta?.degraded ? '' : (k.cashNetResult >= 0 ? 'pos-text' : 'neg-text'),
      sub: moneySub(() => `<span class="badge">${fmtMoney(k.cashNetResultSportsbook)} sportsbook</span>` +
        (k.cashNetResultFantasy !== 0 ? ` <span class="badge neu">${fmtMoney(k.cashNetResultFantasy)} superstars</span>` : '') +
        `<br>Wagered ${fmtMoney(k.cashWageredTotal)} · Won ${fmtMoney(k.cashWonTotal)}`) }),
    kpi({ label: 'Cash Pick Win Rate', value: money(() => (k.cashWinRate == null ? '—' : fmtPct(k.cashWinRate))), valueClass: 'sm',
      sub: moneySub(() => `${fmtNum(k.cashWinCount)}W / ${fmtNum(k.cashLossCount)}L of ${fmtNum(k.cashSettledCount)} settled`) }),
    kpi({ label: 'Token Wagering Net', value: money(() => fmtNum(k.tokenNetResult)), tone: 'violet',
      sub: moneySub(() => `Wagered ${fmtNum(k.tokenWageredTotal)} · Won ${fmtNum(k.tokenWonTotal)}`) }),
    kpi({ label: 'Bonus Value', value: money(() => fmtMoney(k.bonusCashTotal)), tone: 'warn', valueClass: 'sm',
      sub: moneySub(() => `<span class="badge">${fmtNum(k.bonusCount)} claims</span>` +
        (k.depositBonusCount ? ` <span class="badge neu">${fmtNum(k.depositBonusCount)} deposit-match</span>` : '') +
        ` + ${fmtNum(k.bonusTokenTotal)} coins`) }),
    kpi({ label: 'XP Earned', value: money(() => fmtNum(k.xpGrantedTotal)), tone: 'warn', valueClass: 'sm',
      sub: moneySub(() => (k.xpRedeemedTotal ? `${fmtNum(k.xpRedeemedTotal)} redeemed → ${fmtMoney(k.xpRedeemCashGained)}` : `${fmtNum(k.xpGrantCount)} grants`)) }),
  ].join('');

  const comp = [
    { label: 'Deposits', value: k.depositTotal, color: PALETTE[0] },
    { label: 'Withdrawals Paid', value: k.withdrawalPaidTotal, color: PALETTE[3] },
    { label: 'Cash Wagered', value: k.cashWageredTotal, color: PALETTE[4] },
    { label: 'Cash Won', value: k.cashWonTotal, color: PALETTE[1] },
    { label: 'Bonus Cash', value: k.bonusCashTotal, color: PALETTE[2] },
  ].filter((d) => d.value > 0);
  const compTotal = comp.reduce((s, d) => s + d.value, 0);
  // "No cash movements in the selected period" would be a lie on a degraded
  // fetch — there may be plenty, we just can't see them.
  $('chartComposition').innerHTML = state.meta?.degraded
    ? emptyChartNotice('Cash composition needs the per-currency columns, which this fetch didn’t include.')
    : donutChart(comp, {
      format: (v) => fmtMoney(v),
      centerValue: shortNum(compTotal / 100), centerLabel: 'Total $ flow',
      emptyMessage: 'No cash movements in the selected period',
    });

  const catCounts = {};
  state.filtered.forEach((r) => { catCounts[r.category] = (catCounts[r.category] || 0) + 1; });
  const cats = Object.entries(catCounts)
    .map(([cat, count]) => ({ label: CATEGORIES[cat]?.label || cat, value: count, color: CAT_COLOR[cat] }))
    .sort((a, b) => b.value - a.value);
  $('chartCategories').innerHTML = barChart(cats, { format: (v) => fmtNum(v) });

  const grain = state.trendGrain;
  const keys = grain === 'month' ? Object.keys(state.agg.byMonth).sort() : days;
  $('chartTimeline').innerHTML = state.meta?.degraded
    ? emptyChartNotice('The cash timeline needs the per-currency columns, which this fetch didn’t include.')
    : columnChart(keys, [
      { name: 'Deposits', values: catSeries(keys, grain, 'deposit', DEPOSIT_CURRENCY_IDS), color: PALETTE[0] },
      { name: 'Withdrawals Paid', values: catSeries(keys, grain, 'withdrawal_paid', WITHDRAWAL_PAID_CURRENCY_IDS), color: PALETTE[3] },
      { name: 'Cash Wagered', values: catSeriesAbs(keys, grain, 'wager', CASH_CHAIN), color: PALETTE[4] },
      { name: 'Cash Won', values: catSeries(keys, grain, 'settlement_win', CASH_CHAIN), color: PALETTE[1] },
    ], { format: (v) => fmtMoney(v), height: 250, emptyMessage: 'No dated cash transactions to plot' });

  // The profile page's Purchases/Redemptions figures are Sportsbook-only
  // (the "SportsBook" panel on the admin page) — compare against the
  // sportsbook-only ledger figure, not the combined-wallet headline KPI, or
  // every fantasy-active player would show a false-positive Δ here. The
  // fantasy portion is surfaced as its own row instead of folded in.
  // On a degraded fetch the ledger side of every row is 0, which would render
  // as a huge spurious Δ against the real profile figures — the exact
  // "player's numbers don't add up" false alarm this table exists to rule out.
  // Show the profile side only and say why the comparison is unavailable.
  $('tblReconcile').innerHTML = state.meta?.degraded ? `
    <thead><tr><th>Metric</th><th class="num">Profile Record</th><th class="num">Filtered Ledger</th><th class="num">Δ</th></tr></thead>
    <tbody>
      ${degradedReconRow('Purchases / Deposits (Sportsbook)', p.purchasesNum)}
      ${degradedReconRow('Redemptions / Withdrawals (Sportsbook)', p.redemptionsNum)}
      ${degradedReconRow('Global / net value', p.netValueNum)}
      <tr><td colspan="4" class="muted" style="padding:10px 12px">
        Ledger comparison unavailable — this fetch carried no per-currency columns, so a
        reconciliation against these profile figures would only measure what's missing.
      </td></tr>
    </tbody>` : `
    <thead><tr><th>Metric</th><th class="num">Profile Record</th><th class="num">Filtered Ledger</th><th class="num">Δ</th></tr></thead>
    <tbody>
      ${reconRow('Purchases / Deposits (Sportsbook)', p.purchasesNum, k.depositSportsbook / 100)}
      ${reconRow('Redemptions / Withdrawals (Sportsbook)', p.redemptionsNum, k.withdrawalPaidSportsbook / 100)}
      ${reconRow('Global / net value', p.netValueNum, k.netCash / 100)}
      ${k.depositFantasy || k.withdrawalPaidFantasy ? `<tr>
        <td>Superstars wallet (not on profile page's SportsBook panel)</td>
        <td class="num muted">—</td>
        <td class="num">${esc(fmtMoney(k.depositFantasy))} dep · ${esc(fmtMoney(k.withdrawalPaidFantasy))} wd</td>
        <td class="num muted">n/a</td>
      </tr>` : ''}
    </tbody>`;

  const typeCounts = {};
  state.filtered.forEach((r) => { const key = r.type; typeCounts[key] = typeCounts[key] || { count: 0, category: r.category, label: r.typeLabel }; typeCounts[key].count++; });
  const topTypes = Object.entries(typeCounts)
    .sort((a, b) => b[1].count - a[1].count).slice(0, 10)
    .map(([t, v]) => ({ label: truncate(`${t} ${v.label}`, 30), value: v.count, color: CAT_COLOR[v.category] }));
  $('chartTopTypes').innerHTML = barChart(topTypes, { format: (v) => fmtNum(v) });
}

function reconRow(label, profileVal, ledgerVal) {
  const has = Number.isFinite(profileVal);
  const delta = has ? ledgerVal - profileVal : null;
  const cls = delta == null ? 'muted' : Math.abs(delta) < 0.01 ? 'pos-text' : 'warn-text';
  return `<tr>
    <td>${esc(label)}</td>
    <td class="num">${has ? esc(fmtDollars(profileVal)) : '<span class="muted">not on page</span>'}</td>
    <td class="num">${esc(fmtDollars(ledgerVal))}</td>
    <td class="num ${cls}">${delta == null ? '—' : esc(fmtDollars(delta))}</td>
  </tr>`;
}
/** Reconciliation row for a degraded fetch: profile figure only, no false Δ. */
function degradedReconRow(label, profileVal) {
  const has = Number.isFinite(profileVal);
  return `<tr>
    <td>${esc(label)}</td>
    <td class="num">${has ? esc(fmtDollars(profileVal)) : '<span class="muted">not on page</span>'}</td>
    <td class="num muted">unavailable</td>
    <td class="num muted">—</td>
  </tr>`;
}
function fmtDollars(n) { return fmtMoney(n * 100); }

/** Placeholder for a chart that can't be drawn because the fetch lacked currency columns. */
function emptyChartNotice(message) {
  return `<div class="chart-empty">${esc(message)}</div>`;
}

/* ================================================================ *
 * TAB: Player details — unaffected by the ledger schema change.
 * ================================================================ */
function renderDetails() {
  const p = state.profile;
  const a = state.agg;

  const row = (label, value, extra) => {
    const empty = value == null || value === '';
    return `<tr><th>${esc(label)}</th><td class="${empty ? 'kv-missing' : ''}">${empty ? 'Not present on profile page' : esc(value)}${extra ? ` ${extra}` : ''}</td></tr>`;
  };

  $('tblIdentity').innerHTML = `<tbody>
    ${row('Username', p?.username)}
    ${row('User ID', state.userId)}
    ${row('Profile ID', p?.profileId)}
    ${row('Verified email', p?.email)}
    ${row('Verified phone', p?.phone)}
    ${row('Country / region', p?.country)}
    ${row('Referrer', p?.referrer)}
  </tbody>`;

  const firstTx = a?.firstSeen, lastTx = a?.lastSeen;
  const tenure = p?.registeredDate ? daysBetween(p.registeredDate, new Date()) : null;
  $('tblAccount').innerHTML = `<tbody>
    ${row('Account status', p?.status)}
    ${row('KYC / verification', p?.kyc)}
    ${row('User Tags', p?.userTags && p.userTags.length ? p.userTags.join(', ') : null)}
    ${row('Registered', p?.registered, tenure != null ? `<span class="badge">${fmtNum(tenure)} days ago</span>` : '')}
    ${row('Last active (profile)', p?.lastActive)}
    ${row('First transaction (ledger)', firstTx ? formatDateTime(firstTx) : null)}
    ${row('Last transaction (ledger)', lastTx ? formatDateTime(lastTx) : null)}
    ${row('Active days in period', a ? fmtNum(a.activeDays) : null)}
  </tbody>`;

  $('tblFinancial').innerHTML = `<tbody>
    ${row('Global / net value', p?.netValue)}
    ${row('Lifetime purchases', p?.purchases)}
    ${row('Lifetime redemptions', p?.redemptions)}
    ${row('Fliff Cash balance', p?.balance)}
    ${row('Fresh coins', p?.freshCoins)}
    ${row('Won coins', p?.wonCoins)}
    ${row('Loyalty / XP', p?.loyaltyPoints)}
    ${row('Admin notes', p?.notes)}
  </tbody>`;

  renderAllProfileFields();
}

function renderAllProfileFields() {
  const all = state.profile?.all || {};
  const filter = ($('profileFieldSearch').value || '').toLowerCase().trim();
  const entries = Object.entries(all)
    .filter(([k, v]) => !filter || k.toLowerCase().includes(filter) || String(v).toLowerCase().includes(filter))
    .sort((a, b) => a[0].localeCompare(b[0]));

  if (!entries.length) {
    $('tblAllProfile').innerHTML = `<tbody><tr><td class="muted" style="padding:14px">${
      Object.keys(all).length ? 'No fields match that filter.' : 'No profile fields were captured. The profile page may be unavailable or its layout changed.'
    }</td></tr></tbody>`;
    return;
  }
  $('tblAllProfile').innerHTML = `<tbody>${entries.map(([k, v]) =>
    `<tr><th>${esc(k)}</th><td>${esc(truncate(v, 400))}</td></tr>`).join('')}</tbody>`;
}

/* ================================================================ *
 * Entry badges — shared by every ledger table
 * ================================================================ */
function renderEntries(r) {
  if (!r.entries.length) return '<span class="muted">—</span>';
  return r.entries.map((e) => {
    const tone = e.delta > 0 ? 'pos' : e.delta < 0 ? 'neg' : 'neu';
    const amt = fmtByKind(e.kind, e.delta);
    return `<span class="badge ${tone} mono" title="${esc(e.label)} (${e.kind})">${amt}<span class="kind-pill ${e.kind}" style="margin-left:4px">${e.kind === 'cash' ? '$' : '◆'}</span></span>`;
  }).join(' ');
}

function typeBadge(r) {
  if (r.categoryInferred) return `<span class="mono">${esc(r.type ?? '—')}</span> ${esc(truncate(r.typeLabel, 34))} <span class="badge neu" title="Categorized from the fantasy-wallet currency pattern, not a confirmed type-code mapping">inferred</span>`;
  const unmapped = r.typeMatched === false;
  return `<span class="mono">${esc(r.type ?? '—')}</span> ${esc(truncate(r.typeLabel, 34))}${unmapped ? ' <span class="badge warn" title="No category rule matched this type code">?</span>' : ''}`;
}

function productBadge(r) {
  const label = PRODUCT_LABEL[r.product] || r.product;
  return r.product === 'unknown' ? '<span class="muted">—</span>' : `<span class="product-pill ${esc(r.product)}">${esc(label)}</span>`;
}

/* ================================================================ *
 * TAB: Transactions
 * ================================================================ */
function txColumns(showRaw) {
  const base = [
    { key: 'date', label: 'Timestamp', cls: 'mono', width: '146px',
      sort: (r) => (r.date ? r.date.getTime() : 0), render: (r) => esc(r.dateText), value: (r) => r.dateText },
    { key: 'id', label: 'ID', cls: 'mono', sort: (r) => toNumber(r.id) || 0, render: (r) => esc(r.id), value: (r) => r.id },
    { key: 'category', label: 'Category', sort: (r) => r.category,
      render: (r) => `<span class="badge ${CATEGORIES[r.category]?.tone || 'neu'}">${CATEGORIES[r.category]?.icon || ''} ${esc(CATEGORIES[r.category]?.label || r.category)}</span>`,
      value: (r) => CATEGORIES[r.category]?.label || r.category },
    { key: 'product', label: 'Wallet', sort: (r) => r.product, render: productBadge, value: (r) => PRODUCT_LABEL[r.product] || r.product },
    { key: 'type', label: 'Type', sort: (r) => r.type || 0, render: typeBadge, value: (r) => `${r.type} ${r.typeLabel}` },
    { key: 'entries', label: 'Currency Movement', cls: 'mono', sort: (r) => r.cashAbs,
      render: renderEntries, value: (r) => r.entries.map((e) => `${e.key}:${e.delta}`).join(' ') },
    { key: 'reason', label: 'Reason / Pick ID', cls: 'mono', sort: (r) => r.reasonId,
      render: (r) => r.reasonId ? esc(r.reasonId) : '<span class="muted">—</span>', value: (r) => r.reasonId },
    { key: 'history', label: 'History', sort: (r) => r.history,
      render: (r) => esc(truncate(r.history, 70)) || '<span class="muted">—</span>', value: (r) => r.history },
  ];
  if (!showRaw) return base;

  const rawKeys = [...new Set(state.filtered.flatMap((r) => Object.keys(r.raw)))];
  return base.concat(rawKeys.map((rk) => ({
    key: `raw:${rk}`, label: rk, cls: 'mono',
    sort: (r) => String(r.raw[rk] || ''),
    render: (r) => esc(truncate(r.raw[rk], 60)),
    value: (r) => r.raw[rk] || '',
  })));
}

function renderTransactions() {
  if (!state.agg) return;
  const k = state.agg.kpis;
  $('txStrip').innerHTML = [
    ['Records', fmtNum(state.filtered.length)],
    ['Deposits', fmtMoney(k.depositTotal)],
    ['Withdrawals Paid', fmtMoney(k.withdrawalPaidTotal)],
    ['Cash Wagered', fmtMoney(k.cashWageredTotal)],
    ['Cash Won', fmtMoney(k.cashWonTotal)],
    ['Token Wagered', fmtNum(k.tokenWageredTotal)],
    ['XP Earned', fmtNum(k.xpGrantedTotal)],
    ['Distinct types', fmtNum(Object.keys(state.agg.byType).length)],
  ].map(([l, v]) => `<div class="chip"><span class="chip-label">${esc(l)}</span><span class="chip-value">${esc(v)}</span></div>`).join('');

  renderTable({
    tableEl: $('tblTx'), pagerEl: $('txPager'), stateKey: 'tx',
    columns: txColumns($('txShowRaw').checked),
    rows: state.filtered,
    pageSize: Number($('txPageSize').value) || 100,
    emptyMessage: 'No transactions match the current filters.',
    onChange: renderTransactions,
  });
}

/* ================================================================ *
 * TAB: Deposits
 * ================================================================ */
function renderDeposits() {
  const a = state.agg, k = a.kpis;
  const recs = state.filtered.filter((r) => r.category === 'deposit');
  const amounts = recs.map((r) => Math.abs(entrySum(r, DEPOSIT_CURRENCY_IDS))).filter(Boolean);
  const total = k.depositTotal, count = recs.length;
  const avg = count ? total / count : 0;
  const max = amounts.length ? Math.max(...amounts) : 0;
  const min = amounts.length ? Math.min(...amounts) : 0;
  const dates = recs.map((r) => r.date).filter(Boolean).sort((x, y) => x - y);

  $('depKpis').innerHTML = [
    kpi({ label: 'Total Deposits', value: fmtMoney(total), tone: 'pos',
      sub: k.depositFantasy > 0 ? `<span class="badge">Sportsbook ${fmtMoney(k.depositSportsbook)}</span> <span class="badge neu">Superstars ${fmtMoney(k.depositFantasy)}</span>` : '' }),
    kpi({ label: 'Count', value: fmtNum(count) }),
    kpi({ label: 'Average', value: fmtMoney(avg), valueClass: 'sm' }),
    kpi({ label: 'Largest', value: fmtMoney(max), valueClass: 'sm' }),
    kpi({ label: 'Smallest', value: fmtMoney(min), valueClass: 'sm' }),
    kpi({ label: 'First', value: dates[0] ? isoDate(dates[0]) : '—', valueClass: 'sm' }),
    kpi({ label: 'Most recent', value: dates.length ? isoDate(dates[dates.length - 1]) : '—', valueClass: 'sm' }),
    kpi({ label: 'Deposits w/ Bonus', value: fmtNum(k.depositBonusCount), tone: 'teal', valueClass: 'sm',
      sub: k.depositBonusCount ? `+${fmtMoney(k.depositBonusTotal)} bundled — see Bonus & XP tab` : '' }),
  ].join('');

  const byDay = {};
  recs.forEach((r) => { if (r.date) { const dk = isoDate(r.date); byDay[dk] = (byDay[dk] || 0) + Math.abs(entrySum(r, DEPOSIT_CURRENCY_IDS)); } });
  const keys = Object.keys(byDay).sort();
  $('chartDepTrend').innerHTML = keys.length > 1
    ? lineChart(keys, [{ name: 'Deposits', values: keys.map((k2) => byDay[k2]), color: PALETTE[0] }], { format: (v) => fmtMoney(v), yFormat: shortMoney, height: 230 })
    : columnChart(keys, [{ name: 'Deposits', values: keys.map((k2) => byDay[k2]), color: PALETTE[0] }], { format: (v) => fmtMoney(v), yFormat: shortMoney, height: 230, emptyMessage: 'No deposits in this period' });

  const buckets = [
    ['< $5', (v) => v < 500], ['$5–$9.99', (v) => v >= 500 && v < 1000], ['$10–$24.99', (v) => v >= 1000 && v < 2500],
    ['$25–$49.99', (v) => v >= 2500 && v < 5000], ['$50–$99.99', (v) => v >= 5000 && v < 10000], ['$100+', (v) => v >= 10000],
  ].map(([lbl, test], i) => ({ label: lbl, value: amounts.filter(test).length, color: PALETTE[i % PALETTE.length] })).filter((d) => d.value > 0);
  $('chartDepBuckets').innerHTML = barChart(buckets, { format: (v) => `${fmtNum(v)} tx`, emptyMessage: 'No deposits to bucket' });

  $('depCount').textContent = `${fmtNum(count)} records · ${fmtMoney(total)}`;

  renderTable({
    tableEl: $('tblDep'), pagerEl: $('depPager'), stateKey: 'dep',
    columns: txColumns(false).filter((c) => c.key !== 'category').concat([{
      key: 'bonus', label: 'Bonus', cls: 'num', sort: (r) => r.depositBonus?.bonusAmount || 0,
      render: (r) => r.depositBonus ? `<b class="pos-text">+${esc(fmtMoney(r.depositBonus.bonusAmount))}</b>` : '<span class="muted">—</span>',
      value: (r) => (r.depositBonus ? fmtMoney(r.depositBonus.bonusAmount) : ''),
    }]),
    rows: recs, pageSize: 50,
    emptyMessage: 'No deposit records match the current filters.',
    onChange: renderDeposits,
  });
}

/* ================================================================ *
 * TAB: Withdrawals
 * ================================================================ */
function renderWithdrawals() {
  const k = state.agg.kpis;
  const requested = state.filtered.filter((r) => r.category === 'withdrawal_requested');
  const paid = state.filtered.filter((r) => r.category === 'withdrawal_paid');

  $('wdlKpis').innerHTML = [
    kpi({ label: 'Requested', value: fmtMoney(k.withdrawalRequestedTotal), tone: 'neu' }),
    kpi({ label: 'Paid', value: fmtMoney(k.withdrawalPaidTotal), tone: 'pos' }),
    kpi({ label: 'Cancelled', value: fmtMoney(k.withdrawalCancelledTotal), tone: 'neu',
      sub: k.withdrawalCancelledCount ? `${fmtNum(k.withdrawalCancelledCount)} request(s), both wallets` : '' }),
    kpi({ label: 'Pending', value: fmtMoney(k.withdrawalPendingTotal), tone: k.withdrawalPendingTotal > 0.5 ? 'warn' : 'neu',
      sub: 'Currently locked, both wallets' }),
    kpi({ label: 'Requests', value: fmtNum(k.withdrawalRequestedCount), valueClass: 'sm' }),
    kpi({ label: 'Paid Out', value: fmtNum(k.withdrawalPaidCount), valueClass: 'sm' }),
  ].join('');

  const pendingZero = k.withdrawalPendingTotal <= 0.5;
  $('wdlFunnel').innerHTML = `
    <div class="funnel">
      <div class="funnel-stage requested">
        <div class="fs-label">Requested</div>
        <div class="fs-value">${esc(fmtMoney(k.withdrawalRequestedTotal))}</div>
        <div class="fs-sub">${fmtNum(k.withdrawalRequestedCount)} request(s)</div>
      </div>
      <div class="funnel-arrow">→</div>
      <div class="funnel-stage paid">
        <div class="fs-label">Paid</div>
        <div class="fs-value">${esc(fmtMoney(k.withdrawalPaidTotal))}</div>
        <div class="fs-sub">${fmtNum(k.withdrawalPaidCount)} payout(s)</div>
      </div>
      ${k.withdrawalCancelledCount ? `
      <div class="funnel-arrow">→</div>
      <div class="funnel-stage cancelled">
        <div class="fs-label">Cancelled</div>
        <div class="fs-value">${esc(fmtMoney(k.withdrawalCancelledTotal))}</div>
        <div class="fs-sub">${fmtNum(k.withdrawalCancelledCount)} cancelled/declined/failed, both wallets — see pairing table for how each was matched</div>
      </div>` : ''}
      <div class="funnel-arrow">→</div>
      <div class="funnel-stage pending ${pendingZero ? 'zero' : ''}">
        <div class="fs-label">Pending</div>
        <div class="fs-value">${esc(fmtMoney(k.withdrawalPendingTotal))}</div>
        <div class="fs-sub">${pendingZero ? 'Fully reconciled' : 'Currently locked — already nets out cancellations in both wallets'}</div>
      </div>
    </div>`;

  const byDay = {};
  [...requested, ...paid].forEach((r) => {
    if (!r.date) return;
    const dk = isoDate(r.date);
    byDay[dk] = byDay[dk] || { req: 0, paid: 0 };
    const ids = r.category === 'withdrawal_requested' ? WITHDRAWAL_REQUESTED_CURRENCY_IDS : WITHDRAWAL_PAID_CURRENCY_IDS;
    byDay[dk][r.category === 'withdrawal_requested' ? 'req' : 'paid'] += Math.abs(entrySum(r, ids));
  });
  const keys = Object.keys(byDay).sort();
  $('chartWdlTrend').innerHTML = columnChart(keys, [
    { name: 'Requested', values: keys.map((k2) => byDay[k2].req), color: PALETTE[2] },
    { name: 'Paid', values: keys.map((k2) => byDay[k2].paid), color: PALETTE[1] },
  ], { format: (v) => fmtMoney(v), yFormat: shortMoney, height: 230, emptyMessage: 'No withdrawal activity in this period' });

  // Built directly from state.agg.withdrawalPairs — see pairWithdrawals()
  // in core.js. Pairing tries a shared reason_id first (reliable for
  // sportsbook), then falls back to same-amount + close-in-time matching
  // (the fantasy wallet's resolution records all carry reason_id "0", a
  // sentinel rather than a real id, so reason_id alone would leave every
  // fantasy request showing "Pending" forever regardless of whether it was
  // actually paid — confirmed live against player 780602, where every one
  // of 131 fantasy requests over 3+ years had a same-amount resolution
  // within days). The "≈" badge flags rows resolved by that fallback rather
  // than an exact shared id, so it's clear which pairings are inferred.
  const pairs = (state.agg.withdrawalPairs || []).map((p) => {
    const r = p.request, res = p.resolution;
    const reqAmt = Math.abs(entrySum(r, WITHDRAWAL_REQUESTED_CURRENCY_IDS));
    const resAmt = res ? Math.abs(entrySum(res, p.status === 'paid' ? WITHDRAWAL_PAID_CURRENCY_IDS : WITHDRAWAL_REQUESTED_CURRENCY_IDS)) : null;
    const latency = res?.date && r.date ? daysBetween(r.date, res.date) : null;
    const hasRealReasonId = r.reasonId && r.reasonId !== '0';
    return {
      displayId: hasRealReasonId ? r.reasonId : null, txId: r.id,
      requestedAt: r.date, requestedAmt: reqAmt, resolvedAt: res?.date, resolvedAmt: resAmt,
      latency, product: r.product, status: p.status, matchedBy: p.matchedBy,
    };
  }).sort((x, y) => (y.requestedAt || 0) - (x.requestedAt || 0));

  const statusPill = (p) => {
    if (p.status === 'paid') return '<span class="status-pill paid">Paid</span>';
    if (p.status === 'cancelled') return '<span class="status-pill cancelled">Cancelled</span>';
    return '<span class="status-pill pending">Pending</span>';
  };
  const approxBadge = (p) => p.matchedBy === 'amount_time'
    ? ` <span class="badge mono neu" title="Matched by same amount + timing — this wallet's resolution records don't carry a usable request id">≈</span>` : '';

  $('tblWdlPairs').innerHTML = pairs.length ? `
    <thead><tr><th>Request ID</th><th>Wallet</th><th>Requested</th><th class="num">Amount</th><th>Resolved</th><th class="num">Amount</th><th class="num">Latency</th><th>Status</th></tr></thead>
    <tbody>${pairs.map((p) => `<tr>
      <td class="mono">${p.displayId ? esc(p.displayId) : `<span class="muted">tx #${esc(p.txId)}</span>`}</td>
      <td>${productBadge({ product: p.product })}</td>
      <td class="mono">${p.requestedAt ? esc(isoDate(p.requestedAt)) : '—'}</td>
      <td class="num">${esc(fmtMoney(p.requestedAmt))}</td>
      <td class="mono">${p.resolvedAt ? esc(isoDate(p.resolvedAt)) : '<span class="muted">—</span>'}</td>
      <td class="num">${p.resolvedAmt != null ? esc(fmtMoney(p.resolvedAmt)) : '<span class="muted">—</span>'}</td>
      <td class="num">${p.latency != null ? `${fmtNum(p.latency)}d` : '<span class="muted">—</span>'}</td>
      <td>${statusPill(p)}${approxBadge(p)}</td>
    </tr>`).join('')}</tbody>` : '<tbody><tr><td class="muted" style="padding:14px">No withdrawal requests in this period.</td></tr></tbody>';

  $('wdlCount').textContent = `${fmtNum(requested.length + paid.length)} records`;
  renderTable({
    tableEl: $('tblWdl'), pagerEl: $('wdlPager'), stateKey: 'wdl',
    columns: txColumns(false), rows: [...requested, ...paid], pageSize: 50,
    emptyMessage: 'No withdrawal records match the current filters.',
    onChange: renderWithdrawals,
  });
}

/* ================================================================ *
 * TAB: Game Stats
 * ================================================================ */
function renderGameStats() {
  const k = state.agg.kpis, a = state.agg;

  // fanCents !== 0 rather than > 0: a net figure can legitimately be negative
  // on the Superstars side, and that still means there's Superstars activity
  // to break out.
  const walletSplit = (sbCents, fanCents, countLabel) => (fanCents !== 0
    ? `<span class="badge">SB ${fmtMoney(sbCents)}</span> <span class="badge neu">Superstars ${fmtMoney(fanCents)}</span>`
    : countLabel);

  $('cashGameKpis').innerHTML = [
    kpi({ label: 'Wagered', value: money(() => fmtMoney(k.cashWageredTotal)),
      sub: moneySub(() => walletSplit(k.cashWageredSportsbook, k.cashWageredFantasy, `${fmtNum(k.cashWagerCount)} picks`)) }),
    kpi({ label: 'Won (gross)', value: money(() => fmtMoney(k.cashWonTotal)), tone: 'pos',
      sub: moneySub(() => walletSplit(k.cashWonSportsbook, k.cashWonFantasy, `${fmtNum(k.cashWinCount)} wins`)) }),
    kpi({ label: 'Lost (forfeited)', value: money(() => fmtMoney(k.cashLostTotal)), tone: 'neg',
      sub: moneySub(() => `${fmtNum(k.cashLossCount)} losses`) }),
    kpi({ label: 'Net Result', value: money(() => fmtMoney(k.cashNetResult)),
      tone: state.meta?.degraded ? '' : (k.cashNetResult >= 0 ? 'pos' : 'neg'),
      valueClass: state.meta?.degraded ? '' : (k.cashNetResult >= 0 ? 'pos-text' : 'neg-text'),
      sub: moneySub(() => walletSplit(k.cashNetResultSportsbook, k.cashNetResultFantasy, 'net')) }),
    kpi({ label: 'Win Rate', value: money(() => (k.cashWinRate == null ? '—' : fmtPct(k.cashWinRate))), valueClass: 'sm',
      sub: moneySub(() => `of ${fmtNum(k.cashSettledCount)} settled`) }),
  ].join('');

  $('tokenGameKpis').innerHTML = [
    kpi({ label: 'Wagered', value: money(() => fmtNum(k.tokenWageredTotal)), sub: moneySub(() => `${fmtNum(k.tokenWagerCount)} picks`) }),
    kpi({ label: 'Won', value: money(() => fmtNum(k.tokenWonTotal)), tone: 'pos', sub: moneySub(() => `${fmtNum(k.tokenWinCount)} wins`) }),
    kpi({ label: 'Net Flow', value: money(() => fmtNum(k.tokenNetResult)),
      tone: state.meta?.degraded ? '' : (k.tokenNetResult >= 0 ? 'pos' : 'neg'),
      valueClass: state.meta?.degraded ? '' : (k.tokenNetResult >= 0 ? 'pos-text' : 'neg-text') }),
    kpi({ label: 'Pushes', value: money(() => fmtNum(k.tokenPushCount)), valueClass: 'sm' }),
    kpi({ label: 'Loss count', value: 'Not logged', valueClass: 'sm',
      sub: 'Token picks don’t create a separate loss entry — see README' }),
  ].join('');

  const days = dayKeys();
  const cashWageredSeries = CASH_CHAIN.map((c) => daySeries(days, 'day', 'wager', c)).reduce((acc, s) => acc.map((v, i) => v + Math.abs(s[i])), new Array(days.length).fill(0));
  const cashWonSeries = CASH_CHAIN.map((c) => daySeries(days, 'day', 'settlement_win', c)).reduce((acc, s) => acc.map((v, i) => v + s[i]), new Array(days.length).fill(0));
  $('chartCashWagerTrend').innerHTML = days.length > 1
    ? lineChart(days, [{ name: 'Wagered', values: cashWageredSeries, color: PALETTE[4] }, { name: 'Won', values: cashWonSeries, color: PALETTE[1] }], { format: (v) => fmtMoney(v), yFormat: shortMoney, height: 230 })
    : barChart([{ label: 'Wagered', value: k.cashWageredTotal, color: PALETTE[4] }, { label: 'Won', value: k.cashWonTotal, color: PALETTE[1] }], { format: (v) => fmtMoney(v), emptyMessage: 'No cash wagering in this period' });

  const tokWageredSeries = TOKEN_WAGER_IDS.map((c) => daySeries(days, 'day', 'wager', c)).reduce((acc, s) => acc.map((v, i) => v + Math.abs(s[i])), new Array(days.length).fill(0));
  const tokWonSeries = TOKEN_WAGER_IDS.map((c) => daySeries(days, 'day', 'settlement_win', c)).reduce((acc, s) => acc.map((v, i) => v + s[i]), new Array(days.length).fill(0));
  $('chartTokenWagerTrend').innerHTML = days.length > 1
    ? lineChart(days, [{ name: 'Wagered', values: tokWageredSeries, color: PALETTE[5] }, { name: 'Won', values: tokWonSeries, color: PALETTE[6] }], { format: (v) => fmtNum(v), height: 230 })
    : barChart([{ label: 'Wagered', value: k.tokenWageredTotal, color: PALETTE[5] }, { label: 'Won', value: k.tokenWonTotal, color: PALETTE[6] }], { format: (v) => fmtNum(v), emptyMessage: 'No token wagering in this period' });

  const outcomeItems = SETTLEMENT_CATS
    .map((cat, i) => ({ label: CATEGORIES[cat].label, value: state.filtered.filter((r) => r.category === cat).length, color: CAT_COLOR[cat] }))
    .filter((d) => d.value > 0);
  $('chartOutcomes').innerHTML = donutChart(outcomeItems, {
    format: (v) => `${fmtNum(v)} tx`,
    centerValue: fmtNum(outcomeItems.reduce((s, d) => s + d.value, 0)), centerLabel: 'Settlements',
    emptyMessage: 'No settlement records in this period',
  });

  const matrix = Array.from({ length: 7 }, () => new Array(24).fill(0));
  state.filtered.forEach((r) => { if (r.date) matrix[r.date.getDay()][r.date.getHours()] += 1; });
  $('chartHeatmap').innerHTML = heatmap(matrix, { emptyMessage: 'No dated transactions to map' });

  const settleRecs = state.filtered.filter((r) => SETTLEMENT_CATS.includes(r.category));
  renderTable({
    tableEl: $('tblSettle'), pagerEl: $('settlePager'), stateKey: 'settle',
    columns: txColumns(false).filter((c) => c.key !== 'category').concat([{
      key: 'result', label: 'Result', sort: (r) => r.category,
      render: (r) => `<span class="badge ${CATEGORIES[r.category]?.tone}">${CATEGORIES[r.category]?.label}</span>`,
      value: (r) => CATEGORIES[r.category]?.label,
    }]),
    rows: settleRecs, pageSize: 50,
    emptyMessage: 'No settlement records match the current filters.',
    onChange: renderGameStats,
  });
}

/* ================================================================ *
 * TAB: Bonuses & XP
 * ================================================================ */
function renderBonuses() {
  const k = state.agg.kpis;

  $('bonusKpis').innerHTML = [
    kpi({ label: 'Bonus Claims', value: fmtNum(k.bonusCount), tone: 'pos',
      sub: k.bonusCashFantasy > 0 ? `<span class="badge">SB ${fmtMoney(k.bonusCashSportsbook)}</span> <span class="badge neu">Superstars ${fmtMoney(k.bonusCashFantasy)}</span>` : '' }),
    kpi({ label: 'Bonus Cash (Total)', value: fmtMoney(k.bonusCashTotal), tone: 'pos', valueClass: 'sm',
      sub: k.depositBonusTotal > 0 ? `<span class="badge">Claims ${fmtMoney(k.bonusCashClaims)}</span> <span class="badge neu">Deposit-match ${fmtMoney(k.depositBonusTotal)}</span>` : '' }),
    kpi({ label: 'Bonus Coins/Tokens', value: fmtNum(k.bonusTokenTotal), valueClass: 'sm' }),
    kpi({ label: 'Deposit-Match Bonuses', value: fmtMoney(k.depositBonusTotal), tone: 'teal', valueClass: 'sm',
      sub: k.depositBonusCount ? `${fmtNum(k.depositBonusCount)}× on ${fmtMoney(k.depositBonusDepositTotal)} deposited — included in Bonus Cash (Total) above` : 'None bundled into a deposit this period' }),
    kpi({ label: 'XP Earned', value: fmtNum(k.xpGrantedTotal), tone: 'warn' }),
    kpi({ label: 'XP Grants', value: fmtNum(k.xpGrantCount), valueClass: 'sm' }),
    kpi({ label: 'XP Redeemed', value: fmtNum(k.xpRedeemedTotal), valueClass: 'sm',
      sub: k.xpRedeemCount ? `${fmtNum(k.xpRedeemCount)}× → ${fmtMoney(k.xpRedeemCashGained)} + ${fmtNum(k.xpRedeemTokenGained)} coins` : '' }),
  ].join('');

  const bonusRecs = state.filtered.filter((r) => r.category === 'bonus_claim');
  const byDay = {};
  bonusRecs.forEach((r) => { if (r.date) { const dk = isoDate(r.date); byDay[dk] = (byDay[dk] || 0) + 1; } });
  const keys = Object.keys(byDay).sort();
  $('chartBonusTrend').innerHTML = keys.length > 1
    ? columnChart(keys, [{ name: 'Bonus claims', values: keys.map((k2) => byDay[k2]), color: PALETTE[2] }], { format: (v) => fmtNum(v), height: 220 })
    : barChart(keys.map((k2) => ({ label: k2, value: byDay[k2], color: PALETTE[2] })), { format: (v) => fmtNum(v), emptyMessage: 'No bonus claims in this period' });

  const xpSources = {};
  state.filtered.filter((r) => r.category === 'xp_grant').forEach((r) => {
    xpSources[r.typeLabel] = (xpSources[r.typeLabel] || 0) + (r.entries.find((e) => e.currencyId === 5009)?.delta || 0);
  });
  const xpItems = Object.entries(xpSources).map(([lbl, v], i) => ({ label: truncate(lbl, 28), value: v, color: PALETTE[i % PALETTE.length] })).filter((d) => d.value > 0);
  $('chartXpSources').innerHTML = donutChart(xpItems, { format: (v) => fmtNum(v), centerValue: fmtNum(k.xpGrantedTotal), centerLabel: 'XP', emptyMessage: 'No XP grants in this period' });

  const depBonusRecs = state.filtered.filter((r) => r.depositBonus).sort((x, y) => (y.date || 0) - (x.date || 0));
  $('depBonusCount').textContent = `${fmtNum(depBonusRecs.length)} records`;
  renderTable({
    tableEl: $('tblDepositBonus'), pagerEl: $('depBonusPager'), stateKey: 'depBonus',
    columns: depositBonusColumns(), rows: depBonusRecs, pageSize: 50,
    emptyMessage: 'No deposits carried a bundled bonus in this period.',
    onChange: renderBonuses,
  });

  const bonAndXp = state.filtered.filter((r) => ['bonus_claim', 'xp_grant', 'xp_redeem'].includes(r.category));
  $('bonCount').textContent = `${fmtNum(bonAndXp.length)} records`;
  renderTable({
    tableEl: $('tblBon'), pagerEl: $('bonPager'), stateKey: 'bon',
    columns: txColumns(false), rows: bonAndXp, pageSize: 50,
    emptyMessage: 'No bonus/XP records match the current filters.',
    onChange: renderBonuses,
  });
}

/** Columns for the "Deposit-Match Bonuses" table — see parseDepositBonus() in core.js. */
function depositBonusColumns() {
  return [
    { key: 'date', label: 'Timestamp', cls: 'mono', width: '146px',
      sort: (r) => (r.date ? r.date.getTime() : 0), render: (r) => esc(r.dateText), value: (r) => r.dateText },
    { key: 'id', label: 'ID', cls: 'mono', sort: (r) => toNumber(r.id) || 0, render: (r) => esc(r.id), value: (r) => r.id },
    { key: 'product', label: 'Wallet', sort: (r) => r.product, render: productBadge, value: (r) => PRODUCT_LABEL[r.product] || r.product },
    { key: 'deposit', label: 'Deposit Paid', cls: 'num', sort: (r) => r.depositBonus.depositAmount,
      render: (r) => esc(fmtMoney(r.depositBonus.depositAmount)), value: (r) => fmtMoney(r.depositBonus.depositAmount) },
    { key: 'pct', label: 'Bonus %', cls: 'num', sort: (r) => r.depositBonus.bonusPercent ?? 0,
      render: (r) => r.depositBonus.bonusPercent != null ? `${esc(fmtNum(r.depositBonus.bonusPercent))}%` : '<span class="muted">—</span>',
      value: (r) => r.depositBonus.bonusPercent },
    { key: 'bonus', label: 'Bonus Received', cls: 'num', sort: (r) => r.depositBonus.bonusAmount,
      render: (r) => `<b class="pos-text">${esc(fmtMoney(r.depositBonus.bonusAmount))}</b>`, value: (r) => fmtMoney(r.depositBonus.bonusAmount) },
    { key: 'total', label: 'Total Credited', cls: 'num', sort: (r) => r.depositBonus.totalReceived,
      render: (r) => esc(fmtMoney(r.depositBonus.totalReceived)), value: (r) => fmtMoney(r.depositBonus.totalReceived) },
    { key: 'pending', label: 'Amount Pending', cls: 'num', sort: (r) => r.depositBonus.pending,
      render: (r) => esc(fmtMoney(r.depositBonus.pending)), value: (r) => fmtMoney(r.depositBonus.pending) },
    { key: 'multiplier', label: 'Play-Through', cls: 'num', sort: (r) => r.depositBonus.playthroughMultiplier ?? 0,
      render: (r) => r.depositBonus.playthroughMultiplier != null ? `${esc(fmtNum(r.depositBonus.playthroughMultiplier))}×` : '<span class="muted">—</span>',
      value: (r) => r.depositBonus.playthroughMultiplier },
    { key: 'max', label: 'Max Bonus', cls: 'num', sort: (r) => r.depositBonus.maxBonus ?? 0,
      render: (r) => r.depositBonus.maxBonus != null ? esc(fmtMoney(r.depositBonus.maxBonus)) : '<span class="muted">—</span>',
      value: (r) => r.depositBonus.maxBonus },
    { key: 'campaign', label: 'Campaign', cls: 'mono', sort: (r) => r.depositBonus.campaignCode,
      render: (r) => `${esc(r.depositBonus.campaignCode)}${r.depositBonus.campaignType != null ? ` <span class="badge mono neu">${esc(r.depositBonus.campaignType)}</span>` : ''}`,
      value: (r) => r.depositBonus.campaignCode },
  ];
}

/* ================================================================ *
 * TAB: Wallet & Ledger
 * ================================================================ */
function renderWallet() {
  const wallet = Object.entries(state.agg.byWallet).sort((x, y) => y[1].count - x[1].count);

  if (!wallet.length) {
    $('tblCodes').innerHTML = '<tbody><tr><td class="muted" style="padding:14px">No currency movements in the filtered period.</td></tr></tbody>';
  } else {
    $('tblCodes').innerHTML = `
      <thead><tr>
        <th>Currency</th><th>Wallet</th><th>Kind</th><th class="num">Entries</th><th class="num">Inflow</th><th class="num">Outflow</th><th class="num">Net</th>
      </tr></thead>
      <tbody>${wallet.map(([id, v]) => {
        const m = currencyMeta(Number(id));
        return `<tr>
          <td><span class="badge mono neu">${esc(id)}</span> ${esc(v.label)}</td>
          <td>${productBadge({ product: m.product })}</td>
          <td><span class="kind-pill ${v.kind}">${v.kind}</span></td>
          <td class="num">${esc(fmtNum(v.count))}</td>
          <td class="num pos-text">${esc(fmtByKind(v.kind, v.inflow))}</td>
          <td class="num neg-text">${esc(fmtByKind(v.kind, v.outflow))}</td>
          <td class="num"><b>${esc(fmtByKind(v.kind, v.inflow - v.outflow))}</b></td>
        </tr>`;
      }).join('')}</tbody>`;
  }

  const cashItems = wallet.filter(([, v]) => v.kind === 'cash')
    .map(([id, v]) => {
      const net = v.inflow - v.outflow;
      return { label: currencyMeta(Number(id)).label, value: Math.abs(net), color: net >= 0 ? PALETTE[1] : PALETTE[3] };
    });
  $('chartCashFlow').innerHTML = barChart(cashItems, { format: (v) => fmtMoney(v), emptyMessage: 'No cash currency activity in this period' });

  const tokenItems = wallet.filter(([, v]) => v.kind === 'token')
    .map(([id, v], i) => ({ label: currencyMeta(Number(id)).label, value: Math.abs(v.inflow - v.outflow), color: (v.inflow - v.outflow) >= 0 ? PALETTE[5] : PALETTE[9] }));
  $('chartTokenFlow').innerHTML = barChart(tokenItems, { format: (v) => fmtNum(v), emptyMessage: 'No token currency activity in this period' });
}

/* ================================================================ *
 * TAB: Risk
 * ================================================================ */
const RISK_ICON = { high: '⛔', med: '⚠', low: 'ℹ', ok: '✓' };
const RISK_WORD = { high: 'High', med: 'Review', low: 'Note', ok: 'Clear' };

const CONFIDENCE_BADGE = {
  [CONFIDENCE.AUTHORITATIVE]: '',
  [CONFIDENCE.INFERRED]: '<span class="badge warn" title="Built on a heuristic fallback — corroborate before relying on it">inferred</span>',
  [CONFIDENCE.UNKNOWN]: '<span class="badge neu" title="Built on an unmapped type code — corroborate before relying on it">unknown</span>',
};

function renderRisk() {
  const a = state.agg;
  const signals = riskSignals(a);

  const cc = a.confidenceCounts || {};
  $('confidenceSummary').innerHTML =
    `<span class="badge">${fmtNum(cc.authoritative || 0)} authoritative</span>` +
    `<span class="badge warn">${fmtNum(cc.inferred || 0)} inferred</span>` +
    `<span class="badge neu">${fmtNum(cc.unknown || 0)} unknown</span>` +
    ' <span class="muted">(record counts for the currently filtered period)</span>';

  $('riskList').innerHTML = signals.map((s) => `
    <div class="risk-item ${s.level}">
      <span class="risk-ico">${RISK_ICON[s.level]}</span>
      <div>
        <div class="risk-label">${esc(s.label)} ${CONFIDENCE_BADGE[s.confidence] || ''}</div>
        <div class="risk-detail">${esc(s.detail)}</div>
      </div>
      <span class="risk-level">${RISK_WORD[s.level]}</span>
    </div>`).join('');

  const historyTable = (recs) => recs.length ? `
    <thead><tr><th>Date</th><th>ID</th><th>History</th></tr></thead>
    <tbody>${recs.map((r) => `<tr>
      <td class="mono">${esc(r.dateText)}</td>
      <td class="mono">${esc(r.id)}</td>
      <td>${esc(r.history)}</td>
    </tr>`).join('')}</tbody>` : '<tbody><tr><td class="muted" style="padding:14px">None in this period.</td></tr></tbody>';

  $('tblReversals').innerHTML = historyTable(state.filtered.filter((r) => r.category === 'reversal'));
  $('tblManual').innerHTML = historyTable(state.filtered.filter((r) => r.category === 'manual_admin'));

  $('anomalyList').innerHTML = a.anomalies.length
    ? a.anomalies.map((an) => `<div class="risk-item high"><span class="risk-ico">⛔</span><div>
        <div class="risk-label">${esc(an.record.id)} — ${esc(an.record.dateText)}</div>
        <div class="risk-detail">${esc(an.note)} History: ${esc(an.record.history)}</div>
      </div></div>`).join('')
    : '<p class="muted" style="margin:0">No sign anomalies detected.</p>';

  $('tblUnmapped').innerHTML = a.unmapped.length ? `
    <thead><tr><th class="num">Type Code</th><th class="num">Count</th><th>Sample History</th></tr></thead>
    <tbody>${a.unmapped.map((u) => {
      const sample = state.filtered.find((r) => r.type === u.type);
      return `<tr><td class="num mono">${esc(u.type)}</td><td class="num">${fmtNum(u.count)}</td><td>${esc(truncate(sample?.history, 90))}</td></tr>`;
    }).join('')}</tbody>` : '<tbody><tr><td class="muted" style="padding:14px">Every transaction type in this period matched a category rule.</td></tr></tbody>';

  const tblInferred = $('tblInferredFantasy');
  if (tblInferred) {
    tblInferred.innerHTML = a.inferredFantasy.length ? `
      <thead><tr><th class="num">Type Code</th><th class="num">Count</th><th>Inferred Category</th><th>Sample History</th></tr></thead>
      <tbody>${a.inferredFantasy.map((u) => {
        const sample = state.filtered.find((r) => r.type === u.type);
        return `<tr>
          <td class="num mono">${esc(u.type)}</td>
          <td class="num">${fmtNum(u.count)}</td>
          <td><span class="badge warn">${esc(CATEGORIES[u.category]?.label || u.category)} (inferred)</span></td>
          <td>${esc(truncate(sample?.history, 90))}</td>
        </tr>`;
      }).join('')}</tbody>` : '<tbody><tr><td class="muted" style="padding:14px">No fantasy-wallet transactions relied on pattern-based inference in this period.</td></tr></tbody>';
  }
}

/* ================================================================ *
 * TAB: Raw
 * ================================================================ */
function renderRaw() {
  const wallet = Object.entries(state.agg.byWallet).sort((x, y) => Number(x[0]) - Number(y[0]));
  $('currencySchemaSub').textContent = `${wallet.length} active currencies`;
  $('tblCurrencySchema').innerHTML = wallet.length ? `
    <thead><tr><th class="num">ID</th><th>Label</th><th>Kind</th><th></th></tr></thead>
    <tbody>${wallet.map(([id, v]) => {
      const m = currencyMeta(Number(id));
      return `<tr><td class="num mono">${esc(id)}</td><td>${esc(v.label)}</td><td><span class="kind-pill ${v.kind}">${v.kind}</span></td>
        <td>${m.inferred ? '<span class="badge warn">unclassified — defaulted to token</span>' : ''}</td></tr>`;
    }).join('')}</tbody>` : '<tbody><tr><td class="muted" style="padding:14px">No currency activity.</td></tr></tbody>';

  const types = Object.entries(state.agg.byType).sort((x, y) => y[1].count - x[1].count);
  $('typeSchemaSub').textContent = `${types.length} distinct type codes`;
  $('tblTypeSchema').innerHTML = types.length ? `
    <thead><tr><th class="num">Type</th><th>Label</th><th>Category</th><th class="num">Count</th></tr></thead>
    <tbody>${types.map(([t, v]) => `<tr>
      <td class="num mono">${esc(t)}</td><td>${esc(v.label)}</td>
      <td><span class="badge ${CATEGORIES[v.category]?.tone || 'neu'}">${esc(CATEGORIES[v.category]?.label || v.category)}</span></td>
      <td class="num">${fmtNum(v.count)}</td>
    </tr>`).join('')}</tbody>` : '<tbody><tr><td class="muted" style="padding:14px">No records.</td></tr></tbody>';

  const rawKeys = [...new Set(state.filtered.flatMap((x) => Object.keys(x.raw)))];
  $('rawSub').textContent = `${fmtNum(state.filtered.length)} rows · ${rawKeys.length} fields`;

  renderTable({
    tableEl: $('tblRaw'), pagerEl: $('rawPager'), stateKey: 'raw',
    columns: rawKeys.map((rk) => ({
      key: rk, label: rk, cls: 'mono',
      sort: (x) => String(x.raw[rk] || ''),
      render: (x) => esc(truncate(x.raw[rk], 60)),
      value: (x) => x.raw[rk] || '',
    })),
    rows: state.filtered, pageSize: 50,
    emptyMessage: 'No rows to show.',
    onChange: renderRaw,
  });
}

/* ================================================================ *
 * Generic sortable + paginated table
 * ================================================================ */
function renderTable({ tableEl, pagerEl, stateKey, columns, rows, pageSize, emptyMessage, onChange }) {
  const st = (state.tableState[stateKey] = state.tableState[stateKey] || { sortKey: columns[0]?.key, dir: -1, page: 0 });

  if (!columns.length || !rows.length) {
    tableEl.innerHTML = `<tbody><tr><td class="muted" style="padding:16px">${esc(emptyMessage)}</td></tr></tbody>`;
    if (pagerEl) pagerEl.innerHTML = '';
    return;
  }

  const sortCol = columns.find((c) => c.key === st.sortKey) || columns[0];
  const sorted = [...rows].sort((a, b) => {
    const va = sortCol.sort(a), vb = sortCol.sort(b);
    if (typeof va === 'string' || typeof vb === 'string') {
      return String(va).localeCompare(String(vb)) * st.dir;
    }
    return ((Number(va) || 0) - (Number(vb) || 0)) * st.dir;
  });

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  st.page = Math.min(st.page, pages - 1);
  const slice = sorted.slice(st.page * pageSize, st.page * pageSize + pageSize);

  tableEl.innerHTML = `
    <thead><tr>${columns.map((c) => {
      const active = c.key === sortCol.key;
      return `<th class="sortable ${c.cls === 'num' ? 'num' : ''} ${active ? 'sorted' : ''}" data-key="${esc(c.key)}"
        ${c.width ? `style="min-width:${c.width}"` : ''}>${esc(c.label)}<span class="arrow">${active ? (st.dir === -1 ? '▼' : '▲') : '▾'}</span></th>`;
    }).join('')}</tr></thead>
    <tbody>${slice.map((row) => `<tr>${columns.map((c) =>
      `<td class="${c.cls || ''}">${c.render(row)}</td>`).join('')}</tr>`).join('')}</tbody>`;

  tableEl.querySelectorAll('th.sortable').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (st.sortKey === key) st.dir = -st.dir;
    else { st.sortKey = key; st.dir = -1; }
    st.page = 0;
    onChange();
  }));

  if (pagerEl) {
    const from = st.page * pageSize + 1;
    const to = Math.min(sorted.length, (st.page + 1) * pageSize);
    pagerEl.innerHTML = `
      <button type="button" class="btn btn-sm" data-go="first" ${st.page === 0 ? 'disabled' : ''}>« First</button>
      <button type="button" class="btn btn-sm" data-go="prev" ${st.page === 0 ? 'disabled' : ''}>‹ Prev</button>
      <span>Rows <b>${fmtNum(from)}–${fmtNum(to)}</b> of <b>${fmtNum(sorted.length)}</b></span>
      <span class="spacer"></span>
      <span>Page ${st.page + 1} / ${pages}</span>
      <button type="button" class="btn btn-sm" data-go="next" ${st.page >= pages - 1 ? 'disabled' : ''}>Next ›</button>
      <button type="button" class="btn btn-sm" data-go="last" ${st.page >= pages - 1 ? 'disabled' : ''}>Last »</button>`;
    pagerEl.querySelectorAll('button[data-go]').forEach((b) => b.addEventListener('click', () => {
      const go = b.dataset.go;
      if (go === 'first') st.page = 0;
      else if (go === 'prev') st.page = Math.max(0, st.page - 1);
      else if (go === 'next') st.page = Math.min(pages - 1, st.page + 1);
      else st.page = pages - 1;
      onChange();
    }));
  }
}

/* ================================================================ *
 * Export
 * ================================================================ */
function download(filename, text, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function stamp() {
  const d = new Date();
  return `${isoDate(d)}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

function exportCSV() {
  if (!state.filtered.length) return banner('warn', 'Nothing to export for the current filters.', 3000);
  if (state.meta?.degraded) {
    return banner('error', 'Refusing to export: this fetch carried no per-currency columns, so every '
      + 'amount column would export as blank/zero and read as real data in a spreadsheet. '
      + 'Export the CSV from Django admin directly instead.');
  }
  const currencyIds = Object.keys(state.agg.byWallet).map(Number).sort((a, b) => a - b);
  const cols = [
    { label: 'Transaction ID', value: (r) => r.id },
    { label: 'Timestamp', value: (r) => r.dateText },
    { label: 'Type Code', value: (r) => r.type },
    { label: 'Type Label', value: (r) => r.typeLabel },
    { label: 'Category', value: (r) => CATEGORIES[r.category]?.label || r.category },
    ...currencyIds.map((id) => {
      const m = currencyMeta(id);
      // Real numbers, not .toFixed(2) strings — keeps the column
      // spreadsheet-numeric (sortable/summable) and keeps a legitimate
      // negative amount like -12.34 from tripping the CSV formula-injection
      // guard in toCSV(), which only escapes string-typed values.
      // Header carries the real unit (FC vs $ vs token count) so an exported
      // sheet can't be misread as all-dollars once it's out of this tool.
      return { label: `${m.label} (${m.kind})`, value: (r) => { const e = r.entries.find((x) => x.currencyId === id); return e ? (m.kind === 'cash' ? e.delta / 100 : e.delta) : ''; } };
    }),
    { label: 'Reason / Pick ID', value: (r) => r.reasonId },
    { label: 'History', value: (r) => r.history },
  ];
  download(`fliff_player_${state.userId}_transactions_${stamp()}.csv`, toCSV(state.filtered, cols), 'text/csv');
  banner('ok', `Exported ${state.filtered.length} rows to CSV.`, 3000);
}

function exportJSON() {
  if (!state.records.length) return banner('warn', 'Load a player first.', 3000);
  const a = state.agg;
  const payload = {
    generatedAt: new Date().toISOString(),
    source: { host: 'fw10.app.corp.getfliff.com', shard: 32, profileUrl: PROFILE_PATH(state.userId), transactionsUrl: `${TX_PATH}?q=${state.userId}` },
    fetch: {
      method: state.meta.method, complete: state.meta.complete,
      serverReported: state.meta.reported, rowsFetched: state.meta.rowCount,
      // Travels with the export: a consumer of this JSON has no other way to
      // know the kpis block is all zeros because the columns were missing
      // rather than because the player had no activity.
      hasCurrencyData: state.meta.hasCurrencyData !== false,
      degraded: !!state.meta.degraded,
      exportSkipped: state.meta.exportSkipped || undefined,
      ...(state.meta.degraded ? {
        warning: 'This fetch carried no per-currency columns. Every monetary figure in "kpis" '
          + 'and "byWallet" is zero because the data was unavailable, NOT because it was zero. '
          + 'Do not use these figures for reconciliation, fraud, or compliance purposes.',
      } : {}),
    },
    player: { userId: state.userId, ...stripProfile(state.profile) },
    filters: state.filters,
    period: { from: a.firstSeen, to: a.lastSeen, activeDays: a.activeDays, transactions: a.total },
    kpis: a.kpis,
    byWallet: a.byWallet,
    byType: a.byType,
    unmappedTypes: a.unmapped,
    confidenceCounts: a.confidenceCounts,
    anomalies: a.anomalies.map((x) => ({ id: x.record.id, note: x.note })),
    riskSignals: riskSignals(a),
    transactions: state.filtered.map((r) => ({
      id: r.id, timestamp: r.date ? r.date.toISOString() : null, type: r.type, typeLabel: r.typeLabel,
      category: r.category, confidence: r.confidence, entries: r.entries, reasonId: r.reasonId, history: r.history,
      depositBonus: r.depositBonus || undefined, raw: r.raw,
    })),
  };
  download(`fliff_player_${state.userId}_report_${stamp()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  banner('ok', 'Exported full report as JSON.', 3000);
}

function stripProfile(p) {
  if (!p) return { profileAvailable: false };
  const { all, ...rest } = p;
  return { profileAvailable: true, ...rest, allFields: all };
}

/* ================================================================ *
 * Utils
 * ================================================================ */
function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* Everything is declared — safe to start. */
init();
