# Unusual Volume Widget — Requirements

| | |
|---|---|
| **Status** | Approved for v1 |
| **Last updated** | 2026-10-25 |
| **Repo** | Developed in the owner's fork; no upstream issue |
| **Design** | [`docs/design/unusual-volume-widget.md`](../design/unusual-volume-widget.md) |

## 1. Goal

Each morning, show every US stock that closed the **last trading session** with
a **green candle** on **unusually high volume**: ≥ 2.5× its average over the
prior sessions. For each stock, explain **why** the volume spiked using free,
verifiable evidence.

## 2. Definitions

| Term | Definition |
|------|------------|
| **Signal session (D)** | The most recent *fully closed* regular NYSE session (holidays and early closes from §6.5). |
| **Session volume (V)** | Regular-session volume of D (TradingView `volume`). |
| **Baseline (ADV30)** | `(30 × average_volume_30d_calc − V) / 29`. This is the exact mean of the 29 sessions **before** D, with D excluded (§6.2). |
| **Relative volume (RVOL)** | `V / ADV30` |
| **Green candle** | `close(D) > open(D)` |
| **Previous close** | `close / (1 + change / 100)`, derived from the scan's `change` column |
| **Day change** | `close(D) / prevClose − 1`. Shown as a column, but it is *not* the filter. |

> Edge case (decided): only the candle counts. A gap up that fades (red candle)
> is **excluded**. A gap down that recovers (green candle) is **included**.

## 3. Functional requirements

### 3.1 Universe & filtering
- **FR-1** Universe: US-listed common stocks only (`type=stock`, `typespecs=common`, no OTC), the same rules as `marketScan`.
- **FR-2** Include a symbol when **`RVOL ≥ threshold` AND green candle**.
- **FR-3** Threshold presets: **2.5× (default), 3×, 5×**, plus a custom value **≥ 2.5**. The daily run stores rows at 2.5×; widget filters can only *tighten* the stored set, never loosen it (that would need re-scanning and re-enriching, see §5).
- **FR-4** The lookback is fixed: a 30-session window with D excluded.
- **FR-5** Liquidity floor, applied by the run (fixed):
  - **ADV30 ≥ 1,000,000 shares**
  - price ≥ $1
  - market cap ≥ $300M
  The widget may raise the market-cap floor further; it cannot lower it.
- **FR-6** Optional sector filter, using TradingView sector names as the screener does.
- **FR-7** **New listings are excluded.** A symbol needs at least 31 daily bars (D + 30 prior). Check method: §6.3.

### 3.2 Display
- **FR-8** Columns, in priority order. Columns drop from the right as the widget narrows; the first five are always visible:
  1. Symbol
  2. Close
  3. Candle % (close vs. open)
  4. **RVOL**
  5. **Catalyst**
  6. Day Chg%
  7. Volume
  8. ADV30
  9. $ Volume
  10. Market Cap
  11. Sector
  12. Name
- **FR-9** Default sort: RVOL, descending. Every column can be sorted (same header interaction as `ScreenerWidget`). Catalyst sorts by the strongest tag's strength (Strong > Medium > Weak > Context > none), then by tag name.
- **FR-10** The header shows the signal session date (`Session: Fri 23 Oct 2026`), an `early close` marker when D was a half day, the result count, and the time of the last run.
- **FR-11** RVOL is shown in color tiers: 2–3×, 3–5×, 5×+.
- **FR-12** Clicking a row sets the active symbol (`setActiveSymbol`). A chevron expands the row to show the evidence panel and the Explain output.
- **FR-13** Empty, loading and error states follow the existing widgets. The widget renders inside `WidgetErrorBoundary`, as every widget does through `Workspace`.
- **FR-13b** The list and the catalysts are saved as two phases. If the list exists but enrichment hasn't finished (typical for a catch-up run), the rows render and the Catalyst column shows `…` until the enrichment lands.

### 3.3 Integration
- **FR-14** Registration, matching how existing widgets are wired:
  - add `"unusual-volume"` to `WidgetType`
  - add it to `SIZE_BY_TYPE` (suggested 12 × 9, like `screener`)
  - add a case in the `Workspace` render switch and its title map
  - add a `Sidebar` entry `UNUSUAL VOL`
  - ⌥1–⌥9 are all taken, so the entry gets **no shortcut** (`key: ""`), like `calendar` and `insider`
