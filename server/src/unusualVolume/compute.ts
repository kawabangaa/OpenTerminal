import type { Metrics, RunCounts, ScanRow } from "./types.js";

export const DEFAULTS = {
  threshold: 2.5,
  adv30Min: 1_000_000,
  priceMin: 1,
  marketCapMin: 300e6,
};

/** `avg30` includes session D. ADV30 is the mean of the 29 sessions before it. */
export function computeMetrics(row: ScanRow): Metrics {
  const prevClose = row.close / (1 + row.changePct / 100);
  const adv30 = (30 * row.avg30 - row.volume) / 29;
  const rvol = row.volume / adv30;
  const candlePct = (row.close / row.open - 1) * 100;
  const dayChangePct = row.changePct;
  const gapPct = (row.open / prevClose - 1) * 100;
  const closeLocation = row.high > row.low ? (row.close - row.low) / (row.high - row.low) : null;
  const dollarVolume = row.volume * row.close;
  const turnover = row.float ? row.volume / row.float : null;
  return { prevClose, adv30, rvol, candlePct, dayChangePct, gapPct, closeLocation, dollarVolume, turnover };
}

/** Median of `changePct` per sector. Odd count: middle value. Even count: mean of the two middle values. */
export function sectorMedians(rows: ScanRow[]): Map<string, number> {
  const bySector = new Map<string, number[]>();
  for (const row of rows) {
    const changes = bySector.get(row.sector);
    if (changes) changes.push(row.changePct);
    else bySector.set(row.sector, [row.changePct]);
  }
  const medians = new Map<string, number>();
  for (const [sector, changes] of bySector) medians.set(sector, median(changes));
  return medians;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Survivors are counted after each stage. Price sits between liquid and mcap and has no count.
 * A row that fails rvol is not also removed from green.
 */
export function applyFilters(
  rows: Array<ScanRow & Metrics>,
  cfg = DEFAULTS,
): {
  matches: Array<ScanRow & Metrics>;
  counts: Pick<RunCounts, "universe" | "liquid" | "mcap" | "rvol" | "green">;
} {
  const matches: Array<ScanRow & Metrics> = [];
  let liquid = 0;
  let mcap = 0;
  let rvol = 0;
  let green = 0;

  for (const row of rows) {
    if (!(row.adv30 >= cfg.adv30Min && row.adv30 > 0)) continue;
    liquid++;
    if (!(row.close >= cfg.priceMin)) continue;
    if (!(row.marketCap !== null && row.marketCap >= cfg.marketCapMin)) continue;
    mcap++;
    if (!(row.rvol >= cfg.threshold)) continue;
    rvol++;
    if (!(row.close > row.open)) continue;
    green++;
    matches.push(row);
  }

  return { matches, counts: { universe: rows.length, liquid, mcap, rvol, green } };
}
