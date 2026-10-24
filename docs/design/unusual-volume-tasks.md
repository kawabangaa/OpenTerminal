# Unusual Volume Widget — Task Breakdown

| | |
|---|---|
| **Last updated** | 2026-10-25 |
| **Requirements** | [`docs/requirements/unusual-volume-widget.md`](../requirements/unusual-volume-widget.md) (FR/NFR/A-n IDs) |
| **Design** | [`docs/design/unusual-volume-widget.md`](unusual-volume-widget.md) (§ references) |

## How to read this

- Tasks are sized **S** (≤ ½ day), **M** (≈ 1 day), **L** (2–3 days). One task = one PR unless noted.
- **Depends on** lists the tasks whose merged code this one imports. Tasks with no dependency can start in parallel on day 1 (T1–T10).
- Every task's **Tests** section is part of its scope. A task is not done until its tests exist, pass locally and in CI, and the acceptance IDs it names are covered.
- Interfaces between tasks are fixed by the design doc §4 types. If you must change a signature, update the design doc in the same PR and tell the owners of dependent tasks.

## Repository test standard (applies to every task)

Copied from how the repo already works. Reviewers will check each item.

1. **Runner:** vitest, `*.test.ts` next to the module. `npm run test -w server` must pass. The `web` workspace has no test runner; web logic that needs testing moves to the server or into a tiny pure helper.
2. **No network in tests.** Stub `fetch` with `vi.stubGlobal("fetch", vi.fn()…)` and restore with `vi.unstubAllGlobals()` in `afterEach` (or `try/finally`), as `providers/tradingview.test.ts` and `routes/market.test.ts` do.
3. **Fixtures are small and inline.** Hand-built scanner rows `{ s: "NASDAQ:XYZ", d: [...] }`, minimal EDGAR JSON, 2–3-item RSS strings. No recorded multi-KB payloads.
4. **Database tests** follow `db.test.ts`: set `process.env.DATA_DIR` to a `mkdtempSync` dir in `beforeAll`, then `await import("./db.js")` dynamically; `db.close()` and `rmSync` in `afterAll`. Never touch `data/terminal.db`.
5. **Route tests** follow `routes/market.test.ts`: pull the handler from `(router as any).stack`, call it with a fake `req` and a `res` whose `status`/`json` are `vi.fn().mockReturnThis()`.
6. **Time-dependent code** takes `now: Date` as a parameter (or a clock function) so tests pass fixed instants; use `vi.useFakeTimers()` only for the scheduler.
7. **Comments** explain the *why* (provider quirks, bounds, budgets) as the existing providers do; no comment restating the code.
8. **CI must be green:** `npm run test -w server`, `npm run build -w server`, `npm run build -w web`, plus `npm run lint` for web changes.
9. **Commits:** `feat(unusual-volume): <what>` / `test(unusual-volume): …` / `fix(unusual-volume): …`.
10. **Definition of done** for every task: scope implemented · tests listed below pass · CI green · design doc updated if an interface changed · PR description lists the acceptance IDs covered.

---

## Phase A — Foundations (parallel, no dependencies)

### T1 · Time-zone helpers — `server/src/time.ts` · **S**

**Scope**
- `zonedParts(date: Date, tz: string): { date: "YYYY-MM-DD"; hhmm: "HH:MM"; minutes: number; weekday: 0–6 }` via `Intl.DateTimeFormat(..., { timeZone: tz, hour12: false })` + `formatToParts`. No fixed offsets.
- `nyParts(date)` = `zonedParts(date, "America/New_York")`.
- `wallClock(tz, now = new Date())` = `zonedParts(now, tz)`.
- `nyDateTime(dateYmd: string, hhmm: string): Date` — the UTC instant for a NY wall-clock time (search ±1 h around the naive offset, pick the instant whose `nyParts` round-trips; handles DST).
- `isValidTimeZone(tz)`, `isValidHhmm(s)`.
- Out of scope: holidays, trading-day logic (T2).

**Tests — `time.test.ts`**
- A fixed UTC instant maps to the expected Jerusalem and New York wall clocks (**A11d** groundwork).
- Same across a DST boundary: one instant in March after US DST starts but before Israel DST, one in November.
- `nyDateTime("2026-10-23", "16:00")` equals `2026-10-23T20:00:00Z`; a July date gives the −4 h offset.
- `isValidTimeZone("Asia/Jerusalem")` true, `"Mars/Olympus"` false; `isValidHhmm("06:00")` true, `"6:00"` / `"24:00"` false.

