import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Catalysts, RunSummary, UnusualVolumeRow } from "./types.js";

// db.ts reads DATA_DIR at import time and opens a real sqlite file there, so
// point it at a throwaway directory instead of the app's real data/ folder.
let tmpDir: string;
let db: (typeof import("../db.js"))["db"];
let store: typeof import("./store.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "bloomber-uv-store-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  store = await import("./store.js");
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

function fixtureRow(symbol: string, rvol: number): UnusualVolumeRow {
  return {
    symbol,
    exchange: "NASDAQ",
    name: "Example",
    sector: "Tech",
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    changePct: 1.2,
    volume: 100,
    avg30: 40,
    marketCap: 500,
    float: 200,
    earningsLast: null,
    earningsNext: null,
    prevClose: 10,
    adv30: 40,
    rvol,
    candlePct: 5,
    dayChangePct: 1.2,
    gapPct: 0.4,
    closeLocation: 0.75,
    dollarVolume: 1050,
    turnover: 0.5,
    sectorMedianChangePct: 0.3,
    sectorPeersOnList: 1,
    catalysts: null,
  };
}

function fixtureSummary(sessionDate: string, durationMs = 12): RunSummary {
  return {
    sessionDate,
    earlyClose: false,
    spyChangePct: 0.4,
    counts: { universe: 4, liquid: 3, mcap: 3, rvol: 2, green: 2, seasoned: 2, matches: 2 },
    requests: { edgar: 1 },
    failures: {},
    durationMs,
  };
}

function listRun(sessionDate: string, summary = fixtureSummary(sessionDate)) {
  return {
    sessionDate,
    runAt: `${sessionDate}T10:00:00.000Z`,
    earlyClose: false,
    spyChangePct: 0.4 as number | null,
    universeSize: 4,
    summary,
  };
}

describe("unusual volume store", () => {
  it("creates the four unusual-volume tables and no AI-cache table", () => {
    const names = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'unusual_volume%'`)
      .all() as Array<{ name: string }>;
    expect(names.map((row) => row.name).sort()).toEqual([
      "unusual_volume_refresh",
      "unusual_volume_rows",
      "unusual_volume_runs",
      "unusual_volume_seasoned",
    ]);
  });

  it("saves phase 1 as list with null catalysts", () => {
    const sessionDate = "2026-10-23";
    store.saveListPhase(listRun(sessionDate), [fixtureRow("LOW", 2.5), fixtureRow("HIGH", 4)]);

    const run = store.getRun(sessionDate);
    expect(run?.status).toBe("list");
    expect(run?.enrichedAt).toBeNull();
    expect(run?.earlyClose).toBe(false);
    expect(run?.spyChangePct).toBe(0.4);
    expect(run?.universeSize).toBe(4);
    expect(run?.summary).toEqual(fixtureSummary(sessionDate));

    const rows = store.getRows(sessionDate);
    expect(rows.map((row) => row.symbol)).toEqual(["HIGH", "LOW"]);
    expect(rows.every((row) => row.catalysts === null)).toBe(true);
    expect(rows[0]).toEqual(fixtureRow("HIGH", 4));
  });

  it("saves phase 2 as complete and round-trips catalysts", () => {
    const sessionDate = "2026-10-22";
    const enrichedAt = "2026-10-23T03:05:00.000Z";
    const summary = fixtureSummary(sessionDate, 40);
    const catalysts: Catalysts = {
      tags: [{ id: "EARN", strength: "strong", detail: "beat +17%" }],
      evidence: [
        {
          kind: "earnings",
          time: "2026-10-22T20:05:00.000Z",
          afterClose: false,
          title: "Q3 results",
          url: null,
          tags: ["EARN"],
        },
      ],
      explain: ["Q3 earnings beat", "Volume 4× ADV30"],
      sources: { edgar: "ok", news: "fallback", earnings: "ok" },
    };

    store.saveListPhase(listRun(sessionDate), [fixtureRow("LOW", 2.5), fixtureRow("HIGH", 4)]);
    store.saveEnrichmentPhase(sessionDate, new Map([["HIGH", catalysts]]), summary, enrichedAt);

    const run = store.getRun(sessionDate);
    expect(run?.status).toBe("complete");
    expect(run?.enrichedAt).toBe(enrichedAt);
    expect(run?.summary).toEqual(summary);

    const rows = store.getRows(sessionDate);
    expect(rows[0]?.symbol).toBe("HIGH");
    expect(rows[0]?.catalysts).toEqual(catalysts);
    expect(rows[1]?.symbol).toBe("LOW");
    expect(rows[1]?.catalysts).toBeNull();
  });

  it("replaces rows when phase 1 is saved again for the same session", () => {
    const sessionDate = "2026-10-21";
    store.saveListPhase(listRun(sessionDate), [fixtureRow("AAA", 3), fixtureRow("BBB", 5)]);
    store.saveEnrichmentPhase(
      sessionDate,
      new Map([["AAA", { tags: [], evidence: [], explain: ["none"], sources: {} }]]),
      fixtureSummary(sessionDate, 8),
      "2026-10-21T11:00:00.000Z"
    );

    expect(() => store.saveListPhase(listRun(sessionDate), [fixtureRow("AAA", 9)])).not.toThrow();

    const runs = db
      .prepare(`SELECT COUNT(*) AS n FROM unusual_volume_runs WHERE session_date = ?`)
      .get(sessionDate) as { n: number };
    expect(runs.n).toBe(1);
    expect(store.getRun(sessionDate)?.status).toBe("list");
    expect(store.getRun(sessionDate)?.enrichedAt).toBeNull();

    const rows = store.getRows(sessionDate);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.symbol).toBe("AAA");
    expect(rows[0]?.rvol).toBe(9);
    expect(rows[0]?.catalysts).toBeNull();
  });

  it("returns an empty summary when summary_json is blank", () => {
    db.prepare(
      `INSERT INTO unusual_volume_runs (session_date, run_at, status, universe_size, summary_json)
       VALUES (?, ?, 'list', 0, '')`
    ).run("2026-01-01", "2026-01-01T00:00:00.000Z");

    expect(store.getRun("2026-01-01")?.summary).toEqual({
      sessionDate: "",
      earlyClose: false,
      spyChangePct: null,
      counts: { universe: 0, liquid: 0, mcap: 0, rvol: 0, green: 0, seasoned: 0, matches: 0 },
      requests: {},
      failures: {},
      durationMs: 0,
    });
  });

  it("pruneOlderThan removes a run 91 days before now and keeps newer ones", () => {
    const now = new Date("2026-10-24T15:00:00.000Z");
    const removed = "2026-07-25";
    const boundary = "2026-07-26";
    const kept = "2026-07-27";

    for (const sessionDate of [removed, boundary, kept]) {
      store.saveListPhase(
        { ...listRun(sessionDate), spyChangePct: null, earlyClose: true },
        [fixtureRow(sessionDate, 3)]
      );
    }

    store.pruneOlderThan(90, now);

    expect(store.getRun(removed)).toBeUndefined();
    const removedRows = db
      .prepare(`SELECT COUNT(*) AS n FROM unusual_volume_rows WHERE session_date = ?`)
      .get(removed) as { n: number };
    expect(removedRows.n).toBe(0);

    expect(store.getRun(boundary)?.sessionDate).toBe(boundary);
    expect(store.getRows(boundary)).toHaveLength(1);
    expect(store.getRun(kept)?.sessionDate).toBe(kept);
    expect(store.getRows(kept)).toHaveLength(1);
    expect(store.getRun(kept)?.earlyClose).toBe(true);
    expect(store.getRun(kept)?.spyChangePct).toBeNull();
  });

  it("getLatestRun returns the greatest session_date", () => {
    store.saveListPhase(listRun("2026-12-15"), [fixtureRow("NEW", 3)]);
    store.saveListPhase(listRun("2026-03-01"), [fixtureRow("OLD", 3)]);
    expect(store.getLatestRun()?.sessionDate).toBe("2026-12-15");
  });

  it("markSeasoned is idempotent", () => {
    expect(store.isSeasoned("ZZ")).toBe(false);
    expect(() => store.markSeasoned(["ZZ", "YY"], "2026-10-24T00:00:00.000Z")).not.toThrow();
    expect(() => store.markSeasoned(["ZZ"], "2026-10-24T01:00:00.000Z")).not.toThrow();
    expect(store.isSeasoned("ZZ")).toBe(true);
    expect(store.isSeasoned("YY")).toBe(true);
    const row = db
      .prepare(`SELECT checked_at FROM unusual_volume_seasoned WHERE symbol = ?`)
      .get("ZZ") as { checked_at: string };
    expect(row.checked_at).toBe("2026-10-24T01:00:00.000Z");
  });

  it("upserts the refresh timestamp", () => {
    expect(store.getLastRefresh("2026-10-20")).toBeUndefined();
    store.setLastRefresh("2026-10-20", "2026-10-24T03:00:00.000Z");
    store.setLastRefresh("2026-10-20", "2026-10-24T03:10:00.000Z");
    expect(store.getLastRefresh("2026-10-20")).toBe("2026-10-24T03:10:00.000Z");
  });
});