- **FR-15** Filter state (threshold, floor, sector, sort) is local component state, **not persisted**. This follows `ScreenerWidget`. Persisting would need a new per-widget settings field in the store, which is out of scope for v1.

## 4. Catalyst detection — the "why"

### 4.1 Principle
The "why" is built from **evidence**, not guesses. Every tag comes from a
concrete data point that the user can open (a filing, an earnings date, or a
timestamped headline). If nothing is found, the row says **"No catalyst found"**.
That is a signal too: unexplained volume can mean institutional accumulation.

### 4.2 Catalyst time window
Evidence counts if its timestamp falls between **16:00 ET on D-1** and **the
time of the run**. Including the evening of D-1 catches after-hours news, such
as earnings released after the previous close, which drive D.

**Post-close evidence (after 16:00 ET on D):** D's volume happened before it, so
it cannot be the cause.
- **Headlines** after D's close keep full weight: they are usually the write-ups that explain the day.
- **Filings and earnings releases** after D's close are shown in the evidence panel with an `after close` label, demoted to **Context** strength, and worded *"reported after close, reaction expected next session"*. They never produce a Strong tag on their own.

Timestamps come from fields with time-of-day precision: EDGAR's
`acceptanceDateTime` (not the date-only `filingDate`), the RSS `pubDate`, and
TradingView's epoch-second earnings fields. For Form 4, the **filing** time is
what counts, not the trade date: insiders file one or two days after buying, and
the filing is what the market reacts to.

### 4.3 Sources

All sources are free and already used in the codebase. The table shows how many
requests each run makes.

