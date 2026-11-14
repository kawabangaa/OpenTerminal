import { afterEach, describe, expect, it, vi } from "vitest";
import { barCount } from "./nasdaq.js";

function mockFetchOnce(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("nasdaq barCount", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns tradesTable.rows.length for 31 and 20 rows", async () => {
    mockFetchOnce({ data: { tradesTable: { rows: Array.from({ length: 31 }, () => ({})) } } });
    await expect(barCount("AAPL", 31, "2026-10-23")).resolves.toBe(31);

    mockFetchOnce({ data: { tradesTable: { rows: Array.from({ length: 20 }, () => ({})) } } });
    await expect(barCount("AAPL", 20, "2026-10-23")).resolves.toBe(20);
  });

  it("returns 0 when data exists but tradesTable is absent", async () => {
    mockFetchOnce({ data: {} });
    await expect(barCount("AAPL", 31, "2026-10-23")).resolves.toBe(0);
  });

  it("requests historical bars with limit, assetclass, and a 120-day UTC window", async () => {
    const fetchMock = mockFetchOnce({ data: { tradesTable: { rows: Array.from({ length: 31 }, () => ({})) } } });
    await barCount("AAPL", 31, "2026-10-23");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("limit=31");
    expect(url).toContain("assetclass=stocks");
    expect(url).toContain("todate=2026-10-23");
    expect(url).toContain("fromdate=2026-06-25");
  });
});
