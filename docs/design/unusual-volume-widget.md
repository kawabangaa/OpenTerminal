# Unusual Volume Widget — Technical Design

| | |
|---|---|
| **Status** | Draft for review |
| **Last updated** | 2026-10-25 |
| **Requirements** | [`docs/requirements/unusual-volume-widget.md`](../requirements/unusual-volume-widget.md) |
| **Tasks** | [`docs/design/unusual-volume-tasks.md`](unusual-volume-tasks.md) |
| **Repo** | Fork **`kawabangaa/OpenTerminal`** (`origin`). `upstream` = `ErTasselli/openterminal` is fetch-only; never push or open PRs there. Full rules in the tasks doc, "Repository & git workflow". |

Requirement IDs (FR-n, NFR-n, A-n) below refer to that document.

## 1. Overview

A server-side daily job scans the liquid US universe once (one TradingView
request), keeps the green-candle rows with RVOL ≥ 2.5×, enriches them with
filings, headlines and earnings data, renders a rule-based explanation per row,
and saves everything in SQLite. The API serves the saved run; the widget is a
thin table over it. Nothing on the request path calls a provider, except a
catch-up run when no result exists for the current session.

```
                 06:00 Asia/Jerusalem (= 23:00 ET)
                 ┌──────────────────────────────┐
                 │ scheduler.ts (60s tick)       │
                 └──────────────┬───────────────┘
                                ▼
┌────────────────────────── runUnusualVolume() ─────────────────────────────┐
│ 1 resolveSignalSession(now)  ── marketCalendar.ts                         │
│ 2 guard: skip if 04:00–20:00 ET, or run for D already saved (FR-17b/19)   │
│ 3 unusualVolumeScan()        ── tradingview.ts  (1 request, ~3k rows)     │
│   spyChange()                ── tradingview.ts  (1 request)               │
│ 4 compute: ADV30, RVOL, candle, gap, closeLocation, sector medians (pure) │
│ 5 filter: RVOL ≥ 2.5, green, ADV30 ≥ 1M, price ≥ 1, mcap ≥ 300M          │
│ 6 seasoning check for unknown symbols ── nasdaq.ts (≤ 1 req / new match)  │
│ 7 SAVE phase 1: run(status='list') + rows(catalyst_json = NULL)           │
│ 8 enrich each match (fan-out, bounded):                                   │
│     EDGAR submissions ─► filings in window ─► Form 4 parse if any         │
│     Google News RSS   ─► fallback Yahoo RSS                               │
│     Nasdaq earnings-surprise (EARN-tagged only)                           │
│ 9 tag + render explain lines (pure)                                       │
│10 SAVE phase 2: rows.catalyst_json, run(status='complete'), summary log   │
└───────────────────────────────────────────────────────────────────────────┘
                                ▼
                 SQLite: unusual_volume_runs / _rows / _seasoned
                                ▼
          GET /api/unusual-volume  (filter/sort in-process, < 500 ms)
          POST /api/unusual-volume/refresh  (re-enrich, 10-min cooldown)
                                ▼
          web/components/widgets/UnusualVolumeWidget.tsx
          (table, responsive columns, expandable row, Explain RULES/AI)
```

## 2. Files

### 2.1 Server — new

| File | Responsibility |
|------|----------------|
| `server/src/marketCalendar.ts` | NYSE holidays/early closes, trading-day arithmetic, signal-session resolution, OPEX / rebalance / Russell flags. Pure. |
| `server/src/time.ts` | `zonedParts(date, tz)`, `nyParts(date)`, `isBetweenNy(date, "04:00", "20:00")`, `wallClock(tz)`. Thin wrappers over `Intl.DateTimeFormat`. Pure. |
| `server/src/unusualVolume/compute.ts` | RVOL, candle, gap, close location, sector medians, filters. Pure. |
| `server/src/unusualVolume/catalysts.ts` | Window logic, tagging rules (typed constant array), evidence model. Pure. |
| `server/src/unusualVolume/explain.ts` | Rule-based template renderer. Pure. |
| `server/src/unusualVolume/enrich.ts` | Fan-out orchestration over providers for the matched rows. I/O. |
| `server/src/unusualVolume/run.ts` | The pipeline (`runUnusualVolume`), guards, persistence, summary log. I/O. |
| `server/src/unusualVolume/store.ts` | SQLite statements for runs / rows / seasoned / ai cache. |
| `server/src/unusualVolume/scheduler.ts` | 60-second tick timer firing the run at `UNUSUAL_VOLUME_RUN_AT` in `UNUSUAL_VOLUME_TZ`; startup catch-up. |
| `server/src/routes/unusualVolume.ts` | `GET /`, `POST /refresh`. Mounted at `/api/unusual-volume` under the same per-IP rate limiter as `marketRouter`. |
| `*.test.ts` next to each pure module | See §10. |

