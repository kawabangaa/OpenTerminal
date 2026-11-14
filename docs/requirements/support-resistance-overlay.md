# Chart Widget Support / Resistance Overlay — Requirements

| | |
|---|---|
| **Status** | Draft for review |
| **Last updated** | 2026-10-30 |
| **Repo** | Developed in the owner's fork (`kawabangaa/OpenTerminal`); no upstream issue. Git rules in [`docs/design/unusual-volume-tasks.md`](../design/unusual-volume-tasks.md), "Repository & git workflow". |
| **Algorithm** | [`docs/requirements/support_resistance_spec.md`](support_resistance_spec.md) (the formal spec; this document does not restate it) |
| **Design** | [`docs/design/support-resistance-overlay.md`](../design/support-resistance-overlay.md) |
| **Tasks** | [`docs/design/support-resistance-tasks.md`](../design/support-resistance-tasks.md) |
| **Widget** | `web/components/widgets/ChartWidget.tsx` |

## 1. Goal

Add one more toggle to the chart widget's indicator row, next to SMA20 / SMA50
/ VWAP / BOLL …, labelled **`S/R`**. When it is on, the chart shows the
support and resistance levels found by the algorithm in the S/R spec, each
drawn as a **band**: a solid centre line at the level price and two faded
lines at the edges of its zone. **Support is pink, resistance is cyan.** Only
levels built from the **last 6 months** of daily candles are shown, so no
line is older than 6 months.

## 2. Definitions

| Term | Definition |
|------|------------|
| **Level** | One output row of the spec: price ℓ, zone [a, b], type, n_piv, Q, E, score. |
| **Band** | The on-chart drawing of a level: centre line at ℓ, edge lines at a and b. |
| **Analysis window W** | The daily bars whose time is within **183 calendar days** of the last daily bar. This is the spec's W, fixed to "last 6 months". |
| **Warm-up** | Bars before W used only so ATR (n = 14) and the first pivots (k = 3) are defined. Fetched, never shown as levels. |
| **Last close C_N** | Close of the last daily bar loaded (may be today's partial bar during the session). Decides support vs. resistance. |
| **Rank** | Levels above C_N are R1, R2, … from nearest to farthest; below are S1, S2, … the same way. |

## 3. Functional requirements

### 3.1 Toggle
- **FR-1** A new indicator button **`S/R`** at the end of the indicator row, same `term-btn` styling and toggle behaviour as the existing indicators (active = amber border). Default **off**.
- **FR-2** The toggle is independent of range, chart type and other indicators. It can be combined with any of them.
- **FR-3** Like the other indicator toggles today, the S/R state is per widget instance and **not persisted** across reloads. (If indicator persistence is added later, S/R follows the same rule.)

### 3.2 Levels
- **FR-4** Levels are computed exactly as the S/R spec, Steps 1–5 plus the **type** rule of Step 6, with the spec's default parameters (n 14, α 0.5, k 3, wick basis, q_scan 4, g 10, q_keep 6, β 2). Break / flip / retest states (rest of Step 6) are **not** in v1 (§9).
- **FR-5** The levels are always derived from **daily** candles, whatever range the chart is showing. On 1D / 5D / 1M the same daily levels are drawn over the intraday bars; on 5Y / MAX they are drawn over the weekly / monthly bars.
- **FR-6** **Age cap.** W is the last 183 calendar days ending at the last daily bar. Nothing older contributes rejections, and every drawn level's zone comes from pivots or rejection days inside W (pivots may use up to k = 3 bars before W for confirmation, as the spec's reference does). Consequence: a level whose evidence is all older than 6 months is never shown, and a fresh chart on a new day drops evidence that aged out.
- **FR-7** **Minimum history.** If fewer than **40** daily bars are available, no levels are drawn and the legend shows `S/R: not enough history` (dim). This covers new listings.
- **FR-8** **Cap.** At most **10** levels are drawn: the highest `score` first, ties broken by distance to C_N (nearer wins). Rank labels (R1…, S1…) are assigned after the cap.
- **FR-9** **Scan grid step δ** is derived from ε instead of the spec's fixed 0.01, so the scan works for a $0.08 coin and a $700,000 share alike: δ = ε / 30 rounded to one significant figure (for the spec's REAL run, ε = 0.31 gives δ = 0.01, so the validation table is unchanged). See design §4.2.

