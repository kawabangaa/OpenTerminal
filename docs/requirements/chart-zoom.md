# Chart Widget Zoom & Navigation — Requirements

| | |
|---|---|
| **Status** | Draft for review |
| **Last updated** | 2026-10-24 |
| **Repo** | Developed in the owner's fork (`kawabangaa/OpenTerminal`); no upstream issue. Git rules in [`docs/design/unusual-volume-tasks.md`](../design/unusual-volume-tasks.md), "Repository & git workflow". |
| **Design** | _to be written_ (`docs/design/chart-zoom.md`) |
| **Widget** | `web/components/widgets/ChartWidget.tsx` |

## 1. Goal

Let the user **zoom and pan the chart freely**, the way the stock chart on
investing.com does: scroll to zoom, drag to pan, pick a bar interval, jump back
to the latest bar, and reset. Today the widget only offers eight range presets;
the view is locked to "fit everything", and any zoom the user manages to make
by dragging the time axis is wiped out on the next data refresh.

## 2. Current behaviour (what we are fixing)

Findings from reading the widget and the history route:

| # | Observation | Consequence for the user |
|---|-------------|--------------------------|
| C1 | Mouse-wheel scroll and wheel-scale are **disabled** on purpose, to keep the page scrolling. Pinch and time-axis drag are enabled. | No obvious way to zoom; the only discoverable control is the range preset row. |
| C2 | The chart is **recreated** on every change of candles, chart type, indicators or range, and ends with `fitContent()`. Candles refetch every 8 s (1D) or 60 s (all other ranges). | Any zoom or pan made by dragging the axis is **reset within a minute**, within 8 s on 1D. |
| C3 | The bar interval is bound to the range preset and chosen **server-side** (1D → 5 min, 5D → 15 min, 1M → 1 h, 6M/YTD/1Y → 1 day, 5Y → 1 week, MAX → 1 month). The Nasdaq provider, first in the fallback chain, returns **daily bars for every range**, so 1D/5D/1M are intraday only when Nasdaq fails and Yahoo serves. Crypto goes through Binance with its own table (6M = 4 h bars). | The user cannot look at, say, 6 months of 1 h bars, or 5 days of 5 min bars. Zooming into a 6M chart can never show more detail than one bar per day. |
| C4 | Range presets fetch **only** the window they name. | Panning left past the first bar shows empty space; there is no way to load older history without switching preset, which also changes the interval. |
| C5 | No zoom buttons, no "latest" button, no reset, no keyboard shortcuts. | — |
| C6 | Crosshair legend works on hover but there is no indication of the visible window (from–to dates, bar count). | — |

## 3. Reference behaviour (investing.com stock chart)

The target is the interaction model of the investing.com stock chart (the
TradingView-engine "streaming"/advanced chart on a stock page), reduced to the
pieces that fit a terminal widget. We did not find a help page from
investing.com describing the controls, so the list below is written from use
of the chart and is the **behaviour we commit to**, not a claim about their
implementation. §10 tracks the one open check.

| Control | investing.com behaviour | Our requirement |
|---------|-------------------------|-----------------|
| Mouse wheel over the chart | Zooms the time axis around the cursor. | FR-1 |
| Click-drag on the chart | Pans in time (and price when the price scale is unlocked). | FR-4 |
| Drag on the time axis | Stretches/compresses the time scale. | Already works; keep. |
| Drag on the price axis | Stretches/compresses the price scale; double-click resets it to auto. | FR-5 |
| Pinch on touch devices | Zooms. | Already works; keep. |
| **+ / −** buttons (bottom of chart) | Step zoom in/out around the right edge of the visible window. | FR-2 |
| **Interval** selector (1, 5, 15, 30, 1H, 5H, 1D, 1W, 1M) | Changes the bar size without changing where you are looking. | FR-7, FR-8 |
| Range presets (1D … MAX) | Set both the visible window and a sensible interval. | FR-9 |
| **→** "go to latest" button | Scrolls the window so the last bar is visible, keeping the zoom level. | FR-3 |
| Reset (double-click time axis / reset button) | Returns to the preset's default view. | FR-3 |
| Scrolling to the left edge | Loads older history on demand. | FR-10 |
| Streaming updates | New bars append without moving the user's view. | FR-6 |