The requirements doc names a single `unusualVolume.ts` and a route on
`marketRouter`. The split above keeps each pure module under ~200 lines and
avoids growing `routes/market.ts` (already ~780 lines); the mount point, rate
limit and error shape are identical, so the behaviour the requirement asks for
is unchanged.

### 2.2 Server — changed

| File | Change |
|------|--------|
| `server/src/providers/tradingview.ts` | `unusualVolumeScan()`, `spyChange()`; `exchange in_range` filter instead of post-hoc OTC drop. |
| `server/src/providers/secedgar.ts` | Export `filingsSince(symbol, sinceIso)` and `form4Transactions(cik, filingRef)`; the existing `insiderTransactions` becomes a composition of the two. |
| `server/src/providers/news.ts` | `companyNews(name, symbol)` (Google News query builder + relevance filter), reusing `fetchRss`. |
| `server/src/providers/nasdaq.ts` | `barCount(symbol, limit)` using the `historical` endpoint. |
| `server/src/db.ts` | New tables (§3). |
| `server/src/index.ts` | Mount the router; `startScheduler()` after `listen`. |

### 2.3 Web

| File | Change |
|------|--------|
| `web/components/widgets/UnusualVolumeWidget.tsx` | New. |
| `web/store/terminal.ts` | `"unusual-volume"` in `WidgetType`; `SIZE_BY_TYPE` entry `{ w: 12, h: 9 }`. |
| `web/components/Workspace.tsx` | Render case + title `"Unusual Volume"`. |
| `web/components/Sidebar.tsx` | `{ type: "unusual-volume", label: "UNUSUAL VOL", key: "" }`. |
| `web/lib/api.ts` | Shared `UnusualVolumeRow` / response types (mirrors the server type). |

## 3. Data model (SQLite, `server/src/db.ts`)

```sql
CREATE TABLE IF NOT EXISTS unusual_volume_runs (
  session_date   TEXT PRIMARY KEY,          -- 'YYYY-MM-DD' (NY date of D)
  run_at         TEXT NOT NULL,             -- ISO, when phase 1 was saved
  enriched_at    TEXT,                      -- ISO, when phase 2 completed
  status         TEXT NOT NULL CHECK (status IN ('list','complete')),
  early_close    INTEGER NOT NULL DEFAULT 0,
  spy_change_pct REAL,
  universe_size  INTEGER NOT NULL,
  summary_json   TEXT NOT NULL              -- counts per filter stage, requests/failures per source, duration
);

CREATE TABLE IF NOT EXISTS unusual_volume_rows (
  session_date   TEXT NOT NULL REFERENCES unusual_volume_runs(session_date) ON DELETE CASCADE,
  symbol         TEXT NOT NULL,
  rvol           REAL NOT NULL,             -- duplicated out of row_json for ORDER BY / pruning sanity
  row_json       TEXT NOT NULL,             -- UnusualVolumeRow minus catalysts
  catalyst_json  TEXT,                      -- Catalysts | NULL while enrichment pending
  PRIMARY KEY (session_date, symbol)
);

CREATE TABLE IF NOT EXISTS unusual_volume_seasoned (
  symbol         TEXT PRIMARY KEY,
  checked_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS unusual_volume_refresh (
  session_date   TEXT PRIMARY KEY,
  last_refresh   TEXT NOT NULL              -- FR-20 cooldown
);
```

