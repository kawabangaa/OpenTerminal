# Chart Widget Support / Resistance Overlay — Task Breakdown

| | |
|---|---|
| **Last updated** | 2026-10-30 |
| **Requirements** | [`docs/requirements/support-resistance-overlay.md`](../requirements/support-resistance-overlay.md) (FR/NFR/A-n IDs) |
| **Design** | [`docs/design/support-resistance-overlay.md`](support-resistance-overlay.md) (§ references) |
| **Algorithm** | [`docs/requirements/support_resistance_spec.md`](../requirements/support_resistance_spec.md) (Step references) |

## How to read this

- Tasks are sized **S** (≤ ½ day), **M** (≈ 1 day). One task = one PR unless noted.
- **Depends on** lists the tasks whose merged code this one imports. T1 and the fixture capture in T2 can start on day 1; T4 can start against a fixture JSON before T3 merges.
- Every task's **Tests** section is part of its scope. A task is not done until its tests exist, pass locally and in CI, and the acceptance IDs it names are covered.
- Interfaces between tasks are fixed by design §3 (`SrOptions`, `SrLevel`, `SrResult`) and §5 (route). If you must change one, update the design doc in the same PR and tell the owner of the dependent task.

## Repository & git workflow (read before your first commit)

This work happens in the **fork `kawabangaa/OpenTerminal`**, never in the
upstream repo `ErTasselli/openterminal`. The local clone is wired so that the
default path is the safe one; do not change it.

| Remote | URL | Use |
|--------|-----|-----|
| `origin` | `git@github.com:kawabangaa/OpenTerminal.git` | **All pushes and PRs.** `main` tracks `origin/main`. |
| `upstream` | `https://github.com/ErTasselli/openterminal.git` | **Fetch only**, to pull the original project's updates. Never push here, never open PRs here. |

Rules:
1. Branch from `main` with a task-scoped name: `feat/sr-t01-levels`, `test/sr-t02-fixture`, `feat/sr-t04-widget`.
2. Push with `git push -u origin <branch>`. A plain `git push` from a tracking branch also goes to the fork.
3. Open PRs against the fork explicitly, so the tooling cannot pick the parent repo:
   `gh pr create --repo kawabangaa/OpenTerminal --base main --head <branch> …`
4. Never run `git push upstream …` or `gh pr create` without `--repo`. The clone's `upstream` push URL is set to `no_push` (`git remote set-url --push upstream no_push`), so a push there fails with `'no_push' does not appear to be a git repository`. That error is intentional; do not "fix" it by restoring the URL. A fresh clone must apply the same setting.
5. Syncing from the original project (maintainer does this on `main`): `git fetch upstream && git merge upstream/main && git push origin main`.
6. Commits are local until pushed; an agent committing in this clone has written nothing to GitHub. Only `git push` publishes, and it publishes to the fork.

## Repository test standard (applies to every task)

Copied from how the repo already works. Reviewers will check each item.

1. **Runner:** vitest, `*.test.ts` next to the module. `npm run test -w server` must pass. The `web` workspace has no test runner; that is why the algorithm lives on the server (design §1).
2. **No network in tests.** Stub `fetch` with `vi.stubGlobal("fetch", vi.fn()…)` and restore with `vi.unstubAllGlobals()` in `afterEach`, as `routes/market.test.ts` does.
3. **Fixtures are small and inline**, hand-built candle arrays of ≤ 60 bars. The one exception is the recorded REAL series in T2 (≈ 250 bars, ≈ 20 KB), justified because it is the spec's validation set; keep it the only recorded fixture.
4. **Route tests** follow `routes/market.test.ts`: pull the handler from `(router as any).stack`, call it with a fake `req` and a `res` whose `status`/`json` are `vi.fn().mockReturnThis()`.
5. **Pure modules take data, not clocks.** `srLevels` works from the candles' own timestamps; nothing reads `Date.now()`.
6. **Comments** explain the *why* (spec step, anchoring rule, grid bound) as the existing providers do; no comment restating the code.
7. **CI must be green:** `npm run test -w server`, `npm run build -w server`, `npm run build -w web`, plus `npm run lint` for web changes.
8. **Commits:** `feat(sr): …` / `test(sr): …` for server work, `feat(chart): …` for the widget, `docs(sr): …` for docs.
9. **Definition of done** for every task: scope implemented · tests listed below pass · CI green · design doc updated if an interface changed · PR description lists the acceptance IDs covered.

---

## Phase A — Server

### T1 · Pure level detection — `server/src/sr/levels.ts` · **M**