## 4. Functional requirements

### 4.1 Zooming and panning
- **FR-1** **Wheel zoom.** Scrolling the mouse wheel while the pointer is over the chart canvas zooms the time axis around the pointer. Wheel scroll over the toolbar, the legend, or anywhere outside the canvas keeps scrolling the page. Decision: the reason for disabling wheel zoom (page scroll) is addressed by scoping, not by keeping it off. The dashboard scrolls only when the pointer is outside a chart canvas.
  - **FR-1a** Holding **Shift** while scrolling pans in time instead of zooming (trackpad users get horizontal two-finger pan natively).
  - **FR-1b** Zoom limits: never fewer than **5 bars** visible, never more than the loaded bar count plus a right-side margin of 10 bars.
- **FR-2** **Zoom buttons.** A `+` and a `−` button, bottom-right over the canvas, zoom in/out by **25 %** per click, anchored at the right edge of the visible window. They are keyboard-reachable and have `aria-label`s. Keyboard: `+`/`=` and `-` zoom while the widget is focused (mouse over or last clicked).
- **FR-3** **Latest and reset.**
  - A `→|` button scrolls so the last bar is at the right edge, **keeping the current zoom level** (bars per screen). Shown only when the last bar is off-screen, like a "you have scrolled away" cue.
  - A `⟲` **Reset** button (and double-click on the time axis) restores the preset's default view: all bars of the fetched window, auto price scale. Keyboard: `Home` = reset, `End` = latest.
- **FR-4** **Drag to pan.** Click-drag on the canvas pans in time. Vertical drag pans price only when the price scale has been manually scaled (FR-5); otherwise price stays on auto-scale and vertical drag does nothing, which is the common expectation.
- **FR-5** **Price-axis scaling.** Dragging the price axis stretches the price scale and switches it to manual; double-clicking the price axis returns it to auto-scale. A small `A` marker on the axis shows auto mode, matching the reference chart.

### 4.2 View stability
- **FR-6** **Zoom survives refreshes.** When candles refetch (8 s / 60 s), when a new bar arrives, or when the user toggles an indicator or the chart type, the visible window (logical range) and the price-scale mode are **preserved**. Exception: if the user has the last bar in view (within 2 bars of the right edge), the window follows new bars so the chart keeps "streaming" to the right.
  - This means the chart must **not** be torn down and recreated for data and indicator changes; series get `setData`/`update` instead. Only a symbol change creates a fresh chart.
- **FR-6a** Switching **symbol** resets to the preset default view (FR-3 reset). The preset and interval are kept.

### 4.3 Intervals and ranges
- **FR-7** **Interval selector.** A new control with **1m, 5m, 15m, 30m, 1h, 4h, 1D, 1W, 1M**. It is independent of the range preset. Intervals are only offered where a provider can serve them (see §6); unavailable ones are disabled with a tooltip `not available for this symbol`.
- **FR-8** **Interval change keeps position.** Changing the interval re-fetches at the new bar size and re-centres the view on the **same point in time** that was at the centre before, with the same time span on screen (so 6 months of daily bars become 6 months of 1 h bars, scrolled to the same place). If that span would exceed the zoom limits of FR-1b, clamp to the nearest allowed.
- **FR-9** **Range presets stay** (1D, 5D, 1M, 6M, YTD, 1Y, 5Y, MAX) and now mean "set the visible window **and** the default interval for that window":

  | Preset | Default interval | Fetch window |
  |--------|------------------|--------------|
  | 1D | 5m | today's session (+ previous session for context) |
  | 5D | 15m | 5 sessions |
  | 1M | 1h | 1 month |
  | 6M | 1D | 6 months |
  | YTD | 1D | year to date |
  | 1Y | 1D | 1 year |
  | 5Y | 1W | 5 years |
  | MAX | 1M | all |

  Choosing a preset also resets the view (FR-3). After that the user may change the interval (FR-7) without the preset changing. The active preset button is highlighted only while the visible window and interval still match it; otherwise no preset is highlighted.
