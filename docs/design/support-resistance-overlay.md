# Chart Widget Support / Resistance Overlay — Technical Design

| | |
|---|---|
| **Status** | Draft for review |
| **Last updated** | 2026-10-30 |
| **Requirements** | [`docs/requirements/support-resistance-overlay.md`](../requirements/support-resistance-overlay.md) |
| **Algorithm** | [`docs/requirements/support_resistance_spec.md`](../requirements/support_resistance_spec.md) |
| **Tasks** | [`docs/design/support-resistance-tasks.md`](support-resistance-tasks.md) |
| **Repo** | Fork **`kawabangaa/OpenTerminal`** (`origin`). `upstream` is fetch-only; never push or open PRs there. Rules in [`unusual-volume-tasks.md`](unusual-volume-tasks.md), "Repository & git workflow". |

Requirement IDs (FR-n, NFR-n, A-n) refer to the requirements document. Step
numbers refer to the algorithm spec.

## 1. Overview

```
ChartWidget.tsx ── click S/R ──► useQuery(["sr-levels", symbol], enabled: on, refetch 60 s)
                                        │
                                        ▼
                     GET /api/sr-levels/:symbol          routes/market.ts
                                        │  cached("sr:SYM", 60 s)
                                        ▼
                     fetchHistory(symbol, "1Y")           shared with /history (cached 20 s)
                                        │  daily Candle[] (Nasdaq → Yahoo → Stooq | Binance | VIX)
                                        ▼
                     srLevels(candles, SR_DEFAULTS)       server/src/sr/levels.ts  (pure)
                                        │  SrResult
                                        ▼
                     widget: 3 × createPriceLine per level on the main series
                             + one legend row
```

The algorithm is a straight port of the spec's Python reference, kept pure
and tested against a REAL fixture. The widget only draws.

## 2. Files

### 2.1 Server — new

| File | Responsibility |
|------|----------------|
| `server/src/sr/levels.ts` | `srLevels(candles, opts)`: Steps 1–5, type rule of Step 6, age window, cap, ranks. Pure. Exports `SR_DEFAULTS`, `SrOptions`, `SrLevel`, `SrResult`. |
| `server/src/sr/levels.test.ts` | A1–A9 (§9). |
| `server/src/sr/fixtures/real-2026.json` | Daily `Candle[]` for REAL, ~1 year to 2026-10-29, captured once from the history route (§9.1). |

### 2.2 Server — changed

| File | Change |
|------|--------|
| `server/src/routes/market.ts` | Extract the provider chain of `GET /history/:symbol` into `fetchHistory(symbol, rangeKey)` (same `cached()` key `history:${symbol}:${rangeKey}`, same TTL). `/history` and the new `GET /sr-levels/:symbol` both call it; `/earnings-history` may switch to it in the same PR since it duplicates the chain today. Add the route (§5). |
| `server/src/routes/market.test.ts` | A10, A11 next to the existing history tests. |

### 2.3 Web — changed

| File | Change |
|------|--------|
| `web/lib/api.ts` | `SrLevel`, `SrResult` types (mirror of §5; hand-copied like `Candle`). |
| `web/components/widgets/ChartWidget.tsx` | `S/R` button, levels query, price lines, legend row (§6). |
| `README.md` | "Professional charting" bullet mentions support/resistance bands; new screenshot `docs/screenshots/chart-sr.png`. |

No new dependencies, no store changes, no DB changes.

## 3. Types (server, `sr/levels.ts`)

