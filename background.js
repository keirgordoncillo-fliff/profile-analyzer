/**
 * background.js — service worker.
 * Opens the side panel on toolbar click and exposes a context-menu shortcut
 * that jumps straight into the full IMS report for the player on screen.
 *
 * Also the sole gatekeeper for the id-auto-link scanner (content.js): per
 * the security review, that scanner is no longer a persistent <all_urls>
 * content script. It's injected on demand, only into the current tab, only
 * after an explicit user gesture (the "Scan this page" context-menu item —
 * activeTab grants this worker temporary host access to that one tab for
 * that gesture, see https://developer.chrome.com/docs/extensions/develop/concepts/activeTab),
 * and only when that tab's URL matches ALLOWED_SCAN_HOSTS below.
 */

// PLAYER_ID_RE / normalizePlayerId are duplicated verbatim from lib/core.js.
// background.js is a classic (non-module) service worker, so it can't use a
// static `import` of an ES module — see the comment above the canonical
// copy in lib/core.js. tests/validatorsynctest.mjs asserts byte-for-byte
// equality between every copy of this block so they can never silently
// drift apart.
// --- BEGIN shared validator (keep in sync with lib/core.js) ---
const PLAYER_ID_RE = /^\d{4,10}$/;
function normalizePlayerId(value) {
  const id = String(value ?? '').trim();
  if (!PLAYER_ID_RE.test(id)) throw new Error('Invalid player ID');
  return id;
}
// --- END shared validator ---

const REPORT_PAGE = 'report.html';

/**
 * Exact tenant hosts approved by Security for the id-auto-link scanner.
 *
 * IMPORTANT: the fw10.app.corp.getfliff.com entry is real (it's this
 * extension's own admin backend, same as host_permissions above). Every
 * other entry below is a PLACEHOLDER — "REPLACE_ME_..." is not a resolvable
 * hostname and will never match a real tab, so the scanner fails closed
 * (cannot be injected anywhere) until Security replaces these with the
 * actual approved Slack/Zendesk/Atlassian/internal-dashboard hostnames.
 * Exact hostnames only, no wildcards — matched against tab.url's hostname
 * with strict equality in isAllowedScanHost() below.
 */
const ALLOWED_SCAN_HOSTS = new Set([
  'fw10.app.corp.getfliff.com',
  'fliff.zendesk.com',
  'REPLACE_ME_fliff.slack.com',
  'REPLACE_ME_fliff.atlassian.net',
  'REPLACE_ME_internal-dashboard.corp.getfliff.com',
]);

function isAllowedScanHost(url) {
  try { return ALLOWED_SCAN_HOSTS.has(new URL(url).hostname); }
  catch { return false; }
}

/** Shared rate limiter — every path that can open a report tab (context
 * menu, keyboard shortcut, or a message from the injected scanner) goes
 * through this. Caps how often this worker will act, independent of which
 * trigger fired, so a compromised/buggy page spamming messages (or a runaway
 * click loop) can't turn "open a report" into a tab-spawning denial of
 * service against the analyst's own browser. */
const RATE_LIMIT_WINDOW_MS = 10000;
const RATE_LIMIT_MAX = 5;
let recentActions = [];
function rateLimitOk() {
  const now = Date.now();
  recentActions = recentActions.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recentActions.length >= RATE_LIMIT_MAX) return false;
  recentActions.push(now);
  return true;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'openReportForSelection',
      title: 'Fliff IMS: open report for "%s"',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'openReportForPage',
      title: 'Fliff IMS: open report for this player',
      contexts: ['page'],
      documentUrlPatterns: ['https://fw10.app.corp.getfliff.com/*'],
    });
    chrome.contextMenus.create({
      id: 'openReportBlank',
      title: 'Fliff IMS: open blank report',
      contexts: ['action'],
    });
    chrome.contextMenus.create({
      id: 'scanPageForIds',
      title: 'Fliff IMS: scan this page for account IDs',
      contexts: ['page'],
      // UI-level convenience only (Chrome hides the item on non-matching
      // pages) — the real gate is isAllowedScanHost() in scanTab() below,
      // checked again independently of whether the menu item was shown.
      documentUrlPatterns: [...ALLOWED_SCAN_HOSTS].map((h) => `https://${h}/*`),
    });
  });
});

// content.js (injected on demand, see scanTab()) sends this when someone
// clicks an auto-detected account/player/user-id chip it found in the page
// text. Validated per the security review: sender identity, a real
// originating tab, that tab's URL against the same tenant allowlist used to
// gate injection in the first place, a strictly-validated id, and the
// shared rate limiter.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'fliff-ims-open-report') return;

  if (sender.id !== chrome.runtime.id) return; // not a message from this extension's own contexts
  if (!sender.tab || !Number.isInteger(sender.tab.id)) return; // no real originating tab
  if (!sender.tab.url || !isAllowedScanHost(sender.tab.url)) return; // tab not on the approved allowlist

  let id;
  try { id = normalizePlayerId(msg.userId); } catch { return; }

  if (!rateLimitOk()) { console.warn('[Fliff IMS] rate limit hit — dropping open-report message'); return; }
  openReport(id);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'openReportForSelection') {
    let id = null;
    try { id = normalizePlayerId((info.selectionText || '').trim()); } catch { /* reject, don't sanitize-and-continue */ }
    if (!id) return; // silently no-op on a selection that isn't a bare id — no partial/garbled fetches
    if (!rateLimitOk()) return;
    return openReport(id);
  }
  if (info.menuItemId === 'openReportForPage') {
    const id = playerIdFromUrl(tab?.url || info.pageUrl || '');
    if (!id || !rateLimitOk()) return;
    return openReport(id);
  }
  if (info.menuItemId === 'openReportBlank') {
    if (!rateLimitOk()) return;
    return openReport(null);
  }
  if (info.menuItemId === 'scanPageForIds') return scanTab(tab);
});

// Keyboard shortcut (bind in chrome://extensions/shortcuts)
chrome.commands?.onCommand.addListener((command) => {
  if (command !== 'open-report') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = playerIdFromUrl(tabs?.[0]?.url || '');
    if (!id || !rateLimitOk()) return;
    openReport(id);
  });
});

function playerIdFromUrl(url) {
  const m = String(url).match(/usercontestprofileshard_\d+\/(\d+)\//) || String(url).match(/[?&]q=(\d+)/);
  if (!m) return null;
  try { return normalizePlayerId(m[1]); } catch { return null; }
}

function openReport(userId) {
  let id = null;
  if (userId != null) {
    try { id = normalizePlayerId(userId); } catch { return; } // fail closed — never build a URL from an unvalidated id
  }
  const url = chrome.runtime.getURL(REPORT_PAGE) + (id ? `?userId=${encodeURIComponent(id)}` : '');
  chrome.tabs.create({ url });
}

/**
 * Inject the id-auto-link scanner into one tab, on demand, following the
 * "Scan this page" context-menu gesture. This is the whole point of moving
 * off a persistent <all_urls> content script: the scanner only ever runs
 * where the user explicitly asked for it, on the one page they were looking
 * at, gated by activeTab's temporary per-gesture grant — not everywhere,
 * all the time.
 */
function scanTab(tab) {
  if (!tab?.id || !tab.url || !isAllowedScanHost(tab.url)) return;
  chrome.scripting.insertCSS({ target: { tabId: tab.id, allFrames: false }, files: ['content.css'] }).catch(() => {});
  chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: false }, files: ['content.js'] }).catch((e) => {
    console.warn('[Fliff IMS] scan injection failed', e);
  });
}