### 3.3 Drawing
- **FR-10** Each level is drawn as three horizontal lines spanning the full chart width, on the main price series:
  - **centre** at ℓ: **solid, fully opaque**, 2 px;
  - **upper edge** at b and **lower edge** at a: same hue at **35 % opacity**, 1 px.
  The reading of the request "upper/lower bands faded, middle not opaque" taken here is: faded edges, opaque centre. If the centre was meant to be the faded one, swap the two alphas in one constant (design §6.1); nothing else changes.
- **FR-11** **Colours.** Support (ℓ < C_N) **pink `#ff69b4`**; resistance (ℓ > C_N) **cyan `#00e5ff`**. These are reserved for S/R and not reused by other indicators (SMA50 `#4fc3f7` and VWAP `#80cbc4` stay as they are).
- **FR-12** **Labels.** The centre line carries the rank (`R1`, `S2`) as its on-line title and shows the price on the right price axis in the level's colour. Edge lines have no title and no axis label.
- **FR-13** When a level's zone is a single price (a = b, e.g. the spec's 13.82 extreme), only the centre line is drawn.
- **FR-14** **Legend row.** While S/R is on and levels exist, the hover legend gains one row:
  `S/R  R 13.82 · 11.94 · 11.22   S 10.70 · 10.09 · 9.17 · 8.57   ε 0.31`
  with the R group in cyan, the S group in pink, ε dim. Hovering a candle whose **close is inside a zone** brightens that level's entry (bold); otherwise the row is static. The row follows the existing `indicatorRows` layout.
- **FR-15** The band type follows C_N as it moves: when the latest daily close crosses a level, the level's colour and rank flip on the next refresh (FR-17). No animation.

### 3.4 Data and refresh
- **FR-16** Levels come from a new server endpoint `GET /api/sr-levels/:symbol` (design §5) that loads daily history through the existing provider chain and runs the algorithm. The widget never computes levels itself and never fetches a second candle series.
- **FR-17** While the toggle is on, the widget refetches levels every **60 s** (same cadence as non-1D candles). When off, nothing is fetched. The server caches results per symbol for **60 s**.
- **FR-18** Works for every symbol the chart supports: stocks, ETFs, indices via the Nasdaq → Yahoo → Stooq chain, crypto via Binance daily klines, VIX via its own path. Crypto trades 7 days a week; the spec's "trading days" are **bar positions**, so g = 10 bars means 10 calendar days for crypto. Accepted.
- **FR-19** **Failure.** If the endpoint fails, the button stays on and the legend shows `S/R unavailable` (dim). Candles and other indicators are unaffected. The error is not surfaced in the widget's red error line, which is reserved for the candle fetch.

## 4. Non-functional requirements
- **NFR-1** Endpoint latency under 50 ms of CPU for 400 daily bars (the scan is O(grid × |W|) with grid ≈ 30 × price range / ε; design §8).
- **NFR-2** No new provider requests beyond one daily-history fetch per symbol per cache window, shared with `/api/history?range=1Y` through the same `cached()` key.
- **NFR-3** No new UI or charting libraries. `lightweight-charts` 5.x `createPriceLine` draws the lines; filled rectangles would need a series primitive and are out of scope (§9).
- **NFR-4** The algorithm is a pure module with vitest coverage, including a fixture that reproduces the spec's REAL table (design §9).
- **NFR-5** Toggling S/R must not move the user's view more than any other indicator toggle does today. After the chart-zoom work lands (view preserved across indicator changes), S/R must preserve it too: price lines are added/removed on the live series, not by rebuilding the chart (design §6.2).

## 5. Out of scope (v1)
- Break / flip / retest states and their styling (spec Step 6, second half).
- Filled zones, partial-width lines (from first touch to the right edge), or dimming by age.
- User-tunable parameters (window length, α, k, q thresholds).
- Alerts when price enters a zone; S/R in other widgets.
- Intraday-derived levels (e.g. 5-minute pivots for the 1D range).

## 6. Acceptance criteria

### 6.1 Automated (vitest, runs in CI)

