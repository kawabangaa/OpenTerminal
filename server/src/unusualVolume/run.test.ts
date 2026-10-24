import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalysts, RunOutcome, RunSummary, ScanRow, UnusualVolumeRow } from "./types.js";

vi.mock("../providers/tradingview.js", () => ({
  unusualVolumeScan: vi.fn(),
  spyChange: vi.fn(),
}));

vi.mock("../providers/nasdaq.js", () => ({
  barCount: vi.fn(),
}));

vi.mock("./enrich.js", () => ({
  enrichRows: vi.fn(),
}));

// 2026-10-24T03:00:00Z is Friday 23:00 ET (EDT, UTC-4). Session D is 2026-10-23, inside the scan window.
const FULL_NOW = new Date("2026-10-24T03:00:00.000Z");
const ELEVEN_ET = new Date("2026-10-23T15:00:00.000Z");
const FIVE_ET = new Date("2026-10-23T09:00:00.000Z");
const D = "2026-10-23";

const NO_CATALYST: Catalysts = {
  tags: [],
  evidence: [],
  explain: ["No catalyst found in news, filings or earnings."],
  sources: {},
};

let tmpDir: string;
let db: (typeof import("../db.js"))["db"];
let store: typeof import("./store.js");
let runUnusualVolume: (typeof import("./run.js"))["runUnusualVolume"];
let unusualVolumeScan: (typeof import("../providers/tradingview.js"))["unusualVolumeScan"];
let spyChange: (typeof import("../providers/tradingview.js"))["spyChange"];
let barCount: (typeof import("../providers/nasdaq.js"))["barCount"];
let enrichRows: (typeof import("./enrich.js"))["enrichRows"];

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "bloomber-uv-run-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  store = await import("./store.js");
  ({ runUnusualVolume } = await import("./run.js"));
  ({ unusualVolumeScan, spyChange } = await import("../providers/tradingview.js"));
  ({ barCount } = await import("../providers/nasdaq.js"));
  ({ enrichRows } = await import("./enrich.js"));
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

beforeEach(() => {
  db.exec(`
    DELETE FROM unusual_volume_runs;
    DELETE FROM unusual_volume_seasoned;
    DELETE FROM unusual_volume_refresh;
  `);
  vi.mocked(unusualVolumeScan).mockReset();
  vi.mocked(spyChange).mockReset();
  vi.mocked(barCount).mockReset();
  vi.mocked(enrichRows).mockReset();
  vi.mocked(unusualVolumeScan).mockResolvedValue({ rows: scanFixture(), dropped: 1 });
  vi.mocked(spyChange).mockResolvedValue(0.4);
  vi.mocked(barCount).mockResolvedValue(31);
  vi.mocked(enrichRows).mockImplementation(async (rows: UnusualVolumeRow[]) => ({
    bySymbol: catalystsFor(rows),
    requests: { edgar: rows.length, news: rows.length, nasdaq: 0 },
    failures: { edgar: 0, news: 0, nasdaq: 0 },
  }));
});

function catalystsFor(rows: Array<{ symbol: string }>): Map<string, Catalysts> {
  const bySymbol = new Map<string, Catalysts>();
  for (const row of rows) bySymbol.set(row.symbol, NO_CATALYST);
  return bySymbol;
}

function volumeFields(adv30: number, rvol: number): { volume: number; avg30: number } {
  const volume = adv30 * rvol;
  const avg30 = (adv30 * 29 + volume) / 30;
  return { volume, avg30 };
}

function scanRow(overrides: Partial<ScanRow> & Pick<ScanRow, "symbol" | "changePct">): ScanRow {
  return {
    exchange: "NASDAQ",
    name: overrides.symbol,
    sector: "Technology",
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 0,
    avg30: 0,
    marketCap: 1_000_000_000,
    float: 100_000_000,
    earningsLast: null,
    earningsNext: null,
    ...overrides,
  };
}

