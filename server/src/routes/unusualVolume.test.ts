import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const getRun = vi.fn();
const getLatestRun = vi.fn();
const getRows = vi.fn();
const getLastRefresh = vi.fn();
const setLastRefresh = vi.fn();
const runUnusualVolume = vi.fn();

vi.mock("../unusualVolume/store.js", () => ({
  getRun: (...args: unknown[]) => getRun(...args),
  getLatestRun: (...args: unknown[]) => getLatestRun(...args),
  getRows: (...args: unknown[]) => getRows(...args),
  getLastRefresh: (...args: unknown[]) => getLastRefresh(...args),
  setLastRefresh: (...args: unknown[]) => setLastRefresh(...args),
}));

vi.mock("../unusualVolume/run.js", () => ({
  runUnusualVolume: (...args: unknown[]) => runUnusualVolume(...args),
}));

const { unusualVolumeRouter, setUnusualVolumeNow } = await import("./unusualVolume.js");

function fakeRes(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

function handler(method: "get" | "post", path: string) {
  const layer = (unusualVolumeRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response) => unknown }> } }> }).stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method],
  );
  if (!layer?.route) throw new Error(`no ${method} ${path}`);
  return layer.route.stack[0].handle;
}

function row(partial: Record<string, unknown>) {
  return {
    symbol: "AAA",
    name: "Aaa",
    sector: "Tech",
    close: 10,
    candlePct: 1,
    rvol: 3,
    dayChangePct: 1,
    volume: 2_000_000,
    adv30: 1_200_000,
    dollarVolume: 20_000_000,
    marketCap: 1e9,
    catalysts: null,
    ...partial,
  };
}

function stored(sessionDate: string, status: "list" | "complete" = "complete") {
  return {
    sessionDate,
    runAt: `${sessionDate}T03:00:00.000Z`,
    enrichedAt: status === "complete" ? `${sessionDate}T03:01:00.000Z` : null,
    status,
    earlyClose: false,
    spyChangePct: 0.4,
    universeSize: 10,
    summary: {},
  };
}

describe("unusual-volume routes", () => {
  beforeEach(() => {
    getRun.mockReset();
    getLatestRun.mockReset();
    getRows.mockReset();
    getLastRefresh.mockReset();
    setLastRefresh.mockReset();
    runUnusualVolume.mockReset();
    getRows.mockReturnValue([]);
    runUnusualVolume.mockResolvedValue({ kind: "skipped", reason: "exists" });
  });

  it("clamps threshold 2 up to 2.5 and drops a 2.4 row", async () => {
    setUnusualVolumeNow(() => new Date("2026-10-24T10:00:00Z"));
    getRun.mockReturnValue(stored("2026-10-23"));
    getRows.mockReturnValue([row({ symbol: "LOW", rvol: 2.4 }), row({ symbol: "HIGH", rvol: 2.6 })]);
    const res = fakeRes();
    await handler("get", "/")({ query: { threshold: "2" } } as unknown as Request, res);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.rows.map((r: { symbol: string }) => r.symbol)).toEqual(["HIGH"]);
  });

  it("threshold 3 excludes rvol 2.9", async () => {
    setUnusualVolumeNow(() => new Date("2026-10-24T10:00:00Z"));
    getRun.mockReturnValue(stored("2026-10-23"));
    getRows.mockReturnValue([row({ symbol: "MID", rvol: 2.9 }), row({ symbol: "HI", rvol: 3.1 })]);
    const res = fakeRes();
    await handler("get", "/")({ query: { threshold: "3" } } as unknown as Request, res);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.rows.map((r: { symbol: string }) => r.symbol)).toEqual(["HI"]);
  });

  it("sort=catalyst&dir=desc orders strong above medium above none", async () => {
    setUnusualVolumeNow(() => new Date("2026-10-24T10:00:00Z"));
    getRun.mockReturnValue(stored("2026-10-23"));
    getRows.mockReturnValue([
      row({ symbol: "NONE", catalysts: null, rvol: 9 }),
      row({ symbol: "MED", catalysts: { tags: [{ id: "NEWS", strength: "medium" }], evidence: [], explain: [], sources: {} }, rvol: 3 }),
      row({ symbol: "STRONG", catalysts: { tags: [{ id: "EARN", strength: "strong" }], evidence: [], explain: [], sources: {} }, rvol: 3 }),
    ]);
    const res = fakeRes();
    await handler("get", "/")({ query: { sort: "catalyst", dir: "desc" } } as unknown as Request, res);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.rows.map((r: { symbol: string }) => r.symbol)).toEqual(["STRONG", "MED", "NONE"]);
  });

  it("filters by sector and rejects an unknown sort", async () => {
    setUnusualVolumeNow(() => new Date("2026-10-24T10:00:00Z"));
    getRun.mockReturnValue(stored("2026-10-23"));
    getRows.mockReturnValue([row({ symbol: "T", sector: "X" }), row({ symbol: "O", sector: "Y" })]);
    const res = fakeRes();
    await handler("get", "/")({ query: { sector: "X" } } as unknown as Request, res);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.rows.map((r: { symbol: string }) => r.symbol)).toEqual(["T"]);

    const bad = fakeRes();
    await handler("get", "/")({ query: { sort: "nope" } } as unknown as Request, bad);
    expect(bad.status).toHaveBeenCalledWith(400);
  });

  it("serves an older run outside the scan window when today's run is missing", async () => {
    setUnusualVolumeNow(() => new Date("2026-10-24T15:00:00Z"));
    getRun.mockReturnValue(undefined);
    getLatestRun.mockReturnValue(stored("2026-10-22"));
    getRows.mockReturnValue([row({ symbol: "OLD" })]);
    const res = fakeRes();
    await handler("get", "/")({ query: { threshold: "4" } } as unknown as Request, res);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.sessionDate).toBe("2026-10-22");
    expect(runUnusualVolume).not.toHaveBeenCalled();
  });

  it("returns the documented 503 before any run exists", async () => {
    setUnusualVolumeNow(() => new Date("2026-10-24T15:00:00Z"));
    getRun.mockReturnValue(undefined);
    getLatestRun.mockReturnValue(undefined);
    const res = fakeRes();
    await handler("get", "/")({ query: { threshold: "5" } } as unknown as Request, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: "First run has not happened yet. It runs daily at 06:00 or on the next startup outside US market hours.",
    });
  });

  it("refresh returns 202 then 429 inside the cooldown", async () => {
    const now = new Date("2026-10-24T03:00:00Z");
    setUnusualVolumeNow(() => now);
    getRun.mockReturnValue(stored("2026-10-23"));
    getLastRefresh.mockReturnValue(undefined);
    const first = fakeRes();
    handler("post", "/refresh")({} as Request, first);
    expect(first.status).toHaveBeenCalledWith(202);
    expect(runUnusualVolume).toHaveBeenCalledWith({ now, reenrichOnly: true });

    getLastRefresh.mockReturnValue(now.toISOString());
    const second = fakeRes();
    handler("post", "/refresh")({} as Request, second);
    expect(second.status).toHaveBeenCalledWith(429);
    const body = (second.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.retryAfterSec).toBeGreaterThan(0);
  });
});
