# Unusual Volume — Session Range Selector

| | |
|---|---|
| **Status** | Shipped |
| **Last updated** | 2026-10-30 |
| **Extends** | [`docs/requirements/unusual-volume-widget.md`](../requirements/unusual-volume-widget.md), [`docs/design/unusual-volume-widget.md`](unusual-volume-widget.md) |
| **Tasks** | [`docs/design/unusual-volume-range-tasks.md`](unusual-volume-range-tasks.md) |
| **Repo** | Fork `kawabangaa/OpenTerminal` (`origin`); `upstream` is fetch-only. Same rules as the v1 tasks doc. |

This document holds both the requirements (FR-22 onward, A20 onward) and the
technical design for the addition. The v1 documents are not rewritten; the
decisions log and status flip are part of the last task.

## 1. Problem

The widget shows exactly one session: the most recent closed one (D). If the
user does not open the terminal on a given morning, that day's list is gone
from view the next morning, even though the run is still in SQLite for 90
days. Two things are missing:

1. **Looking back.** Show the list for a specific earlier session (2, 3, 4, 5 days ago) exactly as the run saved it, with its catalysts and Explain.
2. **Looking across.** Show several consecutive sessions in one view, so a missed day and today are read together, and names that keep appearing stand out.

The data for both already exists. Nothing new is fetched from any provider.

## 2. Definitions