---

### T2 · Market calendar — `server/src/marketCalendar.ts` · **M**

**Scope** (design §7)
- `HOLIDAYS` and `EARLY_CLOSES` as `Record<number, string[]>` for **2026 and 2027** (NYSE official lists), each with a one-line source comment.
- `isTradingDay(ymd)`, `previousTradingDay(ymd)`, `closeTimeHhmm(ymd)` (`"13:00"` on early-close days, else `"16:00"`).
- `resolveSignalSession(now: Date): { sessionDate: string; earlyClose: boolean }` — today's NY date if trading day and NY time ≥ close time, else previous trading day.
- `inScanWindow(now: Date): boolean` — NY time in `[20:00, 04:00)`.
- `flagsFor(ymd): { opex: boolean; spRebalance: boolean; russell: boolean }` — 3rd Friday rule with holiday shift to the preceding trading day; `spRebalance = opex && month ∈ {3,6,9,12}`; `russell` from a per-year constant.
- Uses T1 for NY parts. Out of scope: scheduler wall clock (T13).

**Tests — `marketCalendar.test.ts`**
- **A9:** `now = 2026-10-24T10:00Z` (Saturday) → `sessionDate = "2026-10-23"`.
- **A10:** the morning after a listed holiday (e.g. the day after Thanksgiving 2026 at 08:00 ET) → the last session before the holiday.
- Trading day at 15:59 ET → previous session; at 16:00 ET → today; early-close day at 13:00 ET → today.
- `inScanWindow` edges: 03:59 true, 04:00 false, 19:59 false, 20:00 true (ET).
- **A19:** 3rd Friday of March 2027 → `opex && spRebalance`; a 3rd Friday that is Good Friday → `opex` on the Thursday.
- Guard test: `HOLIDAYS[new Date().getUTCFullYear()]` is defined (this is the yearly-update reminder; comment says so).

---

### T3 · Schema + store — `server/src/db.ts`, `server/src/unusualVolume/store.ts`, `types.ts` · **M**

**Scope**
- `unusualVolume/types.ts`: all types from design §4, exported.
- `db.ts`: the four `CREATE TABLE IF NOT EXISTS` statements from design §3, appended to the existing `db.exec` block.
- `store.ts` functions (synchronous, `better-sqlite3`, each statement prepared once at module level like `portfolio.ts`):
  - `getRun(sessionDate)`, `getLatestRun()`, `saveListPhase(run, rows)` (one transaction), `saveEnrichmentPhase(sessionDate, catalystsBySymbol, summary)` (one transaction), `getRows(sessionDate)` (parsed JSON), `isSeasoned(symbol)`, `markSeasoned(symbols[])`, `getLastRefresh(sessionDate)`, `setLastRefresh(sessionDate, iso)`, `pruneOlderThan(days)`.
- Out of scope: any computation.

**Tests — `unusualVolume/store.test.ts`** (pattern of `db.test.ts`)
- Save phase 1 → `getRun().status === "list"`, rows have `catalysts === null`.
- Save phase 2 → `status === "complete"`, `catalysts` round-trips through JSON, `enriched_at` set.
- Composite PK: saving the same `(sessionDate, symbol)` twice upserts rather than throwing.
- `pruneOlderThan(90)` removes a run dated 91 days ago and its rows (cascade), keeps one dated 89 days ago.
- `markSeasoned` is idempotent.

---

### T4 · TradingView scan + SPY — `server/src/providers/tradingview.ts` · **M**

**Scope** (design §6.1)
- `unusualVolumeScan(range = 5000): Promise<ScanRow[]>` with the exact body in design §6.1; map `{ s, d }` to `ScanRow`; drop rows with null in any of `open/high/low/close/change/volume/avg30` and return the drop count alongside (`{ rows, dropped }`).
- Throw `new Error("tradingview scan: universe truncated")` when `data.length === range`.
- `spyChange(): Promise<number | null>` (`symbols.tickers: ["AMEX:SPY"]`, `columns: ["change"]`), `null` on missing data.
- Both wrapped in `tracked("tradingview", …)` from `providers/registry.ts`.
- Reuse `HEADERS`; keep the existing `marketScan` untouched.

