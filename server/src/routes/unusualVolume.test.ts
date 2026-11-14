import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const getRun = vi.fn();
const getLatestRun = vi.fn();
const getRowsBetween = vi.fn();
const listRuns = vi.fn();
const getLastRefresh = vi.fn();
const setLastRefresh = vi.fn();
const runUnusualVolume = vi.fn();

vi.mock("../unusualVolume/store.js", () => ({
  getRun: (...args: unknown[]) => getRun(...args),
  getLatestRun: (...args: unknown[]) => getLatestRun(...args),
  getRowsBetween: (...args: unknown[]) => getRowsBetween(...args),
  listRuns: (...args: unknown[]) => listRuns(...args),
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

function wire(run: ReturnType<typeof stored>, rows: Array<Record<string, unknown>> = []) {
  getRun.mockImplementation((date: string) => (date === run.sessionDate ? run : undefined));
  getLatestRun.mockReturnValue(run);
  listRuns.mockReturnValue([run]);
  getRowsBetween.mockReturnValue(rows.map((item) => ({ sessionDate: run.sessionDate, ...item })));
}

describe("unusual-volume routes", () => {
  beforeEach(() => {
    getRun.mockReset();
    getLatestRun.mockReset();
    getRowsBetween.mockReset();
    listRuns.mockReset();
    getLastRefresh.mockReset();
    setLastRefresh.mockReset();
    runUnusualVolume.mockReset();
    getRowsBetween.mockReturnValue([]);
    listRuns.mockReturnValue([]);
    runUnusualVolume.mockResolvedValue({ kind: "skipped", reason: "exists" });
  });

  it("clamps threshold 2 up to 2.5 and drops a 2.4 row", async () => {
    setUnusualVolumeNow(() => new Date("2026-10-24T10:00:00Z"));
    wire(stored("2026-10-23"), [row({ symbol: "LOW", rvol: 2.4 }), row({ symbol: "HIGH", rvol: 2.6 })]);
    const res = fakeRes();
    await handler("get", "/")({ query: { threshold: "2" } } as unknown as Request, res);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.rows.map((r: { symbol: string }) => r.symbol)).toEqual(["HIGH"]);
  });

  it("threshold 3 excludes rvol 2.9", async () => {
    setUnusualVolumeNow(() => new Date("2026-10-24T10:00:00Z"));
    wire(stored("2026-10-23"), [row({ symbol: "MID", rvol: 2.9 }), row({ symbol: "HI", rvol: 3.1 })]);
    const res = fakeRes();
    await handler("get", "/")({ query: { threshold: "3" } } as unknown as Request, res);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.rows.map((r: { symbol: string }) => r.symbol)).toEqual(["HI"]);
  });

  it("sort=catalyst&dir=desc orders strong above medium above none", async () => {
    setUnusualVolumeNow(() => new Date("2026-10-24T10:00:00Z"));
    wire(stored("2026-10-23"), [
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
    wire(stored("2026-10-23"), [row({ symbol: "T", sector: "X" }), row({ symbol: "O", sector: "Y" })]);
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
    const older = stored("2026-10-22");
    getRun.mockReturnValue(undefined);
    getLatestRun.mockReturnValue(older);
    listRuns.mockReturnValue([older]);
    getRowsBetween.mockReturnValue([row({ symbol: "OLD", sessionDate: "2026-10-22" })]);
    const res = fakeRes();
    await handler("get", "/")({ query: { threshold: "4" } } as unknown as Request, res);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].sessionDate).toBe("2026-10-22");
    expect(body.latestSession).toBe("2026-10-22");
    expect(body.to).toBe("2026-10-22");
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
    expect(first.json).toHaveBeenCalledWith({ enrichmentStatus: "pending", sessionDate: "2026-10-23" });
    expect(runUnusualVolume).toHaveBeenCalledWith({ now, reenrichOnly: true });

    getLastRefresh.mockReturnValue(now.toISOString());
    const second = fakeRes();
    handler("post", "/refresh")({} as Request, second);
    expect(second.status).toHaveBeenCalledWith(429);
    const body = (second.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.retryAfterSec).toBeGreaterThan(0);
  });

  it("returns a range with a missing session between saved runs", async () => {
    setUnusualVolumeNow(() => new Date("2026-10-30T15:00:00Z"));
    const runs = [stored("2026-10-29"), stored("2026-10-27"), stored("2026-10-26")];
    getLatestRun.mockReturnValue(runs[0]);
    getRun.mockImplementation((date: string) => runs.find((run) => run.sessionDate === date));
    listRuns.mockReturnValue(runs);
    const savedRows = [
      row({ symbol: "A29", sessionDate: "2026-10-29", rvol: 4 }),
      row({ symbol: "A27", sessionDate: "2026-10-27", rvol: 3 }),
      row({ symbol: "A26", sessionDate: "2026-10-26", rvol: 3 }),
    ];
    getRowsBetween.mockImplementation((from: string, to: string) =>
      savedRows.filter((item) => item.sessionDate >= from && item.sessionDate <= to),
    );
    const res = fakeRes();
    await handler("get", "/")({ query: { to: "2026-10-29", span: "3" } } as unknown as Request, res);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.from).toBe("2026-10-27");
    expect(body.sessions.map((session: { sessionDate: string; status: string }) => `${session.sessionDate}:${session.status}`)).toEqual([
      "2026-10-29:complete",
      "2026-10-28:missing",
      "2026-10-27:complete",
    ]);
    expect(body.rows.map((item: { symbol: string }) => item.symbol)).toEqual(["A29", "A27"]);
    expect(getRowsBetween).toHaveBeenCalledWith("2026-10-27", "2026-10-29");
  });

  it("rejects span outside 1–10 without touching the store", async () => {
    setUnusualVolumeNow(() => new Date("2026-10-30T15:00:00Z"));
    for (const span of ["11", "0", "abc"]) {
      const res = fakeRes();
      await handler("get", "/")({ query: { span } } as unknown as Request, res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(getRun).not.toHaveBeenCalled();
    expect(listRuns).not.toHaveBeenCalled();
    expect(getRowsBetween).not.toHaveBeenCalled();
  });

  it("rejects a non-trading or future anchor", async () => {
    setUnusualVolumeNow(() => new Date("2026-10-24T10:00:00Z"));
    const saturday = fakeRes();
    await handler("get", "/")({ query: { to: "2026-10-31" } } as unknown as Request, saturday);
    expect(saturday.status).toHaveBeenCalledWith(400);
    expect(saturday.json).toHaveBeenCalledWith({ error: "to must be a closed trading session" });

    const future = fakeRes();
    await handler("get", "/")({ query: { to: "2026-10-26" } } as unknown as Request, future);
    expect(future.status).toHaveBeenCalledWith(400);
    expect(future.json).toHaveBeenCalledWith({ error: "to must be a closed trading session" });
  });

  it("catch-up runs once inside the scan window when D has no run", async () => {
    const now = new Date("2026-10-24T02:00:00Z");
    setUnusualVolumeNow(() => now);
    const saved = stored("2026-10-23");
    getRun.mockReturnValueOnce(undefined).mockReturnValue(saved);
    getLatestRun.mockReturnValue(saved);
    listRuns.mockReturnValue([saved]);
    const res = fakeRes();
    await handler("get", "/")({ query: { threshold: "6" } } as unknown as Request, res);
    expect(runUnusualVolume).toHaveBeenCalledTimes(1);
    expect(runUnusualVolume).toHaveBeenCalledWith({ now });
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.to).toBe("2026-10-23");
  });

  it("counts repeats after the threshold filter", async () => {
    setUnusualVolumeNow(() => new Date("2026-10-30T15:00:00Z"));
    const runs = [stored("2026-10-29"), stored("2026-10-27")];
    getLatestRun.mockReturnValue(runs[0]);
    listRuns.mockReturnValue(runs);
    getRowsBetween.mockReturnValue([
      row({ symbol: "AAA", sessionDate: "2026-10-29", rvol: 4 }),
      row({ symbol: "BBB", sessionDate: "2026-10-29", rvol: 3.2 }),
      row({ symbol: "AAA", sessionDate: "2026-10-27", rvol: 2.6 }),
    ]);
    const open = fakeRes();
    await handler("get", "/")({ query: { to: "2026-10-29", span: "3", threshold: "2.5" } } as unknown as Request, open);
    const wide = (open.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const repeatsOf = (body: { rows: Array<{ symbol: string; sessionDate: string; repeats: number }> }, symbol: string, date: string) =>
      body.rows.find((item) => item.symbol === symbol && item.sessionDate === date)?.repeats;
    expect(repeatsOf(wide, "AAA", "2026-10-29")).toBe(2);
    expect(repeatsOf(wide, "BBB", "2026-10-29")).toBe(1);

    const tight = fakeRes();
    await handler("get", "/")({ query: { to: "2026-10-29", span: "3", threshold: "3" } } as unknown as Request, tight);
    const narrow = (tight.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(narrow.rows.map((item: { symbol: string; sessionDate: string }) => `${item.sessionDate}:${item.symbol}`)).toEqual(["2026-10-29:AAA", "2026-10-29:BBB"]);
    expect(repeatsOf(narrow, "AAA", "2026-10-29")).toBe(1);
  });

  it("sorts inside each session and keeps sessions newest first", async () => {
    setUnusualVolumeNow(() => new Date("2026-10-30T15:00:00Z"));
    const runs = [stored("2026-10-29"), stored("2026-10-27")];
    getLatestRun.mockReturnValue(runs[0]);
    listRuns.mockReturnValue(runs);
    getRowsBetween.mockReturnValue([
      row({ symbol: "HI", sessionDate: "2026-10-29", rvol: 5 }),
      row({ symbol: "LO", sessionDate: "2026-10-29", rvol: 3 }),
      row({ symbol: "HI", sessionDate: "2026-10-27", rvol: 4 }),
      row({ symbol: "LO", sessionDate: "2026-10-27", rvol: 2.6 }),
    ]);
    const res = fakeRes();
    await handler("get", "/")({ query: { to: "2026-10-29", span: "3", sort: "rvol", dir: "asc" } } as unknown as Request, res);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.rows.map((item: { sessionDate: string; symbol: string }) => `${item.sessionDate}:${item.symbol}`)).toEqual([
      "2026-10-29:LO",
      "2026-10-29:HI",
      "2026-10-27:LO",
      "2026-10-27:HI",
    ]);
  });

  it("lists recent sessions including pending and missing days", async () => {
    setUnusualVolumeNow(() => new Date("2026-10-24T15:00:00Z"));
    const pending = stored("2026-10-21", "list");
    getLatestRun.mockReturnValue(pending);
    listRuns.mockReturnValue([pending]);
    const res = fakeRes();
    await handler("get", "/sessions")({ query: { limit: "5" } } as unknown as Request, res);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.currentSession).toBe("2026-10-23");
    expect(body.latestSession).toBe("2026-10-21");
    expect(body.sessions).toHaveLength(5);
    expect(body.sessions.map((session: { sessionDate: string }) => session.sessionDate)).toEqual([
      "2026-10-23",
      "2026-10-22",
      "2026-10-21",
      "2026-10-20",
      "2026-10-19",
    ]);
    expect(body.sessions.find((session: { sessionDate: string }) => session.sessionDate === "2026-10-21").status).toBe("pending");
    expect(body.sessions.filter((session: { status: string }) => session.status === "missing")).toHaveLength(4);
    expect(runUnusualVolume).not.toHaveBeenCalled();
  });

  it("misses the cache when a run's enrichedAt changes", async () => {
    setUnusualVolumeNow(() => new Date("2026-10-30T15:00:00Z"));
    const run = stored("2026-10-29");
    getRun.mockReturnValue(run);
    getLatestRun.mockReturnValue(run);
    listRuns.mockImplementation(() => [run]);
    getRowsBetween.mockReturnValue([row({ symbol: "A", sessionDate: "2026-10-29", rvol: 4 })]);
    const query = { to: "2026-10-29", span: "3", threshold: "9" };
    await handler("get", "/")({ query } as unknown as Request, fakeRes());
    run.enrichedAt = "2026-10-30T04:00:00.000Z";
    await handler("get", "/")({ query } as unknown as Request, fakeRes());
    expect(getRowsBetween).toHaveBeenCalledTimes(2);
  });
});
