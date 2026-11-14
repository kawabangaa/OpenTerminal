import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Candle } from "../providers/yahoo.js";
import { SR_DEFAULTS, srLevels, type SrOptions } from "./levels.js";
import { fileURLToPath } from "node:url";

const DAY = 86_400;
const T0 = 1_700_000_000;

function bar(i: number, high: number, low: number, close: number, open = close): Candle {
  return { time: T0 + i * DAY, open, high, low, close, volume: 1 };
}

/** Calm bars whose true range is `tr`, with three isolated swing highs spliced in. */
function withHighs(n: number, tr: number, spikes: Array<{ i: number; high: number }>): Candle[] {
  const mid = 10;
  const candles = Array.from({ length: n }, (_, i) => bar(i, mid + tr / 2, mid - tr / 2, mid));
  for (const s of spikes) {
    candles[s.i] = bar(s.i, s.high, mid - tr / 2, mid);
  }
  return candles;
}

// Prices, pivots and episodes match the spec table. Two rejection counts differ by one
// from that table because the fixture uses the settled Oct 29 bar (O 11.17 H 11.79
// L 11.12 C 11.35) rather than the spec's intraday snapshot (last close 11.31):
// 11.22 has Q 10 instead of 11, and 10.70 has Q 7 instead of 6. No level price moved.
const SPEC_LEVELS = [
  { price: 13.82, nPiv: 1, q: 1, episodes: 1, extreme: true, label: "R2" },
  { price: 11.94, nPiv: 1, q: 6, episodes: 2, extreme: false, label: "R1" },
  { price: 11.22, nPiv: 2, q: 10, episodes: 2, extreme: false, label: "S1" },
  { price: 10.7, nPiv: 2, q: 7, episodes: 2, extreme: false, label: "S2" },
  { price: 10.09, nPiv: 3, q: 8, episodes: 2, extreme: false, label: "S3" },
  { price: 9.17, nPiv: 2, q: 9, episodes: 1, extreme: false, label: "S4" },
  { price: 8.57, nPiv: 1, q: 4, episodes: 1, extreme: true, label: "S5" },
];

describe("REAL validation", () => {
  const candles = JSON.parse(
    readFileSync(fileURLToPath(new URL("./fixtures/real-2026.json", import.meta.url)), "utf8")
  ) as Candle[];

  function run() {
    const asOf = candles[candles.length - 1].time;
    const aug3 = Date.parse("2026-08-03T00:00:00Z") / 1000;
    const windowDays = Math.round((asOf - aug3) / 86400);
    return srLevels("REAL", candles, { ...SR_DEFAULTS, windowDays });
  }

  it("A1: reproduces the spec table for REAL", () => {
    const result = run();
    expect(result.eps).toBeGreaterThanOrEqual(0.3);
    expect(result.eps).toBeLessThanOrEqual(0.32);
    expect(result.windowStart).toBe(Date.parse("2026-08-03T00:00:00Z") / 1000);
    for (const spec of SPEC_LEVELS) {
      const hit = result.levels.find((lv) => Math.abs(lv.price - spec.price) <= 0.02);
      expect(hit, `missing ${spec.price}`).toBeDefined();
      expect(hit!.nPiv).toBe(spec.nPiv);
      expect(hit!.q).toBe(spec.q);
      expect(hit!.episodes).toBe(spec.episodes);
      expect(hit!.extreme).toBe(spec.extreme);
    }
    for (const dropped of [11.45, 10.37, 9.59]) {
      expect(result.levels.some((lv) => Math.abs(lv.price - dropped) <= 0.02)).toBe(false);
    }
  });

  it("A2: ranks resistances and supports nearest to the last close", () => {
    const result = run();
    // Fixture close is the settled Oct 29 print (11.35). It stays between 11.22 and 11.94,
    // so the spec's R1/R2 and S1–S5 labels are unchanged from the 11.31 snapshot.
    expect(result.lastClose).toBeCloseTo(11.35, 2);
    for (const spec of SPEC_LEVELS) {
      const hit = result.levels.find((lv) => Math.abs(lv.price - spec.price) <= 0.02);
      expect(hit!.label).toBe(spec.label);
    }
  });
});