**Tests — add to `providers/tradingview.test.ts`**
- Request body: `filter` contains `type=stock`, `typespecs has common`, `exchange in_range [NASDAQ,NYSE,AMEX]`, `average_volume_30d_calc > 900000`, `close > 1`; `columns` in the documented order; `range` `[0, 5000]`.
- Row mapping: a fixture row yields the right `ScanRow` fields; `float` null passes through as `null`; `earnings_release_date` stays epoch seconds.
- Null-row drop: a row with `close: null` is excluded and counted.
- **A8b:** a response with exactly `range` rows throws `"universe truncated"`.
- `spyChange()` returns the number, and `null` on an empty `data`.

---

### T5 · EDGAR filings in window — `server/src/providers/secedgar.ts` · **M**

**Scope** (design §6.2)
- Export `filingsSince(symbol: string, sinceIso: string): Promise<Filing[] | null>`; `null` when no CIK (caller marks `edgar: "skipped"`).
- Parse `filings.recent` arrays `form`, `acceptanceDateTime`, `items`, `accessionNumber`, `primaryDocument`; stop at the first entry with `acceptanceDateTime < sinceIso` (arrays are newest-first); build `url` as `https://www.sec.gov/Archives/edgar/data/{Number(cik)}/{accessionNoDashes}/{primaryDocument}`; `items` split on `,` and trimmed, `[]` when absent.
- Export `form4Transactions(cik, filing: Filing): Promise<InsiderTransaction[]>` by making the existing `parseForm4` public with the `Filing` shape (map `accessionNumber`/`primaryDocument`/`filingDate`). `insiderTransactions` must keep its current behaviour (compose it from the two).
- Keep the `SEC_EDGAR_CONTACT` User-Agent and `SEC_FETCH_CONCURRENCY`.

**Tests — `providers/secedgar.test.ts`** (new file)
- `filingsSince` returns the 8-K with `items: ["1.01","9.01"]` and the correct archive URL; a filing accepted one second before `sinceIso` is excluded and iteration stops there (assert the later-indexed, older items aren't inspected by making the fixture's older entries malformed).
- Missing `items` field → `[]`.
- Unknown ticker → `null`, and no `submissions` request is made.
- `insiderTransactions` still returns the same shape for the existing fixture path (regression: one Form 4 XML inline, code `P`).

---

### T6 · Company news with fallback — `server/src/providers/news.ts` · **M**

**Scope** (design §6.3)
- `shortName(name: string): string` — strip legal suffixes (`Inc`, `Inc.`, `Corp`, `Corporation`, `Co`, `Company`, `Ltd`, `plc`, `Holdings`, `Group`, `N.V.`, `S.A.`), trailing commas/periods, collapse spaces.
- `companyNews(name, symbol): Promise<{ items: NewsItem[]; source: "google" | "yahoo" | "failed" }>`:
  - Google query `"${shortName}" stock when:3d` via the existing `fetchRss` (publisher "Google News", `symbol` set).
  - Relevance filter: title contains `shortName` (case-insensitive) **or**, for symbols of ≥ 3 chars, the ticker as a whole word.
  - On HTTP error, parse error or zero relevant items → `symbolNews(symbol)`; if that also fails → `{ items: [], source: "failed" }`.