- JSON columns keep the schema flexible while the row shape settles; a run has at most a few hundred rows, so filtering and sorting happen in JS after one `SELECT`.
- Pruning: `DELETE FROM unusual_volume_runs WHERE session_date < date('now','-90 days')` at the end of each run (FR-18); cascade removes rows.
- v1.1 tables (`daily_bars`, `finra_short_volume`) are not created in v1.

## 4. Types (server, exported from `unusualVolume/types.ts`)

```ts
export type ScanRow = {               // straight from TradingView, one per listing
  symbol: string; exchange: string; name: string; sector: string;
  open: number; high: number; low: number; close: number;
  changePct: number;                  // vs previous close, percent
  volume: number; avg30: number;      // average_volume_30d_calc (includes D)
  marketCap: number | null; float: number | null;
  earningsLast: number | null;        // epoch seconds
  earningsNext: number | null;
};

export type Metrics = {
  prevClose: number; adv30: number; rvol: number;
  candlePct: number; dayChangePct: number; gapPct: number;
  closeLocation: number | null;       // null when high === low
  dollarVolume: number; turnover: number | null;
};

export type TagId = "EARN"|"M&A"|"ACTIVIST"|"INSIDER_BUY"|"FDA"|"ANALYST"|"GUIDANCE"
                  |"CONTRACT"|"INDEX"|"8K"|"NEWS"|"SECTOR"|"OPEX"|"REBAL"|"RUSSELL";
export type Strength = "strong"|"medium"|"weak"|"context";

export type Evidence = {
  kind: "headline"|"filing"|"earnings"|"insider";
  time: string;                       // ISO
  afterClose: boolean;                // > 16:00 ET on D
  title: string; url: string | null; publisher?: string;
  form?: string; items?: string[];    // filings
  detail?: string;                    // "EPS $1.42 vs $1.21 est (beat +17%)", "CEO bought 50,000 sh ($2.1M)"
  tags: TagId[];
};

export type Tag = { id: TagId; strength: Strength; afterClose?: boolean; detail?: string };

export type Catalysts = {
  tags: Tag[];                        // sorted strongest first
  evidence: Evidence[];               // newest first, headlines capped at 5
  explain: string[];                  // 1–4 rendered lines (§4.7 of the requirements)
  sources: Partial<Record<"edgar"|"news"|"earnings", "ok"|"failed"|"skipped">>;
};

export type UnusualVolumeRow = ScanRow & Metrics & {
  sectorMedianChangePct: number;      // over the liquid universe
  sectorPeersOnList: number;
  catalysts: Catalysts | null;        // null while phase 2 pending
};

export type RunSummary = {
  sessionDate: string; earlyClose: boolean; spyChangePct: number | null;
  counts: { universe: number; liquid: number; rvol: number; green: number; seasoned: number; matches: number };
  requests: Record<string, number>; failures: Record<string, number>;
  durationMs: number;
};
```

## 5. Pipeline (`unusualVolume/run.ts`)

```ts
export async function runUnusualVolume(opts: { now?: Date; force?: boolean } = {}): Promise<RunOutcome>
// RunOutcome = { kind: "skipped", reason: "market-hours"|"exists" } | { kind: "ran", summary: RunSummary }
```

1. **Resolve D.** `resolveSignalSession(now)` (§7). `sessionDate` is the NY calendar date.
2. **Guards.**
   - Market-hours guard: if NY wall clock is in **04:00–20:00**, return `skipped/market-hours`. The requirement says 04:00–16:00; the design widens it to 20:00 because the scanner's daily values were only validated well after the close (Saturday). After-hours between 16:00 and 20:00 is untested, and no scheduled run falls there. (Reflected back into FR-19.)
   - Exists guard: if `unusual_volume_runs` has `sessionDate` and `!force`, return `skipped/exists`.