/** Five kept scan rows plus one dropped by the scanner (null OHLC, not in `rows`). */
function scanFixture(): ScanRow[] {
  return [
    scanRow({ symbol: "KEEP1", changePct: 1, ...volumeFields(2_000_000, 2.5), open: 10, close: 11 }),
    scanRow({ symbol: "KEEP2", changePct: 2, ...volumeFields(2_000_000, 4), open: 20, close: 22 }),
    scanRow({ symbol: "RED1", changePct: 3, ...volumeFields(2_000_000, 3), open: 15, close: 14 }),
    scanRow({ symbol: "THIN", changePct: 4, ...volumeFields(950_000, 3), open: 8, close: 9 }),
    scanRow({ symbol: "SOFT", changePct: 5, ...volumeFields(1_500_000, 2), open: 10, close: 10.5 }),
  ];
}

function assertRan(outcome: RunOutcome): RunSummary {
  expect(outcome.kind).toBe("ran");
  if (outcome.kind !== "ran") throw new Error("expected a completed run");
  return outcome.summary;
}

function emptySummary(sessionDate: string): RunSummary {
  return {
    sessionDate,
    earlyClose: false,
    spyChangePct: null,
    counts: { universe: 0, liquid: 0, mcap: 0, rvol: 0, green: 0, seasoned: 0, matches: 0 },
    requests: {},
    failures: {},
    durationMs: 0,
  };
}

