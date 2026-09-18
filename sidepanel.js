/**
 * sidepanel.js — compact quick-lookup companion.
 * Heavy analysis lives in report.html; this panel gives an instant read and
 * hands off to the full report.
 */

import { CATEGORIES, normalizeAll, aggregate, fmtMoney, fmtNum, fmtPct, isoDate, PROFILE_PATH, normalizePlayerId } from './lib/core.js';
import { fetchProfile, fetchTransactions } from './lib/fetcher.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let currentId = null;
let controller = null;

init();

function init() {
  const saved = localStorage.getItem('fliff.theme');
  if (saved) document.documentElement.dataset.theme = saved;
  else if (window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';

  $('themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('fliff.theme', next);
  });

  $('lookupForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('userIdInput').value.trim();
    if (id) loadProfile(id);
  });

  $('loadTxBtn').addEventListener('click', () => currentId && loadTransactions(currentId));
  $('fullReportBtn').addEventListener('click', () => openReport(currentId));
  $('openBlankReport').addEventListener('click', () => openReport(null));
  $('adminBtn').addEventListener('click', () => {
    if (currentId) chrome.tabs.create({ url: PROFILE_PATH(currentId) });
  });

  // Prefill from the active tab if it is already on a player page.
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs?.[0]?.url || '';
    const m = url.match(/usercontestprofileshard_\d+\/(\d+)\//) || url.match(/[?&]q=(\d+)/);
    let id = null;
    if (m) { try { id = normalizePlayerId(m[1]); } catch { /* ignore, treat as no match */ } }
    if (id) { $('userIdInput').value = id; status('info', `Detected player ${id} on the current tab.`); }
    else $('userIdInput').focus();
  });
}

function openReport(userId) {
  let id = null;
  if (userId != null) {
    try { id = normalizePlayerId(userId); } catch { return; } // fail closed — never build a URL from an unvalidated id
  }
  const url = chrome.runtime.getURL('report.html') + (id ? `?userId=${encodeURIComponent(id)}` : '');
  chrome.tabs.create({ url });
}

function status(kind, msg) {
  const el = $('status');
  el.className = `sp-status ${kind}`;
  el.textContent = msg;
  el.classList.remove('hidden');
}
function footState(s) { $('footState').textContent = s; }

function kpiTile({ label, value, tone = '', small, title }) {
  return `<div class="sp-kpi ${tone}"${title ? ` title="${esc(title)}"` : ''}>
    <div class="sp-kpi-label">${esc(label)}</div>
    <div class="sp-kpi-value ${small ? 'sm' : ''}">${esc(value)}</div>
  </div>`;
}

/* ------------------------------------------------------------------ */

async function loadProfile(userId) {
  // Single validation chokepoint (lookup form, tab-detected prefill) —
  // reject outright rather than sanitize-and-continue, per the security
  // review.
  try { userId = normalizePlayerId(userId); }
  catch { return status('error', `"${userId}" is not a valid player ID — expected 4-10 digits.`); }

  controller?.abort();
  controller = new AbortController();
  currentId = userId;

  $('emptyCard').classList.add('hidden');
  $('queryBtn').disabled = true;
  status('info', 'Fetching profile…');
  footState('Loading profile');

  try {
    const p = await fetchProfile(userId, { signal: controller.signal });

    $('pName').textContent = p.username || `Player ${userId}`;
    $('pId').textContent = `ID ${userId}`;

    const fmtDollars = (n) => Number.isFinite(n) ? fmtMoney(n * 100) : '—';
    const pTiles = [
      kpiTile({ label: 'Net Value', value: p.netValue || '—', tone: 'teal', small: true }),
      kpiTile({ label: 'FC Balance', value: p.balance || '—', small: true }),
      kpiTile({ label: 'Purchases (SB)', value: p.purchases || '—', tone: 'pos', small: true,
        title: 'Sportsbook wallet, from the profile page\'s "SportsBook" panel.' }),
    ];
    if (p.hasFantasy) pTiles.push(kpiTile({ label: 'Purchases (Superstars)', value: p.fantasyDeposits || '—', tone: 'pos', small: true,
      title: 'Superstars (Fantasy) wallet, from the profile page\'s "Superstars" panel. Real dollars — the Superstars wallet has no Fliff Cash equivalent.' }));
    if (p.hasFantasy) pTiles.push(kpiTile({ label: 'Purchases (Combined)', value: fmtDollars(p.combinedPurchasesNum), tone: 'pos', small: true,
      title: 'Sportsbook + Superstars combined — matches the full IMS report\'s Deposits KPI.' }));
    pTiles.push(kpiTile({ label: 'Redemptions (SB)', value: p.redemptions || '—', tone: 'neg', small: true,
      title: 'Sportsbook wallet, from the profile page\'s "SportsBook" panel.' }));
    if (p.hasFantasy) pTiles.push(kpiTile({ label: 'Redemptions (Superstars)', value: p.fantasyWithdrawRequests || '—', tone: 'neg', small: true,
      title: 'Superstars (Fantasy) wallet, from the "Superstars" panel\'s "Withdraw Requests" field — despite the name, this is the cumulative PAID balance (confirmed against running balances), not just the requested amount.' }));
    if (p.hasFantasy) pTiles.push(kpiTile({ label: 'Redemptions (Combined)', value: fmtDollars(p.combinedRedemptionsNum), tone: 'neg', small: true,
      title: 'Sportsbook + Superstars combined — matches the full IMS report\'s Withdrawals Paid KPI.' }));
    pTiles.push(
      kpiTile({ label: 'Fresh Coins', value: p.freshCoins || '—', tone: 'warn', small: true }),
      kpiTile({ label: 'Won Coins', value: p.wonCoins || '—', tone: 'warn', small: true }),
    );
    $('pKpis').innerHTML = pTiles.join('');

    const row = (l, v) => v ? `<tr><th>${esc(l)}</th><td>${esc(v)}</td></tr>` : '';
    const meta = [
      row('Email', p.email), row('Phone', p.phone), row('Status', p.status),
      row('KYC', p.kyc), row('Registered', p.registered),
      row('User Tags', (p.userTags || []).join(', ')),
      row('Last active', p.lastActive),
    ].join('');
    $('pMeta').innerHTML = meta
      ? `<tbody>${meta}</tbody>`
      : '<tbody><tr><td class="muted" style="padding:8px">No additional fields captured.</td></tr></tbody>';

    $('profileCard').classList.remove('hidden');
    $('loadTxBtn').classList.remove('hidden');
    $('fullReportBtn').classList.remove('hidden');
    $('adminBtn').classList.remove('hidden');
    status('ok', 'Profile loaded. Analyze transactions or open the full report.');
    footState('Profile ready');
  } catch (e) {
    if (e.name === 'AbortError') { footState('Cancelled'); return; }
    status('error', e.message);
    footState('Error');
    $('fullReportBtn').classList.remove('hidden');
    $('adminBtn').classList.remove('hidden');
  } finally {
    $('queryBtn').disabled = false;
  }
}

