# Unusual Volume — Session Range Selector — Task Breakdown

| | |
|---|---|
| **Last updated** | 2026-10-30 |
| **Design** | [`docs/design/unusual-volume-range.md`](unusual-volume-range.md) (§ references, FR-22…29, A20…A30) |
| **v1 tasks** | [`docs/design/unusual-volume-tasks.md`](unusual-volume-tasks.md): the git workflow, the repository test standard and the definition of done there apply unchanged |

## How to read this

- Sizes: **S** (≤ ½ day), **M** (≈ 1 day). One task = one PR.
- Branch names: `feat/uv-range-r1-calendar`, `feat/uv-range-r3-route`, … Commits: `feat(unusual-volume): …` / `test(unusual-volume): …` / `docs(unusual-volume): …`.
- R1 and R2 have no dependencies and can start together. R3 needs both. R4 can start against the §5.1 contract as soon as R3's response type is agreed, using a fixture JSON.
- The §5.1 response shape is the interface between server and web. If R3 changes it, update the design doc in the same PR and tell R4's owner.
- No provider code, no schema, no scheduler changes. If a task finds it needs one, stop and raise it: the design (§3) says this feature adds no fetches.

---

## R1 · Trading-day range helper — `server/src/marketCalendar.ts` · **S**

**Scope** (design §7)
- `tradingDaysEndingAt(to: string, n: number): string[]`: `n` trading days ending at `to` inclusive, newest first. Throws `Error("not a trading day: …")` when `to` fails `isTradingDay`, and `RangeError` when `n` is outside `1…60`.
- Built on `previousTradingDay`; no new tables or constants.

**Tests — add to `marketCalendar.test.ts`**
- **A28:** `tradingDaysEndingAt("2026-11-30", 3)` → `["2026-11-30", "2026-11-27", "2026-11-25"]`.
- Across a weekend: `("2026-10-26", 2)` → `["2026-10-26", "2026-10-23"]`.
- `n = 1` returns `[to]`; `n = 0` and `n = 61` throw `RangeError`.
- Saturday `to` throws; a holiday `to` (2026-11-26) throws.

---

## R2 · Range queries in the store — `server/src/unusualVolume/store.ts` · **S**

**Scope** (design §6)
- `listRuns(fromDate, toDate): StoredRun[]`, `ORDER BY session_date DESC`, inclusive bounds.
- `export type StoredRow = UnusualVolumeRow & { sessionDate: string }` and `getRowsBetween(fromDate, toDate): StoredRow[]`, `ORDER BY session_date DESC, rvol DESC`. Reuse `toUnusualVolumeRow`; add `session_date` to the select.
- Statements prepared once at module level, like the existing ones. `getRows(sessionDate)` stays as is.

**Tests — add to `unusualVolume/store.test.ts`**
- **A29:** rows saved on 26, 27 and 29 → `getRowsBetween("2026-10-27", "2026-10-29")` returns only 27 and 29, newest session first, rvol descending inside a session, `sessionDate` set on each row, `catalysts` round-tripping as in the single-session case.
- `listRuns` is inclusive on both ends and empty when the range holds no run.
- A phase-1 run (`status='list'`) in the range comes back with `catalysts: null` on its rows.

---

## R3 · Route: `to`/`span`, multi-session response, `/sessions` — `server/src/routes/unusualVolume.ts`, `types.ts` · **M** · depends on R1, R2