- **FR-10** **Load more on scroll-left.** When the user pans or zooms so that fewer than **50 bars** remain to the left of the visible window, the widget fetches an older page at the same interval and prepends it, without moving the view. A thin loading bar at the left edge shows the fetch. Hard caps: the provider's limit for that interval (§6), and a per-symbol-interval budget of 20 pages per session. When the provider has no older data, the left edge is marked `no more data` and further requests stop.

### 4.4 Feedback and discoverability
- **FR-11** **Visible-window readout.** The legend row gains a dim line `12 Mar 2026 – 24 Oct 2026 · 158 bars · 1D`, updated as the window changes. On 1D/5D intraday it shows times (`09:30 – 15:55 ET`).
- **FR-12** **Hint on first use.** A one-line dim hint in the legend area, `scroll to zoom · drag to pan · dbl-click axis to reset`, shown until the user performs a zoom once. Dismissal is stored in `localStorage` per browser.
- **FR-13** **Cursor.** `grab` while hovering the canvas, `grabbing` while dragging, `ew-resize` on the time axis, `ns-resize` on the price axis.

### 4.5 Persistence
- **FR-14** Per-widget: **interval and range preset** are saved in the widget instance in the zustand store, next to `symbol` (new optional fields `chartRange`, `chartInterval`). They survive reloads with the rest of the persisted layout. Rationale: unlike screener filters (unusual-volume FR-15), a chart's interval is a long-lived preference and the store already persists per-widget symbol.
- **FR-15** **Zoom level and scroll position are not persisted** across reloads. On load the widget opens at the preset default view. (Persisting a logical range across data changes is fragile; the reference chart does persist it, but the cost/benefit is poor for v1.)

## 5. Non-functional requirements
- **NFR-1** Interaction latency: wheel zoom and drag render at the chart library's native frame rate; no React re-render per wheel event. The visible-window readout (FR-11) may throttle to 10 updates/s.
- **NFR-2** No extra provider requests for zooming or panning within loaded data. Only FR-8 (interval change) and FR-10 (load older) fetch.
- **NFR-3** Load-older pages (FR-10) go through the existing `cached()` layer with the same TTL as `/api/history`, keyed by symbol, interval and page, so re-panning the same region never refetches within the TTL.
- **NFR-4** Free data only; no new provider accounts. Intervals not served by any free provider are disabled (FR-7), not emulated.
- **NFR-5** Works with keyboard only (FR-2, FR-3) and with touch (pinch, drag).
- **NFR-6** No new UI libraries. `lightweight-charts` 5.x already provides wheel/pinch/axis scaling, `setVisibleLogicalRange`, `subscribeVisibleLogicalRangeChange`, `scrollToRealTime`, `fitContent` and `update()`.

## 6. Data approach

The request path today is `GET /api/history/:symbol?range=<preset>`; the server maps the preset to a provider window and interval. Zoom needs the interval to be a first-class parameter, decoupled from the window.

### 6.1 API change
- **`GET /api/history/:symbol?interval=<1m|5m|15m|30m|1h|4h|1d|1w|1mo>&from=<unix>&to=<unix>`**
  - `range=<preset>` keeps working and is translated to the FR-9 defaults, so nothing else in the app changes.
  - Response: the existing `Candle[]`, sorted ascending, plus the header `X-History-Complete: true|false` (`false` when the provider truncated at its own limit, so the widget knows older pages may exist).
- The widget's query key becomes `["history", symbol, interval, from, to]`; pages for FR-10 are separate queries merged client-side.

### 6.2 Provider capability (per interval)