| # | Given | Expect |
|---|-------|--------|
| A1 | The REAL fixture (daily OHLC through 2026-10-29), W from 2026-08-03 | ε = 0.31 ± 0.01; the seven **kept** levels of the spec table (13.82, 11.94, 11.22, 10.70, 10.09, 9.17, 8.57) within ± 0.02, with the table's n_piv / Q / E; 11.45, 10.37, 9.59 **not** kept |
| A2 | Same fixture, last close 11.31 | 13.82 and 11.94 typed `resistance` (R2, R1); 11.22, 10.70, 10.09, 9.17, 8.57 typed `support` (S1 … S5), because 11.22 < C_N = 11.31. Ranks are nearest-first on each side |
| A3 | Synthetic series: 3 identical highs 5 bars apart with k = 3 | one level, n_piv = 3, zone width 0 |
| A4 | Synthetic series with two clusters 0.9 ε apart and a third 1.1 ε above the first | first two merge in Step 3 (anchored to the first member); the third starts a new group |
| A5 | Synthetic shelf: 7 rejections at one price, all within 8 bars | not kept (E = 1, n_piv = 0); same 7 rejections split 3 + 4 by a 12-bar gap ⇒ kept (E = 2) |
| A6 | 39 daily bars | `levels: []`, `reason: "insufficient_history"` |
| A7 | 400 bars, last bar at t₀ | every rejection day and pivot of every returned level is ≥ t₀ − 183 d (pivots: ≥ t₀ − 183 d − 3 bars) |
| A8 | Prices around 0.08 with ATR 0.004 | δ = 0.00007 (one significant figure of ε/30); grid length < 20 000; levels returned |
| A9 | 25 kept candidates | response has 10, ordered by score desc then distance to C_N |
| A10 | `GET /api/sr-levels/AAPL` with the provider stubbed to return a fixture | 200, JSON shape of design §5; second call within 60 s does not hit the provider |
| A11 | Provider chain fails | `fail()` response, same shape as `/api/history` errors |

### 6.2 Manual (once before merging)
1. Open REAL, 6M, click `S/R`: the bands appear, resistance lines cyan above price, support lines pink below; centre lines solid, edge lines faint. The axis shows the centre prices in colour; `R1`/`S1` sit on the lines nearest price.
2. Hover a candle whose close sits inside the 10.99–11.44 zone: the `11.22` entry in the legend row is bold.
3. Switch range to 1D, then 5Y: the same levels are drawn on both. Switch chart type to LINE: lines remain.
4. Toggle `SMA50` on and off with S/R on: S/R lines remain.
5. Click `S/R` again: all lines and the legend row disappear; no network request for levels afterwards (devtools).
6. Open BTC: levels appear (Binance daily). Open a symbol listed in the last month: `S/R: not enough history`.
7. Block `/api/sr-levels` in devtools and toggle S/R: `S/R unavailable` shows; candles still update.
8. Leave the widget on 1D for 2 minutes: the chart keeps updating and the levels do not flicker (react-query structural sharing keeps the same object when nothing changed).

## 7. Decisions log
| Topic | Decision |
|-------|----------|
| Where to compute | Server endpoint, pure module with vitest. The web workspace has no test runner, and the levels need daily bars regardless of the chart's range. |
| Window | Fixed 6 calendar months (183 days) of daily bars. Not user-tunable in v1. |
| Candle basis | Wick (spec default). |
| Grid step δ | ε / 30, one significant figure (reproduces the spec's 0.01 on REAL). Fixed 0.01 breaks on very low- and very high-priced symbols. |
| Band rendering | Three price lines per level (centre opaque, edges 35 %). No fill: `lightweight-charts` has no fill between price lines; a series primitive is deferred. |
| Colours | Support pink `#ff69b4`, resistance cyan `#00e5ff`. |
| Label | Rank on the line (`R1`, `S2`), price on the axis. Score and counts only in the legend/tooltip, not on the chart. |
| Cap | 10 levels by score. |
| Breaks / flips | Not in v1; the type-by-last-close rule already recolours a broken level once price is through it. |
| Persistence | Same as other indicators today: none. |
| Button label | `S/R`. |

## 8. Open items
- **REAL fixture provenance.** The spec's Oct 29 candle was an intraday snapshot. The fixture captured from Nasdaq on 2026-10-30 (settled bar O 11.17 H 11.79 L 11.12 C 11.35) keeps every spec price inside ± 0.02. Two rejection counts differ by one (11.22 Q 10 vs 11, 10.70 Q 7 vs 6); those counts are what A1 asserts, recorded in `levels.test.ts`.
- **Chart-zoom interplay.** When [`chart-zoom.md`](chart-zoom.md) FR-6 lands (chart no longer rebuilt per indicator change), S/R lines must be managed in their own effect (design §6.2). Whichever feature merges second does the adaptation.
- **Defaults on more tickers.** The spec itself says one ticker is not a validation set; keep the parameter table in one constant so a later tuning PR is a one-line change.
