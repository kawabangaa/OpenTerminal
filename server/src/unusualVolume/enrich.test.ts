import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../providers/secedgar.js", () => ({
  filingsSince: vi.fn(),
  form4Transactions: vi.fn(),
}));

vi.mock("../providers/news.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/news.js")>();
  return { ...actual, companyNews: vi.fn() };
});

vi.mock("../providers/nasdaq.js", () => ({
  earningsSurprise: vi.fn(),
}));

import { earningsSurprise, type EarningsSurpriseRow } from "../providers/nasdaq.js";
import { companyNews, type NewsItem } from "../providers/news.js";
import { filingsSince, form4Transactions, type Filing, type InsiderTransaction } from "../providers/secedgar.js";
import { enrichRows } from "./enrich.js";
import type { UnusualVolumeRow } from "./types.js";

const filingsSinceMock = vi.mocked(filingsSince);
const form4Mock = vi.mocked(form4Transactions);
const companyNewsMock = vi.mocked(companyNews);
const earningsSurpriseMock = vi.mocked(earningsSurprise);

const MINUS = "\u2212";
const WINDOW_START = "2026-10-22T20:00:00.000Z";
const IN_WINDOW = "2026-10-23T13:00:00.000Z";

afterEach(() => {
  vi.restoreAllMocks();
  filingsSinceMock.mockReset();
  form4Mock.mockReset();
  companyNewsMock.mockReset();
  earningsSurpriseMock.mockReset();
});

function baseCtx() {
  return {
    sessionDate: "2026-10-23",
    earlyClose: false,
    spyChangePct: 0.6 as number | null,
    flags: { opex: false, spRebalance: false, russell: false },
  };
}

function row(over: Partial<UnusualVolumeRow> = {}): UnusualVolumeRow {
  return {
    symbol: "AAPL",
    exchange: "NASDAQ",
    name: "Apple Inc.",
    sector: "Electronic Technology",
    open: 0,
    high: 0,
    low: 0,
    close: 0,
    changePct: 0,
    volume: 0,
    avg30: 0,
    marketCap: null,
    float: null,
    earningsLast: null,
    earningsNext: null,
    prevClose: 0,
    adv30: 0,
    rvol: 3.8,
    candlePct: 4.1,
    dayChangePct: 0,
    gapPct: 6.2,
    closeLocation: 0.9,
    dollarVolume: 480_000_000,
    turnover: 0.04,
    sectorMedianChangePct: 2.4,
    sectorPeersOnList: 7,
    catalysts: null,
    ...over,
  };
}

function filing(over: Partial<Filing> = {}): Filing {
  return {
    form: "8-K",
    acceptedAt: IN_WINDOW,
    items: ["8.01"],
    accessionNumber: "0000320193-26-000001",
    primaryDocument: "d8k.htm",
    url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/d8k.htm",
    ...over,
  };
}

function form4Filing(acceptedAt: string, accession: string): Filing {
  const bare = accession.replace(/-/g, "");
  return {
    form: "4",
    acceptedAt,
    items: [],
    accessionNumber: accession,
    primaryDocument: "xslF345X06/form4.xml",
    url: `https://www.sec.gov/Archives/edgar/data/320193/${bare}/xslF345X06/form4.xml`,
  };
}

function headline(title: string, publishedAt = "2026-10-23T14:00:00.000Z"): NewsItem {
  return {
    title,
    link: `https://news.example/${encodeURIComponent(title)}`,
    publisher: "Reuters",
    publishedAt,
    symbol: "AAPL",
  };
}

function surprise(over: Partial<EarningsSurpriseRow> & Pick<EarningsSurpriseRow, "dateReported">): EarningsSurpriseRow {
  return {
    fiscalQtrEnd: "2026-09-30",
    eps: 1.42,
    consensusForecast: 1.21,
    surprisePercent: 17,
    ...over,
  };
}

function insiderBuy(): InsiderTransaction {
  return {
    filingDate: IN_WINDOW,
    transactionDate: "2026-10-22",
    ownerName: "Jane Doe",
    ownerTitle: "CEO",
    isDirector: false,
    isOfficer: true,
    isTenPercentOwner: false,
    transactionCode: "P",
    acquiredDisposed: "A",
    shares: 50_000,
    pricePerShare: 42,
    value: 2_100_000,
    sharesOwnedAfter: 150_000,
  };
}