| Interval | Stocks (Nasdaq → Yahoo → Stooq) | Crypto (Binance) | Notes |
|----------|----------------------------------|------------------|-------|
| 1m | Yahoo only, last 7 days | Binance, 1000 bars/page | Nasdaq chart API is daily-only; Stooq daily-only |
| 5m, 15m, 30m | Yahoo only, last 60 days | Binance | Same |
| 1h | Yahoo only, last 730 days | Binance | Same |
| 4h | — (disabled for stocks) | Binance | Yahoo has no 4h; building it from 1h is out of scope for v1 |
| 1D | Nasdaq (any window) → Yahoo → Stooq | Binance | Unchanged |
| 1W, 1M | Nasdaq daily, aggregated server-side → Yahoo native `1wk`/`1mo` | Binance `1w`/`1M` | Aggregation keeps the Nasdaq-first order |

Consequence: for stocks, intraday intervals depend on Yahoo. When Yahoo fails, the interval buttons for 1m–1h are disabled for that symbol (FR-7) and the widget falls back to 1D with a toast-free inline note `intraday unavailable, showing 1D`.

### 6.3 Window limits per interval
Yahoo's hard windows (7 d for 1m, 60 d for ≤ 30m, 730 d for 1h) are the FR-10 "no more data" boundary for stocks. The server returns `X-History-Complete: true` once a page reaches that boundary.

### 6.4 Weekly/monthly aggregation
Aggregate daily bars into ISO weeks (Mon–Fri) and calendar months on the server: open = first open, high = max, low = min, close = last close, volume = sum, time = first bar's time. Unit-tested.

## 7. Engineering conventions (follow the repository's norms)

### 7.1 Server
- Keep `marketRouter.get("/history/:symbol")`; extend its query parsing in the `/screener` style and keep `fail(req, res, err)`, `cached()` and `withFallback` as they are.
- Put interval tables and the aggregation in a pure module (`server/src/history/intervals.ts`, `server/src/history/aggregate.ts`), separate from I/O.
- The provider capability table in §6.2 is a typed constant with a test, like `EUROPE_MARKETS`.
- ESM imports with `.js` suffixes; types exported next to functions.

### 7.2 Web
- `ChartWidget.tsx` keeps `"use client"`, `useQuery` + `apiGet`, `term-btn`, and the CSS variables. The new buttons use `term-btn`; no icon library.
- Split the chart lifecycle: one effect creates the chart per symbol; separate effects apply data, chart type and indicators with `setData`/`update`, preserving the logical range (FR-6). Store the logical range in a `useRef`, not React state, to meet NFR-1.
- Symbols go through `web/lib/symbol` as everywhere else.
- Store fields `chartRange` / `chartInterval` are added to `WidgetInstance` with a persisted-state migration default (no field = `6M` / `1D`).

### 7.3 Tests
- vitest on the server: interval table, preset→interval mapping, aggregation, `from/to` parsing, complete-flag, provider fallback per interval. `fetch` stubbed with `vi.stubGlobal`, restored in `afterEach`; small inline fixtures.
- The web workspace has no test runner, so the pure "keep position on interval change" math (FR-8: centre time + span → new logical range) lives in a tiny helper `web/lib/chartView.ts` that is also imported by a server-side test, as the unusual-volume work did for its pure logic.
- CI: `npm run test -w server`, `npm run build -w server`, `npm run build -w web`, `npm run lint`.

### 7.4 Docs
- Conventional commits: `feat(chart): …`, `fix(chart): …`.
- When shipped: update the README "Professional charting" bullet (zoom, pan, intervals), replace `docs/screenshots/chart.png`, tick "chart zoom" in the roadmap if listed.

## 8. Acceptance criteria

### 8.1 Automated (vitest, runs in CI)