3. **Scan.** `unusualVolumeScan()` and `spyChange()` in parallel. If the scan returns exactly the requested range size, throw `"universe truncated"` (A8b): the run fails and nothing is saved.
4. **Compute** per row (`compute.ts`):
   ```
   prevClose     = close / (1 + changePct / 100)
   adv30         = (30 * avg30 - volume) / 29
   rvol          = volume / adv30
   candlePct     = (close / open - 1) * 100
   dayChangePct  = changePct
   gapPct        = (open / prevClose - 1) * 100
   closeLocation = high > low ? (close - low) / (high - low) : null
   dollarVolume  = volume * close
   turnover      = float ? volume / float : null
   ```
   Sector medians are computed over **all** scan rows (the liquid universe), not the matches.
5. **Filter** in this order, counting survivors for the summary: `adv30 ≥ 1_000_000 && adv30 > 0` → `close ≥ 1` → `marketCap ≥ 300e6` → `rvol ≥ 2.5` → `close > open`.
6. **Seasoning.** For matches not in `unusual_volume_seasoned`: `nasdaq.barCount(symbol, 31)`. `≥ 31` → insert as seasoned; fewer → drop (A8). A Nasdaq failure keeps the row (fail open) and logs it; the symbol stays unseasoned and is re-checked next time.
7. **Save phase 1** in one transaction: run row with `status='list'`, every match with `catalyst_json = NULL`.
8. **Enrich** (§6).
9. **Tag and render** (`catalysts.ts`, `explain.ts`).
10. **Save phase 2** in one transaction: update `catalyst_json` per row, `status='complete'`, `enriched_at`, `summary_json`. Prune > 90 days. Log one line:
    `[unusual-volume] D=2026-10-23 universe=2874 liquid=2874 mcap=2210 rvol=61 green=38 seasoned=37 matches=37 req{tv:2,edgar:41,news:37,nasdaq:9} fail{news:2} 48.2s`

A failure in step 8 for a single symbol leaves that symbol's `catalyst_json`
with the partial result and `sources` marking what failed (NFR-3). A failure of
the whole step (e.g. exception outside the per-symbol `allSettled`) leaves the
run at `status='list'`; the API then reports `enrichmentStatus: "pending"`, and
the next startup/Refresh retries phase 2 only.

## 6. Providers and enrichment

### 6.1 `tradingview.unusualVolumeScan()`

```ts
body = {
  columns: ["name","description","exchange","sector","open","high","low","close","change",
            "volume","average_volume_30d_calc","market_cap_basic","float_shares_outstanding",
            "earnings_release_date","earnings_release_next_date"],
  filter: [
    { left: "type",      operation: "equal",     right: "stock" },
    { left: "typespecs", operation: "has",       right: ["common"] },
    { left: "exchange",  operation: "in_range",  right: ["NASDAQ","NYSE","AMEX"] },
    { left: "average_volume_30d_calc", operation: "greater", right: 900_000 },
    { left: "close",     operation: "greater",   right: 1 },
  ],
  sort: { sortBy: "average_volume_30d_calc", sortOrder: "desc" },
  range: [0, 5000],
}
```
- Same `HEADERS`, same `{ s, d }` row mapping style as `marketScan`. Rows with any null in `open/high/low/close/volume/average_volume_30d_calc/change` are dropped and counted.
- The 900k prefilter is safe (requirements §6): a match always has `avg30 ≥ adv30 ≥ 1M`.
- `spyChange()`: `{ symbols: { tickers: ["AMEX:SPY"] }, columns: ["change"] }`.
- Both calls are wrapped in `tracked("tradingview", …)` so `/api/status` shows them.

### 6.2 `secedgar.filingsSince(symbol, sinceIso)`

Reads `data.sec.gov/submissions/CIK{cik}.json` once per match and returns every
filing whose `acceptanceDateTime ≥ sinceIso`:

