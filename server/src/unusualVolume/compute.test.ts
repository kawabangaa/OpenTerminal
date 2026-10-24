import { describe, expect, it } from "vitest";
import { applyFilters, computeMetrics, DEFAULTS, sectorMedians } from "./compute.js";
import type { Metrics, ScanRow } from "./types.js";

function scanRow(overrides: Partial<ScanRow> = {}): ScanRow {
  return {
    symbol: "AAA",
    exchange: "NASDAQ",
    name: "Aaa Inc",
    sector: "Technology",
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    changePct: 10,
    volume: 3_000_000,
    avg30: 1_100_000,
    marketCap: 1_000_000_000,
    float: 50_000_000,
    earningsLast: null,
    earningsNext: null,
    ...overrides,
  };
}

function withMetrics(overrides: Partial<ScanRow> = {}): ScanRow & Metrics {
  const row = scanRow(overrides);
  return { ...row, ...computeMetrics(row) };
}

describe("computeMetrics", () => {
  it("A1: drops session D from ADV30 (1,034,483) and RVOL (2.90)", () => {
    const metrics = computeMetrics(scanRow({ volume: 3_000_000, avg30: 1_100_000 }));
    // (30 * 1_100_000 - 3_000_000) / 29 = 30_000_000 / 29
    expect(metrics.adv30).toBeCloseTo(1_034_482.7586, 4);
    expect(metrics.rvol).toBeCloseTo(2.9, 5);
    expect(Math.round(metrics.adv30)).toBe(1_034_483);
    expect(Math.round(metrics.rvol * 100) / 100).toBe(2.9);
    expect(metrics.rvol.toFixed(2)).toBe("2.90");
  });

  it("derives prevClose from changePct and signs gapPct from the open", () => {
    const up = computeMetrics(scanRow({ close: 110, open: 120, high: 125, low: 100, changePct: 10, volume: 1_000_000, float: 10_000_000 }));
    // prevClose = 110 / 1.10 = 100; gap = open above that close
    expect(up.prevClose).toBeCloseTo(100);
    expect(up.gapPct).toBeGreaterThan(0);
    expect(up.gapPct).toBeCloseTo(20);
    expect(up.dayChangePct).toBe(10);
    expect(up.candlePct).toBeCloseTo((110 / 120 - 1) * 100);
    expect(up.closeLocation).toBeCloseTo((110 - 100) / (125 - 100));
    expect(up.dollarVolume).toBe(1_000_000 * 110);
    expect(up.turnover).toBeCloseTo(1_000_000 / 10_000_000);

    const down = computeMetrics(scanRow({ close: 110, open: 80, changePct: 10 }));
    expect(down.prevClose).toBeCloseTo(100);
    expect(down.gapPct).toBeLessThan(0);
    expect(down.gapPct).toBeCloseTo(-20);
  });

  it("A17: null or zero float has no turnover; a flat bar has no close location", () => {
    const flat = computeMetrics(scanRow({ float: null, high: 10, low: 10, close: 10 }));
    expect(flat.turnover).toBeNull();
    expect(flat.closeLocation).toBeNull();
    expect(computeMetrics(scanRow({ float: 0 })).turnover).toBeNull();
  });
});

describe("sectorMedians", () => {
  it("uses the whole sector, odd and even, and ignores other sectors", () => {
    // Technology (3): numeric median of 2, 10, 100 is 10. The middle name would fail the filters.
    // Health (4): sorted 3, 4, 20, 100 → (4 + 20) / 2 = 12.
    // Energy must not move either median.
    const rows = [
      scanRow({ symbol: "T1", sector: "Technology", changePct: 10 }),
      scanRow({ symbol: "T2", sector: "Technology", changePct: 2, volume: 1, open: 12, close: 10 }),
      scanRow({ symbol: "T3", sector: "Technology", changePct: 100 }),
      scanRow({ symbol: "H1", sector: "Health", changePct: 20 }),
      scanRow({ symbol: "H2", sector: "Health", changePct: 3 }),
      scanRow({ symbol: "H3", sector: "Health", changePct: 100 }),
      scanRow({ symbol: "H4", sector: "Health", changePct: 4 }),
      scanRow({ symbol: "E1", sector: "Energy", changePct: 999 }),
    ];
    const before = rows.map((row) => ({ ...row }));
    const medians = sectorMedians(rows);

    expect(medians.get("Technology")).toBe(10);
    expect(medians.get("Health")).toBe(12);
    expect(medians.get("Energy")).toBe(999);
    expect(rows).toEqual(before);
  });
});