**Scope** (design §3, §4)
- `SR_DEFAULTS`, `SrOptions`, `SrLevel`, `SrResult` exactly as design §3.
- `srLevels(symbol: string, candles: Candle[], opts = SR_DEFAULTS): SrResult`, a line-for-line port of the spec's reference function with the design §4 additions:
  - window W = bars within `windowDays` of the last bar; `insufficient_history` when `candles.length < minBars` or `W.length < minBars` (§4.1);
  - ε from a simple-mean ATR; `step = Number((eps / 30).toPrecision(1))`; grid capped at 200 000 points (§4.2, §8); `eps === 0` returns no levels with `reason: null`;
  - pivots carry `{ price, idx }` so `firstTouch` / `lastTouch` can be derived (§4.3);
  - Step 3 clustering and Step 5 merge anchored to the **first** member; episodes split on bar-position gaps `> episodeGap`;
  - keep rule with `extreme` recorded; type by last close; cap by `score` desc then distance; R/S ranks; rounding rule; output by price desc (§4.4).
- Typed arrays (`Float64Array`) for h/l/c and the grid; the scan is one loop per grid point over W.
- Out of scope: route, fixture, widget.

**Tests — `sr/levels.test.ts`** (synthetic, ≤ 60 bars each)
- **A3:** three equal highs 5 bars apart, k = 3 → one level, `nPiv = 3`, zone width 0, `firstTouch`/`lastTouch` are the first and third pivot bars.
- Pivot confirmation: a high in the last k bars is not a pivot (`t + k ≤ N`).
- **A4:** two clusters 0.9 ε apart merge; a third 1.1 ε above the first starts a new group (anchor = first member, not previous).
- Scan plateau: a flat run of equal Q ≤ ε wide gives the plateau centre; wider than ε gives the argmax point.
- **A5:** 7 rejections within 8 bars → not kept (E = 1); same 7 split 3 + 4 by a 12-bar gap → kept (E = 2, score = 7 + 2).
- Extreme rule: a lone spike at the window high is kept with `extreme: true`, `nPiv = 1`.
- **A6:** 39 bars → `levels: []`, `reason: "insufficient_history"`.
- **A7:** 400 bars with a strong shelf 200 bars back and nothing recent → that shelf is absent; every returned level's `firstTouch ≥ asOf − 183 d − 3 bars`.
- **A8:** prices ≈ 0.08, ATR 0.004 → `step = 0.00007`, grid < 20 000 points, at least one level; prices rounded to 4 significant figures.
- **A9:** a series engineered to give > 10 kept candidates → exactly 10 returned, ordered by score desc then `|price − lastClose|` asc; ranks R1… / S1… nearest-first.
- Flat series (all bars identical) → `eps = 0`, no levels, `reason: null`.

---

### T2 · REAL fixture and spec validation — `server/src/sr/fixtures/real-2026.json` + test · **S** · depends on T1

**Scope** (design §9.1)
- Capture `GET /api/history/REAL?range=1Y` from a running local server (Nasdaq first in the chain) on or after 2026-10-30; save the `Candle[]`, **truncated after the 2026-10-29 bar**, as the fixture. The capture can be done on day 1 in parallel with T1.
- Add a `describe("REAL validation")` block to `sr/levels.test.ts` that derives `windowDays` from the fixture so W starts exactly on 2026-08-03, runs `srLevels`, and asserts the spec's table.
- If the final Oct 29 bar moves any level by more than ± 0.02, do **not** loosen the tolerance: record the new numbers in a comment, get the spec author's sign-off, and re-baseline (requirements §8).

**Tests**
- **A1:** `eps = 0.31 ± 0.01`; kept levels 13.82, 11.94, 11.22, 10.70, 10.09, 9.17, 8.57 each within ± 0.02 with the table's `nPiv` / `q` / `episodes`; 11.45, 10.37, 9.59 absent; 13.82 and 8.57 have `extreme: true`.
- **A2:** with `lastClose = 11.31`: 13.82 → `R2`, 11.94 → `R1`; 11.22 → `S1`, 10.70 → `S2`, 10.09 → `S3`, 9.17 → `S4`, 8.57 → `S5`.

---

### T3 · History helper and `/api/sr-levels` route — `server/src/routes/market.ts` · **S** · depends on T1

**Scope** (design §2.2, §5)
- Extract the body of `GET /history/:symbol` into `fetchHistory(symbol, rangeKey): Promise<Candle[]>` keeping the `cached()` key `history:${symbol}:${rangeKey}`, `HISTORY_TTL`, the Binance / VIX / `withFallback` branches and the `empty history from all providers` throw. `/history` becomes `res.json(await fetchHistory(...))` in its try/catch. `/earnings-history` may switch to it in the same PR (optional, no behaviour change).
- `GET /sr-levels/:symbol`: upper-case symbol; `cached(\`sr:${symbol}\`, 60_000, async () => srLevels(symbol, await fetchHistory(symbol, "1Y")))`; `res.json(result)`; errors through `fail()`.
- `web/lib/api.ts`: add `SrLevel` and `SrResult` types mirroring design §3 (hand-copied like `Candle`).