function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("enrichRows", () => {
  it("starts request and failure counters at zero", async () => {
    const result = await enrichRows([], baseCtx());
    expect(result.bySymbol.size).toBe(0);
    expect(result.requests).toEqual({ edgar: 0, news: 0, nasdaq: 0 });
    expect(result.failures).toEqual({ edgar: 0, news: 0, nasdaq: 0 });
    expect(filingsSinceMock).not.toHaveBeenCalled();
    expect(companyNewsMock).not.toHaveBeenCalled();
  });

  it("tags an in-window 8-K and two headlines without calling Nasdaq", async () => {
    // Item 8.01 is the weak 8K tag. Item 2.02 would be EARN and would call Nasdaq.
    filingsSinceMock.mockResolvedValue([filing({ items: ["8.01"] })]);
    companyNewsMock.mockResolvedValue({
      items: [headline("Apple shares draw heavy volume"), headline("Afternoon session stays active", "2026-10-23T15:00:00.000Z")],
      source: "google",
    });

    const result = await enrichRows([row()], baseCtx());
    const catalysts = result.bySymbol.get("AAPL");

    expect(catalysts?.tags.map((tag) => tag.id)).toEqual(["8K", "NEWS"]);
    expect(catalysts?.sources).toEqual({ edgar: "ok", news: "ok", earnings: "skipped" });
    expect(catalysts?.explain[0]).toBe("8-K: Other events (8.01)");
    expect(catalysts?.explain.join(" ")).toContain("SPY +0.6%");
    expect(catalysts?.explain.join(" ")).toContain("1 matches today");
    expect(result.requests).toEqual({ edgar: 1, news: 1, nasdaq: 0 });
    expect(result.failures).toEqual({ edgar: 0, news: 0, nasdaq: 0 });
    expect(filingsSinceMock).toHaveBeenCalledWith("AAPL", WINDOW_START);
    expect(companyNewsMock).toHaveBeenCalledWith("Apple Inc.", "AAPL");
    expect(earningsSurpriseMock).not.toHaveBeenCalled();
    expect(form4Mock).not.toHaveBeenCalled();
  });

  it("calls earningsSurprise only when earningsLast is in the window or an 8-K reports item 2.02", async () => {
    const outside = Date.parse("2026-10-22T19:00:00.000Z") / 1000;
    const inside = Date.parse(IN_WINDOW) / 1000;
    filingsSinceMock.mockImplementation(async (symbol: string) => {
      if (symbol === "WEAK") return [filing({ items: ["8.01"] })];
      if (symbol === "EIGHT") return [filing({ items: ["2.02"] })];
      return [];
    });
    companyNewsMock.mockResolvedValue({ items: [], source: "google" });
    earningsSurpriseMock.mockResolvedValue([]);

    const result = await enrichRows(
      [
        row({ symbol: "NONE", earningsLast: null }),
        row({ symbol: "OLD", earningsLast: outside }),
        row({ symbol: "WEAK", earningsLast: null }),
        row({ symbol: "EIGHT", earningsLast: null }),
        row({ symbol: "IN", earningsLast: inside }),
      ],
      baseCtx(),
    );

    expect(earningsSurpriseMock.mock.calls.map((call) => call[0]).sort()).toEqual(["EIGHT", "IN"]);
    expect(earningsSurpriseMock).toHaveBeenCalledTimes(2);
    expect(result.requests.nasdaq).toBe(2);
    expect(result.failures.nasdaq).toBe(0);
    expect(result.bySymbol.get("IN")?.sources.earnings).toBe("failed");
    expect(result.bySymbol.get("IN")?.tags.map((tag) => tag.id)).toContain("EARN");
    expect(result.bySymbol.get("EIGHT")?.sources.earnings).toBe("skipped");
    expect(result.bySymbol.get("EIGHT")?.tags.map((tag) => tag.id)).toContain("EARN");
    expect(result.bySymbol.get("WEAK")?.tags.map((tag) => tag.id)).toContain("8K");
    expect(result.bySymbol.get("WEAK")?.tags.map((tag) => tag.id)).not.toContain("EARN");
    expect(result.bySymbol.get("NONE")?.sources.earnings).toBe("skipped");
  });

  it("formats the matching earnings row and ignores a different UTC date", async () => {
    // 2026-10-23T02:00:00Z is 22:00 ET on Oct 22. The reported date is that NY date,
    // not the UTC date of the release and not the NY date of UTC midnight.
    const earningsLast = Date.parse("2026-10-23T02:00:00.000Z") / 1000;
    const oct22 = Date.UTC(2026, 9, 22) / 1000;
    const oct23 = Date.UTC(2026, 9, 23) / 1000;
    filingsSinceMock.mockResolvedValue([]);
    companyNewsMock.mockResolvedValue({ items: [], source: "google" });
    earningsSurpriseMock.mockImplementation(async (symbol: string) => {
      if (symbol === "BEAT") {
        return [
          surprise({ dateReported: oct23, eps: 9.99, consensusForecast: 9, surprisePercent: 50 }),
          surprise({ dateReported: oct22, eps: 1.42, consensusForecast: 1.21, surprisePercent: 17 }),
        ];
      }
      if (symbol === "MISS") {
        return [surprise({ dateReported: oct23, eps: 0.9, consensusForecast: 0.98, surprisePercent: -8 })];
      }
      return [surprise({ dateReported: oct23, eps: 1.25, consensusForecast: 1, surprisePercent: null })];
    });

    const result = await enrichRows(
      [
        row({ symbol: "BEAT", earningsLast }),
        row({ symbol: "MISS", earningsLast: Date.parse(IN_WINDOW) / 1000 }),
        row({ symbol: "MATH", earningsLast: Date.parse(IN_WINDOW) / 1000 }),
      ],
      baseCtx(),
    );

    const beat = result.bySymbol.get("BEAT");
    expect(beat?.tags.find((tag) => tag.id === "EARN")?.detail).toBe("EPS $1.42 vs $1.21 est (beat +17%)");
    expect(beat?.evidence.find((ev) => ev.kind === "earnings")?.time).toBe("2026-10-23T02:00:00.000Z");
    expect(beat?.sources.earnings).toBe("ok");
    expect(result.bySymbol.get("MISS")?.tags.find((tag) => tag.id === "EARN")?.detail).toBe(
      `EPS $0.90 vs $0.98 est (miss ${MINUS}8%)`,
    );
    expect(result.bySymbol.get("MATH")?.tags.find((tag) => tag.id === "EARN")?.detail).toBe(
      "EPS $1.25 vs $1.00 est (beat +25%)",
    );
    expect(earningsSurpriseMock).toHaveBeenCalledTimes(3);
    expect(result.failures.nasdaq).toBe(0);
  });

  it("uses the 8-K acceptance time when earningsLast is null", async () => {
    const oct23 = Date.UTC(2026, 9, 23) / 1000;
    filingsSinceMock.mockResolvedValue([filing({ items: ["2.02"], acceptedAt: IN_WINDOW })]);
    companyNewsMock.mockResolvedValue({ items: [], source: "google" });
    earningsSurpriseMock.mockResolvedValue([
      surprise({ dateReported: oct23, eps: 2, consensusForecast: 1.5, surprisePercent: 33 }),
    ]);

    const result = await enrichRows([row({ earningsLast: null })], baseCtx());
    const earn = result.bySymbol.get("AAPL")?.evidence.find((ev) => ev.kind === "earnings");

    expect(earningsSurpriseMock).toHaveBeenCalledTimes(1);
    expect(earn?.time).toBe(IN_WINDOW);
    expect(earn?.detail).toBe("EPS $2.00 vs $1.50 est (beat +33%)");
    expect(result.requests).toEqual({ edgar: 1, news: 1, nasdaq: 1 });
  });

  it("does not count a Nasdaq miss when the call succeeds with no matching row", async () => {
    filingsSinceMock.mockResolvedValue([]);
    companyNewsMock.mockResolvedValue({ items: [], source: "google" });
    earningsSurpriseMock.mockResolvedValue([
      surprise({ dateReported: Date.UTC(2026, 0, 1) / 1000, eps: 1, consensusForecast: 1, surprisePercent: 0 }),
    ]);

    const result = await enrichRows([row({ earningsLast: Date.parse(IN_WINDOW) / 1000 })], baseCtx());
    const catalysts = result.bySymbol.get("AAPL");

    expect(catalysts?.sources.earnings).toBe("failed");
    expect(catalysts?.tags.find((tag) => tag.id === "EARN")?.detail).toBeUndefined();
    expect(result.failures.nasdaq).toBe(0);
    expect(result.requests.nasdaq).toBe(1);
  });

  it("keeps the EARN tag when the earnings-surprise call throws", async () => {
    filingsSinceMock.mockResolvedValue([]);
    companyNewsMock.mockResolvedValue({
      items: [headline("Apple shares draw heavy volume")],
      source: "google",
    });
    earningsSurpriseMock.mockRejectedValue(new Error("nasdaq down"));

    const result = await enrichRows([row({ earningsLast: Date.parse(IN_WINDOW) / 1000 })], baseCtx());
    const catalysts = result.bySymbol.get("AAPL");

    expect(catalysts?.sources).toEqual({ edgar: "ok", news: "ok", earnings: "failed" });
    expect(catalysts?.tags.map((tag) => tag.id)).toEqual(expect.arrayContaining(["EARN", "NEWS"]));
    expect(result.failures).toEqual({ edgar: 0, news: 0, nasdaq: 1 });
    expect(result.requests.nasdaq).toBe(1);
  });

  it("fetches each in-window Form 4 once and skips filings that are not Form 4", async () => {
    const boundary = form4Filing(WINDOW_START, "0000320193-26-000010");
    const later = form4Filing(IN_WINDOW, "0000320193-26-000011");
    const old = form4Filing("2026-10-22T19:59:59.000Z", "0000320193-26-000009");
    const eightK = filing({ items: ["8.01"] });
    filingsSinceMock.mockImplementation(async (symbol: string) => {
      if (symbol === "NONE") return [eightK];
      return [old, boundary, later, eightK];
    });
    companyNewsMock.mockResolvedValue({ items: [], source: "google" });
    form4Mock.mockImplementation(async () => {
      if (form4Mock.mock.calls.length === 1) throw new Error("form4 down");
      return [insiderBuy()];
    });

    const result = await enrichRows([row({ symbol: "FORM" }), row({ symbol: "NONE" })], baseCtx());

    expect(form4Mock).toHaveBeenCalledTimes(2);
    expect(form4Mock.mock.calls.map((call) => call[0])).toEqual(["320193", "320193"]);
    expect(form4Mock.mock.calls.map((call) => call[1].url)).toEqual([boundary.url, later.url]);
    expect(result.bySymbol.get("FORM")?.tags.map((tag) => tag.id)).toEqual(expect.arrayContaining(["INSIDER_BUY", "8K"]));
    expect(result.bySymbol.get("NONE")?.tags.map((tag) => tag.id)).toContain("8K");
    expect(result.bySymbol.get("NONE")?.tags.map((tag) => tag.id)).not.toContain("INSIDER_BUY");
    expect(result.requests).toEqual({ edgar: 4, news: 2, nasdaq: 0 });
    expect(result.failures).toEqual({ edgar: 1, news: 0, nasdaq: 0 });
    expect(result.bySymbol.get("FORM")?.sources.edgar).toBe("ok");
  });

  it("leaves EDGAR skipped when the ticker has no CIK", async () => {
    filingsSinceMock.mockResolvedValue(null);
    companyNewsMock.mockResolvedValue({
      items: [headline("Apple shares draw heavy volume")],
      source: "google",
    });

    const result = await enrichRows([row()], baseCtx());
    const catalysts = result.bySymbol.get("AAPL");

    expect(catalysts?.sources.edgar).toBe("skipped");
    expect(catalysts?.tags.map((tag) => tag.id)).toContain("NEWS");
    expect(result.failures.edgar).toBe(0);
    expect(result.requests.edgar).toBe(1);
    expect(form4Mock).not.toHaveBeenCalled();
  });

  it("records a Yahoo fallback and a news failure separately", async () => {
    filingsSinceMock.mockResolvedValue([]);
    companyNewsMock.mockImplementation(async (_name: string, symbol: string) => {
      if (symbol === "FAIL") return { items: [], source: "failed" as const };
      return { items: [headline("Quiet session for the tape")], source: "yahoo" as const };
    });

    const result = await enrichRows([row({ symbol: "YAHOO" }), row({ symbol: "FAIL" })], baseCtx());

    expect(result.bySymbol.get("YAHOO")?.sources.news).toBe("fallback");
    expect(result.bySymbol.get("YAHOO")?.tags.map((tag) => tag.id)).toContain("NEWS");
    expect(result.bySymbol.get("FAIL")?.sources.news).toBe("failed");
    expect(result.failures).toEqual({ edgar: 0, news: 1, nasdaq: 0 });
    expect(result.requests.news).toBe(2);
  });

  it("keeps the row when filingsSince rejects (A16)", async () => {
    filingsSinceMock.mockRejectedValue(new Error("edgar down"));
    companyNewsMock.mockResolvedValue({
      items: [
        headline("Apple shares draw heavy volume"),
        headline("Afternoon session stays active", "2026-10-23T15:30:00.000Z"),
      ],
      source: "google",
    });

    const result = await enrichRows([row()], baseCtx());
    const catalysts = result.bySymbol.get("AAPL");

    expect(catalysts).toBeDefined();
    expect(catalysts?.sources.edgar).toBe("failed");
    expect(catalysts?.sources.news).toBe("ok");
    expect(catalysts?.tags.map((tag) => tag.id)).toContain("NEWS");
    expect(catalysts?.evidence.some((ev) => ev.kind === "filing")).toBe(false);
    expect(result.failures).toEqual({ edgar: 1, news: 0, nasdaq: 0 });
    expect(result.requests).toEqual({ edgar: 1, news: 1, nasdaq: 0 });
    expect(form4Mock).not.toHaveBeenCalled();
  });

  it("counts sector share from the full row list", async () => {
    filingsSinceMock.mockResolvedValue([]);
    companyNewsMock.mockResolvedValue({ items: [], source: "google" });
    const energy = Array.from({ length: 5 }, (_, i) => row({ symbol: `E${i}`, sector: "Energy" }));
    const finance = Array.from({ length: 3 }, (_, i) => row({ symbol: `F${i}`, sector: "Finance" }));

    const result = await enrichRows([...energy, ...finance], baseCtx());

    expect(result.bySymbol.get("E0")?.tags.map((tag) => tag.id)).toContain("SECTOR");
    expect(result.bySymbol.get("F0")?.tags.map((tag) => tag.id)).not.toContain("SECTOR");
  });

  it("never runs more than five rows at once", async () => {
    let filingsInFlight = 0;
    let maxFilings = 0;
    let newsInFlight = 0;
    let maxNews = 0;
    const gate = defer();
    filingsSinceMock.mockImplementation(() => {
      filingsInFlight++;
      maxFilings = Math.max(maxFilings, filingsInFlight);
      return gate.promise.then(() => {
        filingsInFlight--;
        return [];
      });
    });
    companyNewsMock.mockImplementation(() => {
      newsInFlight++;
      maxNews = Math.max(maxNews, newsInFlight);
      return gate.promise.then(() => {
        newsInFlight--;
        return { items: [], source: "google" as const };
      });
    });

    const rows = Array.from({ length: 12 }, (_, i) => row({ symbol: `S${i}` }));
    const pending = enrichRows(rows, baseCtx());
    try {
      expect(filingsInFlight).toBe(5);
      expect(newsInFlight).toBe(5);
      expect(maxFilings).toBeLessThanOrEqual(5);
      expect(maxNews).toBeLessThanOrEqual(5);
      expect(filingsSinceMock).toHaveBeenCalledTimes(5);
      expect(companyNewsMock).toHaveBeenCalledTimes(5);
    } finally {
      gate.resolve();
    }
    const result = await pending;

    expect(maxFilings).toBeLessThanOrEqual(5);
    expect(maxNews).toBeLessThanOrEqual(5);
    expect(maxFilings).toBe(5);
    expect(filingsInFlight).toBe(0);
    expect(newsInFlight).toBe(0);
    expect(filingsSinceMock).toHaveBeenCalledTimes(12);
    expect(companyNewsMock).toHaveBeenCalledTimes(12);
    expect(result.bySymbol.size).toBe(12);
    expect(result.requests).toEqual({ edgar: 12, news: 12, nasdaq: 0 });
  });
});