| # | Source | Existing code | Gives | Requests per run |
|---|--------|---------------|-------|------------------|
| 1 | TradingView scanner, **whole** liquid US universe (no top-N cap; range sized to ~5,000 and the run asserts the response wasn't truncated) | `tradingview.ts` (new `unusualVolumeScan`) | volume, averages, OHLC, change, sector, float, earnings dates | **1** |
| 2 | TradingView scanner, `AMEX:SPY` | `tradingview.ts` | Market day change | **1** |
| 3 | SEC EDGAR submissions | `secedgar.ts` (`edgarFetch`, ticker→CIK map) | Filings in the window: form + 8-K items | 1 per match |
| 4 | SEC EDGAR Form 4 | `secedgar.insiderTransactions` | Insider purchases | Only for matches with a Form 4 in the window |
| 5 | **Google News RSS** (primary), query `"{company name}" stock` | `news.topNews(query)` (existing) | Timestamped headlines from all publishers | 1 per match |
| 5b | Yahoo Finance RSS (fallback, per symbol) | `news.symbolNews` | Headlines, used only when Google fails or returns nothing | 0 in the normal case |
| 6 | Nasdaq earnings surprise | `nasdaq.earningsSurprise` | EPS actual vs. estimate | Only for **EARN**-tagged matches, usually a handful |
| 7 | Nasdaq historical | `nasdaq.ts` | Bar count for the new-listing check (§6.3) | Only for matches not yet known to be ≥ 31 bars |
| 8 | The scan itself | — | Sector move, sector clustering | 0 |
| 9 | Market calendar module | new, §6.5 | Holidays, OPEX, rebalance and reconstitution days | 0 |

- Per-match calls go through `mapWithConcurrency`, staying under EDGAR's 10 requests/second limit. Google News is fetched at a concurrency of 2 with a short delay between calls.
- No per-symbol Yahoo **history** calls are made. The yearly-high style facts were dropped to stay clear of Yahoo's rate limiter.
- A typical run of 20–100 matches makes roughly 2 + 2 × matches requests. The 2.5× base (FR-3) keeps that bounded; loosening the threshold would roughly double it, which is why it isn't offered.
- **Google query noise:** the query uses the company name from the scan, not the ticker, so short symbols (`F`, `A`, `T`) don't match unrelated news. Headlines are kept only if they mention the company name or the ticker.

### 4.4 Tagging rules

A row can have several tags. The strongest is shown first.

| Tag | Rule | Strength |
|-----|------|----------|
| **EARN** | `earnings_release_date` is in the window, **or** an 8-K **Item 2.02** is in the window | Strong |
| **M&A** | 8-K **Item 1.01 / 2.01**, or form `SC TO-T` / `DEFM14A` / `425`, **or** a headline matching `acquir\|merger\|buyout\|takeover\|to be acquired\|deal to buy` | Strong (filing) / Medium (headline) |
| **ACTIVIST** | `SC 13D` / `SC 13D/A` in the window | Strong |
| **INSIDER BUY** | Form 4 with transaction code `P` in the window | Strong |
| **FDA / TRIAL** | Headline matching `FDA\|approval\|PDUFA\|phase [123]\|trial results\|topline` | Medium |
| **ANALYST** | Headline matching `upgrade\|initiat\|price target\|raises target\|outperform\|overweight\|buy rating` | Medium |
| **GUIDANCE** | Headline matching `guidance\|raises outlook\|raises forecast\|preannounce` | Medium |
| **CONTRACT** | Headline matching `contract\|awarded\|partnership\|agreement with\|collaboration` | Medium |
| **INDEX** | Headline matching `added to (the )?S&P\|join.*index\|Russell reconstitution` | Medium |
| **8-K** | Any other 8-K in the window, with its item numbers translated (5.02 executive change, 8.01 other event, …) | Weak |
| **NEWS** | Headlines in the window that match no rule above | Weak |
| **SECTOR** | ≥ 25% of the stored 2.5× result set is in this sector **and** the sector has ≥ 5 matches (computed by the run, not on the user's filtered view) | Context |
| **OPEX / REBAL** | D is a calendar flag day (§6.5) | Context |
| **—** | No evidence | — |

The keyword rules are a typed constant array in the server module. This is the
same pattern as `EUROPE_MARKETS` in `tradingview.ts`. Changing a rule is a code
change and needs a matching test case.

### 4.5 Evidence panel (expanded row)
- Each tag lists its evidence:
  - headline, publisher and time (linked)
  - filing form, items and time (linked to EDGAR)
  - earnings date, with BMO/AMC timing
- At most 5 headlines, newest first, de-duplicated with `news.dedupe`.

### 4.6 "Explain" — two modes

| Mode | When | Output |
|------|------|--------|
| **Rule-based** (default) | Always | A template summary (§4.7) |
| **AI** | Only when **both** are true: (a) the server reports AI as available, **and** (b) the user switches on "Use AI for Explain" in the widget (off by default; disabled with the hint "AI not configured" otherwise) | One or two sentences from `/api/ai/chat`, using only the provided evidence |

- **Availability check:** `GET /api/status` already returns `ai: boolean`. The widget reads that; no new endpoint.
- **Automatic fallback:** if AI is off, unavailable, slower than 15 s or errors, the rule-based summary is shown. A label shows the mode that produced the text (`RULES` / `AI`).
- **AI prompt input:** the row's numbers, the §4.7 facts, the tags, the headlines and the filings. The prompt forbids outside knowledge and requires "No clear catalyst in available sources" when the evidence is thin.
- **Caching:** the AI result is cached per (D, symbol) for the browser session (React Query) and only requested on click. The rule-based summary is precomputed by the run.

### 4.7 Rule-based "Explain" — facts & template

The summary has up to 4 lines. A fact is shown only if its data exists.

**Line 1 — Catalyst** (the strongest tag, with detail)
- Earnings: *"Q3 earnings after close Oct 22 — EPS $1.42 vs $1.21 est (beat +17%)"*
- Filing: *"8-K: Entry into material agreement (1.01)"*, *"13D: new activist stake filed"*
- Insider: *"CEO bought 50,000 sh ($2.1M) on Oct 22"*
- Top headline, with publisher and time
- Otherwise: *"No catalyst found in news, filings or earnings."*

**Line 2 — The move** (all values come from the scan; no history calls)
- RVOL: *"3.8× its 29-session average"*
- Gap: `open / prevClose − 1`. Candle: `close / open − 1`.
- Close location: `(close − low) / (high − low)`.
  - ≥ 0.8 → "closed near high"
  - ≤ 0.4 → "faded from high"

**Line 3 — Who's trading**
- Turnover: `V / float_shares_outstanding`, e.g. *"Traded 14% of float"*. Omitted when float is null.
- Dollar volume: `V × close`, e.g. *"$480M traded"*

**Line 4 — Context**
- Sector move: the **median day change of all universe stocks in the same TradingView sector**, computed from the scan, plus how many sector peers are on the list. Example: *"Electronic Technology median +2.4%; 7 on the list"*. This needs no ETF mapping and no extra requests.
- Market: SPY day change and the total match count.
- Calendar: an OPEX / S&P rebalance / Russell reconstitution flag, and *"Earnings in N days"* when `earnings_release_next_date` is ≤ 7 days away.

**Example**
> **XYZ · RVOL 3.8×**
> Q3 earnings after close Oct 22 — EPS beat +17%; "XYZ raises full-year guidance" (Reuters, 16:12).
> 3.8× its 29-session average · gapped +6.2%, closed +4.1% above open, near day high.
> Traded 4% of float · $480M.
> Electronic Technology median +2.4%, 7 on the list · SPY +0.6% · 41 matches today.

**Wording rules**
- Facts within a line follow a fixed priority list.
- Numbers are formatted with the existing `fmt` / `fmtBig` helpers.
- Hedged phrases are only allowed from a fixed list, each tied to a threshold ("possible run-up" ⇔ earnings ≤ 7 days away).

**Phasing**
- **v1:** everything in §4.7 above.
- **v1.1** (uses the §6.6 snapshot store):
  - multi-day volume streak
  - SMA 50/200 crosses
  - 20-day-high breakout
  - FINRA short-volume ratio vs. its 30-day average
  - news-burst baseline
- **Dropped:** 52-week/all-time highs and "highest volume since…". These need per-symbol yearly history and would hit Yahoo's rate limiter.
- **Later:** unusual options activity.

## 5. Scheduling & freshness
- **FR-16** A daily run at **06:00**, configurable with `UNUSUAL_VOLUME_RUN_AT` (`HH:MM`) and interpreted in `UNUSUAL_VOLUME_TZ` (IANA name, default `Asia/Jerusalem`). The time zone is explicit because the Docker image runs on UTC, where "06:00 local" would be 08:00–09:00 in Israel. It is an in-process timer in the server, since the server has no scheduler today. All market-hours logic uses `America/New_York` via `Intl.DateTimeFormat`, never fixed offsets.
- **FR-17** Catch-up: if the server was off at run time, the run happens on startup, or on the first request when the run for the current D is missing.
- **FR-17b** Idempotent: a run is skipped when a result for the same D already exists. Saturday, Sunday and Monday mornings all resolve to Friday's session and produce one run, not three.
- **FR-18** Results are saved in SQLite, so a restart serves the last run without refetching. Runs are kept for **90 days**, then pruned.
- **FR-19** **Market-hours guard:** if a run (usually a catch-up) would start between 04:00 and 20:00 ET (pre-market, regular session and the untested after-hours window; 11:00–03:00 Israel time), the server does **not** scan. The scanner's numbers would include today's unfinished session. The widget keeps showing the last saved run, marked with its date.
- **FR-20** A manual **Refresh** in the widget re-runs the catalyst enrichment (not the scan) for the current list. This picks up news published after the morning run. Cooldown: 10 minutes per D, enforced server-side.
- **FR-21** Logging: each run writes one summary line: D, universe size, counts after the liquidity, RVOL and candle filters, matches, requests made per source, failures per source, duration. The manual acceptance checks in §8.2 read these counts.

## 5b. Non-functional requirements
- **NFR-1** Free data only. Fully functional with no AI key; AI is opt-in.
- **NFR-2** `GET /api/unusual-volume` responds in < 500 ms from saved results. No provider call happens on the request path except a catch-up run.
- **NFR-3** Graceful degradation: if one enrichment source fails for a symbol, that symbol's tags from that source are missing and the row still renders. If a source fails for the whole run (e.g. EDGAR down), the run completes and the summary line records it; the Refresh button retries enrichment later.
- **NFR-4** Request budget per run stays within: 2 scanner calls, ≤ 1 EDGAR submissions call per match (+ Form 4 fetches only where a Form 4 is in the window), ≤ 1 Google News call per match (+ Yahoo only on fallback), Nasdaq earnings only for EARN-tagged matches, Nasdaq history only for unseasoned matches.

## 6. Data approach

Main scan: one TradingView request over the liquid universe. Liquidity is
prefiltered server-side at `average_volume_30d_calc ≥ 900k`; the exact ADV30
filter is applied after the correction. The prefilter cannot drop a qualifying
stock: for any match `V > ADV30`, so the raw 30-day average (which includes V)
is always ≥ ADV30 ≥ 1M. Columns:
- `open`, `high`, `low`, `close`, `change`, `volume`
- `average_volume_30d_calc`
- `market_cap_basic`, `sector`, `float_shares_outstanding`
- `earnings_release_date`, `earnings_release_next_date`

### 6.1 Validation results (2026-10-24, D = Fri 2026-10-23)
We compared the scanner with Nasdaq daily bars for AAPL, MSFT, JPM, KO, AMD, F, INTC and XOM.

| Question | Finding |
|----------|---------|
| Does `average_volume_30d_calc` include D? | **Yes.** It is the mean of the last 30 sessions *including* D (0.00% difference on all 8; the same holds for 10/60/90d). |
| Trading or calendar days? | Trading sessions. A calendar-day mean was off by 2–10%. |
| Does `volume` match? | Yes, consolidated regular-session volume. |
| `relative_volume_10d_calc` | `V / mean(10 prior sessions)`, with D excluded. This is the same convention we adopt. |
| `float_shares_outstanding` | Sometimes null (e.g. MSFT). |

### 6.2 Baseline correction
Including D would understate spikes: a true 3.0× reads as about 2.8×. We remove D arithmetically:
`ADV30 = (30 × avg30 − V) / 29`, then `RVOL = V / ADV30`.
This uses only the two TradingView columns.

### 6.3 New-listing check (FR-7)
TradingView exposes no listing date. For each **match** only, fetch Nasdaq
historical bars with a limit of 31.
- With ≥ 31 bars, the symbol is cached in SQLite as "seasoned" and never checked again.
- With fewer, the symbol is excluded.
- After the first week of runs, this is close to zero requests per day.

### 6.4 Run-time window
The machine runs on **Israel time**, so the 06:00 run is 23:00–00:00 ET: after the close and well before pre-market opens at 04:00 ET. The scanner describes D at that time. Pre-market behaviour (04:00–09:30 ET, i.e. 11:00–16:30 Israel time) was **not** tested. If `UNUSUAL_VOLUME_RUN_AT` is ever moved into that window, test with the §6.1 script first.

Open check, non-blocking: how a recent IPO looks in `average_volume_30d_calc`, to see whether §6.3 could be skipped.

### 6.5 Market calendar module
A new typed-constant module, e.g. `server/src/marketCalendar.ts`. Like `EUROPE_MARKETS`, the data is updated by a code change.
- **NYSE holidays and early closes:** a constant per year, updated yearly.
- **Monthly OPEX:** computed as the 3rd Friday of the month, or the Thursday before it when that Friday is a holiday.
- **S&P quarterly rebalance:** computed as the 3rd Friday of Mar/Jun/Sep/Dec.
- **Russell reconstitution dates:** a per-year constant, since FTSE Russell publishes them each year.
- Unit tests cover the date rules and the holiday-to-signal-session resolution.

### 6.6 Daily snapshot store (v1.1)
After each run, store `(date, symbol, open, high, low, close, volume)` for the
universe and FINRA short volume in SQLite. This feeds the v1.1 facts. It is
**not** used for RVOL.

## 7. Engineering conventions (follow the repository's norms)

### 7.1 Server
- **Provider code:** add the scan to `server/src/providers/tradingview.ts` (new `unusualVolumeScan`), next to `marketScan`, reusing its `HEADERS` and its row-mapping style.
- **Feature logic:** a new module, e.g. `server/src/unusualVolume.ts`. It holds pure functions for RVOL, the candle rule, filters, tagging and the template, separate from the I/O so they can be tested without the network.
- **Route:** `GET /api/unusual-volume` in its own `server/src/routes/unusualVolume.ts`, mounted under the same prefix, per-IP rate limiter and error shape as `marketRouter` (see the design doc).
  - Query params are parsed the way `/screener` does it.
  - Errors go through the shared `fail(req, res, err)`.
  - `cached()` / stale fallback are used for provider calls.
- **Comments:** document the fan-out bound in a block comment above the orchestration, the way `getQuotes` documents its worst-case request count.
- **SQLite:** tables are added in `server/src/db.ts` with `CREATE TABLE IF NOT EXISTS`. They hold the run results, the seasoned symbols and, in v1.1, the snapshots.
- **Imports:** ESM with `.js` import suffixes, and TypeScript types exported next to their functions (e.g. `MarketRow`).
- **Fan-out and requests:** `mapWithConcurrency` for fan-out. EDGAR requests keep the existing contact-email User-Agent.

### 7.2 Web
- **Widget file:** `web/components/widgets/UnusualVolumeWidget.tsx`, with `"use client"`.
- **Data and formatting:** fetch with `useQuery` + `apiGet`, and format with `fmt` / `fmtBig` / `pctClass` from `web/lib/api`.
- **Styling:** the `data-table` and `term-btn` classes and CSS variables (`--amber`, …). No new UI libraries.
- **Symbols:** pass symbols through the existing symbol validation and encoding (`web/lib/symbol`, PR #37).
- **Refetch:** at most every 15 minutes, since the data changes once a day.
- **Server-side logic:** the web workspace has no test runner, so the logic stays on the server and the widget stays a thin view.

### 7.3 Tests
- Use **vitest**, with `*.test.ts` files next to the code (e.g. `unusualVolume.test.ts`, more cases in `tradingview.test.ts`).
- **No live network calls in tests.** Mock `fetch` with `vi.stubGlobal("fetch", …)` and call `vi.unstubAllGlobals()` in `afterEach`, as `tradingview.test.ts` does.
- Fixtures stay small and inline: hand-built scanner rows `{ s, d: [...] }`, as in the existing tests.
- CI (`.github/workflows/ci.yml`) must pass: `npm run test -w server`, `npm run build -w server`, `npm run build -w web`. Run `npm run lint` for web.

### 7.4 Docs & process
- Use conventional commit subjects, as in the history, e.g. `feat(unusual-volume): …` and `fix(web): …`.
- When the widget ships:
  - add a bullet to the README **Features** list
  - add the widget to the README project-structure line for `components/widgets/`
  - add a screenshot under `docs/screenshots/` if the other features have one
- Update **Last updated** in this doc whenever a decision changes. Record each decision in §9.

## 8. Acceptance criteria

### 8.1 Automated (vitest, runs in CI)

**RVOL and filters**

| # | Given | Expect |
|---|-------|--------|
| A1 | Scan row with `volume = 3,000,000` and `avg30 = 1,100,000` | ADV30 = 1,034,483 and RVOL = 2.90 (2 dp) |
| A2 | TradingView raw ratio 2.40, corrected RVOL 2.52, green | **Included** (proves the D-exclusion correction matters) |
| A3 | Corrected RVOL exactly 2.50, green | Included (`≥`) |
| A4 | RVOL 2.49, green | Excluded |
| A5 | RVOL 4.0, `close < open`, `close > prevClose` (gap and fade) | Excluded |
| A6 | RVOL 4.0, `close > open`, `close < prevClose` (gap down, recovered) | Included |
| A7 | ADV30 = 950,000, everything else qualifies | Excluded by the liquidity floor |
| A8 | Nasdaq history returns 20 bars | Excluded as a new listing; not cached as seasoned |
| A8b | Scanner returns exactly the requested range size | Run fails loudly ("universe truncated") instead of saving a partial list |

**Signal session and scheduling**

| # | Given | Expect |
|---|-------|--------|
| A9 | Run on Sat 2026-10-24 | D = Fri 2026-10-23 |
| A10 | Run on the day after a market holiday, before the open | D = the last session before the holiday |
| A11 | Catch-up run requested at 11:00 ET on a trading day | No scan; the last saved run is returned |
| A11b | Catch-up run requested at 05:00 ET on a trading day (pre-market) | No scan; the last saved run is returned |
| A11c | A run for D already exists | Second run for the same D is skipped |
| A11d | `UNUSUAL_VOLUME_TZ=Asia/Jerusalem`, process TZ = UTC | Timer fires at 06:00 Jerusalem, not 06:00 UTC |

**Catalysts and Explain**

| # | Given | Expect |
|---|-------|--------|
| A12 | `earnings_release_date` at 16:05 ET on D-1, with an earnings surprise of actual 1.42 / est. 1.21 | EARN tag; line 1 reads "beat +17%" |
| A12b | `earnings_release_date` at 16:05 ET on **D** | No Strong EARN; shown as Context with `after close`, "reaction expected next session" |
| A12c | 8-K Item 1.01 accepted at 17:30 ET on D | M&A shown as Context with `after close`, not Strong |
| A13 | EDGAR 8-K with items `1.01` in the window | M&A tag (Strong) with the filing link |
| A14 | Headline "Analyst upgrades XYZ to Buy" in the window, and one at 15:00 ET on D-1 (outside) | ANALYST from the first only |
| A14b | Google News returns 429 for a symbol | Yahoo RSS is tried; headlines come from Yahoo |
| A14c | Google result for symbol `F` includes a headline without "Ford" or "F" | That headline is dropped |
| A15 | No filings, headlines or earnings | "No catalyst found…" |
| A16 | EDGAR fetch fails (502) | Row still present, with no filing tags |
| A17 | `float_shares_outstanding = null` | The turnover fact is omitted; no "NaN%" |
| A18 | AI status unavailable / AI toggle off / AI returns 503 / AI exceeds 15 s | Rule-based text, labeled `RULES` |
| A19 | Calendar: the 3rd Friday of Mar 2027 | OPEX and REBAL flags set |

### 8.2 Live acceptance (manual, once before merging, on a real morning)
1. The 06:00 run happened. The header shows the previous US session's date and the run time.
2. **RVOL accuracy:** for 5 listed symbols, recompute RVOL from Nasdaq daily bars (V / mean of the 29 prior sessions). All 5 are within ±1%.
3. **Candle rule:** every listed row has `close > open`. In the raw scan, find 3 symbols with RVOL ≥ 2.5 and a red candle. None of them is listed.
4. **Liquidity:** every listed row has ADV30 ≥ 1M.
5. **Earnings:** at least one listed stock that reported between D-1's close and D's close shows EARN, and its beat/miss matches nasdaq.com.
6. **Persistence:** restart the server. The list returns from SQLite with no new scanner call (checked in the server log).
7. **No AI key:** Explain works and is labeled `RULES`, and the AI toggle is disabled with "AI not configured".
8. **Speed:** `GET /api/unusual-volume` returns in < 500 ms from saved results.

## 9. Decisions log
| Topic | Decision |
|-------|----------|
| "Positive" | High volume **and** a green candle (`close > open`). Day change is not a filter. |
| Baseline | 30-session window with D excluded → `(30·avg30 − V)/29` from TradingView (§6.2) |
| Threshold | 2.5× fixed base for the run; widget can tighten (3×, 5×, custom ≥ 2.5), not loosen |
| Liquidity | ADV30 ≥ 1M shares, price ≥ $1, market cap ≥ $300M, fixed in the run; widget can raise the cap floor |
| Universe | US common stocks only |
| New listings | Excluded (§6.3) |
| Yearly highs | Dropped, to avoid rate limits |
| Sector context | Median day change of the TradingView sector, computed from the scan, with no ETF mapping |
| Schedule | 06:00 Israel time daily (= 23:00 ET), with catch-up and a market-hours guard (§5) |
| Columns | All 12, collapsing by priority (FR-8) |
| Explain | Rule-based by default and as the automatic fallback. AI only if available **and** switched on. |
| Own history | Built where no free source exists (v1.1 snapshot store); not used for RVOL |
| Settings persistence | Not persisted, matching the screener (FR-15) |
| Headlines | Google News RSS primary (company-name query), Yahoo RSS fallback |
| Post-close evidence | Headlines keep full weight; filings/earnings after 16:00 ET on D are Context, labeled `after close` |
| Time zone | Run time in `UNUSUAL_VOLUME_TZ` (default `Asia/Jerusalem`); market logic in `America/New_York` |
| Retention | 90 days of runs |

## 10. Open items
- None blocking. See §6.4 for the IPO check.