```ts
export type SrOptions = {
  atrLength: number;     // n   = 14
  alpha: number;         // α   = 0.5
  pivotHalfWindow: number; // k = 3
  qScan: number;         // 4
  qKeep: number;         // 6
  episodeGap: number;    // g   = 10 (bars)
  beta: number;          // 2
  windowDays: number;    // 183 calendar days (FR-6)
  minBars: number;       // 40 (FR-7)
  maxLevels: number;     // 10 (FR-8)
};
export const SR_DEFAULTS: SrOptions = { atrLength: 14, alpha: 0.5, pivotHalfWindow: 3, qScan: 4, qKeep: 6, episodeGap: 10, beta: 2, windowDays: 183, minBars: 40, maxLevels: 10 };

export type SrLevel = {
  price: number;               // ℓ, 2 dp for ≥ 1, else 4 significant figures (see §4.4)
  zone: [number, number];      // [a, b]
  type: "support" | "resistance";
  rank: number;                // 1 = nearest to lastClose on its side
  label: string;               // "R1" | "S3"
  nPiv: number;
  q: number;                   // Q(ℓ) after the Step-5 re-count
  episodes: number;            // E(ℓ)
  score: number;               // nPiv + q + beta * (episodes - 1)
  extreme: boolean;            // kept by the window-extreme rule
  firstTouch: number;          // unix s of the earliest pivot/rejection bar
  lastTouch: number;           // unix s of the latest one
};

export type SrResult = {
  symbol: string;
  asOf: number;        // time of the last daily bar used (C_N's bar)
  windowStart: number; // time of W's first bar
  lastClose: number;
  eps: number;
  step: number;        // δ actually used
  bars: number;        // daily bars received
  levels: SrLevel[];   // sorted by price descending
  reason: "insufficient_history" | null;
};
```

`SrLevel` carries the diagnostics (`nPiv`, `q`, `episodes`, `score`,
`firstTouch`, `lastTouch`) even though v1 only draws `price`, `zone`, `type`,
`label`. They cost nothing, make A1 assertable through the API, and are what a
later "age-dimmed" or "partial-width" rendering needs.

## 4. Algorithm port (`srLevels`)

Inputs: `candles` ascending by `time`, as returned by the history route (unix
seconds). Each step below names the spec step it implements and any deviation.

### 4.1 Window and warm-up
1. `N = candles.length`. If `N < minBars` → `{ levels: [], reason: "insufficient_history", … }`.
2. `asOf = candles[N-1].time`; `W = indices with time ≥ asOf − windowDays·86400`. `windowStart = candles[W[0]].time`.
3. If `W.length < minBars` the same empty result is returned (a symbol with 300 bars but a 2-month gap at the end is not worth guessing at).

### 4.2 Step 1 — ε and δ
- `TR_t` and `ATR` exactly as the spec, simple mean of the last `atrLength` true ranges, `eps = alpha · ATR`.
- `step = roundToOneSignificantFigure(eps / 30)` (FR-9). `roundToOneSignificantFigure(x) = Number(x.toPrecision(1))`. Examples: 0.31 → 0.0103 → **0.01**; ε = 2.4 → 0.08; ε = 5000 → 200; ε = 0.004 → 0.0001.
- If `eps === 0` (flat series, e.g. a halted stock): empty result with `reason: null` and `eps: 0`. The widget shows nothing.