**Tests — add to `routes/market.test.ts`**
- **A10:** `fetch` stubbed to return a Nasdaq-shaped payload (reuse the existing history stub) → 200, body has `symbol`, `asOf`, `eps`, `levels[]` with the §3 fields; a second call within the TTL makes no further `fetch` call.
- **A11:** all providers rejecting → the same `fail()` shape as `/history` (status and body asserted the way the existing history failure test does).
- `/history` regression: the existing history tests still pass unchanged after the extraction.

---

## Phase B — Web

### T4 · `S/R` toggle, query and bands — `web/components/widgets/ChartWidget.tsx` · **M** · depends on T3 for the contract (start against a fixture JSON if T3 is not merged)

**Scope** (design §6.1–§6.3)
- Append `"SR"` to `INDICATORS`; render its button label as `S/R`; `toggleIndicator` unchanged (FR-1, FR-2).
- `useQuery(["sr-levels", symbol])`, `enabled: active.has("SR")`, `refetchInterval: 60_000` (FR-16, FR-17).
- Constants `SR_COLOR`, `SR_EDGE_ALPHA = 0.35`, `SR_CENTER_ALPHA = 1`, helper `withAlpha(hex, a)` (FR-10, FR-11).
- `drawSrLevels(series, levels): IPriceLine[]` as a standalone function: centre line 2 px opaque with `title = label` and `axisLabelVisible: true`; edge lines 1 px at 35 % with no label; single-price zones get the centre line only (FR-12, FR-13).
- Call it inside the chart effect after the main series is created; add `srOn ? sr : null` to the effect's dependency list so lines are rebuilt with the chart and removed when the toggle goes off (design §6.2, "today's lifecycle"). If chart-zoom has merged first, implement the "after chart-zoom" variant instead: own effect, `IPriceLine[]` in a `useRef`, `removePriceLine` on cleanup (NFR-5).
- Out of scope: legend row and failure text (T5).

**Tests / checks**
- No automated web tests (no runner). Manual checks from requirements §6.2: items 1, 3, 4, 5, 6 (levels appear), 8. Record them in the PR description.
- `npm run build -w web` and `npm run lint` green.

---

### T5 · Legend row and degraded states — `ChartWidget.tsx` · **S** · depends on T4

**Scope** (design §6.4)
- When `S/R` is on, add one legend row: `R` group in cyan (price desc), `S` group in pink (price desc), `ε` dim; the entry whose zone contains the hovered candle's close is bold (FR-14).
- `reason === "insufficient_history"` → dim `S/R: not enough history` (FR-7); query error → dim `S/R unavailable`, button stays active, candle error line untouched (FR-19).
- Prices through `fmt`; layout follows `indicatorRows`.

**Tests / checks**
- Manual checks from requirements §6.2: items 2, 6 (new listing), 7. Record them in the PR description.
- Build and lint green.

---

## Phase C — Finish

### T6 · Docs, README, screenshot, status flip · **S** · depends on T2, T5

**Scope**
- README "Professional charting" bullet mentions support/resistance bands; add `docs/screenshots/chart-sr.png` (REAL or another ticker with a clear band set, S/R on, 6M).
- Requirements and design docs: status → **Shipped**, "Last updated" bumped, decisions log amended with anything that changed during implementation (in particular the FR-10 alpha reading and any REAL re-baseline from T2).
- Run the full manual list of requirements §6.2 once on the merged `main` and note the result in the PR.

**Tests / checks** — build green; links in the docs resolve.

---

## Dependency graph

```
T1 ─┬─► T2 ─────────────┐
    │                   ├─► T6
    └─► T3 ─► T4 ─► T5 ─┘
```

Suggested staffing for one engineer: T1, T2, T3, T4, T5, T6 in order, about four days. For two engineers: **E1** T1, T2, T3 · **E2** T4 against a fixture JSON from day 1, then T5 once T3 merges · either does T6.

## Acceptance-ID coverage map

| ID | Task(s) |
|----|---------|
| A1, A2 | T2 |
| A3, A4, A5, A6, A7, A8, A9 | T1 |
| A10, A11 | T3 |
| §6.2 manual 1, 3, 4, 5, 8 | T4 |
| §6.2 manual 2, 6, 7 | T5 |
| §6.2 full pass on `main` | T6 |