- Module-level limiter: max 2 concurrent Google requests with ≥ 300 ms between starts (same style as Nasdaq's `acquire/release`).

**Tests — `providers/news.test.ts`** (new file; add to the existing one if present)
- `shortName` table: `"Ford Motor Company"` → `"Ford Motor"`, `"Agilent Technologies, Inc."` → `"Agilent Technologies"`, `"Royal Dutch Shell plc"` → `"Royal Dutch Shell"`, `"AT&T Inc."` → `"AT&T"`.
- Query URL contains the encoded `"Ford Motor" stock when:3d`.
- **A14c:** for symbol `F`, a headline without "Ford" is dropped; a headline with "Ford" is kept; for symbol `AMD`, a headline containing the word `AMD` is kept.
- **A14b:** Google returns 429 → Yahoo URL is fetched and `source === "yahoo"`; both fail → `source === "failed"`, `items: []`, no throw.
- Limiter: 5 concurrent calls never have more than 2 in flight (count via the fetch mock with a deferred promise).

---

### T7 · Nasdaq bar count — `server/src/providers/nasdaq.ts` · **S**

**Scope** (design §6.4)
- `barCount(symbol: string, limit: number, toYmd: string): Promise<number>` using `/api/quote/{symbol}/historical?assetclass=stocks&fromdate={to − 120 days}&todate={to}&limit={limit}` through `nfetch`; return `data.tradesTable.rows.length` (0 when absent).

**Tests — `providers/nasdaq.test.ts`** (new file or extend)
- 31 rows → 31; 20 rows → 20 (feeds **A8**); missing `tradesTable` → 0; URL contains `limit=31` and the two dates.

---

### T8 · Metrics & filters — `server/src/unusualVolume/compute.ts` · **M**

**Scope** (design §5 steps 4–5)
- `computeMetrics(row: ScanRow): Metrics` with the formulas in design §5; `closeLocation = null` when `high === low`; `turnover = null` when `float` is null or 0.
- `sectorMedians(rows: ScanRow[]): Map<string, number>` (median of `changePct` per sector over the whole universe).
- `applyFilters(rows: (ScanRow & Metrics)[], cfg = DEFAULTS): { matches; counts: RunSummary["counts"] }` in the fixed order `adv30 ≥ 1M && adv30 > 0` → `close ≥ 1` → `marketCap ≥ 300M` → `rvol ≥ 2.5` → `close > open`, counting survivors at each stage.
- `DEFAULTS` exported: `{ threshold: 2.5, adv30Min: 1_000_000, priceMin: 1, marketCapMin: 300e6 }`.
- Pure; no imports from providers.

**Tests — `unusualVolume/compute.test.ts`**
- **A1:** `volume 3,000,000`, `avg30 1,100,000` → `adv30 ≈ 1,034,482.76`, `rvol 2.90` (2 dp).
- **A2:** raw ratio 2.40 → corrected 2.52 → included at 2.5.
- **A3/A4:** 2.50 included, 2.49 excluded (build fixtures from the target RVOL backwards).
- **A5:** `close < open`, `close > prevClose` excluded. **A6:** `close > open`, `close < prevClose` included.
- **A7:** `adv30 = 950,000` excluded with `counts.liquid` decremented.
- **A17:** `float: null` → `turnover: null`; `high === low` → `closeLocation: null`.
- `prevClose` from `changePct` (`close 110, changePct 10` → `100`); `gapPct` sign.
- `sectorMedians` with an odd and an even sector size; non-matching rows count.
- Filter order: a row failing both `rvol` and `green` is counted out at `rvol`, not `green`.

---

### T9 · Tagging & evidence — `server/src/unusualVolume/catalysts.ts` · **L**

**Scope** (requirements §4.2–4.5, design §4)
- `RULES: readonly KeywordRule[]` typed constant (`{ tag, strength, pattern: RegExp }`) for FDA/ANALYST/GUIDANCE/CONTRACT/INDEX/M&A-headline exactly as the requirements table; comment that every rule needs a test case.
- `catalystWindow(sessionDate, earlyClose): { start: Date; closeOfD: Date }` — `start = nyDateTime(previousTradingDay, "16:00")`, `closeOfD = nyDateTime(D, "13:00" | "16:00")` (uses T1/T2).
- `buildCatalysts(input: { row; filings: Filing[] | null; headlines: NewsItem[]; newsSource; form4: InsiderTransaction[]; earnings: EarningsDetail | null; window; ctx: { sectorShare: number; sectorCount: number; flags } }): Omit<Catalysts, "explain">`:
  - Filing rules: 8-K 2.02 → EARN; 8-K 1.01/2.01, `SC TO-T`, `DEFM14A`, `425` → M&A; `SC 13D`/`SC 13D/A` → ACTIVIST; Form 4 code `P` → INSIDER_BUY; other 8-K → `8K` (weak) with items translated through a small `ITEM_NAMES` map.
  - `earningsLast` in window → EARN.
  - Headlines → first matching rule, else NEWS (weak); cap evidence headlines at 5, newest first, after `news.dedupe`.
  - **After-close demotion:** filings/earnings with `time > closeOfD` get `afterClose: true`, strength `context`, detail suffix *"reported after close, reaction expected next session"*; headlines unaffected.
  - SECTOR when `sectorShare ≥ 0.25 && sectorCount ≥ 5`; OPEX/REBAL/RUSSELL from `flags`.
  - Tags sorted by strength rank then id; one tag per id (strongest instance wins).
  - `sources` filled from inputs (`null` filings → `"skipped"`).
- `strengthRank(s: Strength): number` exported for the API sort.

**Tests — `unusualVolume/catalysts.test.ts`**
- **A12:** `earningsLast` at 16:05 ET on D-1 → EARN strong, evidence `kind: "earnings"`.
- **A12b:** `earningsLast` at 16:05 ET on **D** → tag strength `context`, `afterClose: true`, no strong EARN.
- **A13:** 8-K items `["1.01"]` at 09:00 ET on D → M&A strong with the filing URL.
- **A12c:** 8-K 1.01 accepted 17:30 ET on D → context + afterClose.
- **A14:** headline "Analyst upgrades XYZ to Buy" at 10:00 ET on D → ANALYST; one at 15:00 ET on D-1 → ignored.
- **A15:** empty inputs → `tags: []`, `evidence: []`.
- One test per `RULES` entry (positive title) and one negative title that must fall through to NEWS.
- Form 4 code `S` → no INSIDER_BUY; code `P` → INSIDER_BUY with detail containing shares and `$` value.
- SECTOR: share 0.3 & count 5 → tagged; share 0.3 & count 4 → not.
- Sorting: `[NEWS, EARN, OPEX]` → `[EARN, NEWS, OPEX]`; duplicate ids collapse.
- Headline cap: 7 in → 5 out, newest first.

---

### T10 · Explain renderer — `server/src/unusualVolume/explain.ts` · **M**

**Scope** (requirements §4.7)
- `renderExplain(row: UnusualVolumeRow, catalysts: Omit<Catalysts,"explain">, ctx: { spyChangePct: number | null; totalMatches: number; flags; earlyClose }): string[]` returning 1–4 lines, each built from a fixed priority list of facts; a fact is omitted when its data is null.
- Formatting through a server-side copy of the number helpers (`fmtBig`-style `1.2M/480M`, percentages with sign and 1 dp); keep them in `explain.ts` to avoid a web import.
- Hedged phrases only from a constant list with thresholds (`"possible run-up"` ⇔ `earningsNext` within 7 days).
- Line 1 wording for earnings beat/miss, filing translation, insider, top headline, or *"No catalyst found in news, filings or earnings."*

**Tests — `unusualVolume/explain.test.ts`**
- Full fixture reproduces the four example lines from requirements §4.7 (modulo the symbol).
- Beat and miss wording (`+17%`, `−8%`); EARN without numbers → "Q3 earnings after close Oct 22" only.
- `turnover: null` → no "of float" fragment (**A17**); `spyChangePct: null` → no SPY fragment; `closeLocation 0.85` → "near day high"; `0.3` → "faded from high"; `0.6` → neither.
- `earningsNext` in 6 days → "Earnings in 6 days (possible run-up)"; in 8 days → absent.
- Empty catalysts → line 1 is the "No catalyst found…" sentence and the output still has lines 2–4.

---

## Phase B — Orchestration (depends on Phase A)

### T11 · Enrichment fan-out — `server/src/unusualVolume/enrich.ts` · **M** · depends on T5, T6, T9, T10

**Scope** (design §6.5–6.6)
- `enrichRows(rows: UnusualVolumeRow[], ctx): Promise<{ bySymbol: Map<string, Catalysts>; requests: Record<string, number>; failures: Record<string, number> }>` using `mapWithConcurrency(rows, 5, …)`; per row `Promise.allSettled([filingsSince, companyNews])`, then Form 4 parsing only for Form 4 filings in the window, then `earningsDetail` only when EARN applies; `buildCatalysts` + `renderExplain`; counters for requests/failures per source.
- `earningsDetail(row, sessionDate)` picks the `earningsSurprise` row whose `dateReported` NY date equals `earningsLast`'s NY date; computes `beatPct` from `surprisePercent` or `(eps − consensus)/|consensus|`.
- A per-row exception never rejects the whole call: catch, mark all sources `"failed"`, still return a `Catalysts` with `explain` rendered from the row alone.

**Tests — `unusualVolume/enrich.test.ts`** (providers mocked with `vi.mock("../providers/secedgar.js")` etc.)
- Happy path: one row with an 8-K and two headlines → EARN/NEWS tags, `requests.edgar === 1`, `requests.news === 1`, `requests.nasdaq === 0`.
- EARN row → exactly one `earningsSurprise` call; non-EARN row → none.
- Form 4 present → `form4Transactions` called once per Form 4 filing; absent → not called.
- **A16:** `filingsSince` rejects → row still returned, `sources.edgar === "failed"`, headlines tagged normally, `failures.edgar === 1`.
- Concurrency bound: with 12 rows and a deferred mock, never more than 5 in flight.

---

### T12 · Run pipeline — `server/src/unusualVolume/run.ts` · **L** · depends on T1–T4, T7, T8, T11

**Scope** (design §5)
- `runUnusualVolume(opts: { now?: Date; force?: boolean; reenrichOnly?: boolean }): Promise<RunOutcome>` implementing steps 1–10, including the exists guard, the scan window guard, the truncation abort, the seasoning check (fail-open on Nasdaq error), phase-1/phase-2 persistence via T3, pruning, and the single summary log line in the documented format.
- Shared in-flight promise so concurrent callers await the same run.
- `reenrichOnly` (for Refresh / phase-2 retry): loads rows for the current D, runs T11, saves phase 2.

**Tests — `unusualVolume/run.test.ts`** (`DATA_DIR` temp dir; providers stubbed via `vi.mock`; fixed `now`)
- Full run on a 6-row scan fixture (2 qualify, 1 red candle with high RVOL, 1 low ADV30, 1 null close, 1 below 2.5×) → 2 rows saved, `counts` match, `status` ends `complete`, log line matches the regex `^\[unusual-volume\] D=\d{4}-\d{2}-\d{2} universe=\d+ … \d+(\.\d)?s$`.
- **A8:** `barCount` → 20 for one match → that row excluded, not marked seasoned; → 31 → marked seasoned and `barCount` not called on a second run with `force`.
- **A8b:** scan throws truncated → nothing saved, outcome rejects, previous run intact.
- **A11:** `now` = 11:00 ET on a trading day → `skipped/market-hours`, no fetch. **A11b:** 05:00 ET → same.
- **A11c:** second call for the same D → `skipped/exists`; with `force: true` → runs.
- Phase-2 failure (enrich rejects) → run saved with `status: "list"`, rows present with `catalysts: null`; `reenrichOnly` afterwards completes it.
- Two concurrent `runUnusualVolume()` calls → one scan request.

---

### T13 · Scheduler — `server/src/unusualVolume/scheduler.ts` + `index.ts` wiring · **S** · depends on T1, T12

**Scope** (design §8)
- `startScheduler(opts?: { runAt?: string; tz?: string; run?: typeof runUnusualVolume; now?: () => Date })` with env defaults `UNUSUAL_VOLUME_RUN_AT=06:00`, `UNUSUAL_VOLUME_TZ=Asia/Jerusalem`; invalid values log an error and fall back to defaults. `UNUSUAL_VOLUME_SCHEDULER=0` disables (used by CI/tests).
- Startup catch-up call, then a 60 s `setInterval(...).unref()` tick firing once per zone-date at `runAt`.
- `safeRun` catches and logs; never throws.
- `index.ts`: call `startScheduler()` after `app.listen`.

**Tests — `unusualVolume/scheduler.test.ts`** (`vi.useFakeTimers`, injected `run` mock and `now`)
- Startup calls `run` once (catch-up).
- **A11d:** with `tz = "Asia/Jerusalem"` and the system clock in UTC, the tick fires when Jerusalem wall clock is `06:00` and not at `06:00` UTC.
- Fires once per day even though the tick lands on 06:00 twice (two ticks inside the minute).
- `run` rejecting does not propagate out of the tick.
- `UNUSUAL_VOLUME_SCHEDULER=0` → no interval, no catch-up.

---

### T14 · API route — `server/src/routes/unusualVolume.ts` + `index.ts` mount · **M** · depends on T3, T9 (`strengthRank`), T12

**Scope** (design §9)
- `GET /` with `zod` query schema (coerce numbers; clamp `threshold` to ≥ 2.5 and `marketCapMin` to ≥ 3e8; `sort` enum of row keys + `"catalyst"`; `dir`). Loads the run for `resolveSignalSession(now)`; if missing and `inScanWindow(now)` → await `runUnusualVolume()`; if missing otherwise → latest saved run; if none → `503` with the documented message. Filters, sorts (catalyst sort = `strengthRank` then id; rows without catalysts last), responds with the design §9 shape. 60 s memo via `cached()` keyed by the query string + sessionDate + enrichment status.
- `POST /refresh`: cooldown via T3 `getLastRefresh`; `429 { error, retryAfterSec }` or `202 { enrichmentStatus: "pending" }` and fire-and-forget `runUnusualVolume({ reenrichOnly: true })`.
- Errors through a local `fail()` identical in shape to `market.ts`.
- `index.ts`: `app.use("/api/unusual-volume", rateLimit({ windowMs: 60_000, max: 240 }), unusualVolumeRouter)` placed **before** the `/api` market mount so the prefix wins.

**Tests — `routes/unusualVolume.test.ts`** (handler pulled from the router stack; store mocked with `vi.mock("../unusualVolume/store.js")`)
- `threshold=2` → rows at 2.4 excluded (clamped to 2.5); `threshold=3` → 2.9 excluded.
- `sort=catalyst&dir=desc` orders strong > medium > none.
- `sector=X` filters; unknown sort → 400.
- No run, outside scan window, older run exists → responds with the older run's `sessionDate`.
- No run at all → 503 with the documented message.
- Refresh: first call 202; second within 10 min 429 with `retryAfterSec > 0`.

---

## Phase C — Web (depends on T14 for the contract; can start against a fixture JSON)

### T15 · Widget registration + shared types · **S** · depends on none (contract from design §9)

**Scope**
- `web/store/terminal.ts`: `"unusual-volume"` in `WidgetType`, `SIZE_BY_TYPE["unusual-volume"] = { w: 12, h: 9 }`.
- `web/components/Workspace.tsx`: import + `case "unusual-volume"` + title `"Unusual Volume"`.
- `web/components/Sidebar.tsx`: `{ type: "unusual-volume", label: "UNUSUAL VOL", key: "" }`.
- `web/lib/api.ts`: `UnusualVolumeRow`, `UnusualVolumeResponse`, `Catalysts`, `Tag`, `Evidence` types mirroring the server.
- A placeholder `UnusualVolumeWidget.tsx` that renders "Loading…" so the build passes.

**Tests / checks**
- `npm run build -w web` and `npm run lint` pass; the TypeScript `switch` in `Workspace` stays exhaustive (the build fails if a case is missing — that is the test).
- Manual: the sidebar shows the entry and adds a 12×9 widget.

---

### T16 · Widget table, toolbar, responsive columns · **M** · depends on T15

**Scope** (design §10)
- `useQuery` on `/api/unusual-volume?…` with `refetchInterval` 15 min, 10 s while `enrichmentStatus === "pending"`.
- Toolbar: threshold buttons `2.5× 3× 5×` + numeric input (min 2.5), MCap min ($B, min 0.3), sector select from `/api/sectors?market=us`, header text `Session: … · N matches · run HH:MM`, `early close` chip.
- Table with the 12 columns in FR-8 order; header sort interaction copied from `ScreenerWidget`; row click → `setActiveSymbol(normalizeSymbol(symbol))`.
- Responsive columns: export a pure helper `visibleColumns(widthPx: number): ColumnKey[]` (first five always; cumulative thresholds for the rest) and drive both `<th>` and `<td>` from it; measure width with `ResizeObserver` on the root.
- RVOL tier classes `rvol-2 / rvol-3 / rvol-5` added to `web/app/globals.css` next to `.up/.down`; Candle % and Day Chg% via `pctClass`.
- Empty state: "No unusual volume for {sessionLabel} at ≥ {threshold}×"; 503 → the server's first-run message; errors like other widgets.

**Tests / checks**
- `visibleColumns` is a pure function with its threshold table documented in a comment. The web workspace has no test runner, so reviewers verify it against three widths (narrow / medium / full) from screenshots attached to the PR.
- Build + lint green. Manual: sorting by every column, clamping of inputs below the base, sector filter.

---

### T17 · Expanded row, evidence, Explain (RULES/AI), Refresh · **M** · depends on T16

**Scope** (design §9 "AI Explain", §10)
- Chevron toggles an expanded full-width row: explain lines, evidence grouped by kind with NY time, `after close` chip, publisher/form, external link (`target="_blank" rel="noopener"`); `…` while `catalysts === null`.
- AI toggle: `useQuery(["status"])` → disabled with `title="AI not configured"` when `!ai`; when on and a row is expanded, `apiPost("/api/ai/chat", { messages: [{ role: "user", content: EXPLAIN_PROMPT }], context })` with a 15 s `AbortController`; React Query key `["uv-ai", sessionDate, symbol]`, `staleTime: Infinity`; on error/timeout show rule lines; label `RULES` / `AI`.
- Refresh button → `POST /refresh`; on 429 show "Refreshed Xs ago"; on 202 switch to the 10 s polling until `complete`.

**Tests / checks**
- Build + lint green.
- Manual checklist in the PR: **A18** scenarios (no key → RULES + disabled toggle; toggle on + server 503 → RULES; toggle on + success → AI label), evidence links open the EDGAR document, `…` shows during a pending enrichment (simulate by calling Refresh).

---

## Phase D — System level

### T18 · System test: full pipeline through the route · **M** · depends on T12, T14

**Scope**
- `server/src/unusualVolume/system.test.ts`: one test file that stubs **only `fetch`** (not the modules) with a URL-dispatching mock covering TradingView scan + SPY, EDGAR `company_tickers.json` + one `submissions` JSON + one Form 4 XML, Google RSS (one 429 to exercise the Yahoo fallback), Yahoo RSS, Nasdaq `historical` and `earnings-surprise`. Uses a temp `DATA_DIR`. Fixed `now = 2026-10-24T03:00:00Z` (06:00 Jerusalem, Friday 23:00 ET).
- Asserts, end to end: the saved run for `2026-10-23`; the matched symbols and their RVOL to 2 dp; tags per symbol (one EARN+beat, one M&A filing, one INSIDER_BUY, one with `after close` demotion, one "No catalyst found"); `sources.news === "yahoo"` for the 429 symbol; the `GET` handler's response shape and default sort; the summary log line's request counts equal the number of mock calls per host.
- This is the repo's first cross-module test; keep fixtures minimal (≤ 6 symbols) and comment the fixture map at the top of the file.

**Tests** — the file is the deliverable. Must run in < 5 s.

---

### T19 · Live acceptance run (manual, before enabling by default) · **S** · depends on T13–T17

**Scope**
- On a real morning after the 06:00 run, execute requirements §8.2 items 1–8 and record results in the PR (or a `docs/design/unusual-volume-acceptance-2026-xx-xx.md` note): RVOL recomputed from Nasdaq bars for 5 symbols (±1%), no red candles listed (from the summary log counts), ADV30 ≥ 1M on all rows, one EARN beat/miss cross-checked on nasdaq.com, restart serves from SQLite with no scanner call, no-AI mode behaviour, `GET` latency < 500 ms (`curl -w "%{time_total}"`).
- Re-run the validation script (`tvavg.mjs` from the requirements §6.1, moved into `server/scripts/` as `validate-tv-avg.mjs`) against that day's data and attach its output.

**Tests** — the checklist with evidence is the deliverable.

---

### T20 · Docs, README, screenshots, status flip · **S** · depends on T19

**Scope**
- README: feature bullet under **Features** (one line, same tone as the others), add `UnusualVolume` to the `components/widgets/` structure line, screenshot `docs/screenshots/unusual-volume.png` at full width.
- README **Configuration/Environment** section (if present) gains `UNUSUAL_VOLUME_RUN_AT`, `UNUSUAL_VOLUME_TZ`, `UNUSUAL_VOLUME_SCHEDULER`; `docker-compose.yml` passes them through like the other env vars.
- Requirements and design docs: status → **Shipped**, "Last updated" bumped, decisions log amended with anything that changed during implementation.

**Tests / checks** — build green; links in the docs resolve.

---

## Dependency graph

```
T1 ─┬─► T2 ─┐
    │       ├─► T12 ─► T13
T3 ─┤       │     │
T4 ─┤       │     ├─► T14 ─► T18
T7 ─┤       │     │
T8 ─┘       │     │
T5 ─┐       │     │
T6 ─┼─► T11 ┘     │
T9 ─┤             │
T10 ┘             │
T15 ─► T16 ─► T17 ┴─► T19 ─► T20
```

Suggested staffing for three engineers, week 1: **E1** T1, T2, T8, T12 · **E2** T4, T5, T6, T7, T11 · **E3** T3, T9, T10, T15, T16. Week 2: E1 T13, T14, T18 · E2 T17 · E3 review + T19/T20.

## Acceptance-ID coverage map

| ID | Task(s) |
|----|---------|
| A1–A7, A17 | T8 (A17 also T10) |
| A8 | T7, T12 |
| A8b | T4, T12 |
| A9, A10, A19 | T2 |
| A11, A11b, A11c | T12 |
| A11d | T1, T13 |
| A12, A12b, A12c, A13, A14, A15 | T9 |
| A14b, A14c | T6 |
| A16 | T11 |
| A18 | T17 (manual), T14 (server never depends on AI) |
| §8.2 live checks | T19 |
| End-to-end | T18 |
