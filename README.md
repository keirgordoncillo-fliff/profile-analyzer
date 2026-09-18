# Fliff IMS — Player Profile Analyzer

A Chrome extension that turns the Fliff Django admin into a Playtech IMS-style player
reporting console: financial summary, player details, full transaction ledger,
deposit/withdrawal analysis, cash vs. token game stats, bonuses/XP, a per-currency
wallet ledger and risk flags — all filterable and exportable.

---

## Install

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Sign in to `https://fw10.app.corp.getfliff.com/admin/` in the same browser profile

The extension uses your existing Django admin session cookie. It never asks for,
reads, or stores credentials. Everything comes from the live admin session —
with one deliberate exception, **"Load CSV…"**, which reads a transaction export
you downloaded from Django admin yourself. That exists because the automatic
server-side export can be blocked by server policy (see "Only strategy 1 sees
the money" below); the file is parsed in-page and never uploaded anywhere.

### Also available: a Google Sheets edition

`sheets/` holds an Apps Script version — paste a transaction CSV export into a
Google Sheet, run one menu command, get Summary / Wallet / Risk tabs. No
extension install, no live admin access (it can't reach the database at all),
and it works when the automatic export is blocked.

`sheets/Core.gs` is **generated** from `lib/core.js`, so both editions compute
every figure with the same code; `tests/appsscriptparitytest.mjs` fails if they
ever diverge. Setup and usage: **`sheets/SETUP.md`**.

### Three ways in

| Entry point | What it does |
|---|---|
| Toolbar icon | Opens the side panel (quick lookup) |
| `Alt+Shift+F` | Opens the full report for the player on the current admin page |
| Right-click | "Fliff IMS: open report for…" on a selection or an admin page |
| Auto-detected id chip | Click a highlighted `account_id`/`player_id`/etc. on **any** page — see below |

Rebind the shortcut at `chrome://extensions/shortcuts`.

---

## Auto-linked account/player ids, anywhere in the browser

Support tickets, Slack messages, internal dashboards — an id shows up as plain
text like `account_id: 3732846` far more often than as a link into this tool.

**As of 3.0.0, this is on-demand, not persistent.** Earlier versions ran
`content.js` as a permanent `<all_urls>` content script on every page. Following
the security review, that's gone: there is no `content_scripts` entry in
`manifest.json` at all. Instead —

1. You right-click a page and choose **"Fliff IMS: scan this page for account
   IDs"** (an explicit user gesture).
2. `background.js` checks that page's hostname against `ALLOWED_SCAN_HOSTS` — an
   exact-match allowlist, no wildcards.
3. Only if it matches does the worker use the `activeTab` permission (a
   temporary, gesture-triggered grant — see
   [Chrome's activeTab docs](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab))
   to inject `content.js` into that one tab via `chrome.scripting.executeScript`,
   scoped to the top frame only (`allFrames: false`).

**`ALLOWED_SCAN_HOSTS` currently contains placeholders.** Only this
extension's own admin host (`fw10.app.corp.getfliff.com`) is real; the Slack,
Zendesk, Atlassian, and internal-dashboard entries are literal
`REPLACE_ME_...` strings that can never match a real tab. The scanner fails
closed — it cannot be injected anywhere else — until Security supplies the
exact approved hostnames to swap in (see `background.js`'s comment above the
`ALLOWED_SCAN_HOSTS` definition).

Once injected, `content.js` scans visible text for a labeled id:

```
account_id: 3732846      Player ID = 780602      AccountID:9981234
```

Recognized label roots: `account`, `player`, `user`, `customer`, `acct`,
`member`, `reg` — with or without an underscore/hyphen/space before `id`,
followed by a 4–10 digit number, validated by the shared `normalizePlayerId`
(see below). It deliberately does **not** match a bare `id:` (too many false
positives — ticket ids, order ids, row ids on other tools) or partial words
like `account_id_type` (`id` has to be a whole word).

Matches get wrapped in a small dotted-underline chip (↗). Clicking one:

- is ignored unless the click is a real user gesture (`if (!event.isTrusted)
  return;` — a script-dispatched synthetic click is rejected, not just a
  programmatic one from this page but from any page)
- is throttled to at most one every `CLICK_COOLDOWN_MS` (1000ms), so a
  malicious/broken page can't turn rapid synthetic or repeated clicks into a
  flood of requests
- re-validates the id through `normalizePlayerId` before sending it anywhere

and only then sends that single validated numeric id to `background.js` via
`chrome.runtime.sendMessage`, which opens `report.html?userId=<id>` in a new
tab — the same path as the right-click menu. A `MutationObserver` re-scans
newly-added content so it keeps working on SPA pages that load content after
the initial scan (Zendesk ticket threads, etc.), without re-scanning the whole
page on every keystroke.

It never reads form fields, inputs, `contenteditable` regions, or the
contents of links/buttons — only static page text — and never sends anything
anywhere except the literal id you click on. See `tests/contentscripttest.mjs`
and `tests/backgroundtest.mjs` for the full behavior spec (what does/doesn't
get linked, the gesture/cooldown guards, the allowlist gating, click wiring,
the dynamic-content case).

---

## The real ledger schema

Each transaction is a wide row: a numeric `type` code (no embedded label), a
human-readable `history` line, and up to ~24 named currency columns in
delta/running-balance pairs — `d_6001_real_money_in` (this transaction's change)
and `r_6001_real_money_in` (the balance right after it). A row can move more
than one currency at once.

Two currency **kinds**, never blended together in a total:

- **cash** — real-money-backed, stored in cents: `real_money_in/out`, `cash_out_locked/paid`,
  and the Fliff Cash chain (`playable → locked-in-picks → redeemable`).
- **token** — play-money units with no cash value: gold coins, tokens, qtokens, XP.
  Formatted as plain numbers, never `$`.

### FC vs. $ — which cash column is which

**The report formats every cash currency as `$`.** But they are not all
dollars, and the distinction matters when cross-checking a figure against the
admin page:

| Currencies | Really | Notes |
|---|---|---|
| `pending`/`cleared`/`rewards`/`playable`/`locked-in-picks`/`redeemable` Fliff Cash (5002-5004, 5011-5013) | **Fliff Cash (FC)** | The sportsbook in-product currency. The admin's own balance field renders it with a trailing unit, e.g. `0.18 FC` — so expect a formatting difference against that page, not a discrepancy. `lib/core.js` → `FC_CHAIN` |
| `real_money_in/out`, `cash_out_locked/paid` (6001-6004) | **dollars** | Genuine money moving to and from a payment processor — sportsbook-side, but not Fliff Cash. This is why Deposits and Withdrawals Paid reconcile against the admin's dollar figures directly |
| every `fantasy_*` column (8001-8003, 8011-8013) | **dollars** | The Superstars wallet has no FC equivalent — its columns are literally named `fantasy_*_usd` |

FC redeems 1:1 with USD, so rendering everything as `$` doesn't distort any
total, and a figure spanning both wallets is still meaningful. Where a headline
does span wallets (Cash Wagering Net, Game Stats' cash block) it carries a
per-wallet Sportsbook/Superstars split so you can see the composition.

> **Version note.** 3.1.0 rendered the Fliff Cash chain as `39.86 FC` to mirror
> the admin exactly. That was reverted in 3.2.0 in favour of one consistent
> money format on screen. `FC_CHAIN` and this table are retained as the
> reference for which columns are which.

The **Global Value** KPI (formerly "Net Cash Position") is named after the
admin's own `Global / net value` field, which the Summary tab's reconciliation
table compares against directly. Confirmed against a live player:
`Purchases 9.69 − Redemptions 192.00 − Balance 6.29 = −188.60`, matching the
admin's Global Value exactly.

`type` has no text label in the data — its meaning was reverse-engineered from the
`history` field and which currencies move alongside it. That mapping lives in
`lib/core.js` → `TYPE_META`:

| Type | Category | What moves |
|---|---|---|
| 4027 | Deposit (Purchase) | `real_money_in` + |
| 4023 | Withdrawal Requested | `cash_out_locked` + |
| 4141 | Withdrawal Paid | `cash_out_paid` + |
| 4012 | Pick Placed (wager) | redeemable/playable Fliff Cash − *or* qtokens/tokens − |
| 4013 | Settled — Win | redeemable Fliff Cash + *or* qtokens/tokens + |
| 4025 | Settled — Loss | locked-in-picks Fliff Cash − (cash-funded picks only) |
| 4015 / 4014 | Settled — Push / No Action | stake refunded |
| 4009 | Bonus Claimed | tokens + redeemable Fliff Cash + |
| 4048 / 4049 / 4050 / 4075 | XP Earned | XP + |
| 4074 | XP Redeemed | XP −, tokens/cash + |
| 4052 | Reversal | varies — always shown with the raw `history` text |
| 4119 | Manual Admin Adjustment | varies — always shown with the raw `history` text |
| 4071 | Initial Account Setup | one-time |

A type code not in this table isn't dropped — it's labelled "unmapped", counted,
and surfaced in **Risk & Flags → Unclassified Type Codes** with a sample `history`
line so a new code can be identified and added.

One deliberate asymmetry: cash-funded picks use a three-state escrow
(`playable`/`redeemable` → `locked-in-picks` → back to `redeemable`, or forfeited),
so a loss needs an explicit ledger entry to release the escrow. Token-funded picks
have no escrow step, so a token loss produces **no separate transaction at all** —
the stake simply never returns. That's why Game Stats shows a Loss count and win
rate for cash picks but not for tokens; claiming a token "loss count" would have to
be inferred, not read from the ledger, so it isn't shown as a hard number.

---

## Two wallets: sportsbook and fantasy

Fliff runs **two separate economies** on the same account, each with its own
currency columns: **sportsbook** (`5xxx`/`6xxx` ids) and **fantasy** (`8xxx` ids).
A player can deposit into, wager from, and withdraw from either wallet
independently, and the ledger never mixes them — `d_8001_fantasy_real_money_in`
and `d_6001_real_money_in` are both "money in," just to different wallets.

Every KPI that used to read a single sportsbook currency id now sums **both**
wallets: `depositTotal = depositSportsbook + depositFantasy`, and likewise for
withdrawals requested/paid and cash wagered/won. The Summary, Deposits, and
Withdrawals tabs show a Sportsbook/Fantasy sub-badge whenever fantasy activity
is present, and every transaction row carries a `product` field (`sportsbook`,
`fantasy`, `mixed`, or `unknown`) rendered as a wallet pill in the Transactions,
Withdrawals-pairing, and Wallet tables.

**Why "Purchases" on the side panel could be lower than "Deposits" on the full
report before this fix**: the side panel's Purchases figure and the report's
Deposits KPI were both reading only the sportsbook `real_money_in` column
(`6001`). A player who topped up their fantasy wallet (`8001`) had that amount
silently excluded from both — not a display bug, a real gap in what was being
summed. Fixed in `lib/core.js`'s `aggregate()`.

### The fantasy-side type-code caveat

Most of `TYPE_META`'s original entries were reverse-engineered from a real
export that happened to have **zero fantasy-wallet activity**. That gap is now
partly closed: confirmed live against a second real, fantasy-heavy player
(780602, Aug 2026), `TYPE_META` now has real entries for the fantasy
deposit/withdrawal lifecycle — `5300`/`5301` (purchase), `5011` (chargeback),
`5042`/`5043`/`5045` (withdrawal requested), `5210`/`5211` (withdrawal paid),
`5061`/`5062`/`5220` (withdrawal cancelled/declined/failed), and `5063` (paid
withdrawal later refunded). Fantasy's **wager/settlement** side (entry placed,
win, loss, void) still has no confirmed type code — those still fall through
to the inference fallback below. Rather than leave every unconfirmed fantasy
transaction as "unclassified," `lib/core.js` → `inferFantasyCategory()` infers
a category from *which fantasy currency moved and its sign*, on the assumption
that fantasy mirrors sportsbook's parallel column numbering (`8001-8003` ↔
`6001-6004`, `8011-8013` ↔ `5011-5013`):

| Fantasy signal | Inferred category |
|---|---|
| `fantasy_real_money_in` (8001) increases | Deposit |
| `fantasy_real_money_out_locked` (8002) increases | Withdrawal Requested |
| `fantasy_real_money_out_paid` (8003) increases | Withdrawal Paid |
| `fantasy_cleared_usd` (8013) increases | Settled — Win |
| `fantasy_locked_in_entries_usd` (8012) decreases with no clear increase | Settled — Loss |
| `fantasy_pending_usd` (8011) decreases, or locked-entries increases | Entry Placed (wager) |
| `fantasy_pending_usd` (8011) increases on its own | Entry Refunded (void) |

Every record classified this way is flagged `categoryInferred: true` — shown
with an "inferred" badge in the Transactions ledger and tracked separately from
truly-unmapped codes in **Risk & Flags → Fantasy-Wallet Inferred Categories**.
This is a reasonable-pattern guess, not confirmed-mapping confidence like the
sportsbook `TYPE_META` table. Once a real fantasy export with known type codes
is available, add proper `TYPE_META` entries for them and the fallback simply
stops firing for those codes (the fallback only runs when `TYPE_META` has no
match at all).

`tests/fixtures/synthetic_fantasy.csv` is a small hand-built fixture (no real
fantasy sample exists yet) exercising all seven inferred categories plus a
withdrawal request↔paid pairing, validated in `tests/fantasytest.mjs` —
including a check that mixing fantasy rows into the real sportsbook-only
export never shifts the sportsbook-only totals.

### Fantasy stats on the side panel, without fetching the ledger

The profile page's "Wallet v4" summary actually has a dedicated panel for
each product — "SportsBook" (Purchases/Redemptions) and **"Superstars"**,
which is Fliff's internal name for the Fantasy product, with its own
lifetime **Deposits** and **Withdraw Requests** figures. Confirmed live
against player 780602: Superstars' Deposits ($587,975.00) and Withdraw
Requests ($542,615.00) exactly match the fantasy-wallet running balances
`aggregate()` computes from the full transaction ledger (see "Fantasy
withdrawals stuck showing Pending forever" above for why "Withdraw Requests"
is actually the cumulative *paid* balance, not the requested amount).

That means the side panel's quick profile card can show real Sportsbook,
Fantasy, and Combined purchase/redemption figures immediately on lookup —
no "Analyze Transactions" ledger fetch required. `lib/fetcher.js` →
`harvestWalletSection()` scopes to one small unstyled table by its `<th>`
header text (`SportsBook` / `Superstars`) rather than reading every 2-cell
table row on the page unscoped, so a same-named field in a different section
(e.g. both panels have their own "Value" and "Balance" rows) can never
collide across sections. The Fantasy/Combined tiles only render when a
Superstars panel is actually present on the page, so a player with no
fantasy activity doesn't get clutter for figures that would just duplicate
the Sportsbook ones. `tests/fetchtest.mjs` covers the section-scoping (a
same-named "Balance"/"Value" row in each table never leaks into the other),
and `tests/paneltest.mjs` covers the rendered tiles end-to-end.

### Balance (Sportsbook + Superstars), and Global Value accounting for it

The Summary tab's KPI grid has a **Balance** tile — the player's current
wallet balance, Sportsbook plus Superstars combined, straight from the
profile page's own "Balance" fields (`lib/fetcher.js` → `sportsbookBalance` /
`fantasyBalance`, same section-scoping as the deposits/redemptions figures
above). Unlike every other tile on this tab, it's a **live snapshot** — it
doesn't move when you change the date-range filter, since it isn't derived
from the filtered ledger at all. The sub-line says so explicitly.

**Global Value** now folds it in: `Deposits − Withdrawals Paid −
Balance`, instead of just `Deposits − Withdrawals Paid`. The idea: money that
went in, didn't come back out as a withdrawal, and isn't still sitting in the
wallet either — i.e. what actually got consumed by play — rather than a
figure that misleadingly counts a big remaining balance as if it were
already-realized profit to the house. This is a **display-only** change scoped to the
KPI tile in `report.js`; `lib/core.js`'s `aggregate()` still returns the
plain ledger-only `k.netCash` (`Deposits − Withdrawals Paid`) untouched,
since the reconciliation table on the same tab compares it against the
profile page's own "Global / net value" field and folding balance in there
too would double-count it.

`lib/fetcher.js`'s scoped `sportsbookBalance` falls back to the older,
unscoped generic `balance` field on profile pages that render the simpler
form-row layout instead of the "Wallet v4" table — both shapes are covered
in `tests/fetchtest.mjs`. Fixing this also caught a latent bug: the
Sportsbook balance field renders as e.g. `"0.18 FC"` (Fliff Cash), and
`toNumber()` didn't strip that trailing unit suffix, silently returning
`NaN` for anything that read it numerically. Nothing did, until this
feature — `toNumber()` now strips a trailing currency-unit suffix.

---

## What you get

### Side panel — quick lookup
Auto-detects the player ID from the current admin tab. Shows profile KPIs —
Sportsbook purchases/redemptions plus, whenever the profile page's fantasy
("Superstars") panel is present, Fantasy and Combined purchases/redemptions
too — and an optional ledger snapshot (deposits, withdrawals paid, net cash,
cash wagering net, cash win rate, token wagering net, bonus cash, XP), then
hands off to the full report.

### Full report — 10 tabs

| Tab | Contents |
|---|---|
| **Summary** | 9 headline KPIs (deposits, withdrawals paid, live balance, global value, cash/token wagering net, win rate, bonus, XP — with FC/$ wallet splits where the figure spans both wallets), cash-flow composition donut, category activity chart, cash timeline, lifetime-vs-period reconciliation against the profile page, top transaction types |
| **Player Details** | Identity, account status (with tenure), financial position, and every field scraped from the profile page with a live filter |
| **Transactions** | Full ledger — sortable, paginated (50/100/250/1000), category badges, per-currency movement badges (cash vs token tagged), optional raw columns |
| **Deposits** | KPIs (including a "Deposits w/ Bonus" count), volume trend, size-distribution buckets, deposit records with a per-row bundled-bonus badge |
| **Withdrawals** | KPIs, a Requested → Paid → Pending funnel, volume trend, requests paired with their payout by withdrawal-request id (with latency), full records |
| **Game Stats** | Cash and token blocks side by side — wagered/won/lost/net/win-rate for cash, wagered/won/net for tokens — wager-vs-win trend per currency, settlement outcome donut, weekday×hour activity heatmap, settlement records |
| **Bonuses & XP** | Claim/XP/redemption KPIs, a dedicated Deposit-Match Bonuses table (parsed from `serialized_details` — see below), claims-over-time trend, XP-by-source donut, combined records |
| **Wallet & Ledger** | Every currency column with activity in the period — inflow/outflow/net, cash and token charted separately |
| **Risk & Flags** | Heuristic review flags, reversals table, manual admin adjustments table, sign anomalies (e.g. a negative deposit), unclassified type codes |
| **Raw Data** | Currency schema (id → label → cash/token), type-code schema (code → label → category → count), and the untouched scraped/CSV rows |

### Filtering
Quick ranges (7D/30D/90D/1Y/All), explicit date range, free-text search (id, type
label, history, reason/pick id), category, type code, currency, and min/max cash
amount (cash-valued transactions only — token amounts aren't dollar figures, so
they're intentionally excluded from a $ filter rather than mixed in). All tabs
respond to the same filter set.

### Export
- **CSV** — filtered transactions, one column per active currency (cash columns
  exported in dollars, token columns as raw units)
- **JSON** — the whole report: fetch provenance, profile, filters, KPIs, the full
  per-currency wallet ledger, risk signals and the transaction array
- **Print / PDF** — `⎙` prints every tab stacked with nav chrome stripped

Light and dark themes; the choice persists. Recent lookups are remembered.

---

## How it fetches data

Transactions are fetched **completely**, not just page one. Three strategies, in order:

1. **Server-side CSV export** — if a `export_as_csv`-style admin action exists,
   it's submitted with `select_across=1`. One request, all rows, and it's the
   richest source: it dumps every currency column, not just what the admin's
   list view happens to display.
2. **`?all=` show-all view** — one request when the server permits it.
3. **Paginated crawl** — `?p=0…N`, driven by the paginator's reported total,
   with live progress and a 200-page safety cap.

The status banner always states which strategy was used and warns if the row count
falls short of what the server reported. Long fetches can be cancelled.

### Only strategy 1 sees the money — and what happens when it's unavailable

This matters more than it sounds. The `d_<currency>_<name>` delta columns —
the source of *every* monetary figure in this tool — exist **only in the CSV
export**. The changelist fallbacks (strategies 2 and 3) see just the columns
the admin's list view renders, which don't include them.

So a report built from a changelist fallback has zero currency entries, and
every cash KPI aggregates to a perfectly real-looking `$0.00`.

This actually happened. A support-facing report for a live player showed
`Deposits $0.00` and `Withdrawals Paid $0.00` while that player's admin page
read `$9.69` and `$192.00`, with all 1,400 transactions classified
`Other / Unmapped`. Read at face value, that screen says the player never
deposited or withdrew anything.

**Root cause: a CSRF 403 on the export POST.** An extension page fetching the
admin is *cross*-origin, so the POST carried `Origin:
chrome-extension://<id>`, and no `Referer` at all — `Referer` is a forbidden
header, so the `fetch()` call setting it had that header silently stripped by
Chrome. Django's CSRF middleware answers that with 403. It's diagnostic that
every **GET** succeeded (profile page, all 15 changelist pages — Django doesn't
CSRF-check GET) and only the single **POST** failed.

### Making the export work: the same-origin relay

`lib/fetcher.js` → `postExportViaAdminTab()` asks the background worker to run
the export POST *inside a tab already on the admin host*, via
`chrome.scripting.executeScript`. From there the request is genuinely
same-origin, so `Origin` and `Referer` are both what Django expects and the
CSRF check passes. The direct POST is still attempted as a fallback, since it
works wherever the backend is configured to trust the extension's origin.

The relay is validated as tightly as the rest of the messaging surface
(`background.js`): the message must come from one of this extension's own pages
(`sender.url` prefixed with `chrome.runtime.getURL('')` — a content script or
web page can never match), the target URL must be `https` on the admin host
(the handler POSTs to what it's given, so it must never accept an arbitrary
host), and it goes through the shared rate limiter. The returned body runs
through the same `finishCsvExport()` validation as a direct response — login
page, content type, HTML, size and row caps — so the relay can't become a way
around the security review's response checks.

**It needs an admin tab open.** If there isn't one, the relay reports exactly
that and the report falls back (visibly — see below). The cleaner long-term
alternative is backend-side: add the extension's origin to Django's
`CSRF_TRUSTED_ORIGINS`, after which the direct POST works with no open tab
required. The 403 message names both options.

Two further changes make that failure mode impossible to miss when it does
happen:

1. **`tryCsvExport()` never fails silently.** Every bail-out returns
   `{ skipped: <reason> }` instead of `null`, and when the approved action
   isn't present it reports the action values the page *did* offer — so an
   admin-side rename diagnoses itself from the report screen. The reason
   travels on the fetch result as `exportSkipped`.
2. **A degraded fetch never renders a monetary figure.** `report.js` checks
   whether any record carried a currency entry (`state.meta.degraded`). If
   not: every money KPI renders `—` with "currency data not in this fetch"
   instead of a number, the cash charts explain what's missing rather than
   claiming "no cash movements", the reconciliation table shows the profile
   figures with the ledger side marked *unavailable* (rather than a huge
   spurious Δ), CSV export is blocked outright, JSON export carries a
   `degraded: true` + `warning` field, and a non-dismissing error banner
   names the fetch method and the skip reason.

**Balance is the deliberate exception** — it's scraped from the profile page,
not the ledger, so it stays trustworthy and keeps rendering on a degraded
fetch. Suppressing it too would throw away good data.

If you hit this, read the reason off the banner, then:

1. **Fastest, always works** — click **"Load CSV…"** and pick a transaction
   export you downloaded from Django admin yourself. Django's export action
   works normally from inside the admin UI; this reads that file directly.
2. For a 403, keep an admin tab open so the export can run same-origin, or get
   the extension's origin added to Django's `CSRF_TRUSTED_ORIGINS`.
3. If the banner names a different action value than `EXPORT_ACTION`, set that
   in `lib/fetcher.js`.

The proper fix remains a dedicated API.

### Why headline Deposits/Withdrawals totals aren't category-filtered

Confirmed live against a real player (489318, Aug 2026): the profile page's
lifetime **Purchases** ($125,043.63) and **Redemptions** ($56,014.00) figures
are plain sums of positive deltas on `real_money_in` / `cash_out_paid`, with
**no dependency on which type code produced them**. The report's Deposits
total was undercounting that same player by exactly the amount contributed
by a second purchase-processor type code (Mazooma Web Cashier, `4026`) that
`TYPE_META` only had one processor's code for (Paysafe, `4027`) — filtering
the total to `category === 'deposit'` before summing was the actual bug, not
just a missing type-code entry. Withdrawals had the same gap for an
Aeropay-processed disbursement (`4191`) alongside the legacy code (`4141`).

Fixed two ways, in `lib/core.js` → `aggregate()`:

1. Added `TYPE_META` entries for every processor-specific code found on that
   player's real export (`4026`, `4181`, `4191`, plus several smaller ones —
   `4003`, `4022`, `4039`, `4114`, `4116`, `5400`, `8000`) so they show up
   correctly labeled in the Deposits/Withdrawals tabs and Transactions
   ledger, not as "unmapped."
2. The headline Deposits/Withdrawals Requested/Withdrawals Paid totals are
   now computed with `sumPositiveByCurrency()` — a sum of positive deltas
   straight out of `byWallet`, across every category — instead of a
   category-filtered `cell()` read. This is a permanent safety net: the next
   time Fliff adds a new payment processor with its own type code, that
   money still lands in the headline total immediately, even before anyone
   adds a `TYPE_META` entry for it. When that happens, a low-severity risk
   signal ("`<Tab>` total includes an unmapped type code") points at exactly
   how much and which records, so the gap is visible instead of silent —
   the opposite of how the original bug behaved.

`tests/processortest.mjs` exercises this directly: two mapped
purchase-processor codes plus one deliberately-unmapped one all land in
`depositTotal`, while only the unmapped one shows up in
`depositOutsideCategory` and trips the risk signal.

### Pending vs. cancelled withdrawals

"Pending" used to mean "requested minus paid" with no way to tell a request
that's genuinely still in flight from one the player cancelled or that got
reversed for a technical reason — both looked identical (present in
Requested, absent from Paid), so a cancelled request sat in Pending forever.

Confirmed live against player 489318: a "withdraw cancelled" record (type
`4022`) carries the **same `reason_id`** (Fliff's internal withdrawal_request
id) as the request it cancels — e.g. reason_id `3012304` linked a `4023`
request to its `4022` cancellation directly. Every one of that player's 24
cancellation records matched a request this way. `lib/core.js` →
`pairWithdrawals()` finds these by looking for a `reversal`-category record
that shares a `withdrawal_requested` record's `reason_id` and releases the
same locked currency (a negative delta on the same column the request
locked) — this is strategy 1 of 2; see "Per-request pairing still showed
fantasy withdrawals stuck on Pending forever" below for strategy 2, which
covers the wallet reason_id can't. Matched requests:

- No longer count toward `withdrawalPendingTotal` (excluded, not just
  netted against something else).
- Are tallied separately as `withdrawalCancelledTotal` /
  `withdrawalCancelledCount`.
- Show a "Cancelled" status pill in the Withdrawals tab's request↔paid
  pairing table instead of "Pending", and a "Cancelled" funnel stage
  appears whenever any exist in the filtered period.
- Raise a low-severity risk signal so cancellations stay visible instead of
  just quietly not being flagged as overdue.

This is a pattern match, not a `TYPE_META`-only fix — it works for any
reversal-type code with this reason_id + currency-release signature, not
just `4022` specifically.

### Fantasy withdrawals stuck showing "Pending" forever

Reported against a real, fantasy-heavy player (780602, Aug 2026): a large
chunk of that player's withdrawals sat in Pending indefinitely, even though
most had actually been paid, cancelled, declined, or failed at the processor
long ago. Two separate bugs, both fixed in `lib/core.js` → `aggregate()`:

1. **Deposits/Withdrawal-Paid were positive-only sums, but Fliff's own
   figures are net sums.** Confirmed by matching the running-balance columns
   exactly: the admin's lifetime Deposits figure was $1,000 below a
   positive-only sum of `fantasy_real_money_in` because of one
   chargeback-reversal row (`5011`) with a negative delta on that same
   column; the cumulative paid-withdrawal figure was $10,000 below a
   positive-only sum of `fantasy_real_money_out_paid` because of one
   "refund_withdrawal_request … bad Skrill address" row (`5063`) clawing
   back an already-paid amount. `depositTotal`/`depositSportsbook`/
   `depositFantasy` and `withdrawalPaidTotal`/`withdrawalPaidSportsbook`/
   `withdrawalPaidFantasy` now use `netByCurrency()` (inflow − outflow)
   instead of `sumPositiveByCurrency()`. `withdrawalRequestedTotal`
   deliberately stays positive-only — it's meant to read as "lifetime total
   ever locked for withdrawal," a figure that shouldn't shrink just because
   a request later got paid or cancelled.
2. **Pending can't be computed by pairing a cancellation back to its request
   for the fantasy wallet — there's no ID to pair on.** `reason_id` works
   for sportsbook (see above), but every fantasy cancellation/decline/
   processor-failure code (`5061`, `5062`, `5220`) carries `reason_id "0"` on
   real data, and `parent_transaction_id`/`opposite_transaction_id` are
   unpopulated too. `withdrawalPendingTotal` is now computed directly as the
   net running balance of the withdrawal-lock currencies
   (`netByCurrency(byWallet, [6003, 8002])`, floored at zero) instead of
   "requested − paid − cancelled." This is correct for both wallets
   regardless of whether an individual record can be traced back to the
   request it resolves — the per-request pairing table is display-only;
   nothing about the headline Pending number ever depended on it succeeding
   (see below for how that per-request pairing was later fixed too).
3. **The Summary tab's reconciliation table compared the wrong things.**
   `tblReconcile` was comparing the profile page's Purchases/Redemptions
   (sportsbook-only, from the "SportsBook" admin panel) against the
   *combined*-wallet `depositTotal`/`withdrawalPaidTotal`. Any player with
   fantasy activity would show a Δ there and get flagged `warn-text` even
   though nothing was wrong — the two numbers were never supposed to match.
   Fixed to compare against `depositSportsbook`/`withdrawalPaidSportsbook`
   instead; fantasy activity now gets its own informational row underneath
   rather than corrupting the sportsbook comparison.

`tests/fixtures/synthetic_fantasy_net.csv` / `tests/fantasynettest.mjs`
exercise all of this: a fantasy deposit netted against a chargeback, a
fantasy withdrawal paid then partially refunded, and a second fantasy
withdrawal requested-then-cancelled with an unpaired `reason_id "0"` on both
sides — confirming Pending still lands on $0.00 despite zero traceable
pairing. `tests/e2e.mjs` separately confirms the Summary tab's reconciliation
table shows no false warning on the real (sportsbook-only) fixture.

### Per-request pairing still showed fantasy withdrawals stuck on Pending forever

Reported directly by a user looking at a live report for player 780602: the
Withdrawals tab's request↔payout table showed a long, suspicious-looking
list of same-size fantasy withdrawal requests — many at exactly $10,000.00,
one per day for weeks — every single one still "Pending," which the user
correctly flagged as implausible and asked to have investigated against
`serialized_details`. (Claude in Chrome was disabled mid-investigation; the
user exported the player's full CSV from the extension itself and uploaded
it directly so the analysis could continue offline.)

The headline Pending KPI was already correct (see above — it's a running
balance, not built from pairing), but the *per-request* pairing table was
genuinely broken for the reason predicted in the previous section: every
fantasy resolution record's `reason_id` is the literal string `"0"` —
confirmed by checking the raw export — a sentinel Fliff uses for "not set,"
never a real id. Checking the full 27,979-row export end to end: 131 fantasy
withdrawal requests (types `5042`/`5043`/`5045`) and 131 resolutions (`5061`
cancel / `5062` decline / `5210`/`5211` paid / `5220` processor failure) net
to exactly $0.00, and *every single request* had a resolution of the exact
same dollar amount within days — often the same day (a $7,480.00 request at
08:45 resolved by a same-day "Mass approval withdrawal requests" payout at
15:38). These weren't unresolved requests; they were untraceable ones.

`lib/core.js` → `pairWithdrawals()` replaces the old sportsbook-only
`findCancelledWithdrawalRequests()` with two strategies, tried in order:

1. Shared `reason_id` + a matching release of the locked currency (as
   before) — but now a literal `"0"` is treated as *absent*, not as a
   matchable value. Without that guard, two unrelated withdrawal_requested
   records that both happen to have reason_id `"0"` (which, for fantasy, is
   all of them) could get a cancellation attributed to whichever one
   happened to be processed last — a latent bug that existed but had no
   real-data test coverage until now.
2. Same exact locked-currency amount, resolved within 45 days of the
   request, matched earliest-unclaimed-first (greedy; a given resolution can
   only be claimed by one request) — the fallback for exactly the case above.

Applying this to the full player-780602 export: all 248 withdrawal requests
(both wallets) now resolve — 140 paid, 108 cancelled, zero still pending;
117 matched via reason_id (sportsbook), 131 via the new amount+time fallback
(fantasy, previously all stuck "Pending"). The Withdrawals tab table now
shows a "≈" badge on amount+time-matched rows so it's clear which pairings
are inferred rather than exact, and falls back to showing the transaction's
own id instead of a meaningless `"0"` for those rows. The "Cancelled" KPI
and risk signal now cover both wallets instead of sportsbook-only, since the
fallback makes fantasy cancellations traceable for the first time.

`tests/fixtures/synthetic_withdrawal_pairing.csv` /
`tests/withdrawalpairingtest.mjs` cover: a same-day paid resolution, a
same-day cancellation, the same dollar amount recurring in a later unrelated
flow (must not cross-wire with an earlier claimed resolution), a request
with no resolution anywhere (must stay genuinely pending, not get
force-matched), sportsbook's real reason_id still taking priority when
present, and two ambiguous same-amount/reason_id-`"0"` requests competing
for one resolution (only the earlier may claim it).

### Deposit-bundled bonuses (parsed from `serialized_details`)

Reported directly by a user reviewing a real player: a deposit can carry a
deposit-match bonus *inside its own transaction* rather than as a separate
bonus_claim-type record. Confirmed live against player 780602: a $1,000
Paysafe fantasy deposit (type `5301`) credited $2,500 total to
`fantasy_pending_usd` in that single row — the deposit's own currency delta
already includes the $1,500 bonus, so there's no separate ledger line for it
at all. The only place it exists is the raw `serialized_details` JSON column
(previously unused by this tool entirely), under
`transaction_request.obtain_fantasy_goods_request`:

- `applied_goods.amount_in_cents` / `amount_in_cents_paid` — the deposit
  actually paid
- `applied_goods.amount_in_cents_bonus` — the bonus credited
- `applied_goods.amount_in_cents_total_received` — both combined
- `applied_goods.amount_reserved_from_deposit` / `amount_to_pending` /
  `amount_to_cleared` — where the credited total landed
- `applied_goods.fantasy_bonus_code` / `campaign_type` — which campaign
  (e.g. `deposit__pt_bonus|2000`, type `43402`)
- `fantasy_offer_1_applied.deposit_bonus_amount_in_percents` — the bonus %
  (150%)
- `fantasy_offer_1_applied.deposit_bonus_max_amount_in_cents` — the cap
  ($7,500)
- `fantasy_offer_1_applied.play_through_multiplier_in_percents` — stored as
  a percent (2000 → the "|2000" in the campaign code itself, i.e. 20×)

`lib/core.js` → `parseDepositBonus()` extracts this into a `depositBonus`
field on the record, only when `fantasy_bonus_code` starts with
`deposit__` and the bonus amount is nonzero — the same JSON wrapper is also
used for two things this must *not* fire for:

- Pure no-deposit bonus grants (`free__daily_bonus`, `free__vip_active_bonus`,
  ...) — `amount_in_cents_paid` is 0, the whole "bonus" IS the grant, not a
  deposit sweetener.
- Internal conversions tagged `deposit__no_bonus` with
  `amount_in_cents_bonus` === 0 (e.g. redeeming XP into fantasy cash) — no
  bonus was actually granted.

Surfaced on the **Deposits** tab (a "Deposits w/ Bonus" KPI tile and a
per-row bonus badge) and, per the original report, on the **Bonus & XP**
tab — a dedicated "Deposit-Match Bonuses" table plus a KPI tile. `bonusCashTotal`
(the Summary tab's "Bonus Value" and the Bonus tab's "Bonus Cash (Total)")
folds this in too, per follow-up user feedback — a bonus is a bonus
regardless of whether it moved its own currency delta or rode along inside
a deposit's. Safe to fold in without double-counting: `depositFantasy` only
ever sums the `8001` (actual money in) column, never the pending-escrow
total that includes the bonus, so the bonus amount was never counted
anywhere else to begin with. The currency-delta-only subtotal is still
available as `bonusCashClaims` for anyone who wants the two figures apart.

**A related bug found along the way**: the two free-bonus-grant type codes
above (`5021` free daily bonus, `5022` free VIP active bonus) had no
`TYPE_META` entry, so they fell through to `inferFantasyCategory()`'s
currency-pattern fallback — which mis-categorized them as
`settlement_win`/`settlement_void` (whichever cash-chain currency the grant
happened to land on) instead of `bonus_claim`, making them invisible on the
Bonus tab and silently inflating Game Stats' win/void counts instead. Fixed
with confirmed `TYPE_META` entries. Doing so also exposed that
`bonusCashTotal` only ever summed the sportsbook bonus currency (`5013`) —
widened to also sum the fantasy bonus currencies (`8011`/`8013`), split out
as `bonusCashSportsbook`/`bonusCashFantasy`, following the same
sportsbook/fantasy pattern used everywhere else in this codebase.

**Not changed, flagged for awareness**: the same investigation turned up two
more fantasy type codes (`5031`, `5032`) that also carry
`fantasy_bonus_code: "deposit__no_bonus"` but aren't deposits at all — they're
internal conversions (XP redeemed into fantasy cash; sportsbook redeemable
cash moved into the fantasy wallet). They still fall through to the
inference fallback and get mis-labeled `settlement_win`, which inflates Cash
Won on Game Stats for money that never came from a contest. Left alone for
now since the "correct" category for a cross-wallet internal transfer isn't
one that exists yet (it isn't a deposit, wager, or settlement) — would need
a deliberate design decision, not a type-code lookup.

`tests/fixtures/synthetic_deposit_bonus.csv` /
`tests/depositbonustest.mjs` cover all of the above: a deposit with a real
bonus (exact numbers from player 780602), a deposit with no bonus chosen,
both free-bonus-grant codes, and confirms neither the sportsbook deposit nor
the sportsbook bonus claim in the same fixture are affected.

### Profile field extraction

Most profile fields are resolved generically (label text → known aliases, with
a body-text scan as a last resort). Two fields are deliberately handled as
special cases instead, in `lib/fetcher.js`:

- **Registration date** — the admin page's "Info:" field renders as two
  stacked lines (`object_created`, then `object_updated` with a change
  counter) inside one `.readonly` block. A generic scan for the word
  "registered" would have matched a "REGISTERED / USER ID" table header
  elsewhere on the same page (the Referrals section) well before it ever
  reached the real field — that was an actual bug, fixed by matching on the
  row's `field-*` class fragment (`object_created_updated_date_time`)
  instead of label text or body content.
- **User Tags** — a profile can carry zero, multiple, or one tag, each
  rendered as its own `[id] Tag Name` badge inside the "User Tags:" field,
  followed by a "Manage User Tags" control. Matched on the
  `details_user_tags` field class, then filtered to the `[id] ...` pattern
  so the management control never gets pulled in as if it were a tag.

Matching on the Django field's own `field-<attribute_name>` class is more
reliable than label text or a body-text scan for both: it's what the server
actually renders from the model's attribute name, so it can't collide with
unrelated text elsewhere on the page. `tests/fetchtest.mjs` includes the
decoy table header as a regression case.

### Robustness

- **Currency columns** are discovered per-row from the `d_<id>_<name>` pattern —
  nothing assumes a fixed set of ~24 columns is present. A currency id not in the
  known registry still gets parsed and shown, defaulted to `token` kind and
  flagged "unclassified" rather than dropped or silently treated as real money.
- **Type codes** not in `TYPE_META` are labelled, counted, and surfaced rather
  than mis-categorized or dropped.
- If the CSV export action isn't available, the HTML-changelist fallback
  discovers whatever columns the admin's list view actually renders (via
  `field-*` CSS classes, then header text) and maps onto the same categories —
  it just won't see currencies the list view doesn't display.
- **Timestamps** parse ISO, Django's `March 14, 2026, 10:05 p.m.`, US `M/D/YYYY`,
  and epoch-millisecond columns.
- **CSV** parsing is RFC 4180 compliant — quoted commas, embedded newlines and
  `""` escapes are all handled.
- Headline numbers are never hand-modeled from assumed transaction semantics.
  Every KPI is a sum of a specific, named currency column over a specific set of
  type codes (e.g. "Cash Wagering Net" = the `redeemable_fliff_cash` delta summed
  over the wager and win type codes) — auditable against the Wallet tab and the
  Raw Data schema, not a reconstruction that could silently drift from the ledger.

---

## Extending it

### Add or reclassify a currency
`lib/core.js` → `CURRENCY_META`:

```js
5099: { key: 'new_currency', label: 'New Currency', kind: 'cash' },
```

`kind: 'cash'` stores the amount in cents and formats as `$`. `kind: 'token'`
formats as a plain integer. Anything not listed here still works — it just shows
up as "unclassified" until given a real label/kind.

### Map a new transaction type
`lib/core.js` → `TYPE_META`:

```js
4200: { category: 'bonus_claim', label: 'Referral Bonus', amountFields: [5013, 5005] },
```

`category` must be a key in `CATEGORIES`. `amountFields` lists candidate headline
currency ids in priority order — the first one that's nonzero on a given row
becomes that record's sort/filter amount; every currency the row actually touches
is still shown in full on the Transactions ledger regardless.

Check **Risk & Flags → Unclassified Type Codes** after a load — anything listed
there needs an entry.

### Adjust risk heuristics
`lib/core.js` → `riskSignals()`. Thresholds are inline and commented. These are
review aids, not compliance determinations.

### Change the shard
`lib/core.js` → `SHARD` (currently `32`). All URLs derive from it.

---

## Files

```
manifest.json      MV3 manifest — minimal permissions, self-only CSP, no persistent content_scripts
background.js      Service worker: side panel, context menus, keyboard command, id-chip click handler,
                   on-demand scanner injection (activeTab + chrome.scripting), sender/host/rate-limit validation
content.js         On-demand scanner (no longer <all_urls>): injected only after a user gesture, into an
                   allowlisted tab; auto-detects labeled account/player ids; real-gesture + cooldown gated
content.css        Styling for the injected id chips (scoped to .fliff-ims-idlink)
sidepanel.html/js  Quick-lookup panel
sidepanel.css
report.html/js     Full IMS report page
report.css
theme.css          Fliff design tokens, shared, light + dark
icons/             Extension icons + favicon (16/32/48/128px, Fliff blue→teal gradient, "IMS" mark)
lib/core.js        Currency/type registries (incl. FC vs $ units), parsing, categorization, aggregation,
                   formatting, the shared normalizePlayerId validator, CSV formula-injection guard,
                   confidence tagging
lib/fetcher.js     Network layer + fetch strategies + error messages; validates every id via
                   normalizePlayerId; hard-coded CSV export action + response validation/size/row caps
lib/charts.js      Dependency-free SVG charts (CSP-safe, no CDN)
tests/             2026 security-review suite (validator drift guard, core security surfaces, fetcher
                   hardening, content-script gesture/rate-limit, background sender validation, core
                   parsing/aggregation smoke) — see "Tests" below, including a note on an earlier suite
tests/fixtures/    mini_ledger.csv — small hand-built fixture for the core parsing/aggregation smoke test
                   (rendertest.mjs and terminologytest.mjs build their two-wallet fixtures inline)
preview/           Static rendered snapshots — open in any browser, no VPN needed
sheets/            Google Sheets edition — Code.gs (menu + output tabs), Core.gs (GENERATED
                   from lib/core.js, do not edit), build-core-gs.mjs, SETUP.md
```

`lib/charts.js` draws everything as hand-built SVG. No Chart.js, no CDN — the
manifest sets `script-src 'self'`, so external scripts would be blocked anyway.

---

## Tests

```bash
npm install --no-save jsdom
node tests/run.mjs
```

**Note on suite history**: this is a freshly-built suite written for the 2026
security-review remediation below. The much larger pre-existing suite (real
5,683-row export validation against pandas-computed totals, fantasy-wallet
inference, withdrawal pairing, deposit-bonus parsing, full e2e boots of
`report.html`/`sidepanel.html`, etc. — previously documented in this section)
was found empty/missing from the `tests/` directory at the start of the
security pass, for reasons unrelated to the changes made here. It has not been
reconstructed; the table below reflects what currently exists.

| Suite | Covers |
|---|---|
| `validatorsynctest.mjs` | Drift guard: the shared `PLAYER_ID_RE`/`normalizePlayerId` block duplicated in `background.js` and `content.js` (which can't `import` the canonical copy in `lib/core.js` — see "Extending it" note below) stays byte-for-byte identical (modulo indentation) in both places, plus basic accept/reject sanity checks |
| `securitytest.mjs` | `normalizePlayerId` accept/reject matrix (valid/whitespace/too short or long/letters/decimals/negative/path-traversal-shaped/null/undefined/empty input); `spreadsheetSafeText`/`FORMULA_PREFIX` CSV formula-injection guard cases; end-to-end `toCSV` (string fields neutralized, numeric fields stay real numbers); `recordConfidence` unit cases and end-to-end confidence propagation through `normalizeRow`/`aggregate`/`riskSignals` |
| `fetchertest.mjs` | Every fetch entry point (`fetchProfile`, `fetchTransactions`) rejects an invalid id before ever calling `fetch()`; the hard-coded `EXPORT_ACTION` is only submitted when it exists verbatim in the admin's action dropdown (a lookalike-but-unapproved action is correctly never submitted); response content-type rejection; login-page detection; byte-size and row-count caps |
| `contentscripttest.mjs` | `content.js` run verbatim in a jsdom page: the `isTrusted` gesture guard, the click cooldown, which labeled-id patterns do/don't get linked, and a behavioral proof that a synthetic (jsdom-dispatched) click does **not** trigger `runtime.sendMessage` |
| `backgroundtest.mjs` | `background.js` run verbatim in a jsdom page with a mocked `chrome` global: message-sender validation (extension id, real tab, allowlisted host, valid id), the shared rate limiter, and `scanTab()`'s allowlist gating for on-demand injection |
| `coresmoketest.mjs` | Basic parsing/categorization/aggregation regression against a small hand-built fixture (`tests/fixtures/mini_ledger.csv`) — a guard that the security pass's `lib/core.js` changes (domain rename, `PROFILE_PATH` refactor, `toCSV` rewrite, confidence wiring) didn't break the basic pipeline |
| `terminologytest.mjs` | Money format and Django-aligned naming: every cash currency renders as `$` (and no FC formatter or unit tag survives anywhere in the UI), `FC_CHAIN` still records which columns are really Fliff Cash, the `cashNetResult` per-wallet split sums to the combined figure without leaking across wallets, and the rendered labels say "Global Value" / "Superstars" |
| `rendertest.mjs` | Boots the real `report.html` + `report.js` against a mocked admin (synthetic profile page + CSV export) and asserts on the resulting DOM: the Global Value tile, the Cash Wagering Net FC/$ split, the Balance tile's FC badge, FC-tagged ledger badges, the Raw Data unit column, and that no `NaN`/`undefined`/`[object Object]` reaches the page |
| `degradedfetchtest.mjs` | The no-currency-columns failure mode and the export relay: every `tryCsvExport()` bail-out reports a reason (listing the admin actions actually offered when the approved one is missing), a 403 is explained as CSRF with both remedies named, the same-origin relay is used when available and its response is validated identically to a direct one (a relayed login page still raises `needsAuth`), a failed relay still falls through to the direct POST with both reasons preserved, and a full report boot against a changelist-only admin proves no fake `$0.00`, no spurious reconciliation Δ, Balance still rendered from the profile, and a loud error banner naming the cause |

**Sandbox note**: the three jsdom-based suites (`fetchertest.mjs`,
`contentscripttest.mjs`, `backgroundtest.mjs`) can appear to hang if
`node_modules` sits on a slow or virtualized filesystem (a network drive, a
FUSE mount, certain WSL configurations) — jsdom's own module load touches
enough files that the overhead compounds into tens of seconds. It's not a
code issue; if a run seems stuck, try again with `node_modules` on a local
disk.

---

## Privacy and safety notes

- Read-only. The extension issues `GET` requests plus one `POST` for the admin's
  own CSV export action. It never modifies player records.
- `host_permissions` is scoped to `fw10.app.corp.getfliff.com` only — that's the
  only domain the extension ever fetches data *from*.
- `content.js` (the id auto-linker) no longer runs on `<all_urls>`. As of 3.0.0
  it has no persistent content-script presence at all — see "Auto-linked
  account/player ids" above for the full on-demand-injection model. It's
  gated, in order, by: an explicit user gesture (context-menu click), the
  `ALLOWED_SCAN_HOSTS` exact-hostname allowlist (currently placeholders
  pending Security's real list — see below), and `activeTab`'s
  temporary-permission model. It only reads static page text client-side to
  find labeled ids and inject a clickable chip; it never transmits page
  content anywhere, and the only data that ever leaves the page is the
  literal id you click — itself re-validated and rate-limited — sent locally
  to this extension's own background worker.
- `localStorage` holds only the theme choice and recent player IDs — no profile
  or transaction data is persisted.
- Player data lives in memory for the life of the tab.
- Risk flags are heuristics for triage. They are not a compliance determination.
  As of 3.0.0, every figure and flag carries a confidence state — see
  "Confidence tagging" below — and inferred/unknown values are explicitly
  called out as unfit to drive a suspension, fraud, compliance, reconciliation,
  or automated-action decision on their own.

---

## Version history

There's no `package.json` in this project — `manifest.json`'s `"version"`
field is the single source of truth for the extension's version.

### 3.3.0 — Manual CSV import; export runs from the page, not the worker

3.2.0's same-origin export relayed through the service worker and failed with
`The message port closed before a response was received` — a messaging bug, not
an export bug. Fixed by removing the hop: `report.html` is an extension page
with full `chrome.*` access, so `lib/fetcher.js` now calls
`chrome.scripting.executeScript` directly. No message, so no message-port
failure mode and no sender-validation surface to get wrong.

Because two remote attempts at the CSRF problem both failed, this release also
adds a path that doesn't depend on the export working at all.

| Change | Detail | Where |
|---|---|---|
| Export injection moved to the page | `postExportViaAdminTab()` calls `chrome.tabs.query` + `chrome.scripting.executeScript` directly; the service-worker relay and its message handler are deleted | `lib/fetcher.js`, `background.js` |
| `exportInPage()` is verified self-contained | It's serialized for injection, so it can't reference module scope. A test extracts the function source and asserts it touches no module-level binding | `lib/fetcher.js`, `tests/degradedfetchtest.mjs` |
| **Manual "Load CSV…"** | Loads a transaction CSV exported by hand from Django admin, parsed in-page and never uploaded. Django's own export action always works from inside the admin UI, so a blocked automatic export now costs one manual step instead of the whole analysis. A list-view export (no `d_<id>_<name>` columns) is rejected with that explanation rather than showing zeros, and a file spanning several user ids raises a warning | `report.html`, `report.js` (`loadFromCsvFile`) |
| Header said `FW310` | The environment badge still read `FW310 · SHARD 32` — uppercase, so the earlier `fw310` sweep missed it | `report.html` |
| New test suite | `csvimporttest.mjs` (16 assertions) drives the real file input against a full export, a list-view export, a two-player file and an empty file. Suite total: 237 assertions across 10 files | `tests/` |

**This release makes the tool usable regardless of the CSRF outcome.** The
automatic export may now work with an admin tab open; if it doesn't, Load CSV
gets you the same figures.

### 3.2.0 — Fix the export 403; revert FC display

Two parts: the actual cause of the `$0.00` figures, and a rollback of the FC
units.

**The 403.** `tryCsvExport()`'s new diagnostics (3.1.1) reported
`HTTP 403` on the export POST. Cause: an extension page fetching the admin is
cross-origin, so the POST carried `Origin: chrome-extension://<id>` and no
`Referer` — the code set that header, but `Referer` is forbidden and Chrome
strips it silently — and Django's CSRF middleware rejects that. Every GET
succeeded; only the POST failed.

| Change | Detail | Where |
|---|---|---|
| Same-origin export relay | The POST now runs inside a tab already on the admin host via `chrome.scripting.executeScript`, making it genuinely same-origin so Django's CSRF check passes. Direct POST retained as a fallback for backends that trust the extension origin | `lib/fetcher.js` (`postExportViaAdminTab`), `background.js` (`runExportInAdminTab`, `exportInPage`) |
| Relay is validated like the rest of the messaging surface | Must originate from one of this extension's own pages, target `https` on the admin host only, and pass the shared rate limiter. The relayed body goes through the same `finishCsvExport()` checks (login page, content type, HTML, size, row caps) as a direct response, so it can't bypass the security review's validation | `background.js`, `lib/fetcher.js` |
| 403 now explains itself | The skip reason says a 403 is CSRF rejection rather than a permissions problem, and names both remedies: keep an admin tab open, or add the extension origin to Django's `CSRF_TRUSTED_ORIGINS` | `lib/fetcher.js` |
| Dropped the stripped `Referer` header | It never reached the server; setting it only made the failure harder to reason about | `lib/fetcher.js` |

**The FC revert.** 3.1.0's `39.86 FC` rendering is rolled back — every cash
currency formats as `$` again. This was a display choice, not a correctness
fix: it was never related to the `$0.00` bug, and the Global Value formula it
came in with was independently confirmed correct against the same admin page.

| Reverted | Kept |
|---|---|
| `fmtFC` / `fmtFCUnits`, the `unit` tags on `CURRENCY_META`, FC badges and pills, the Raw Data Unit column, `(FC)`/`(USD)` CSV headers, the FC balance badge | **"Global Value"** (validated: `9.69 − 192.00 − 6.29 = −188.60`, matching the admin exactly), the **Sportsbook/Superstars split** on Cash Wagering Net and Game Stats (now in `$`), **"Superstars"** naming, `FC_CHAIN` as reference data, and `barChart`'s per-row formatter hook |

### 3.1.1 — Degraded fetches no longer show fake zeros

Fixes a **3.0.0 regression** found on a live report: a player whose admin page
showed `$9.69` purchases and `$192.00` redemptions displayed `$0.00` for both,
with all 1,400 transactions `Other / Unmapped`. Cause: 3.0.0 replaced the old
export-action discovery with a single hard-coded `EXPORT_ACTION` and, when it
didn't match, `tryCsvExport()` returned `null` silently — falling back to the
changelist crawl, which carries none of the per-currency columns. Nothing on
screen indicated the figures were unavailable rather than zero.

Not caused by 3.1.0's FC work, which is display-only; the Global Value formula
was independently confirmed correct against that same admin page
(`9.69 − 192.00 − 6.29 = −188.60`, matching Django's Global Value exactly).

| Change | Detail | Where |
|---|---|---|
| Export failures name themselves | `tryCsvExport()` returns `{ skipped: <reason> }` on every bail-out (no CSRF, action absent, HTTP error, network error, wrong content-type, HTML body, unparseable, zero rows) instead of a bare `null`. When the approved action is missing it lists the action values the page actually offered, making an admin rename self-diagnosing. Surfaced as `exportSkipped` on the fetch result | `lib/fetcher.js` |
| Degraded fetches are detected | `state.meta.degraded` is set when records loaded but not one carried a currency entry | `report.js` |
| No monetary figure is rendered on a degraded fetch | New `money()` / `moneySub()` guards: every cash/token/bonus/XP KPI on Summary and Game Stats renders `—` + "currency data not in this fetch". Balance is exempt — it comes from the profile page and stays valid | `report.js` |
| Charts and reconciliation stop lying | Cash composition and timeline explain what's missing instead of "No cash movements in the selected period"; the reconciliation table shows profile figures with the ledger column marked *unavailable* rather than generating a full-size false Δ | `report.js` |
| Exports refuse to launder the gap | CSV export is blocked with an explanation; JSON export carries `hasCurrencyData`, `degraded`, `exportSkipped` and an explicit `warning` string in its `fetch` block | `report.js` |
| Loud, non-dismissing banner | Error-level (not warning), names the fetch method and the skip reason, and says what to do | `report.js` |
| New test suite | `degradedfetchtest.mjs` (26 assertions): each skip path reports its reason, the happy path is not flagged, and a full report boot against a changelist-only admin asserts no `$0.00`, no false Δ, Balance still present, and the banner content. Suite total: 215 assertions across 9 files | `tests/` |

### 3.1.0 — Django-aligned terminology and FC units

Display-and-naming pass, aligning the report with the admin's own vocabulary.
No change to how any figure is computed — the same cents come out of
`aggregate()`; this changes what they're labelled and how they're split for
display, plus one new derived pair (`cashNetResultSportsbook`/`Fantasy`).

| Change | Detail | Where |
|---|---|---|
| Sportsbook Fliff Cash now reads in **FC**, not `$` | Added a `unit` field to `CURRENCY_META`, the `FC_CHAIN` id list, and `fmtFC`/`fmtFCUnits`/`fmtByCurrency`; `fmtByKind` takes an optional unit. Applied to the Balance tile's sportsbook badge, Game Stats' cash block, the Wallet & Ledger table and its chart, ledger movement badges (incl. an `FC` pill), the currency filter dropdown, and the Raw Data schema's new Unit column | `lib/core.js`, `report.js`, `sidepanel.js` |
| Deliberately **not** applied to sportsbook real-money columns | `real_money_in/out` and `cash_out_locked/paid` (6001-6004) are actual dollars at a processor, so Deposits and Withdrawals Paid stay `$`. The Superstars wallet has no FC equivalent and stays `$` throughout | `lib/core.js` (`FC_CHAIN` comment) |
| **"Net Cash Position" → "Global Value"** | Matches the admin's `Global / net value` field; the Summary reconciliation row is relabelled to match, and the side panel's "Net Cash" tile follows | `report.js`, `sidepanel.js`, `preview/*.html` |
| **Cash Wagering Net now shows a per-wallet split** | New `cashNetResultSportsbook` (5013) / `cashNetResultFantasy` (8013) alongside the combined `cashNetResult`. The tile keeps a single combined `$` headline (FC redeems 1:1) with `X FC sportsbook` / `$Y superstars` badges beneath. Game Stats' Net Result tile gained the same split | `lib/core.js`, `report.js`, `sidepanel.js` (tooltip) |
| "Fantasy" → **"Superstars"** in user-facing labels | Fliff's own product name, and what the admin panel is titled. Wallet pills, KPI breakdown badges, the reconciliation row, and the Risk tab's inferred-categories heading. Internal field names (`depositFantasy`, `product: 'fantasy'`) are unchanged | `report.js`, `report.html`, `sidepanel.js` |
| CSV export headers carry the unit | Currency column headers now read `(FC)` or `(USD)` instead of `(cash)`, so an exported sheet can't be misread as all-dollars | `report.js` |
| `barChart` supports per-row formatters | Needed for the Wallet & Ledger cash chart, where FC and `$` rows sit in the same chart and one shared formatter would mislabel some bars | `lib/charts.js` |
| Two new test suites | `terminologytest.mjs` (53 assertions) covers the units/naming/split logic; `rendertest.mjs` (24) boots the real report page against a mocked admin and asserts on the rendered DOM. Suite total: 189 assertions across 8 files, all passing | `tests/` |

### 3.0.0 — 2026 security review remediation

Domain renamed `fw310` → `fw10` throughout (manifest `host_permissions`,
`lib/core.js`'s `BASE`, install instructions, side panel footer, preview
snapshots). All seven security-review items implemented — see "2026 security
review" above for the narrative and the table below for exactly what changed
where. Test suite rebuilt (the previous suite was found missing from
`tests/` at the start of this pass — see "Tests" above).

| # | Item | What changed | Where |
|---|---|---|---|
| 1 | Restrict content-script scope | Removed the persistent `"content_scripts"` block (`<all_urls>`, `all_frames: true`) from `manifest.json` entirely. Added `activeTab` + `scripting` permissions. Scanner now injects only on an explicit context-menu gesture, into the clicked tab only, `allFrames: false`, gated by the `ALLOWED_SCAN_HOSTS` exact-hostname allowlist | `manifest.json`, `background.js` (`scanTab`, `ALLOWED_SCAN_HOSTS`, `isAllowedScanHost`) |
| 2 | Require a real user gesture | Click handler checks `event.isTrusted` before acting; added a `CLICK_COOLDOWN_MS` (1000ms) throttle on repeated chip clicks | `content.js` |
| 3 | Strictly validate player IDs | Added one shared `PLAYER_ID_RE` / `normalizePlayerId` (`/^\d{4,10}$/`, reject-not-sanitize) in `lib/core.js`; duplicated verbatim (with a drift-guard test) into the two non-module contexts; applied at every id entry point | `lib/core.js`, `lib/fetcher.js`, `background.js`, `content.js`, `sidepanel.js`, `report.js` |
| 4 | Validate message senders | `onMessage` handler now checks `sender.id === chrome.runtime.id`, a real `sender.tab` with a numeric id, that tab's URL against the allowlist, `normalizePlayerId` on the payload, and the shared rate limiter — in that order, before opening a report tab | `background.js` |
| 5 | Remove automatic export-action discovery | Replaced regex-based admin-action matching with one hard-coded `EXPORT_ACTION` value, existence-checked against the action dropdown before submission; added response-status, content-type, login-page/HTML, byte-size, and row-count checks | `lib/fetcher.js` (`tryCsvExport`, `looksLikeLoginPage`, `EXPORT_ACTION`, `MAX_EXPORT_BYTES`, `MAX_EXPORT_ROWS`) |
| 6 | Protect CSV exports from formula injection | Added `FORMULA_PREFIX` / `spreadsheetSafeText`; `toCSV` now runs string-valued fields through it before quoting, while numeric currency fields stay real numbers | `lib/core.js` (`toCSV`, `spreadsheetSafeText`), `report.js` (fixed a currency-column formatter that had been stringifying numeric cells, which would otherwise have tripped the new guard on legitimate negative amounts) |
| 7 | Stop inferred data from driving consequential actions | Added `CONFIDENCE` states (Authoritative/Inferred/Unknown) and `recordConfidence`; every normalized record and risk signal now carries one; Risk & Flags tab shows badge counts and an explicit notice that Inferred/Unknown must not drive a suspension, fraud, compliance, reconciliation, or automated-action decision | `lib/core.js` (`CONFIDENCE`, `recordConfidence`, `normalizeRow`, `aggregate`, `riskSignals`), `report.js`, `report.html`, `report.css` |
| — | Domain rename | `fw310` → `fw10` | `manifest.json`, `lib/core.js`, `README.md`, `sidepanel.html`, `preview/*.html` |
| — | Version bump | `2.x` → `3.0.0` | `manifest.json` |

**Known open item**: `ALLOWED_SCAN_HOSTS` in `background.js` still has
placeholder entries for Slack, Zendesk, Atlassian, and the internal
dashboard. The scanner will not function on any of those tools until
Security provides the exact hostnames to use in their place.

**Not yet addressed** (raised in the same review, out of scope for this
change): publishing to GitHub with PR review, branch protection, and a
release process; who maintains the extension going forward; and — flagged
separately by the reviewer, pending SRE analysis — the question of whether
widespread support-team usage could put meaningful load on the underlying
database, since every "Analyze Transactions" action is a live fetch against
the Django admin, not a cached or rate-limited-server-side call.

### 2026 security review — what changed in 3.0.0

A data/security review of the pre-3.0.0 extension raised seven items. All
seven are implemented; see the "Version history" section below for the full
per-item table. In summary:

1. **Scope restriction** — the persistent `<all_urls>` content script is gone,
   replaced by `activeTab` + on-demand injection gated by an exact-hostname
   allowlist, `all_frames: false`. **`ALLOWED_SCAN_HOSTS` in `background.js`
   still contains `REPLACE_ME_...` placeholders for Slack/Zendesk/
   Atlassian/internal-dashboard — the scanner cannot function on those tools
   until Security supplies the real approved hostnames.** This is the one
   open item from the review that code alone can't close.
2. **Real user gesture required** — the id-chip click handler checks
   `event.isTrusted` and enforces a cooldown; the on-demand scan itself only
   ever fires from a context-menu click, never automatically.
3. **Strict player-ID validation** — one shared `normalizePlayerId` (reject,
   don't sanitize) applied in `content.js`, `background.js`, `sidepanel.js`,
   `report.js`, and `lib/fetcher.js`.
4. **Message-sender validation** — `background.js`'s `onMessage` handler
   checks `sender.id`, that a real tab exists, that tab's URL against the
   allowlist, the id validator, and a shared rate limiter, in that order.
5. **No more automatic export-action discovery** — `lib/fetcher.js` submits
   one hard-coded `EXPORT_ACTION` value only if it exists verbatim in the
   admin's action dropdown, then validates response status, content type,
   rejects login-page/HTML responses, and enforces a byte-size and row-count
   cap.
6. **CSV formula-injection protection** — string fields get a
   `spreadsheetSafeText` guard before quoting; numeric currency fields stay
   real numbers, never escaped strings.
7. **Confidence tagging** — every record and risk signal is tagged
   Authoritative / Inferred / Unknown, surfaced in the Risk & Flags tab with
   an explicit notice that Inferred/Unknown values must not drive a
   consequential decision on their own. This tool has no write/consequential
   actions of its own to gate — it's read-only — so this is a labeling
   safeguard for whoever acts on what it shows, not an access-control layer.

Publishing this to GitHub with branch protection, PR review, and a release
process, and who maintains the extension going forward, are open questions
raised in the same review and are organizational decisions outside this
codebase's scope.
