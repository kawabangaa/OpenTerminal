import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { marketRouter } from "./market.js";

function fakeRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

function getHandler(path: string) {
  const layer = (marketRouter as any).stack.find((l: any) => l.route?.path === path);
  if (!layer) throw new Error(`no route registered for ${path}`);
  return layer.route.stack[0].handle as (req: Request, res: Response, next: () => void) => unknown;
}

function nasdaqChart(bars: number) {
  const chart = Array.from({ length: bars }, (_, i) => ({
    x: (1_700_000_000 + i * 86_400) * 1000,
    z: { open: "10", high: "11", low: "9", close: "10.5", volume: "100" },
  }));
  return { ok: true, json: async () => ({ data: { chart } }) };
}

describe("GET /sr-levels/:symbol", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("A10: returns levels and serves a second call from the cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue(nasdaqChart(45));
    vi.stubGlobal("fetch", fetchMock);
    const handler = getHandler("/sr-levels/:symbol");
    const req = { params: { symbol: "srfix" } } as unknown as Request;
    const res = fakeRes();
    await handler(req, res, () => {});
    expect(res.json).toHaveBeenCalled();
    const body = (res.json as any).mock.calls[0][0];
    expect(body.symbol).toBe("SRFIX");
    expect(body).toEqual(expect.objectContaining({
      asOf: expect.any(Number),
      eps: expect.any(Number),
      levels: expect.any(Array),
      reason: null,
    }));
    expect(body.levels.length).toBeGreaterThan(0);
    expect(body.levels[0]).toEqual(expect.objectContaining({
      price: expect.any(Number),
      zone: expect.any(Array),
      type: expect.stringMatching(/support|resistance/),
      label: expect.any(String),
      nPiv: expect.any(Number),
      q: expect.any(Number),
      episodes: expect.any(Number),
    }));
    const calls = fetchMock.mock.calls.length;
    const res2 = fakeRes();
    await handler(req, res2, () => {});
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("A11: provider failure uses the same fail() body as history", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const handler = getHandler("/sr-levels/:symbol");
    const req = { params: { symbol: "srfail" } } as unknown as Request;
    const res = fakeRes();
    await handler(req, res, () => {});
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({
      error: "All data providers are temporarily unavailable. Try again shortly.",
    });
  });
});

describe("GET /history/:symbol", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("still returns the provider candles after fetchHistory was extracted", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(nasdaqChart(3)));
    const handler = getHandler("/history/:symbol");
    const req = { params: { symbol: "histfix" }, query: { range: "1Y" } } as unknown as Request;
    const res = fakeRes();
    await handler(req, res, () => {});
    const body = (res.json as any).mock.calls[0][0];
    expect(body).toHaveLength(3);
    expect(body[0]).toMatchObject({ open: 10, high: 11, low: 9, close: 10.5 });
  });
});

describe("GET /crypto/orderbook/:symbol", () => {
  it("rejects a symbol outside the supported crypto whitelist with 400, before touching the network", async () => {
    const handler = getHandler("/crypto/orderbook/:symbol");
    const req = { params: { symbol: "AAA&limit=5000" } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "unsupported crypto symbol" });
  });

  it("accepts a whitelisted symbol (case-insensitive) and proceeds past validation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ bids: [], asks: [] }) })
    );
    try {
      const handler = getHandler("/crypto/orderbook/:symbol");
      const req = { params: { symbol: "btc" } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => {});

      expect(res.status).not.toHaveBeenCalledWith(400);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