```ts
export type Filing = {
  form: string;                  // "8-K", "4", "SC 13D", "SC 13D/A", "425", "DEFM14A", "SC TO-T", …
  acceptedAt: string;            // ISO from filings.recent.acceptanceDateTime
  items: string[];               // 8-K items parsed from filings.recent.items ("1.01,9.01")
  accessionNumber: string; primaryDocument: string;
  url: string;                   // https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/{primaryDocument}
};
```
- `filings.recent` is already newest-first; stop scanning at the first entry older than `sinceIso`.
- No CIK → `[]` with `sources.edgar = "skipped"`.
- `form4Transactions(cik, filing)` is the existing `parseForm4` made public. It is called only for Form 4 filings in the window, through the existing `SEC_FETCH_CONCURRENCY`.

### 6.3 `news.companyNews(name, symbol)`

```ts
query  = `"${shortName(name)}" stock when:3d`
url    = https://news.google.com/rss/search?q=<query>&hl=en-US&gl=US&ceid=US:en
```
- `shortName` strips legal suffixes and punctuation: `Inc`, `Inc.`, `Corp`, `Corporation`, `Co`, `Company`, `Ltd`, `plc`, `Holdings`, `Group`, `N.V.`, `S.A.`, trailing commas. `"Ford Motor Company"` → `"Ford Motor"`; `"Agilent Technologies, Inc."` → `"Agilent Technologies"`.
- Relevance filter (A14c): keep a headline only if the title contains the short name (case-insensitive) or the ticker as a whole word (`\bF\b` is still noisy, so for symbols shorter than 3 characters only the name counts).
- Fallback (A14b): on HTTP error, empty parse, or zero relevant items → `symbolNews(symbol)` (Yahoo). `sources.news` records `"ok"` / `"fallback"` / `"failed"`.
- Concurrency 2 with a 300 ms gap, as a module-level limiter like Nasdaq's, so Refresh clicks and the run share one budget.

### 6.4 `nasdaq.barCount(symbol, limit)`

`GET api.nasdaq.com/api/quote/{symbol}/historical?assetclass=stocks&fromdate={D-120d}&todate={D}&limit={limit}` through the existing `nfetch` limiter; returns `data.tradesTable.rows.length`.

### 6.5 Earnings detail

For rows with `earningsLast` in the window: `nasdaq.earningsSurprise(symbol)`, pick the row whose `dateReported` (UTC midnight) equals the NY date of `earningsLast`; render `EPS $a vs $b est (beat +p%)` using `surprisePercent` when present, else `(a − b) / |b|`. Missing or failed → the EARN tag stays, line 1 omits the numbers.

### 6.6 Fan-out shape (`enrich.ts`)

```ts
const windowStart = nyDateTime(D - 1 trading day, "16:00");   // ISO
const closeOfD    = nyDateTime(D, earlyClose ? "13:00" : "16:00");

await mapWithConcurrency(matches, 5, async (row) => {
  const [filings, headlines] = await Promise.allSettled([
    secedgar.filingsSince(row.symbol, windowStart),
    news.companyNews(row.name, row.symbol),
  ]);
  const form4 = filingsOk ? await insiderBuys(filings.filter(f => f.form === "4")) : [];
  const earnings = inWindow(row.earningsLast) ? await earningsDetail(row) : null;
  return buildCatalysts(row, { filings, headlines, form4, earnings, closeOfD, ctx });
});
```
Budget per match: 1 EDGAR + 1 Google (+ 1 Yahoo on fallback) + Form 4 docs only if present + 1 Nasdaq only if EARN. That is NFR-4.

## 7. Market calendar and time (`marketCalendar.ts`, `time.ts`)

- All "what time is it in New York" questions go through `Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, … }).formatToParts`. No fixed offsets anywhere (A11d).
- `HOLIDAYS: Record<year, string[]>` and `EARLY_CLOSES: Record<year, string[]>` for 2026 and 2027, `YYYY-MM-DD`. A unit test fails if the current year is missing, which is the yearly reminder.
- `isTradingDay(d)`: weekday and not a holiday.
- `previousTradingDay(d)`.
- `resolveSignalSession(now)`: let `ny = nyParts(now)`. If `isTradingDay(ny.date)` and `ny.time ≥ closeTime(ny.date)` → `D = ny.date`; else `D = previousTradingDay(ny.date)`. (A9, A10)
- `inScanWindow(now)`: NY time in `[20:00, 24:00) ∪ [00:00, 04:00)`.
- `flagsFor(D)`: `opex` = 3rd Friday of the month, or the preceding trading day if that Friday is a holiday; `spRebalance` = `opex && month ∈ {3,6,9,12}`; `russell` = listed date for that year. (A19)
- Scheduler wall-clock: `wallClock(tz)` returns `{ date, hhmm }` in `UNUSUAL_VOLUME_TZ`; the tick fires when `hhmm === RUN_AT` and the last fire date in that zone ≠ today. Validation at startup: an invalid IANA name or `HH:MM` logs an error and falls back to the defaults.