**Scope** (design §5, §9)
- `types.ts`: `SessionStatus = "complete" | "pending" | "missing"` and `SessionMeta` (design §5.1).
- Query schema: add `to` (`z.string().regex(/^\d{4}-\d{2}-\d{2}$/)`, optional) and `span` (`z.coerce.number().int().min(1).max(10)`, default 1). Validation messages exactly as in design §5.1.
- Resolution order from design §5.1 steps 2–4, including the unchanged catch-up (`inScanWindow` + shared `runUnusualVolume`) which happens **only** when `to` is absent and D has no run.
- `to` later than D, or not a trading day → 400 `"to must be a closed trading session"`. Catch the `Error` from `tradingDaysEndingAt` for the non-trading-day case; compare strings for the "later than D" case (zero-padded dates sort lexicographically).
- Build `sessions[]` from `tradingDaysEndingAt(to, span)` joined with `listRuns(from, to)`; `missing` where no run. `matches` = count of stored rows for that session (from the `getRowsBetween` result, before filters).
- Filter with the existing predicate, compute `repeats` over the filtered rows (`Map<symbol, count>`), sort by `sessionDate desc` then `compareRows`.
- Response fields exactly as design §5.1: `from`, `to`, `currentSession`, `latestSession`, `sessions`, `totalMatches`, `rows`. Remove the v1 top-level session fields.
- Cache key per design §5.1 step 8.
- `GET /sessions?limit=` (1–60, default 20): `tradingDaysEndingAt(D, limit)` + one `listRuns`; same `SessionMeta` mapper; 60 s memo; never runs a catch-up.
- `POST /refresh`: add `sessionDate` to the 202 body. Nothing else changes.
- Keep `sessionLabel()` and `fail()`; factor the `SessionMeta` mapper into one function used by both GET handlers.

**Tests — `routes/unusualVolume.test.ts`** (extend; the store mock gains `listRuns` and `getRowsBetween`)
- **A20:** runs 29/27/26, none for 28, `to=2026-10-29&span=3` → sessions `[complete, missing, complete]`, `from === "2026-10-27"`, rows only from 29 and 27, every 29 row before every 27 row.
- **A21:** `span=11`, `span=0`, `span=abc` → 400 and no store function called.
- **A22:** `to=2026-10-31` → 400 with the exact message; `to` one trading day after D → 400.
- **A23:** no params, no run for D, `now` outside the scan window, older run exists → one session equal to the older run, `runUnusualVolume` not called.
- **A24:** no params, no run for D, `now` inside the scan window → `runUnusualVolume` called once with `{ now }`.
- **A25:** AAA on 29 (rvol 4) and 27 (rvol 2.6), BBB on 29 only → `repeats` 2 / 1; with `threshold=3` → AAA `repeats` 1 and no 27 row.
- **A26:** `sort=rvol&dir=asc` over two sessions → ascending inside each; session order newest first.
- **A27:** `/sessions?limit=5` with one `list`-status run → 5 entries, that day `pending`, others `complete`/`missing`, `currentSession === D`, `latestSession` = newest saved.
- **A30:** two calls with the same query; between them the mocked run's `enrichedAt` changes → second call rebuilds the body (assert `getRowsBetween` called twice).
- Regression: the existing threshold-clamp, sector, unknown-sort-400, 503-first-run and refresh-cooldown tests still pass against the new shape (update their assertions to `sessions[0]`).
- Refresh 202 body contains `sessionDate`.

---

## R4 · Widget: anchor/span controls, grouped rows, badge, refresh gating — `web/` · **M** · depends on R3 (contract)

**Scope** (design §8)
- `web/lib/api.ts`: replace `UnusualVolumeResponse` with the §5.1 shape; add `SessionMeta`, `SessionStatus`; add `sessionDate: string` and `repeats: number` to `UnusualVolumeRow`.
- State: `anchor` (`""` = latest), `span` (1–10) with `spanDraft` and the same commit-on-blur/Enter pattern as the threshold input; `expanded` keyed by `${sessionDate}:${symbol}`.
- Sessions query (`/api/unusual-volume/sessions?limit=20`, `staleTime` 5 min) → anchor `<select>` with `Latest` first and option labels `Thu 29 Oct`, `Wed 28 Oct · no run`, `Fri 23 Oct · pending`.
- Main query key gains `anchor` and `span`; `to` is sent only when `anchor !== ""`. Polling: 10 s while any `sessions[i].status === "pending"` or after a refresh, else 15 min (replace the `enrichmentStatus` check).
- Span buttons `1D 2D 3D 5D` + numeric input 1–10, placed before the threshold buttons.
- Header text per design §8 (single-session wording unchanged; range wording with `(N)` and an amber `k missing` when applicable).
- Table: when `span > 1`, iterate `data.sessions` and emit a `uv-session` header `<tr>` (`colSpan = columns.length`) before that session's rows; missing sessions render the FR-26 sentence. When `span === 1`, no header rows (pixel-identical to v1).
- Symbol cell: `×N` badge when `row.repeats ≥ 2`, `title="On the list N of M sessions"`.
- `ExpandedDetail` takes `row.sessionDate`.
- Refresh button disabled unless `latestSession` is in `sessions`; title "Refresh applies to the latest session only".
- Empty states per design §8.
- `globals.css`: `.uv-session` next to the `rvol-*` tiers (dim text, top border, left aligned).