async function loadTransactions(userId) {
  controller?.abort();
  controller = new AbortController();
  $('loadTxBtn').disabled = true;
  footState('Loading ledger');

  try {
    const tx = await fetchTransactions(userId, {
      signal: controller.signal,
      onProgress: (p) => status('info', p.message),
    });

    const records = normalizeAll(tx.rows);
    const a = aggregate(records);
    const k = a.kpis;

    $('txMeta').textContent = `${fmtNum(records.length)} records`;
    $('txKpis').innerHTML = [
      kpiTile({ label: 'Deposits', value: fmtMoney(k.depositTotal), tone: 'pos', small: true }),
      kpiTile({ label: 'Withdrawals Paid', value: fmtMoney(k.withdrawalPaidTotal), tone: 'neg', small: true }),
      kpiTile({ label: 'Global Value', value: fmtMoney(k.netCash), tone: k.netCash >= 0 ? 'pos' : 'neg', small: true,
        title: 'Deposits − withdrawals paid, from the filtered ledger. Matches the admin\'s "Global / net value" field.' }),
      kpiTile({ label: 'Cash Wager Net', value: fmtMoney(k.cashNetResult), tone: 'teal', small: true,
        title: `Sportsbook ${fmtMoney(k.cashNetResultSportsbook)} + Superstars ${fmtMoney(k.cashNetResultFantasy)}.` }),
      kpiTile({ label: 'Cash Win Rate', value: k.cashWinRate == null ? '—' : fmtPct(k.cashWinRate), small: true }),
      kpiTile({ label: 'Token Wager Net', value: fmtNum(k.tokenNetResult), tone: 'warn', small: true }),
      kpiTile({ label: 'Bonus Cash', value: fmtMoney(k.bonusCashTotal), tone: 'warn', small: true }),
      kpiTile({ label: 'XP Earned', value: fmtNum(k.xpGrantedTotal), tone: 'warn', small: true }),
    ].join('');

    const catCounts = {};
    records.forEach((r) => { catCounts[r.category] = (catCounts[r.category] || 0) + 1; });
    const cats = Object.entries(catCounts).sort((x, y) => y[1] - x[1]);
    $('catTable').innerHTML = `
      <thead><tr><th>Category</th><th class="num">Tx</th></tr></thead>
      <tbody>${cats.map(([c, count]) => `<tr>
        <td><span class="badge ${CATEGORIES[c]?.tone || 'neu'}">${esc(CATEGORIES[c]?.label || c)}</span></td>
        <td class="num">${fmtNum(count)}</td>
      </tr>`).join('')}</tbody>`;

    $('txCard').classList.remove('hidden');

    const span = a.firstSeen && a.lastSeen ? ` · ${isoDate(a.firstSeen)} → ${isoDate(a.lastSeen)}` : '';
    if (!tx.complete) status('warn', `Loaded ${records.length} of ${tx.reported ?? 'unknown'} records — open the full report for a complete fetch.${span}`);
    else status('ok', `${records.length} records via ${tx.method}${span}`);
    footState('Ledger ready');
  } catch (e) {
    if (e.name === 'AbortError') { footState('Cancelled'); return; }
    status('error', e.message);
    footState('Error');
  } finally {
    $('loadTxBtn').disabled = false;
  }
}