describe("applyFilters", () => {
  it("A2: raw volume/avg30 of 2.40 corrects to about 2.52 and is included", () => {
    // volume / avg30 = 2_640_000 / 1_100_000 = 2.40 (D still inside the average).
    // adv30 = (30 * 1_100_000 - 2_640_000) / 29 = 30_360_000 / 29 ≈ 1_046_896.55
    // rvol = 2_640_000 / adv30 = 2.40 * 29 / 27.6 ≈ 2.5217
    const row = withMetrics({ symbol: "A2", volume: 2_640_000, avg30: 1_100_000, open: 10, close: 11, marketCap: 500_000_000 });
    expect(row.volume / row.avg30).toBeCloseTo(2.4);
    expect(row.rvol).toBeCloseTo(2.5217, 3);
    const { matches } = applyFilters([row]);
    expect(matches.map((match) => match.symbol)).toEqual(["A2"]);
  });

  it("A3: corrected RVOL of exactly 2.50 is included", () => {
    // volume = 2.5 * 30 * 1_050_000 / 31.5 = 2_500_000; adv30 = 1_000_000; rvol = 2.5
    const row = withMetrics({ symbol: "A3", volume: 2_500_000, avg30: 1_050_000, open: 10, close: 11 });
    expect(row.rvol).toBe(2.5);
    expect(row.adv30).toBe(1_000_000);
    expect(applyFilters([row]).matches).toHaveLength(1);
  });

  it("A4: corrected RVOL of 2.49 is excluded", () => {
    // volume = 2.49 * 30 * 3_149_000 / 31.49 = 7_470_000; adv30 = 3_000_000; rvol = 2.49
    const row = withMetrics({ symbol: "A4", volume: 7_470_000, avg30: 3_149_000, open: 10, close: 11 });
    expect(row.rvol).toBe(2.49);
    expect(applyFilters([row]).matches).toEqual([]);
  });

  it("A5: a gap that fades (red candle, close still above prevClose) is excluded", () => {
    const row = withMetrics({
      symbol: "A5",
      volume: 4_000_000,
      avg30: 1_100_000,
      open: 105,
      high: 106,
      low: 100,
      close: 102,
      changePct: 2,
    });
    expect(row.rvol).toBe(4);
    expect(row.close).toBeLessThan(row.open);
    expect(row.close).toBeGreaterThan(row.prevClose);
    expect(applyFilters([row]).matches).toEqual([]);
  });

  it("A6: a gap down that recovers (green candle, close still below prevClose) is included", () => {
    const row = withMetrics({
      symbol: "A6",
      volume: 4_000_000,
      avg30: 1_100_000,
      open: 95,
      high: 99,
      low: 94,
      close: 98,
      changePct: -2,
    });
    expect(row.rvol).toBe(4);
    expect(row.close).toBeGreaterThan(row.open);
    expect(row.close).toBeLessThan(row.prevClose);
    expect(applyFilters([row]).matches.map((match) => match.symbol)).toEqual(["A6"]);
  });

  it("A7: ADV30 of 950,000 is excluded and liquid is one below universe", () => {
    // (30 * 997_500 - 2_375_000) / 29 = 950_000; rvol = 2_375_000 / 950_000 = 2.5
    const thin = withMetrics({
      symbol: "THIN",
      volume: 2_375_000,
      avg30: 997_500,
      open: 10,
      close: 11,
      marketCap: 500_000_000,
    });
    const kept = withMetrics({ symbol: "KEEP", volume: 4_000_000, avg30: 1_100_000, open: 10, close: 11 });
    expect(thin.adv30).toBe(950_000);
    expect(thin.rvol).toBe(2.5);
    expect(thin.close).toBeGreaterThan(thin.open);

    const { matches, counts } = applyFilters([kept, thin]);
    expect(matches.map((match) => match.symbol)).toEqual(["KEEP"]);
    expect(counts.liquid).toBe(counts.universe - 1);
    expect(counts).toMatchObject({ universe: 2, liquid: 1 });
  });

  it("counts a row that fails rvol and the candle at rvol only, and keeps input order", () => {
    const passA = withMetrics({ symbol: "PASS_A", volume: 4_000_000, avg30: 1_100_000, open: 10, close: 11, marketCap: DEFAULTS.marketCapMin });
    // rvol = 3_000_000 / 1_500_000 = 2, and the candle is red.
    const both = withMetrics({ symbol: "BOTH", volume: 3_000_000, avg30: 1_550_000, open: 12, close: 10, marketCap: 1_000_000_000 });
    const red = withMetrics({ symbol: "RED", volume: 4_000_000, avg30: 1_100_000, open: 12, close: 10 });
    const cheap = withMetrics({ symbol: "CHEAP", volume: 4_000_000, avg30: 1_100_000, open: 0.4, close: 0.5, marketCap: 1_000_000_000 });
    const small = withMetrics({ symbol: "SMALL", volume: 4_000_000, avg30: 1_100_000, open: 10, close: 11, marketCap: DEFAULTS.marketCapMin - 1 });
    const noCap = withMetrics({ symbol: "NOCAP", volume: 4_000_000, avg30: 1_100_000, open: 10, close: 11, marketCap: null });
    const thin = withMetrics({ symbol: "THIN", volume: 2_375_000, avg30: 997_500, open: 10, close: 11 });
    const passB = withMetrics({ symbol: "PASS_B", volume: 4_000_000, avg30: 1_100_000, open: 10, close: 12 });

    expect(both.rvol).toBe(2);
    expect(both.close).toBeLessThan(both.open);

    const { matches, counts } = applyFilters([passA, both, red, cheap, small, noCap, thin, passB]);
    expect(matches.map((match) => match.symbol)).toEqual(["PASS_A", "PASS_B"]);
    expect(counts).toEqual({ universe: 8, liquid: 7, mcap: 4, rvol: 3, green: 2 });
  });
});