| # | Given | Expect |
|---|-------|--------|
| A1 | `?range=6M` | Translated to `interval=1d`, 6-month window; response identical to today's |
| A2 | `?interval=5m&from&to` for a stock, Yahoo returns bars | Yahoo used; Nasdaq not called |
| A3 | `?interval=5m` for a stock, Yahoo fails | 503-style `fail()`; no silent fallback to daily bars |
| A4 | `?interval=1w` for a stock | Nasdaq daily bars aggregated into weekly; `open/high/low/close/volume` match the rule in §6.4 |
| A5 | `?interval=4h` for a stock | 400 "interval not available"; for a crypto symbol the Binance 4h path is used |
| A6 | A Yahoo 1m request whose `from` is older than 7 days | `from` clamped; `X-History-Complete: true` |
| A7 | Pure helper: centre `t`, span `S`, old interval 1D, new interval 1h | Returned logical range covers `[t−S/2, t+S/2]` at the new bar size, clamped to FR-1b |
| A8 | Provider capability constant | Every interval in FR-7 has an entry for both asset classes; no `undefined` |

### 8.2 Manual (once before merging)
1. Open AAPL, 6M. Scroll the wheel over the canvas: the chart zooms around the pointer; the page does not scroll. Scroll over the toolbar: the page scrolls.
2. Zoom into ~20 bars, wait 70 s (two refetches). The window has not moved.
3. Switch SMA50 on and off, switch candles → line. The window has not moved.
4. Drag left until the first bar passes the middle of the screen: older bars load and the view does not jump; readout updates. Keep going on 1Y daily until `no more data` appears (Stooq/Nasdaq end).
5. Press `−` three times, then `→|`: the last bar is at the right edge and bars-per-screen is unchanged.
6. On 6M/1D, select interval 1h: the same dates stay centred, bars are hourly. Select 1D again: the view returns to daily at the same place. No preset is highlighted until 6M is clicked, which resets the view.
7. Drag the price axis; the `A` marker goes off. Double-click the axis; it returns to auto.
8. Open BTC (crypto), 6M: the interval row shows 4h enabled; choose it and scroll.
9. Open a symbol for which Yahoo fails (or block the host): 1m–1h are disabled with the tooltip; the chart shows 1D with the inline note.
10. Reload the page: the widget reopens on its saved preset and interval, at the default view.
11. Keyboard only: focus the widget, press `-`, `+`, `End`, `Home`; each works.
12. Touch (devtools device mode): pinch zooms, one-finger drag pans.

## 9. Decisions log
| Topic | Decision |
|-------|----------|
| Wheel zoom vs. page scroll | Wheel zooms **only** over the canvas; page scrolls elsewhere. The earlier blanket disable is reverted. |
| Chart lifecycle | Chart created once per symbol; data/indicator changes update series in place so zoom survives (FR-6). |
| Interval control | Separate from presets; presets set a default interval and reset the view (FR-9). |
| Interval set | 1m, 5m, 15m, 30m, 1h, 4h, 1D, 1W, 1M. No 2h/3h/5h (investing.com's 5H is not served by any free provider we use). |
| Intraday stocks | Yahoo only; disabled when Yahoo fails. No synthetic bars. |
| Weekly/monthly for stocks | Aggregated server-side from daily, Nasdaq first. |
| Older history | Loaded on scroll-left, paged, capped by provider windows and a 20-page budget. |
| Persistence | Preset + interval per widget in the store; zoom/scroll position not persisted. |
| Box-zoom (drag a rectangle) | **Not** in v1. The reference chart does not offer it by default either. |
| Drawing tools, comparison overlay | Out of scope; remain on the README roadmap. |

## 10. Open items
- **Reference check:** confirm against a live investing.com stock page that the control set in §3 is what is wanted (in particular the `+/−` buttons, the "go to latest" arrow and the interval list). The behaviour is specified from use, not from a published help page.
- **4h for stocks:** build from 1h bars in v1.1 if users ask.
- **Sessions on 1D preset:** whether to include the previous session for context (table in FR-9) depends on how Yahoo's `1d` window behaves pre-market; verify during implementation.