## 8. Scheduler (`scheduler.ts`)

```ts
export function startScheduler(): void {
  void catchUp();                               // FR-17: startup
  setInterval(tick, 60_000).unref();
}
async function tick() { if (wallClock(TZ).hhmm === RUN_AT && firedToday !== wallClock(TZ).date) { firedToday = …; await safeRun(); } }
async function catchUp() { await safeRun(); }   // run() itself applies the guards and no-ops when not needed
```
- `safeRun` wraps `runUnusualVolume()` in try/catch and logs; a failure never crashes the process.
- A run already in progress sets a module-level promise; concurrent triggers (tick + request-path catch-up) await the same promise instead of starting a second scan.
- Disable with `UNUSUAL_VOLUME_SCHEDULER=0` (tests, CI builds).

## 9. API (`routes/unusualVolume.ts`)

### `GET /api/unusual-volume`

Query (all optional, validated with `zod` as `portfolio.ts` does; values below the run's base are clamped up, FR-3/FR-5):

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `threshold` | number ≥ 2.5 | 2.5 | |
| `marketCapMin` | number ≥ 3e8 | 3e8 | |
| `sector` | string | — | exact TradingView sector name |
| `sort` | one of row keys or `catalyst` | `rvol` | |
| `dir` | `asc`\|`desc` | `desc` | |

Response:
```ts
{
  sessionDate: "2026-10-23", sessionLabel: "Fri 23 Oct 2026", earlyClose: false,
  runAt: "2026-10-24T03:00:12Z", enrichmentStatus: "complete" | "pending",
  spyChangePct: 0.6, totalMatches: 37,          // before the widget's own filters
  flags: { opex: false, spRebalance: false, russell: false },
  rows: UnusualVolumeRow[]                       // after filters, sorted
}
```
- Request path: `SELECT` run + rows → JSON parse → filter → sort → respond. No provider call.
- **No run for the current D:** if `inScanWindow(now)` the route awaits a catch-up `runUnusualVolume()` (shared in-flight promise) then serves it; otherwise it serves the latest saved run (its `sessionDate` tells the widget it is older). If nothing is saved at all → `503 { error: "First run has not happened yet. It runs daily at 06:00 or on the next startup outside US market hours." }`.
- Catalyst sort key: `(strengthRank(strongest tag), tag id)`; rows with no catalysts last.
- Errors → the same `fail()` shape as `market.ts` (502 + generic message), with the detail logged.

### `POST /api/unusual-volume/refresh`

Re-runs phase 2 (enrichment) for the current run. `429 { retryAfterSec }` when the last refresh for this `sessionDate` is < 10 minutes old (FR-20). Responds `202 { enrichmentStatus: "pending" }` immediately; the widget polls `GET` until `complete`.

### AI Explain

No new endpoint. The widget calls the existing `POST /api/ai/chat` (already key-protected and rate-limited) with:
```ts
messages: [{ role: "user", content: EXPLAIN_PROMPT }],
context:  { symbol, sessionDate, metrics, tags, evidence, explainRules: row.catalysts.explain }
```
`EXPLAIN_PROMPT` (a constant in the widget) asks for ≤ 2 sentences, evidence-only, and the literal fallback text when thin. The result is cached in React Query under `["uv-ai", sessionDate, symbol]` with `staleTime: Infinity`, which satisfies "cached per (D, symbol)" for the session. A 15 s `AbortController` timeout and any error fall back to the rule lines (A18).

## 10. Web widget (`UnusualVolumeWidget.tsx`)

- **Data:** `useQuery(["unusual-volume", params], () => apiGet(...), { refetchInterval: 15 * 60_000 })`; while `enrichmentStatus === "pending"`, `refetchInterval` drops to 10 s.
- **AI availability:** `useQuery(["status"], () => apiGet("/api/status"))`, read `ai`.
- **Local state (not persisted, FR-15):** `threshold`, `marketCapMinB`, `sector`, `sort`, `dir`, `expanded: string | null`, `useAi: boolean`.
- **Toolbar:** threshold buttons `2.5× 3× 5×` + a numeric input (min 2.5), MCap min input (min 0.3 $B), sector `<select>` (from `/api/sectors?market=us`, as the screener), Refresh button, AI toggle (disabled with title "AI not configured" when `!status.ai`), and the header text `Session: Fri 23 Oct 2026 · 37 matches · run 06:00` with an `early close` chip when set.
- **Responsive columns (FR-8):** a `ResizeObserver` on the widget root measures width; a column is shown when `width ≥ minWidthForColumn[i]` with cumulative thresholds, the first five always on. Implemented as a `visibleColumns` array that drives both `<th>` and `<td>` rendering, so header and body never diverge.
- **Rows:** click → `setActiveSymbol(normalizeSymbol(symbol))`; chevron → toggles `expanded`. RVOL cell gets a class per tier (`rvol-2`, `rvol-3`, `rvol-5`) defined next to the existing `.up/.down` in `globals.css`. Candle % and Day Chg% use `pctClass`.
- **Expanded row** (a full-width `<td colSpan>`):
  - Explain block: `catalysts.explain` lines, or the AI text when `useAi` and the AI query succeeded; a small `RULES` / `AI` label.
  - Evidence list grouped by kind, each with time (NY), `after close` chip when set, publisher/form, link (`target="_blank" rel="noopener"`).
  - `…` placeholder when `catalysts === null`.
- **Empty states:** "No unusual volume for Fri 23 Oct 2026 at ≥ 2.5×" vs. the 503 first-run message.
- Everything else (table classes, `term-btn`, `Flash` not needed since data is daily) follows `ScreenerWidget`.

## 11. Error handling and degradation (NFR-3)

| Failure | Behaviour |
|---------|-----------|
| TradingView scan fails or truncated | Run aborts, nothing saved, logged; last saved run keeps being served. Scheduler retries on next tick-day; startup catch-up retries. |
| SPY call fails | `spyChangePct = null`; line 4 omits the market fact. |
| Nasdaq `barCount` fails | Row kept, symbol stays unseasoned (fail open, logged). |
| EDGAR fails for a symbol | No filing tags; `sources.edgar = "failed"`; row rendered. |
| Google News fails | Yahoo fallback; if both fail, `sources.news = "failed"`. |
| Earnings-surprise fails | EARN tag without numbers. |
| Phase 2 throws as a whole | Run stays `status='list'`; API says `pending`; retried by startup catch-up / Refresh. |
| AI chat fails / slow | Rule lines shown, labeled `RULES`. |

## 12. Performance

- Request path: one `SELECT` of ≤ ~300 rows + JSON parse + sort. Well under 500 ms (NFR-2). The whole response is additionally memoised in `cache.ts` for 60 s keyed by the query string, so a polling widget is nearly free.
- Run: scan ~1–2 s; enrichment for 40 matches at EDGAR concurrency 5 and news concurrency 2 (300 ms gap) ≈ 15–30 s; 100 matches ≈ 40–70 s. Acceptable for a 06:00 job.
- Memory: the scan response (~3k rows × 15 columns) is a few MB, processed and released.

## 13. Testing plan

All pure modules get vitest coverage without network; I/O modules are tested with `vi.stubGlobal("fetch", …)` as in `tradingview.test.ts`.

| Test file | Covers |
|-----------|--------|
| `unusualVolume/compute.test.ts` | A1–A7, A17 (null float → `turnover: null`), `closeLocation` when `high === low`, sector median over universe |
| `marketCalendar.test.ts` | A9, A10, A19, early-close close time, holiday table has the current year, `inScanWindow` edges (03:59 / 04:00 / 19:59 / 20:00 ET) |
| `time.test.ts` | A11d: a fixed UTC instant maps to the expected Jerusalem and New York wall clocks across a DST boundary |
| `unusualVolume/catalysts.test.ts` | A12–A15 and A12b/A12c (after-close demotion), window boundaries (A14), tag ordering, SECTOR rule on the stored set, Form 4 uses acceptance time |
| `unusualVolume/explain.test.ts` | Each line's fixtures: beat/miss wording, filing translation, insider line, "No catalyst found…", omission of null facts |
| `providers/tradingview.test.ts` | `unusualVolumeScan` body (filters, columns), row mapping, null-row drop, A8b truncation throw |
| `providers/secedgar.test.ts` | `filingsSince` parses `items`, uses `acceptanceDateTime`, stops at the boundary, builds the archive URL |
| `providers/news.test.ts` | `shortName` cases, query shape, relevance filter (A14c), fallback on 429 (A14b) |
| `providers/nasdaq.test.ts` | `barCount` for 31 / 20 rows (feeds A8) |
| `unusualVolume/run.test.ts` | A8, A11, A11b, A11c with stubbed providers and an in-memory `better-sqlite3` (`:memory:`); phase-1/phase-2 persistence; summary counts; partial enrichment failure keeps rows (A16) |
| `routes/unusualVolume.test.ts` | Param clamping (threshold 2 → 2.5), sort by catalyst, 503 before first run, refresh cooldown 429 |

The web side has no test runner; the widget is kept declarative and the
responsive-column logic is a tiny pure helper exported from the component file
so it can be reasoned about by reading.

Manual acceptance (requirements §8.2) runs once on a real morning before merge;
the summary log line provides the counts for check 3.

## 14. Work breakdown (PR sequence)

| PR | Content | Depends on |
|----|---------|------------|
| 1 | `time.ts`, `marketCalendar.ts` + tests | — |
| 2 | Provider additions (`tradingview`, `secedgar`, `news`, `nasdaq`) + tests | — |
| 3 | `compute.ts`, `catalysts.ts`, `explain.ts` + tests | — |
| 4 | `store.ts`, `db.ts` tables, `enrich.ts`, `run.ts`, `scheduler.ts`, route, `index.ts` wiring + tests | 1–3 |
| 5 | Widget, store/workspace/sidebar wiring, CSS tiers | 4 |
| 6 | README feature bullet + structure line, screenshot, requirements/design status → "Shipped" | 5 |

PRs 1–3 are independent and can be built in parallel. Commit subjects:
`feat(unusual-volume): …`.

## 15. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| TradingView changes column names or starts rejecting the `in_range` exchange filter | Scan test pins the request body; a failed scan never overwrites a saved run. |
| Google News blocks or reshapes its RSS | Yahoo fallback; `sources.news` makes gaps visible; headlines are optional for every tag except the Medium keyword ones. |
| EDGAR `items` field absent for older/odd filings | Treated as `[]`; 8-K without items still yields the Weak `8K` tag. |
| Company-name query misses (brand ≠ legal name, e.g. "Alphabet" vs "Google") | Accept for v1; the relevance filter also accepts the ticker for ≥ 3-char symbols. Track misses from `sources.news === "fallback"` counts. |
| Holiday table goes stale | Test fails when the running year has no entry. |
| 06:00 run coincides with a US DST shift week | Still 22:00–00:00 ET, inside the scan window. |

## 16. Deviations from the requirements doc

Recorded here and mirrored back into the requirements:

1. **FR-19 guard** widened from 04:00–16:00 ET to **04:00–20:00 ET** (§5 step 2).
2. **Route placement:** a separate `routes/unusualVolume.ts` instead of adding to `marketRouter`; same mount prefix, limiter and error shape.
3. **AI cache** lives in the client (React Query, per session) rather than SQLite; it still never re-asks for the same (D, symbol) within a session and costs nothing server-side.
