# Fliff IMS Player Profile Analyzer — Security Review Remediation Summary

**Version:** 2.x → **3.0.0** (`manifest.json` — the sole version source; no `package.json` exists)
**Date:** 2026-08-20
**Scope:** All 7 items from the data/security team's review, plus the requested domain rename.

## Summary table

| # | Item (as raised) | What changed | Files | Status |
|---|---|---|---|---|
| 1 | Restrict where the content script runs — exact tenant hosts, not wildcards; `all_frames: false`; prefer `activeTab` + on-demand injection | Removed the persistent `content_scripts` block (`<all_urls>`, `all_frames: true`) from `manifest.json` entirely. Added `activeTab` + `scripting` permissions. Scanner now injects only after a context-menu click, into the clicked tab only, `allFrames: false`, gated by an exact-hostname allowlist (`ALLOWED_SCAN_HOSTS`) | `manifest.json`, `background.js` | **Done, with one open item** — see caveat below |
| 2 | Require a real user gesture (`event.isTrusted`); prevent rapid repeated requests | Click handler checks `event.isTrusted` before acting; added a 1000ms cooldown between chip clicks; the scan-injection trigger itself is also gesture-only (context menu, never automatic) | `content.js` | Done |
| 3 | Strictly validate player IDs everywhere — reject invalid input, don't just strip non-digits | Added one shared `PLAYER_ID_RE` / `normalizePlayerId` in `lib/core.js`; duplicated verbatim into the two non-module scripts (`background.js`, `content.js`) with an automated drift-guard test proving both copies stay identical; applied at every id entry point | `lib/core.js`, `lib/fetcher.js`, `background.js`, `content.js`, `sidepanel.js`, `report.js` | Done |
| 4 | Validate message senders — extension id, real tab, allowlisted tab URL, valid id, reasonable frequency | `onMessage` handler now checks, in order: `sender.id === chrome.runtime.id`; a real `sender.tab` with a numeric id; that tab's URL against the allowlist; `normalizePlayerId` on the payload; a shared rate limiter (max 5 actions / 10s) | `background.js` | Done |
| 5 | Remove automatic export-action discovery — hard-code one approved action, verify status/content-type/not-HTML-or-login/size/row caps | Replaced regex-based admin-action matching with one hard-coded `EXPORT_ACTION` value (existence-checked against the dropdown before submission, never inferred); added response-status, content-type, login-page/HTML rejection, a byte-size cap, and a row-count cap | `lib/fetcher.js` | Done (a dedicated API remains the proper long-term fix, as the reviewer noted) |
| 6 | Protect CSV exports — neutralize formula-leading characters on string fields; keep numeric currency fields as real numbers | Added `FORMULA_PREFIX` / `spreadsheetSafeText`; `toCSV` runs every string-valued cell through it before quoting; numeric currency cells stay real numbers, never converted to escaped strings | `lib/core.js`, `report.js` (a currency-column formatter was also fixed here — it had been stringifying numeric cells, which would have wrongly tripped the new guard on legitimate negative amounts) | Done |
| 7 | Stop inferred data from driving consequential actions — three confidence states, excluded from suspension/fraud/compliance/reconciliation/automated-action use | Added `CONFIDENCE` states (Authoritative / Inferred / Unknown) and `recordConfidence`; every normalized record and risk signal now carries one; Risk & Flags tab shows badge counts and an explicit notice against using Inferred/Unknown values for those five decision types | `lib/core.js`, `report.js`, `report.html`, `report.css` | Done — note this tool has no write/consequential actions of its own; this is a labeling safeguard for whoever acts on what it shows |
| — | Domain rename | `fw310` → `fw10` everywhere it appeared | `manifest.json`, `lib/core.js`, `README.md`, `sidepanel.html`, `preview/*.html`, user guide docx | Done |
| — | Version bump | `2.x` → `3.0.0` | `manifest.json` | Done |
| — | Documentation | README.md rewritten (new architecture, all 7 items, changelog); user guide bumped to v1.1 with matching updates | `README.md`, `Fliff_IMS_Player_Analyzer_User_Guide_v1.1.docx` | Done |
| — | Test suite | Rebuilt from scratch (see caveat below); 6 suites, 112 assertions, all passing | `tests/` | Done, with one caveat below |

## Two things to flag before this goes further

**`ALLOWED_SCAN_HOSTS` is still placeholders.** Only this extension's own admin
host (`fw10.app.corp.getfliff.com`) is real in the allowlist. The Slack,
Zendesk, Atlassian, and internal-dashboard entries are literal
`REPLACE_ME_...` strings — the scanner fails closed and cannot be injected
anywhere else until Security supplies the exact approved hostnames to swap
in. This is the one item that can't be closed from the codebase side alone.

**The original test suite was missing.** At the start of this remediation
pass, `tests/` was empty — the larger pre-existing suite (real-export
validation, fantasy-wallet inference, withdrawal pairing, deposit-bonus
parsing, full end-to-end report boots, documented in the previous README)
was gone, for reasons unrelated to this work. A new suite was built covering
specifically the security changes above plus a basic parsing/aggregation
regression check — 6 files, 112 assertions, all passing — but it does not
have the same breadth as what existed before. Worth deciding whether to
reconstruct the older suite separately.

## Not addressed in this pass (raised in the same review, out of scope for code changes)

- Publishing to GitHub with PR review, branch protection, and a release process.
- Who maintains the extension going forward.
- The SRE load-on-the-database question the reviewer flagged as needing analysis first (@Sabri Arslan) — every "Analyze Transactions" action is a live fetch against the Django admin, not cached or server-side rate-limited, so this is worth resolving before wider rollout regardless of how the security items land.