| Term | Definition |
|------|------------|
| **Current session (D)** | Unchanged: `resolveSignalSession(now)`, the most recent fully closed NYSE session. |
| **Anchor (`to`)** | The newest session in the selected range. Defaults to D, or to the newest saved session when D has no run (today's fallback behaviour). |
| **Span** | Number of consecutive **trading days** in the range, counted backwards from the anchor, inclusive. 1 to 10. Default 1. |
| **Range** | The trading days `from … to`, where `from` is `span − 1` trading days before the anchor. Weekends and NYSE holidays are skipped, not counted. |
| **Missing session** | A trading day inside the range with no saved run. |
| **Latest session** | The newest saved run. The only session Refresh applies to. |

## 3. Why a missed day cannot be backfilled

The TradingView scan is a snapshot: `volume` and `average_volume_30d_calc`
describe the current state, with no "N days ago" variant. A run that did not
happen for session X cannot be reproduced later, because the next evening the
scanner already describes X + 1. Per-symbol Nasdaq history could reconstruct
RVOL, but only for symbols we already know to check, and the whole universe is
roughly 3,000 symbols, far beyond the Nasdaq rate budget.

So a missing session stays missing. The design makes gaps **visible** (a
session marked "no run saved") instead of silently showing the nearest day,
and the widget keeps working for the days that were saved. The local database
on 2026-10-30 is a live example: runs exist for Oct 23, 26, 27 and 29, and
Wed Oct 28 is absent because the server was not running between 20:00 and
04:00 ET that night.

The only way to avoid gaps is operational: keep the server running through
06:00 Israel time, or start it before 11:00 Israel time (04:00 ET). This is
restated in the README task (§12).

## 4. Functional requirements

- **FR-22 Session range.** The widget can show any range of 1 to 10 consecutive trading sessions ending at any saved session within the 90-day retention. Default is one session, D (unchanged behaviour).
- **FR-23 Range control.** The toolbar gains an **anchor** `<select>` listing the last 20 trading days (newest first, each with its state: saved / pending / no run) and a **span** control: preset buttons `1D 2D 3D 5D` plus a numeric input (1–10). "Latest" is the default anchor option and follows the server's own default.
- **FR-24 Grouped presentation.** With span > 1, rows are grouped by session, newest group first. Each group starts with a header row: date, match count, SPY change, run time, `early close` chip when set. The chosen sort (FR-9) applies **within** each group; sessions never interleave. With span = 1 nothing changes visually.
- **FR-25 Repeats.** Each row carries `repeats`: on how many sessions of the range the symbol appears **after** the widget's threshold / market-cap / sector filters. The symbol cell shows a `×N` badge when `N ≥ 2`, with a title "On the list N of M sessions". Not a sortable column in this version.
- **FR-26 Missing and pending sessions.** A missing session renders its group header with "No run saved for Wed 28 Oct 2026 (server was off between 20:00 and 04:00 ET)". A session whose run is still at phase 1 renders normally with `…` in the Catalyst column (FR-13b). The anchor select shows both states. Missing sessions are selectable as an anchor; the result is the message, not an error.
- **FR-27 Refresh scope.** Refresh keeps re-enriching the **latest saved session only**. The button is enabled only when that session is inside the displayed range; otherwise it is disabled with the title "Refresh applies to the latest session only". Reason: the enrichment window has no upper bound and Google News is queried with `when:3d`, so re-enriching an older day would attach later news to it.
- **FR-28 Explain.** Rule-based and AI Explain work on any row in the range. The AI cache key is already `(sessionDate, symbol)`; it stays per session.
- **FR-29 Not persisted.** Anchor and span are component state, like the other filters (FR-15). Reloading the page returns to span 1, latest.
- **NFR-5** `GET /api/unusual-volume` with span 10 answers in < 500 ms from SQLite. The 10-session cap is enforced server-side (400 beyond it).
- **NFR-6** No provider call is added. The catch-up run on the request path is unchanged: it still happens only for D, only inside the scan window.

Non-goals for this version: a global sort across sessions, a calendar date
picker, backfilling missing sessions, persisting the selection, and a
"streak" column. Each is a small follow-up if wanted (§11).

## 5. API

### 5.1 `GET /api/unusual-volume`

New query parameters, next to the existing `threshold`, `marketCapMin`, `sector`, `sort`, `dir`:

| Param | Type | Default | Validation |
|-------|------|---------|------------|
| `to` | `YYYY-MM-DD` | D if a run exists for it, else the latest saved session | Must be a trading day (`isTradingDay`) and `≤ D`. Otherwise `400 { error: "to must be a closed trading session" }`. |
| `span` | integer | 1 | `1 ≤ span ≤ 10`, else `400 { error: "span must be between 1 and 10" }`. |

`to` + `span` was chosen over `from` + `to` because it mirrors the widget's
state one to one and keeps trading-day arithmetic on the server, where it is
tested. The response still reports both `from` and `to`.

Request path, in order:

1. Parse and validate the query (zod, as today).
2. Resolve `D = resolveSignalSession(now).sessionDate`.
3. If `to` is absent: `to = getRun(D) ? D : getLatestRun()?.sessionDate`. If that is still undefined → `503 FIRST_RUN` (unchanged message). If `to` is absent and `D` has no run and `inScanWindow(now)` → await the shared catch-up `runUnusualVolume({ now })` first, exactly as today, then resolve `to` again.
4. `dates = tradingDaysEndingAt(to, span)` (§7), newest first. `from = dates[dates.length − 1]`.
5. `runs = listRuns(from, to)` and `rows = getRowsBetween(from, to)` (§6): two statements, no per-session loop.
6. Build one `SessionMeta` per date in `dates`, `status: "missing"` where no run exists.
7. Filter rows (threshold / market cap / sector, unchanged), compute `repeats` per symbol over the filtered set, then sort: `sessionDate desc`, then the requested `sort`/`dir` with the existing `compareRows`.
8. Memoise 60 s under `uv:${from}:${to}:${runs.map(r => `${r.sessionDate}/${r.status}/${r.enrichedAt ?? ""}`).join(",")}:${JSON.stringify(query)}` so a phase-2 completion or a refresh invalidates the key.

Response:

```ts
type SessionMeta = {
  sessionDate: string;                  // "2026-10-29"
  sessionLabel: string;                 // "Thu 29 Oct 2026"
  status: "complete" | "pending" | "missing";
  earlyClose: boolean;
  runAt: string | null;                 // null when missing
  spyChangePct: number | null;
  flags: { opex: boolean; spRebalance: boolean; russell: boolean };
  matches: number;                      // saved rows before widget filters; 0 when missing
};

type UnusualVolumeResponse = {
  from: string;                         // oldest session in the range
  to: string;                           // anchor
  currentSession: string;               // D as resolved now
  latestSession: string | null;         // newest saved run; what Refresh targets
  sessions: SessionMeta[];              // newest first, one per trading day, gaps included
  totalMatches: number;                 // sum of sessions[].matches
  rows: Array<UnusualVolumeRow & { sessionDate: string; repeats: number }>;
};
```

This replaces the v1 single-session shape (`sessionDate`, `sessionLabel`,
`earlyClose`, `runAt`, `enrichmentStatus`, `spyChangePct`, `flags` at the top
level). The widget is the only consumer and is updated in the same change set.
A span-1 response is the v1 response with those fields moved into
`sessions[0]`.

### 5.2 `GET /api/unusual-volume/sessions`

Feeds the anchor select.

| Param | Type | Default | Validation |
|-------|------|---------|------------|
| `limit` | integer | 20 | `1 ≤ limit ≤ 60` |

Response: `{ currentSession, latestSession, sessions: SessionMeta[] }` for the
last `limit` trading days ending at D, newest first, missing days included.
One `listRuns(from, D)` statement. Memoised 60 s keyed by `limit` and the
same run-state string as §5.1. Never triggers a catch-up run.

### 5.3 `POST /api/unusual-volume/refresh`

Unchanged semantics (latest saved session, 10-minute cooldown). The 202 body
gains `sessionDate` so the widget can confirm which session is being
re-enriched: `202 { enrichmentStatus: "pending", sessionDate }`.

## 6. Store (`server/src/unusualVolume/store.ts`)

No schema change. The primary key `(session_date, symbol)` already serves a
range scan on `session_date`.

```ts
export function listRuns(fromDate: string, toDate: string): StoredRun[];
// SELECT … FROM unusual_volume_runs WHERE session_date BETWEEN ? AND ? ORDER BY session_date DESC

export type StoredRow = UnusualVolumeRow & { sessionDate: string };
export function getRowsBetween(fromDate: string, toDate: string): StoredRow[];
// SELECT session_date, row_json, catalyst_json FROM unusual_volume_rows
// WHERE session_date BETWEEN ? AND ? ORDER BY session_date DESC, rvol DESC
```

`getRows(sessionDate)` stays for `run.ts` (re-enrich path). `getRun`,
`getLatestRun`, `getLastRefresh`, `setLastRefresh` unchanged.

## 7. Calendar (`server/src/marketCalendar.ts`)

```ts
/** `n` trading days ending at `to` inclusive, newest first. `to` must be a trading day. */
export function tradingDaysEndingAt(to: string, n: number): string[];
```

Built on the existing `previousTradingDay`. Bounded by `n ≤ 60` (the sessions
endpoint's cap); each step is itself bounded by `previousTradingDay`'s 14-day
search, so a missing holiday year surfaces as an error, not a spin. A `to`
that is not a trading day throws; the route turns that into the 400 above.

## 8. Widget (`web/components/widgets/UnusualVolumeWidget.tsx`)

**State added:** `anchor: string` (`""` = latest), `span: number` (1–10), `spanDraft: string`. `expanded` becomes `string | null` keyed by `${sessionDate}:${symbol}`.

**Queries**

- `["unusual-volume", "sessions"]` → `/api/unusual-volume/sessions?limit=20`, `staleTime` 5 min, `refetchInterval` 15 min. Populates the anchor select. Its absence never blocks the table.
- `["unusual-volume", anchor, span, threshold, marketCapMinB, sector, sort, dir]` → `/api/unusual-volume?span=…&to=…` (`to` sent only when `anchor !== ""`). Polling rule unchanged: 10 s while any session in the response is `pending` or after a refresh, else 15 min.

**Toolbar** (left to right): anchor `<select>` → span buttons `1D 2D 3D 5D` + numeric input (1–10, same commit-on-blur pattern as the threshold input) → the existing threshold / market cap / sector / Refresh / AI controls → header text on the right:

- span 1: `Session: Thu 29 Oct 2026 · 26 matches · run 06:00` (unchanged, now read from `sessions[0]`)
- span > 1: `Sessions: Mon 26 Oct – Thu 29 Oct 2026 (4) · 62 matches`, plus `1 missing` in amber when any session is missing.

Anchor option labels: `Latest`, then `Thu 29 Oct`, `Wed 28 Oct · no run`, `Tue 27 Oct`, …, `Fri 23 Oct · pending`.

**Table**

- Rows come grouped from the server. The widget emits a group header `<tr>` whenever `row.sessionDate` changes, **only when span > 1**. Missing sessions have no rows, so group headers are driven from `sessions[]`, not from the rows: iterate `sessions`, render the header, then the rows whose `sessionDate` matches. This is what makes a gap visible.
- Header row content: `Thu 29 Oct 2026 · 26 matches · SPY +0.6% · run 06:00` with `early close` / `pending` chips; for a missing session the FR-26 sentence. Class `uv-session` added to `globals.css` next to the `rvol-*` tiers (dim text, top border, left aligned, `colSpan = columns.length`).
- Symbol cell: `×N` badge after the symbol when `row.repeats ≥ 2`, class `dim`, `title="On the list N of M sessions"` where M = `sessions.length`.
- `ExpandedDetail` receives `row.sessionDate` instead of the top-level date; the AI query key is unchanged in shape.
- Refresh button: `disabled` unless `data.latestSession !== null && data.sessions.some(s => s.sessionDate === data.latestSession)`; title per FR-27. The 429 cooldown note is unchanged.

**Empty states**

- Every session in the range is missing → one `dim` line: "No run saved for {from}–{to}. Runs happen at 06:00 or on the next startup before 04:00 ET."
- Sessions present but zero rows after filters → "No unusual volume for {range label} at ≥ {threshold}×" (range label = single date or `from – to`).
- `503` → the existing first-run message.

**Responsive columns** unchanged. The group header spans all visible columns.

## 9. Error handling

| Case | Behaviour |
|------|-----------|
| `to` not a trading day, or after D | 400 with the message in §5.1; widget shows it in the error line. |
| `span` outside 1–10 | 400. The numeric input clamps client-side, so this only hits via curl. |
| Range extends past the oldest saved run (e.g. 10D on the first week) | Not an error: the older days are `missing`. |
| Range extends past retention (90 days) | Same as above; those days were pruned. The anchor select only lists 20 days, so this is a curl-only case. |
| Nothing saved at all, no `to` given | 503 first-run message, unchanged. |
| Nothing saved at all, `to` given | 200, all sessions `missing`, `rows: []`, `latestSession: null`. |
| `/sessions` fails | The select shows only `Latest`; the table still loads with the server default. |

## 10. Performance

- Worst case is span 10 with ~100 matches a day: ~1,000 rows, two statements, one JSON parse per row. Measured on v1 data a 300-row session parses in well under 50 ms; 10× that stays inside NFR-5. The 60 s memo makes the polling widget free.
- Response size: roughly 2–4 KB per row with evidence, so 2–4 MB at the cap. Acceptable for a local terminal; if it ever matters, drop `catalysts.evidence` from rows of non-anchor sessions until expanded (§11).

## 11. Follow-ups (not in this version)

- Global sort across the range (a `groupBy=none` switch).
- Sortable `Days` column replacing the badge; a streak counter over the full retention rather than the range.
- Persist anchor/span in the widget store (needs the per-widget settings field FR-15 mentions).
- Evidence-on-expand to shrink multi-session responses.
- An ops guard that warns in the server log at 11:00 Israel time when the day's run is missing, so a gap is noticed the same day.

## 12. Files touched

| File | Change |
|------|--------|
| `server/src/marketCalendar.ts` | `tradingDaysEndingAt` |
| `server/src/unusualVolume/store.ts` | `listRuns`, `getRowsBetween`, `StoredRow` |
| `server/src/unusualVolume/types.ts` | `SessionMeta`, `SessionStatus` |
| `server/src/routes/unusualVolume.ts` | `to`/`span` params, multi-session response, `GET /sessions`, refresh body |
| `server/src/unusualVolume/system.test.ts` | Range scenario with a gap |
| `web/lib/api.ts` | New `UnusualVolumeResponse`, `SessionMeta`, `sessionDate`/`repeats` on the row |
| `web/components/widgets/UnusualVolumeWidget.tsx` | Anchor/span controls, grouped rendering, badge, refresh gating |
| `web/app/globals.css` | `.uv-session` |
| `README.md`, `docs/requirements/unusual-volume-widget.md`, `docs/design/unusual-volume-widget.md` | Feature line, FR-22…29 cross-reference, decisions log, status |

## 13. Acceptance criteria

### 13.1 Automated

| # | Given | Expect |
|---|-------|--------|
| A20 | Runs saved for 2026-10-29, 27, 26; none for 28. `to=2026-10-29&span=3` | `sessions` = [29 complete, 28 missing, 27 complete]; `from = 2026-10-27`; rows only from 29 and 27; all 29 rows precede all 27 rows |
| A21 | `span=11`, `span=0`, `span=abc` | 400 each; no store call |
| A22 | `to=2026-10-31` (Saturday); `to` later than D | 400 "to must be a closed trading session" |
| A23 | No params, D has no run, outside the scan window, an older run exists | Range is that older session alone (span 1); `latestSession` equals it; no `runUnusualVolume` call (regression of A11) |
| A24 | No params, D has no run, inside the scan window | `runUnusualVolume` called once, then the response is built from what it saved |
| A25 | AAA on 29 (rvol 4) and 27 (rvol 2.6); BBB on 29 only; `span=3` | `AAA.repeats = 2`, `BBB.repeats = 1`; with `threshold=3` the 27 row drops and `AAA.repeats = 1` |
| A26 | `sort=rvol&dir=asc` over two sessions | Ascending inside each session; session order stays newest first |
| A27 | `/sessions?limit=5` with one run at `status='list'` | 5 trading days ending at D, newest first; that day is `pending`; days without runs are `missing`; `currentSession = D` |
| A28 | `tradingDaysEndingAt("2026-11-30", 3)` | `["2026-11-30", "2026-11-27", "2026-11-25"]` (Thanksgiving 26 skipped) |
| A29 | `getRowsBetween("2026-10-27", "2026-10-29")` with rows on 26, 27, 29 | Rows from 27 and 29 only, ordered `session_date DESC, rvol DESC`, each carrying `sessionDate` |
| A30 | Cached span-3 response, then one run's `enriched_at` changes | The next request is a cache miss (key includes run state) |

### 13.2 Manual (widget, on real data)

1. Default view is identical to v1: one session, same header, same table.
2. Pick `3D`: three group headers appear, newest first, each with its own counts; a missing day (if any) shows the "No run saved" header.
3. Pick an anchor 3 days back with `1D`: that day's list, catalysts and Explain render; Refresh is disabled with the FR-27 title.
4. A symbol on two of the days shows `×2`; raising the threshold so one of its rows drops removes the badge.
5. Expand a row in an older session with AI on: the AI text is requested once per `(session, symbol)` and does not leak into another session's row for the same symbol.
6. Sort by Close ascending with `5D`: each group is sorted independently.
7. `curl -w "%{time_total}"` on `?span=10` returns in < 500 ms.

## 14. Decisions

| Topic | Decision |
|-------|----------|
| Range parameters | `to` + `span` (trading days), not `from`/`to`; mirrors the UI, keeps calendar math on the server |
| Gaps | Shown as `missing` sessions; never substituted with the nearest run; no backfill (§3) |
| Span cap | 10 sessions, server-enforced |
| Ordering | Grouped by session newest first, chosen sort within the group |
| Repeats | Counted after widget filters, shown as a badge, not sortable |
| Refresh | Latest saved session only; disabled when it is outside the range |
| Persistence | Not persisted, matching FR-15 |
| Response shape | New shape with `sessions[]`; the v1 top-level session fields are removed rather than duplicated |
| Screenshot | README has no unusual-volume image, so none was added for the range view |
| Schema | No change; existing composite primary key serves the range scans |