describe("srLevels", () => {
  it("A3: three equal highs five bars apart are one level with nPiv 3", () => {
    const candles = withHighs(48, 1, [
      { i: 10, high: 20 },
      { i: 15, high: 20 },
      { i: 20, high: 20 },
    ]);
    const level = srLevels("A3", candles).levels.find((lv) => lv.nPiv === 3);
    expect(level).toBeDefined();
    expect(level!.zone[1] - level!.zone[0]).toBe(0);
    expect(level!.firstTouch).toBe(candles[10].time);
    expect(level!.lastTouch).toBe(candles[20].time);
  });

  it("does not treat a high in the last k bars as a pivot", () => {
    const candles = withHighs(48, 1, [{ i: 46, high: 30 }]);
    expect(srLevels("PIV", candles).levels.some((lv) => lv.price === 30)).toBe(false);
  });

  it("A4: clusters anchor to the first member, not the previous pivot", () => {
    // ATR of the tail is 1 → ε = 0.5. Gaps: 0.45 = 0.9ε (same group), 0.55 = 1.1ε from the first (new group).
    // Spikes sit above the calm high (10.5) so each one is a confirmed swing.
    const candles = withHighs(50, 1, [
      { i: 8, high: 20 },
      { i: 16, high: 20.45 },
      { i: 24, high: 20.55 },
    ]);
    const levels = srLevels("A4", candles).levels;
    const pair = levels.find((lv) => lv.nPiv === 2);
    expect(pair).toBeDefined();
    expect(pair!.zone[0]).toBe(20);
    expect(pair!.zone[1]).toBe(20.45);
    const third = levels.find((lv) => lv.price === 20.55);
    expect(third).toBeDefined();
    expect(third!.nPiv).toBe(1);
    expect(third!.extreme).toBe(true);
    expect(levels.some((lv) => lv.zone[0] <= 20 && lv.zone[1] >= 20.55)).toBe(false);
  });

  it("centres a scan plateau that is at most ε wide", () => {
    // Seven touches at one price: the Q run is ε wide, so the level is the plateau centre (the touch).
    const narrow = rejectionSeries([
      { touches: [10, 11, 13], shield: 12 },
      { touches: [26, 27, 29, 30], shield: 28 },
    ]);
    const level = srLevels("PLAT", narrow).levels.find((lv) => lv.nPiv === 0 && lv.q >= 4);
    expect(level).toBeDefined();
    expect(level!.price).toBeCloseTo(50, 1);
  });

  it("A5: one episode of seven rejections is dropped; two episodes are kept", () => {
    const bunched = rejectionSeries([
      { touches: [10, 11, 13, 14], shield: 12 },
      { touches: [15, 17, 18], shield: 16 },
    ]);
    const split = rejectionSeries([
      { touches: [10, 11, 13], shield: 12 },
      { touches: [26, 27, 29, 30], shield: 28 },
    ]);
    expect(srLevels("A5", bunched).levels.some((lv) => Math.abs(lv.price - 50) < 0.5)).toBe(false);
    const kept = srLevels("A5", split).levels.find((lv) => Math.abs(lv.price - 50) < 0.5);
    expect(kept).toBeDefined();
    expect(kept!.nPiv).toBe(0);
    expect(kept!.q).toBe(7);
    expect(kept!.episodes).toBe(2);
    expect(kept!.score).toBe(9);
  });

  it("keeps a lone window-high spike as an extreme", () => {
    const candles = withHighs(48, 1, [{ i: 12, high: 40 }]);
    const level = srLevels("EXT", candles).levels.find((lv) => lv.price === 40);
    expect(level).toMatchObject({ extreme: true, nPiv: 1 });
  });

  it("A6: 39 bars is not enough history", () => {
    const candles = Array.from({ length: 39 }, (_, i) => bar(i, 11, 9, 10));
    const result = srLevels("A6", candles);
    expect(result.levels).toEqual([]);
    expect(result.reason).toBe("insufficient_history");
  });

  it("A7: evidence older than the window is ignored", () => {
    const n = 400;
    const candles = Array.from({ length: n }, (_, i) => bar(i, 50.5, 49.5, 50));
    for (let i = 20; i < 40; i++) candles[i] = bar(i, 100, 90, 95);
    candles[300] = bar(300, 60, 49.5, 50);
    const result = srLevels("A7", candles);
    expect(result.levels.some((lv) => lv.price > 80)).toBe(false);
    const bound = result.asOf - 183 * DAY - 3 * DAY;
    for (const lv of result.levels) expect(lv.firstTouch).toBeGreaterThanOrEqual(bound);
  });

  it("A8: a sub-dollar series uses a one-significant-figure step", () => {
    const candles = pennyShelf();
    const result = srLevels("A8", candles);
    expect(result.eps).toBeCloseTo(0.002, 6);
    expect(result.step).toBeCloseTo(0.00007, 8);
    const span = 0.02 + 2 * result.eps;
    expect(span / result.step).toBeLessThan(20_000);
    expect(result.levels.length).toBeGreaterThan(0);
    for (const lv of result.levels) {
      expect(lv.price).toBe(Number(lv.price.toPrecision(4)));
      expect(lv.zone[0]).toBe(Number(lv.zone[0].toPrecision(4)));
      expect(lv.zone[1]).toBe(Number(lv.zone[1].toPrecision(4)));
    }
  });

  it("A9: the cap keeps ten levels, highest score then nearest price", () => {
    const opts: SrOptions = { ...SR_DEFAULTS, pivotHalfWindow: 1 };
    const candles = rankedPivots();
    const result = srLevels("A9", candles, opts);
    expect(result.levels).toHaveLength(10);
    const prices = result.levels.map((lv) => lv.price);
    // Price 10 is farther from the close than 30, but its extra pivot gives it the higher score.
    expect(prices.some((p) => Math.abs(p - 10) < 1)).toBe(true);
    expect(prices.some((p) => Math.abs(p - 30) < 1)).toBe(false);
    const byPrice = [...result.levels].sort((a, b) => b.price - a.price);
    expect(result.levels.map((lv) => lv.price)).toEqual(byPrice.map((lv) => lv.price));
    const resists = result.levels.filter((lv) => lv.type === "resistance").sort((a, b) => a.rank - b.rank);
    const supports = result.levels.filter((lv) => lv.type === "support").sort((a, b) => a.rank - b.rank);
    for (let i = 1; i < resists.length; i++) expect(resists[i].price).toBeGreaterThan(resists[i - 1].price);
    for (let i = 1; i < supports.length; i++) expect(supports[i].price).toBeLessThan(supports[i - 1].price);
  });

  it("returns no levels and a null reason when ATR is zero", () => {
    const candles = Array.from({ length: 45 }, (_, i) => bar(i, 5, 5, 5));
    const result = srLevels("FLAT", candles);
    expect(result.eps).toBe(0);
    expect(result.levels).toEqual([]);
    expect(result.reason).toBeNull();
  });
});