describe("runUnusualVolume", () => {
  it("saves the two qualifiers and logs the summary", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const summary = assertRan(await runUnusualVolume({ now: FULL_NOW }));
      expect(summary.counts).toMatchObject({
        universe: 5,
        liquid: 4,
        mcap: 4,
        rvol: 3,
        green: 2,
        seasoned: 2,
        matches: 2,
      });
      expect(summary.spyChangePct).toBe(0.4);
      expect(summary.requests).toMatchObject({ tv: 2, edgar: 2, news: 2, nasdaq: 2 });
      expect(summary.earlyClose).toBe(false);

      const stored = store.getRun(D);
      expect(stored?.status).toBe("complete");
      expect(stored?.universeSize).toBe(5);
      expect(stored?.spyChangePct).toBe(0.4);
      const rows = store.getRows(D);
      expect(rows.map((row) => row.symbol).sort()).toEqual(["KEEP1", "KEEP2"]);
      for (const row of rows) {
        expect(row.sectorMedianChangePct).toBe(3);
        expect(row.sectorPeersOnList).toBe(2);
        expect(row.catalysts).toEqual(NO_CATALYST);
      }
      expect(store.isSeasoned("KEEP1")).toBe(true);
      expect(store.isSeasoned("KEEP2")).toBe(true);

      expect(vi.mocked(unusualVolumeScan)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(spyChange)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(barCount).mock.calls.map((call) => call[0]).sort()).toEqual(["KEEP1", "KEEP2"]);
      expect(vi.mocked(barCount).mock.calls.every((call) => call[1] === 31 && call[2] === D)).toBe(true);

      const line = log.mock.calls.map((args) => args.map(String).join(" ")).find((entry) => entry.startsWith("[unusual-volume]"));
      expect(line).toMatch(/^\[unusual-volume\] D=\d{4}-\d{2}-\d{2} universe=\d+.+/);
      expect(line).toContain("D=2026-10-23");
      expect(line).toContain("universe=5 liquid=4 mcap=4 rvol=3 green=2 seasoned=2 matches=2");
      expect(line).toContain("req{tv:2,edgar:2,news:2,nasdaq:2}");
      expect(line).toContain("fail{edgar:0,news:0,nasdaq:0}");
      expect(line).toMatch(/\d+\.\ds$/);
    } finally {
      log.mockRestore();
    }
  });

  it("A11 skips 11:00 ET without scanning", async () => {
    const outcome = await runUnusualVolume({ now: ELEVEN_ET });
    expect(outcome).toEqual({ kind: "skipped", reason: "market-hours" });
    expect(vi.mocked(unusualVolumeScan)).not.toHaveBeenCalled();
    expect(vi.mocked(spyChange)).not.toHaveBeenCalled();
    expect(store.getRun("2026-10-22")).toBeUndefined();
  });

  it("A11b skips 05:00 ET without scanning", async () => {
    const outcome = await runUnusualVolume({ now: FIVE_ET });
    expect(outcome).toEqual({ kind: "skipped", reason: "market-hours" });
    expect(vi.mocked(unusualVolumeScan)).not.toHaveBeenCalled();
    expect(vi.mocked(spyChange)).not.toHaveBeenCalled();
  });

  it("A11c skips a second call for the same session unless force is set", async () => {
    assertRan(await runUnusualVolume({ now: FULL_NOW }));
    expect(vi.mocked(unusualVolumeScan)).toHaveBeenCalledTimes(1);

    const again = await runUnusualVolume({ now: FULL_NOW });
    expect(again).toEqual({ kind: "skipped", reason: "exists" });
    expect(vi.mocked(unusualVolumeScan)).toHaveBeenCalledTimes(1);

    assertRan(await runUnusualVolume({ now: FULL_NOW, force: true }));
    expect(vi.mocked(unusualVolumeScan)).toHaveBeenCalledTimes(2);
    expect(store.getRun(D)?.status).toBe("complete");
  });

  it("A8 drops a 20-bar name and does not recheck a seasoned survivor", async () => {
    vi.mocked(barCount).mockImplementation(async (symbol: string) => (symbol === "KEEP1" ? 20 : 31));

    const summary = assertRan(await runUnusualVolume({ now: FULL_NOW }));
    expect(summary.counts.matches).toBe(1);
    expect(summary.counts.seasoned).toBe(1);
    expect(store.getRows(D).map((row) => row.symbol)).toEqual(["KEEP2"]);
    expect(store.getRows(D)[0]?.sectorPeersOnList).toBe(1);
    expect(store.isSeasoned("KEEP1")).toBe(false);
    expect(store.isSeasoned("KEEP2")).toBe(true);
    expect(vi.mocked(barCount).mock.calls.map((call) => call[0])).toEqual(["KEEP1", "KEEP2"]);

    vi.mocked(barCount).mockClear();
    assertRan(await runUnusualVolume({ now: FULL_NOW, force: true }));
    expect(vi.mocked(barCount).mock.calls.map((call) => call[0])).toEqual(["KEEP1"]);
    expect(store.isSeasoned("KEEP2")).toBe(true);
    expect(store.isSeasoned("KEEP1")).toBe(false);
    expect(store.getRows(D).map((row) => row.symbol)).toEqual(["KEEP2"]);
  });

  it("A8b writes nothing when the scan reports a truncated universe", async () => {
    store.saveListPhase(
      {
        sessionDate: "2026-10-22",
        runAt: "2026-10-22T03:00:00.000Z",
        earlyClose: false,
        spyChangePct: 0.1,
        universeSize: 1,
        summary: emptySummary("2026-10-22"),
      },
      [],
    );
    vi.mocked(unusualVolumeScan).mockRejectedValue(new Error("tradingview scan: universe truncated"));

    await expect(runUnusualVolume({ now: FULL_NOW })).rejects.toThrow("tradingview scan: universe truncated");
    expect(store.getRun(D)).toBeUndefined();
    expect(store.getRun("2026-10-22")?.sessionDate).toBe("2026-10-22");
    expect(store.getRows(D)).toEqual([]);
  });

  it("keeps a row when barCount throws and leaves it unseasoned", async () => {
    vi.mocked(barCount).mockImplementation(async (symbol: string) => {
      if (symbol === "KEEP1") throw new Error("nasdaq down");
      return 31;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const summary = assertRan(await runUnusualVolume({ now: FULL_NOW }));
      expect(summary.counts.matches).toBe(2);
      expect(summary.counts.seasoned).toBe(1);
      expect(summary.failures.nasdaq).toBe(1);
      expect(summary.requests.nasdaq).toBe(2);
      expect(store.getRows(D).map((row) => row.symbol).sort()).toEqual(["KEEP1", "KEEP2"]);
      expect(store.isSeasoned("KEEP1")).toBe(false);
      expect(store.isSeasoned("KEEP2")).toBe(true);
      const seasoning = warn.mock.calls.filter((call) => String(call[0]).includes("KEEP1"));
      expect(seasoning).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("continues with a null SPY print when spyChange throws", async () => {
    vi.mocked(spyChange).mockRejectedValue(new Error("spy down"));
    const summary = assertRan(await runUnusualVolume({ now: FULL_NOW }));
    expect(summary.spyChangePct).toBeNull();
    expect(summary.requests.tv).toBe(2);
    expect(store.getRun(D)?.spyChangePct).toBeNull();
    expect(vi.mocked(unusualVolumeScan)).toHaveBeenCalledTimes(1);
  });

  it("leaves status list when enrichment fails, then reenrichOnly completes it", async () => {
    vi.mocked(enrichRows).mockRejectedValueOnce(new Error("enrich down"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const first = assertRan(await runUnusualVolume({ now: FULL_NOW }));
      expect(first.counts.matches).toBe(2);
      expect(store.getRun(D)?.status).toBe("list");
      expect(store.getRows(D).every((row) => row.catalysts === null)).toBe(true);
      const logged = () => log.mock.calls.filter((call) => String(call[0]).startsWith("[unusual-volume]")).length;
      expect(logged()).toBe(1);

      const scans = vi.mocked(unusualVolumeScan).mock.calls.length;
      const second = assertRan(await runUnusualVolume({ now: FULL_NOW, reenrichOnly: true }));
      expect(second.counts.matches).toBe(2);
      expect(store.getRun(D)?.status).toBe("complete");
      expect(store.getRows(D).every((row) => row.catalysts !== null)).toBe(true);
      expect(vi.mocked(unusualVolumeScan)).toHaveBeenCalledTimes(scans);
      expect(logged()).toBe(1);

      vi.mocked(enrichRows).mockClear();
      const refreshed = assertRan(await runUnusualVolume({ now: FULL_NOW, reenrichOnly: true }));
      expect(store.getRun(D)?.status).toBe("complete");
      expect(refreshed.requests).toMatchObject({ tv: 2, edgar: 2, news: 2, nasdaq: 2 });
      expect(vi.mocked(unusualVolumeScan)).toHaveBeenCalledTimes(scans);
      expect(vi.mocked(enrichRows)).toHaveBeenCalledTimes(1);
      expect(logged()).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  it("throws when reenrichOnly has no list for the session", async () => {
    await expect(runUnusualVolume({ now: FULL_NOW, reenrichOnly: true })).rejects.toThrow(
      "unusual-volume: no list to enrich",
    );
    expect(vi.mocked(unusualVolumeScan)).not.toHaveBeenCalled();
  });

  it("shares one scan across two concurrent callers", async () => {
    let release!: (value: { rows: ScanRow[]; dropped: number }) => void;
    const gate = new Promise<{ rows: ScanRow[]; dropped: number }>((resolve) => {
      release = resolve;
    });
    vi.mocked(unusualVolumeScan).mockReturnValue(gate);

    const pending = Promise.all([runUnusualVolume({ now: FULL_NOW }), runUnusualVolume({ now: FULL_NOW })]);
    try {
      expect(vi.mocked(unusualVolumeScan)).toHaveBeenCalledTimes(1);
    } finally {
      release({ rows: scanFixture(), dropped: 1 });
    }
    const [first, second] = await pending;
    expect(vi.mocked(unusualVolumeScan)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spyChange)).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(store.getRun(D)?.status).toBe("complete");
    expect(store.getRows(D)).toHaveLength(2);
  });
});