**Tests / checks**
- `npm run build -w web` and `npm run lint` pass.
- The pure helpers added for the header text (`rangeLabel(sessions)`) and for grouping (`rowsBySession(rows, sessions)`) are exported from the component file with a comment, so they can be read and reviewed in isolation; the web workspace has no test runner.
- PR attaches three screenshots: span 1 (identical to v1), span 3 with a missing day, span 5 with a `×N` badge visible. Manual checklist = design §13.2 items 1–6.

---

## R5 · System test: range through the route — `server/src/unusualVolume/system.test.ts` · **S** · depends on R3

**Scope**
- Extend the existing end-to-end file (it stubs only `fetch` and uses a temp `DATA_DIR`): after the v1 run for 2026-10-23, insert two more saved runs directly through `saveListPhase`/`saveEnrichmentPhase` for 2026-10-26 and 2026-10-27 (small fixtures, one shared symbol), then call the GET handler with `to=2026-10-27&span=4` and `now` pinned to a time where D = 2026-10-27.
- Assert: `sessions` = [27, 26, 23, 22] with 2026-10-22 `missing` (span 4 from Tue 27 is 27, 26, 23, 22), `from === "2026-10-22"`, the shared symbol has `repeats === 2`, rows grouped newest first, and the summary/log side effects of v1 are untouched.
- Also call `/sessions?limit=4` and assert the same statuses.

**Tests** — the file is the deliverable; must still run in < 5 s.

---

## R6 · Docs, README, decisions log, status flip · **S** · depends on R4, R5

**Scope**
- README feature bullet: extend the unusual-volume line with "browse any of the last 90 sessions, or several at once" and one sentence on gaps: "A session is lost if the server is not running between 20:00 and 04:00 ET (03:00–11:00 Israel time); keep it up through the 06:00 run."
- `docs/requirements/unusual-volume-widget.md`: add a pointer under §3.2 to FR-22…29 in the range design; add the §14 decisions of the range design to the §9 decisions log; bump "Last updated".
- `docs/design/unusual-volume-widget.md`: §9 API section gets a one-line pointer to the new shape; §14 work breakdown gains R1–R6; bump "Last updated".
- `docs/design/unusual-volume-range.md`: status → **Shipped**, record anything that changed during implementation.
- Screenshot `docs/screenshots/unusual-volume-range.png` (span 3 with a gap) if the README shows one for the widget.

**Tests / checks** — build green; links in the docs resolve.

---

## Dependency graph

```
R1 ─┐
    ├─► R3 ─┬─► R5 ─┐
R2 ─┘       │       ├─► R6
            └─► R4 ─┘
```

Suggested order for one engineer: R1, R2 (half a day together), R3 (one day), R4 (one day), R5 + R6 (half a day). Two engineers: E1 R1 → R3 → R5; E2 R2 → R4 (against a fixture JSON until R3 lands) → R6.

## Acceptance-ID coverage map

| ID | Task(s) |
|----|---------|
| A20, A21, A22, A23, A24, A25, A26, A27, A30 | R3 |
| A28 | R1 |
| A29 | R2 |
| End-to-end range with a gap | R5 |
| §13.2 manual checks | R4 (items 1–6), R6 (item 7, recorded in the PR) |