/**
 * Touches at 50 that close back through the level. A shield bar of high 51 sits in the
 * middle of each group so none of the touches is a swing pivot (k = 3).
 */
function rejectionSeries(groups: Array<{ touches: number[]; shield: number }>): Candle[] {
  const n = 56;
  const candles = Array.from({ length: n }, (_, i) => bar(i, 10.4, 9.6, 10));
  for (const group of groups) {
    for (const i of group.touches) candles[i] = bar(i, 50, 9.6, 49);
    candles[group.shield] = bar(group.shield, 51, 9.6, 50);
  }
  return candles;
}

function pennyShelf(): Candle[] {
  const n = 56;
  const candles = Array.from({ length: n }, (_, i) => bar(i, 0.081, 0.077, 0.079));
  const idxs = [10, 12, 14, 26, 28, 30, 32];
  for (const i of idxs) {
    candles[i] = bar(i, 0.08, 0.077, 0.078);
    candles[i + 1] = bar(i + 1, 0.09, 0.077, 0.085);
  }
  return candles;
}

/** Eleven pivot levels plus the shared lows. A calm tail keeps ε at 0.5 so levels stay apart. */
function rankedPivots(): Candle[] {
  const candles: Candle[] = [];
  let i = 0;
  const pushLevel = (price: number, pivots: number) => {
    for (let t = 0; t < pivots; t++) {
      candles.push(bar(i++, price, 1, 50));
      candles.push(bar(i++, price - 1, 1, 50));
    }
  };
  // Far, but three pivots — higher score than the doubles, so the cap keeps it.
  pushLevel(10, 3);
  for (const price of [30, 33, 36, 39, 42, 48, 60, 70, 90]) pushLevel(price, 2);
  while (candles.length < 60) candles.push(bar(i++, 50.5, 49.5, 50));
  return candles;
}