### 4.3 Steps 2–5 — as the reference
Port the Python function line for line, with these notes:
- **Pivots** scan `t ∈ [max(0, W[0] − k), N − k)`; the window used for the max/min is clamped at index 0 like the reference.
- **Step 3 clustering** anchors to the first member of the group (`p − G[0] > eps` starts a new group). Zone = `[min G, max G]`, price = median.
- **Step 4 scan** grid is `l[W].min − eps … h[W].max + eps` by `step`. Use typed arrays and one pass per grid point over `W` (§8). Plateau and "used" marking as the reference. Candidate zone `[x − eps/2, x + eps/2]`, `nPiv = 0`.
- **Step 5 merge** anchors to the merged level's first member at distance `eps/2`; price = mean of members, zone = union, `nPiv` = sum. Re-count `Q(ℓ)` with `rejDays(ℓ)`, episodes split on gaps `> episodeGap` **in bar positions** (`W` indices), not calendar days.
- **Keep rule** exactly as the spec (nPiv ≥ 2, or Q ≥ qKeep ∧ E ≥ 2, or within eps/2 of the window's highest high / lowest low; `extreme` records the last).
- **Touch times**: for each kept level, collect the bar indices of its member pivots (track them alongside the prices in Step 2/3; a pivot carries `{price, idx}`) and its rejection days; `firstTouch` / `lastTouch` are the min / max of those bars' times. Scan-only levels have rejection days only.

### 4.4 Step 6 — type, cap, rank, rounding
1. `type = price > lastClose ? "resistance" : "support"` (a level exactly at `lastClose` is support, matching the reference's `else`).
2. **Cap** (FR-8): sort by `score` desc, then `|price − lastClose|` asc; keep `maxLevels`.
3. **Rank**: among the kept levels, resistances sorted by price asc get `rank 1…`, supports sorted by price desc get `rank 1…`; `label = (type === "resistance" ? "R" : "S") + rank`.
4. **Rounding**: `price` and `zone` are rounded to 2 dp when `lastClose ≥ 1`, otherwise to 4 significant figures (crypto). The comparisons above use unrounded values.
5. Output sorted by `price` desc.

## 5. API (`routes/market.ts`)

```
GET /api/sr-levels/:symbol
```
- Symbol upper-cased like `/history`. No query parameters in v1 (window and parameters are fixed; FR-6, §7).
- Body: `SrResult` (§3).
- `cached(\`sr:${symbol}\`, 60_000, …)` wraps `fetchHistory(symbol, "1Y")` + `srLevels`. The inner history call is itself cached 20 s under `history:${symbol}:1Y`, so a chart on the 1Y range and the S/R endpoint share one provider fetch (NFR-2).
- Why `1Y` and not `6M`: W needs 183 days **plus** warm-up (14 TRs, 3 pivot bars), and Nasdaq's `6M` mapping is 190 calendar days. `1Y` (400 days Nasdaq / 365 bars Binance / Yahoo `1y 1d`) is the first preset that always covers W with warm-up, every provider returns it as daily bars, and it is already cached for charts on 1Y.
- Errors: provider failure or empty history → `fail(req, res, err)`, the same shape as `/history` (A11). `insufficient_history` is **not** an error: 200 with empty `levels` and the `reason` field (A6), so the widget can distinguish "nothing to show" from "could not compute".
- Rate limit: the route lives on `marketRouter`, so the existing per-IP limiter applies.

`fetchHistory(symbol, rangeKey): Promise<Candle[]>` is the body of today's
`/history` handler (`binance` | `vixHistory` | `withFallback([...])` under
`cached`), including the `empty history from all providers` throw. The route
handler shrinks to `res.json(await fetchHistory(...))` inside its try/catch.

## 6. Widget (`ChartWidget.tsx`)

### 6.1 Constants
```ts
const SR_COLOR = { support: "#ff69b4", resistance: "#00e5ff" } as const;
const SR_EDGE_ALPHA = 0.35;   // FR-10; swap with 1 if the centre was meant to be the faded one
const SR_CENTER_ALPHA = 1;
```
`withAlpha(hex, a)` is a 4-line helper in the widget (hex → `rgba()`); no colour library.

### 6.2 State, query, lifecycle
- `"SR"` is appended to the `INDICATORS` tuple so the button renders through the existing `INDICATORS.map` with label text `S/R` (a `LABEL` map, or render `ind === "SR" ? "S/R" : ind`). `toggleIndicator("SR")` works unchanged.
- Query:
  ```ts
  const srOn = active.has("SR");
  const { data: sr, isError: srError } = useQuery({
    queryKey: ["sr-levels", symbol],
    queryFn: () => apiGet<SrResult>(`/api/sr-levels/${encodeURIComponent(symbol)}`),
    enabled: srOn,
    refetchInterval: 60_000,
  });
  ```
  react-query's structural sharing returns the same object when the payload is unchanged, so a refetch with identical levels does not re-run the effect below.
- **Drawing, today's lifecycle.** The chart effect currently rebuilds the chart on `[candles, chartType, indicatorData, range, byTime]`. Add `srOn ? sr : null` to that list and, inside the effect after the main series is created, call `drawSrLevels(mainSeries, sr.levels)`. Lines die with the chart on cleanup. This is the smallest change and matches how every other indicator is drawn.
- **Drawing after chart-zoom.** chart-zoom FR-6 keeps one chart per symbol and updates series in place. Then `drawSrLevels` moves to its own effect keyed on `[sr, srOn]`, holding the created `IPriceLine[]` in a `useRef` and removing them with `series.removePriceLine` on cleanup. `drawSrLevels` is written as a standalone function `(series, levels) => IPriceLine[]` from the start so this move is mechanical. Whichever feature merges second does it (requirements §8).

### 6.3 `drawSrLevels`
For each level, on the main (candle / bar / line / area) series:
```ts
const color = SR_COLOR[level.type];
lines.push(series.createPriceLine({
  price: level.price, color: withAlpha(color, SR_CENTER_ALPHA), lineWidth: 2,
  lineStyle: LineStyle.Solid, axisLabelVisible: true, title: level.label,
}));
if (level.zone[0] !== level.zone[1]) {           // FR-13
  for (const p of level.zone) lines.push(series.createPriceLine({
    price: p, color: withAlpha(color, SR_EDGE_ALPHA), lineWidth: 1,
    lineStyle: LineStyle.Solid, axisLabelVisible: false, title: "",
  }));
}
```
`createPriceLine` draws across the full pane width and puts a coloured label on
the right axis, which is what FR-10/FR-12 ask for. Price lines are not part of
the series' autoscale, so a far level (the 13.82 spike on a chart zoomed to
10–12) is simply off-screen rather than squashing the candles.

### 6.4 Legend row (FR-14)
Extend `indicatorRows` (or add a sibling `srRow`) when `srOn`:
- `sr?.reason === "insufficient_history"` → single dim item `S/R: not enough history`.
- `srError` → dim `S/R unavailable` (FR-19).
- Otherwise: `R` group (resistances, price desc) in cyan, `S` group (supports, price desc) in pink, then `ε {fmt(sr.eps)}` dim. The entry whose zone contains `legend.close` (the hovered candle) gets `font-bold`.
Prices use `fmt` like the other rows.

## 7. Parameters

All in `SR_DEFAULTS` (§3), one place. v1 exposes none of them through the API
or UI (requirements decisions log). A tuning PR after checking more tickers
changes the constant and the fixture expectations only.

## 8. Performance (NFR-1)

Scan cost = grid points × |W|. Grid points ≈ (h.max − l.min + 2ε) / step with
step = ε / 30, so ≈ 30 × (window range / ε). A stock whose 6-month range is
40 ATRs (ε = 0.5 ATR → 80 ε) gives ≈ 2 400 points × 126 bars ≈ 300 k
comparisons; a 200-ATR mover gives ≈ 1.5 M. Both are well under 10 ms in V8
with typed arrays. The plateau walk and merge are linear. Pathological
inputs (tiny ATR after a long flat period, then a huge move) are bounded by
clamping the grid to **200 000 points**; above that, `step` is raised to
`(range / 200000).toPrecision(1)` and `SrResult.step` reports it.

## 9. Testing plan

### 9.1 REAL fixture (A1, A2)
- Capture `GET /api/history/REAL?range=1Y` once on or after 2026-10-30 from a
  running server (Nasdaq first in the chain) and save the array as
  `server/src/sr/fixtures/real-2026.json`, **truncated after the 2026-10-29 bar**
  so later bars never shift the result.
- Test calls `srLevels(fixture, { ...SR_DEFAULTS, windowDays: <days such that W starts 2026-08-03> })` — simpler: the test computes `windowDays` from the fixture's last bar and `2026-08-03` so W is exactly the spec's, then asserts the spec table (kept levels ± 0.02, counts exact, dropped levels absent) and `eps` ± 0.01.
- If the captured final Oct 29 bar moves a level beyond the tolerance, re-baseline with sign-off (requirements §8), recording the new numbers in the test's comment.
- Captured 2026-10-30 from Nasdaq (the history route's first provider). The settled Oct 29 bar is O 11.17 / H 11.79 / L 11.12 / C 11.35. Every spec price is unchanged (± 0.00, inside ± 0.02). Two rejection counts differ by one from the intraday snapshot the spec tabulated: 11.22 has Q 10 (spec 11) and 10.70 has Q 7 (spec 6). ε = 0.306. Ranks are unchanged because 11.35 is still between 11.22 and 11.94.

### 9.2 Synthetic unit tests (A3–A9)
Small hand-built candle arrays (≤ 60 bars) in the test file, one per step:
pivot confirmation and the `t + k ≤ N` edge, anchored clustering, scan
plateau centring, merge at ε/2, episode splitting, keep rule each branch,
extreme rule, age window, cap and rank order, δ derivation, `insufficient_history`,
`eps === 0`.

### 9.3 Route tests (A10, A11)
In `market.test.ts`, `vi.stubGlobal("fetch", …)` as the existing history tests
do, restored in `afterEach`: one happy path asserting shape and that a second
call within the TTL makes no further `fetch`; one all-providers-fail path
asserting the `fail()` shape.

### 9.4 CI
`npm run test -w server`, `npm run build -w server`, `npm run build -w web`,
`npm run lint`. Nothing new.

## 10. Work breakdown (PR sequence)

| # | PR | Contents |
|---|----|----------|
| 1 | `feat(sr): pure support/resistance level detection` | `sr/levels.ts`, synthetic tests, REAL fixture + A1/A2. No route yet. |
| 2 | `feat(market): /api/sr-levels endpoint` | `fetchHistory` extraction, route, route tests, `web/lib/api.ts` types. |
| 3 | `feat(chart): S/R bands toggle` | Button, query, `drawSrLevels`, legend row, README bullet, screenshot. Manual checklist in the PR description. |

Each PR is independently mergeable; 2 depends on 1, 3 on 2. Branch names
`feat/sr-levels`, `feat/sr-endpoint`, `feat/chart-sr-overlay`, all pushed to
`origin` with `gh pr create --repo kawabangaa/OpenTerminal`.

## 11. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Nasdaq returns today's partial bar during the session, so `lastClose` and ATR drift intraday and a level near price flips colour during the day. | Accepted (FR-15). The 60 s cadence bounds the flicker; ε moves by at most one TR/14. |
| Many lines on a dense chart (10 levels × 3 lines). | Cap at 10; edges at 35 % so centres dominate. If still busy, the first tuning knob is `maxLevels`. |
| Price lines ignore the visible time range: a level is drawn across history where it did not yet exist (5Y chart). | Accepted for v1 and listed out of scope; a series primitive can draw from `firstTouch` later. |
| Chart-zoom merges first and changes the chart lifecycle. | `drawSrLevels` is lifecycle-agnostic (§6.2); the adaptation is a 15-line effect. |
| REAL fixture does not reproduce the spec exactly because of the Oct 29 snapshot. | §9.1 tolerance and re-baseline rule. |

## 12. Deviations from the spec

| Spec | Here | Why |
|------|------|-----|
| δ = 0.01 fixed | δ = ε/30 to one significant figure | Works across price scales; identical on REAL. |
| Grid unbounded | Grid capped at 200 000 points | Bound CPU on pathological inputs. |
| Output unordered, no cap | Score-ranked cap of 10, R/S ranks | Chart readability. |
| Step 6 breaks / flips / retests | Type rule only | Spec marks the rest "definition only, not run on REAL". |
| Trading-day gaps | Bar-position gaps | Same for stocks; 7-day bars for crypto, accepted. |
