import { afterEach, describe, expect, it, vi } from "vitest";
import { europeMarketScan, spyChange, unusualVolumeScan } from "./tradingview.js";

function rowsFor(url: string): unknown[] {
  if (url.includes("/uk/scan")) {
    return [{ s: "LSE:HSBA", d: ["HSBC Holdings Plc", 850, 1.2, 300_000_000_000, "Finance", 1000, "GBP"] }];
  }
  if (url.includes("/germany/scan")) {
    return [{ s: "XETR:SAP", d: ["SAP SE", 183, -2.5, 213_000_000_000, "Technology Services", 700, "EUR"] }];
  }
  if (url.includes("/switzerland/scan")) {
    // Switzerland's response is broken this run — the merge must still return the other markets' rows.
    return null as unknown as unknown[];
  }
  return [];
}

function mockFetch() {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    const rows = rowsFor(url);
    if (rows === null) return Promise.resolve({ ok: false, status: 502 });
    return Promise.resolve({ ok: true, json: async () => ({ data: rows }) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("europeMarketScan", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queries every configured European market and merges the results", async () => {
    const fetchMock = mockFetch();
    const rows = await europeMarketScan();

    // One POST per market in EUROPE_MARKETS (uk, germany, france, netherlands,
    // switzerland, italy, spain, sweden, belgium) — no combined region exists.
    expect(fetchMock.mock.calls.length).toBe(9);
    expect(rows.map((r) => r.symbol).sort()).toEqual(["HSBA", "SAP"]);
  });

  it("sorts merged rows by market cap descending, largest first regardless of source market", async () => {
    mockFetch();
    const rows = await europeMarketScan();
    expect(rows[0].symbol).toBe("HSBA"); // 300B > SAP's 213B
    expect(rows[1].symbol).toBe("SAP");
  });

  it("tags each row with its country and fundamental currency for later FX normalization", async () => {
    mockFetch();
    const rows = await europeMarketScan();
    const sap = rows.find((r) => r.symbol === "SAP");
    expect(sap).toMatchObject({ country: "Germany", currency: "EUR", exchange: "XETR" });
  });

  it("keeps the rows from healthy markets when one market's request fails", async () => {
    mockFetch();
    const rows = await europeMarketScan();
    // Switzerland's fetch resolves ok:false above — europeMarketScan must not
    // reject the whole scan because of it (Promise.allSettled).
    expect(rows.length).toBe(2);
  });
});

function stubFetch(data: unknown) {
  const fetchMock = vi.fn().mockImplementation(() =>
    Promise.resolve({ ok: true, status: 200, json: async () => ({ data }) })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("unusualVolumeScan", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the documented filters, column order, and range", async () => {
    const fetchMock = stubFetch([]);
    await unusualVolumeScan();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe("https://scanner.tradingview.com/america/scan");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Referer: "https://www.tradingview.com/",
      Origin: "https://www.tradingview.com",
    });
    expect(JSON.parse(init.body)).toEqual({
      columns: [
        "name",
        "description",
        "exchange",
        "sector",
        "open",
        "high",
        "low",
        "close",
        "change",
        "volume",
        "average_volume_30d_calc",
        "market_cap_basic",
        "float_shares_outstanding",
        "earnings_release_date",
        "earnings_release_next_date",
      ],
      filter: [
        { left: "type", operation: "equal", right: "stock" },
        { left: "typespecs", operation: "has", right: ["common"] },
        { left: "exchange", operation: "in_range", right: ["NASDAQ", "NYSE", "AMEX"] },
        { left: "average_volume_30d_calc", operation: "greater", right: 900000 },
        { left: "close", operation: "greater", right: 1 },
      ],
      sort: { sortBy: "average_volume_30d_calc", sortOrder: "desc" },
      range: [0, 5000],
    });
  });

  it("maps a scanner row onto ScanRow, keeping a null float and epoch-second earnings", async () => {
    stubFetch([
      {
        s: "NASDAQ:AAPL",
        d: [
          "AAPL",
          "Apple Inc.",
          "NASDAQ",
          "Electronic Technology",
          180.25,
          186.4,
          179.1,
          183.5,
          1.25,
          51_200_000,
          47_800_000,
          2_900_000_000_000,
          null,
          1_719_792_000,
          1_727_740_800,
        ],
      },
    ]);

    const { rows, dropped } = await unusualVolumeScan();
    expect(dropped).toBe(0);
    expect(rows).toEqual([
      {
        symbol: "AAPL",
        exchange: "NASDAQ",
        name: "Apple Inc.",
        sector: "Electronic Technology",
        open: 180.25,
        high: 186.4,
        low: 179.1,
        close: 183.5,
        changePct: 1.25,
        volume: 51_200_000,
        avg30: 47_800_000,
        marketCap: 2_900_000_000_000,
        float: null,
        earningsLast: 1_719_792_000,
        earningsNext: 1_727_740_800,
      },
    ]);
  });

  it("falls back to the symbol for a blank description and to Other for a blank sector", async () => {
    stubFetch([
      {
        s: "NYSE:F",
        d: ["NOT-THE-NAME", "", "NYSE", "", 10, 11, 9.5, 10.5, 0.4, 2_000_000, 1_500_000, null, null, null, null],
      },
    ]);

    const { rows, dropped } = await unusualVolumeScan();
    expect(dropped).toBe(0);
    expect(rows[0]).toMatchObject({ symbol: "F", name: "F", sector: "Other", marketCap: null, float: null, earningsLast: null, earningsNext: null });
  });

  it("excludes a row whose close is null and counts it as dropped", async () => {
    stubFetch([
      {
        s: "NASDAQ:AAPL",
        d: ["AAPL", "Apple Inc.", "NASDAQ", "Electronic Technology", 180, 186, 179, null, 1.25, 51_200_000, 47_800_000, 2_900_000_000_000, 15_000_000_000, 1_719_792_000, 1_727_740_800],
      },
    ]);

    const { rows, dropped } = await unusualVolumeScan();
    expect(rows).toEqual([]);
    expect(dropped).toBe(1);
  });

  it("throws when the scanner page is exactly the requested range (A8b)", async () => {
    stubFetch([
      {
        s: "NASDAQ:AAPL",
        d: ["AAPL", "Apple Inc.", "NASDAQ", "Electronic Technology", 180, 186, 179, 183, 1.25, 51_200_000, 47_800_000, 2_900_000_000_000, null, 1_719_792_000, null],
      },
    ]);

    await expect(unusualVolumeScan(1)).rejects.toThrow(/universe truncated/);
  });
});

describe("spyChange", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the SPY change number", async () => {
    const fetchMock = stubFetch([{ s: "AMEX:SPY", d: [0.37] }]);
    await expect(spyChange()).resolves.toBe(0.37);

    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe("https://scanner.tradingview.com/america/scan");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      symbols: { tickers: ["AMEX:SPY"] },
      columns: ["change"],
    });
  });

  it("returns null when data is empty", async () => {
    stubFetch([]);
    await expect(spyChange()).resolves.toBeNull();
  });

  it("returns null when change is null", async () => {
    stubFetch([{ s: "AMEX:SPY", d: [null] }]);
    await expect(spyChange()).resolves.toBeNull();
  });
});
