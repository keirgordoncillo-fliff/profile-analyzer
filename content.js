/**
 * content.js — the id-auto-link scanner. NOT a persistent content script:
 * per the security review, this is injected on demand by background.js's
 * scanTab() after the user explicitly runs "Fliff IMS: scan this page for
 * account IDs" from the right-click menu, only into that one tab, and only
 * when that tab's URL is on the ALLOWED_SCAN_HOSTS allowlist in
 * background.js. It used to run everywhere, always, via a manifest
 * content_scripts entry matching <all_urls> — that's gone.
 *
 * Support agents run into account/player IDs on approved internal tools —
 * Zendesk tickets, Slack, internal dashboards — as plain text far more
 * often than as a link into this tool. This scans visible text for a
 * labeled ID ("account_id: 3732846", "Player ID = 780602", ...) and turns
 * the number into a small clickable chip that opens the Fliff IMS report
 * for that id in a new tab.
 *
 * Fully read-only and local: it never sends page content anywhere. The only
 * thing that leaves this scope is the literal numeric id, and only once the
 * person actually clicks the chip with a real (isTrusted) click — via a
 * runtime message to background.js, which independently re-validates the
 * sender, the tab, the id, and a rate limit before opening
 * report.html?userId=<id>.
 */
(() => {
  const MARK_CLASS = 'fliff-ims-idlink';

  // PLAYER_ID_RE / normalizePlayerId duplicated verbatim from lib/core.js —
  // see the comment on the canonical copy there for why (content scripts
  // can't use a static `import`). tests/validatorsynctest.mjs enforces that
  // every copy of this block stays byte-for-byte identical.
  // --- BEGIN shared validator (keep in sync with lib/core.js) ---
  const PLAYER_ID_RE = /^\d{4,10}$/;
  function normalizePlayerId(value) {
    const id = String(value ?? '').trim();
    if (!PLAYER_ID_RE.test(id)) throw new Error('Invalid player ID');
    return id;
  }
  // --- END shared validator ---

  // Recognized label roots: account/player/user/customer/acct/member/reg(istration),
  // optionally separated from "id" by a space/underscore/hyphen or nothing at all
  // (AccountID, account_id, Account Id, acct-id, ...).
  const RE = /\b(account|player|user|customer|acct|member|reg)[ _-]?id\b\s*[:=]?\s*["']?\b(\d{4,10})\b["']?/gi;

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'A', 'BUTTON']);

  function isSkippable(el) {
    for (let n = el; n; n = n.parentElement) {
      if (!n.tagName) break;
      if (SKIP_TAGS.has(n.tagName)) return true;
      if (n.isContentEditable) return true;
      if (n.classList && n.classList.contains(MARK_CLASS)) return true;
    }
    return false;
  }

  function wrapTextNode(textNode) {
    const text = textNode.nodeValue;
    RE.lastIndex = 0;
    let m;
    let last = 0;
    let frag = null;
    while ((m = RE.exec(text))) {
      const full = m[0];
      const label = m[1];
      const id = m[2];
      const idIdx = m.index + full.lastIndexOf(id);
      if (!frag) frag = document.createDocumentFragment();
      frag.appendChild(document.createTextNode(text.slice(last, idIdx)));
      const chip = document.createElement('span');
      chip.className = MARK_CLASS;
      chip.textContent = id;
      chip.title = `Open Fliff IMS report for ${label} id ${id}`;
      chip.dataset.imsId = id;
      frag.appendChild(chip);
      last = idIdx + id.length;
    }
    if (!frag) return;
    frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode);
  }

  function scan(root) {
    if (!root || root.nodeType === undefined) return;
    const rootEl = root.nodeType === 1 ? root : root.parentElement;
    if (!rootEl || isSkippable(rootEl)) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const val = node.nodeValue;
        if (!val || val.length < 8) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || isSkippable(parent)) return NodeFilter.FILTER_REJECT;
        RE.lastIndex = 0;
        return RE.test(val) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    // Collect first, mutate after — mutating mid-walk would desync the TreeWalker.
    nodes.forEach(wrapTextNode);
  }

  // --- scheduling: batch mutation-triggered rescans via idle callback so a
  // busy SPA (Zendesk, admin tables re-rendering) doesn't get hammered. ---
  const queue = new Set();
  let pending = false;
  function schedule(root) {
    queue.add(root);
    if (pending) return;
    pending = true;
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 250));
    idle(() => {
      pending = false;
      const roots = [...queue];
      queue.clear();
      for (const r of roots) {
        try { scan(r); } catch (e) { /* never break the host page */ }
      }
    }, { timeout: 800 });
  }

  // Per the security review: require a real user gesture (reject synthetic,
  // programmatically-dispatched clicks a hostile page's own script could
  // fire against our injected chip), and rate-limit rapid repeated
  // triggers. background.js independently re-validates and rate-limits
  // again on its end — this is the first line of defense, not the only one.
  const CLICK_COOLDOWN_MS = 1000;
  let lastClickAt = 0;
  document.addEventListener('click', (e) => {
    const chip = e.target && e.target.closest && e.target.closest(`.${MARK_CLASS}`);
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();

    if (!e.isTrusted) return; // synthetic click — not a real person clicking

    const now = Date.now();
    if (now - lastClickAt < CLICK_COOLDOWN_MS) return;
    lastClickAt = now;

    let id;
    try { id = normalizePlayerId(chip.dataset.imsId); } catch { return; } // dataset could have been tampered with post-injection
    chrome.runtime.sendMessage({ type: 'fliff-ims-open-report', userId: id });
  }, true);

  schedule(document.body);

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList') {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && node.classList && node.classList.contains(MARK_CLASS)) continue;
          if (node.nodeType === 1) schedule(node);
          else if (node.nodeType === 3) schedule(node.parentNode || document.body);
        }
      } else if (m.type === 'characterData') {
        schedule(m.target.parentNode || document.body);
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });
})();
