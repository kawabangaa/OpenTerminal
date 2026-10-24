import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

// Fixture map. Fixed clock 2026-10-24T03:00:00.000Z → signal session 2026-10-23.
// Every symbol is a green candle, ADV30 2_000_000, price ≥ 1, market cap ≥ 300e6.
// avg30 = (adv30 * 29 + volume) / 30 with volume = adv30 * rvol, so corrected RVOL is exact.
//
// EARN  rvol 5.0  "Earnco Industries"  earnings 2026-10-22T20:05:00Z + Nasdaq surprise beat.
//       Google: out-of-window headline (no in-window match). Tag EARN; explain contains "beat".
// MNA   rvol 4.0  "Mna Holdings"       8-K item 1.01 accepted 2026-10-23T13:00:00Z. Tag M&A strong; filing url on evidence.
//       Google: out-of-window headline.
// INSD  rvol 3.5  "Insd Corp"          Form 4 accepted in the window; XML is form4.xml (filename after the last slash),
//       code P, 50_000 shares at 42. Tag INSIDER_BUY. Google: out-of-window headline.
// LATE  rvol 3.0  "Late Inc"           8-K item 1.01 accepted 2026-10-23T21:30:00Z (17:30 ET, after the cash close).
//       Tag M&A strength "context", afterClose true. Google: out-of-window headline.
// QUIET rvol 2.6  "Quiet Co"           No filings. Google 429. Yahoo RSS title contains "Quiet Co" at 2026-10-23T14:00:00Z.
//       sources.news === "fallback". The headline is in-window, so this row is NEWS, not the empty case.
// NONE  rvol 2.7  "None Co"            No filings, empty Google RSS, empty Yahoo RSS.
//       explain[0] is the no-catalyst sentence. sources.news === "failed" (both feeds returned nothing).
//
// Log counters vs HTTP (assert what run.ts records, not every socket):
//   tv     = 2 scanner POSTs (universe scan + AMEX:SPY). Hardcoded in the list phase, equals scanner.tradingview.com.
//   edgar  = one submissions fetch per match + one Form 4 XML. company_tickers is www.sec.gov and is not in this counter.
//            Concurrent CIK lookups share one in-flight download of that file.
//            edgar = data.sec.gov submissions + the form4.xml fetch.
//   news   = one companyNews attempt per match. A Yahoo fallback is a second HTTP call and is not added again.
//   nasdaq = one historical barCount per unseasoned match + one earnings-surprise for EARN (the only in-window earnings date).

const NOW = new Date("2026-10-24T03:00:00.000Z");
const SESSION = "2026-10-23";
const ADV30 = 2_000_000;
const OUTSIDE = "Wed, 21 Oct 2026 12:00:00 GMT";
const INSIDE = "Fri, 23 Oct 2026 14:00:00 GMT";

const CIK: Record<string, number> = {
  EARN: 101,
  MNA: 102,
  INSD: 103,
  LATE: 104,
  QUIET: 105,
  NONE: 106,
};

const MNA_ACCESSION = "0000000102-26-000001";
const INSD_ACCESSION = "0000000103-26-000004";
const LATE_ACCESSION = "0000000104-26-000001";
const MNA_URL = filingUrl(CIK.MNA, MNA_ACCESSION, "mna-8k.htm");
const INSD_XML_URL = `https://www.sec.gov/Archives/edgar/data/${CIK.INSD}/${INSD_ACCESSION.replace(/-/g, "")}/form4.xml`;

const FORM4_XML = `<?xml version="1.0"?>
<ownershipDocument>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>Ada Lovelace</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>0</isDirector>
      <isOfficer>1</isOfficer>
      <isTenPercentOwner>0</isTenPercentOwner>
      <officerTitle>CEO</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-10-23</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>50000</value></transactionShares>
        <transactionPricePerShare><value>42</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>50000</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

type Fixture = {
  symbol: string;
  name: string;
  sector: string;
  rvol: number;
  earningsLast: number | null;
};

const FIXTURES: Fixture[] = [
  { symbol: "EARN", name: "Earnco Industries", sector: "Technology", rvol: 5, earningsLast: Date.parse("2026-10-22T20:05:00.000Z") / 1000 },
  { symbol: "MNA", name: "Mna Holdings", sector: "Finance", rvol: 4, earningsLast: null },
  { symbol: "INSD", name: "Insd Corp", sector: "Healthcare", rvol: 3.5, earningsLast: null },
  { symbol: "LATE", name: "Late Inc", sector: "Energy", rvol: 3, earningsLast: null },
  { symbol: "NONE", name: "None Co", sector: "Utilities", rvol: 2.7, earningsLast: null },
  { symbol: "QUIET", name: "Quiet Co", sector: "Industrials", rvol: 2.6, earningsLast: null },
];

const SHORT: Record<string, string> = {
  EARN: "Earnco Industries",
  MNA: "Mna",
  INSD: "Insd",
  LATE: "Late",
  QUIET: "Quiet",
  NONE: "None",
};

let tmpDir: string;
let db: (typeof import("../db.js"))["db"];
let runUnusualVolume: (typeof import("./run.js"))["runUnusualVolume"];
let getRun: (typeof import("./store.js"))["getRun"];
let getRows: (typeof import("./store.js"))["getRows"];
let unusualVolumeRouter: (typeof import("../routes/unusualVolume.js"))["unusualVolumeRouter"];
let setUnusualVolumeNow: (typeof import("../routes/unusualVolume.js"))["setUnusualVolumeNow"];

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "bloomber-uv-system-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  ({ runUnusualVolume } = await import("./run.js"));
  ({ getRun, getRows } = await import("./store.js"));
  ({ unusualVolumeRouter, setUnusualVolumeNow } = await import("../routes/unusualVolume.js"));
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("unusual-volume system", () => {
  it("runs the pipeline through the GET handler", async () => {
    const hosts: Record<string, number> = {};
    vi.stubGlobal("fetch", async (input: string, init?: { body?: unknown }) => {
      const url = String(input);
      const host = new URL(url).host;
      hosts[host] = (hosts[host] ?? 0) + 1;
      return dispatch(url, String(init?.body ?? ""));
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const outcome = await runUnusualVolume({ now: NOW });
      expect(outcome.kind).toBe("ran");

      const stored = getRun(SESSION);
      expect(stored?.status).toBe("complete");
      const saved = getRows(SESSION);
      const bySymbol = new Map(saved.map((row) => [row.symbol, row]));
      expect([...bySymbol.keys()].sort()).toEqual(["EARN", "INSD", "LATE", "MNA", "NONE", "QUIET"]);
      for (const fixture of FIXTURES) {
        expect(bySymbol.get(fixture.symbol)?.rvol.toFixed(2)).toBe(fixture.rvol.toFixed(2));
      }

      const earn = bySymbol.get("EARN");
      const mna = bySymbol.get("MNA");
      const insd = bySymbol.get("INSD");
      const late = bySymbol.get("LATE");
      const quiet = bySymbol.get("QUIET");
      const none = bySymbol.get("NONE");
      expect(earn?.catalysts?.tags).toEqual(expect.arrayContaining([expect.objectContaining({ id: "EARN" })]));
      expect(earn?.catalysts?.explain[0]).toContain("beat");
      expect(mna?.catalysts?.tags).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "M&A", strength: "strong" })]),
      );
      expect(mna?.catalysts?.evidence.some((ev) => ev.url === MNA_URL)).toBe(true);
      expect(insd?.catalysts?.tags.map((tag) => tag.id)).toContain("INSIDER_BUY");
      expect(late?.catalysts?.tags).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "M&A", strength: "context", afterClose: true })]),
      );
      expect(quiet?.catalysts?.sources.news).toBe("fallback");
      expect(none?.catalysts?.explain[0]).toBe("No catalyst found in news, filings or earnings.");
      expect(none?.catalysts?.sources.news).toBe("failed");

      setUnusualVolumeNow(() => NOW);
      const res = fakeRes();
      await getHandler()({ query: {}, path: "/" } as Request, res);
      const body = vi.mocked(res.json).mock.calls[0][0] as {
        sessionDate: string;
        enrichmentStatus: string;
        rows: Array<{ symbol: string; rvol: number }>;
      };
      expect(body.sessionDate).toBe(SESSION);
      expect(body.enrichmentStatus).toBe("complete");
      expect(body.rows.map((row) => row.symbol)).toEqual(["EARN", "MNA", "INSD", "LATE", "NONE", "QUIET"]);
      expect(body.rows.map((row) => row.rvol.toFixed(2))).toEqual(["5.00", "4.00", "3.50", "3.00", "2.70", "2.60"]);

      const line = log.mock.calls.map((call) => String(call[0])).find((entry) => entry.startsWith("[unusual-volume]"));
      expect(line).toBeDefined();
      // tv: scanner host (scan + SPY).
      // edgar: data.sec.gov submissions + the one form4.xml fetch. company_tickers is www.sec.gov
      // and is not in the edgar counter. Concurrent lookups share one ticker download.
      // www.sec.gov is that download plus the Form 4 XML.
      // news: one companyNews per match. QUIET and NONE also hit Yahoo; that HTTP is not counted again.
      // nasdaq: one historical per match + one earnings-surprise for EARN.
      expect(hosts["scanner.tradingview.com"]).toBe(2);
      expect(hosts["data.sec.gov"]).toBe(FIXTURES.length);
      expect(hosts["www.sec.gov"]).toBe(1 + 1);
      expect(hosts["news.google.com"]).toBe(FIXTURES.length);
      expect(hosts["feeds.finance.yahoo.com"]).toBe(2);
      expect(hosts["api.nasdaq.com"]).toBe(FIXTURES.length + 1);
      expect(line).toContain(
        `req{tv:${hosts["scanner.tradingview.com"]},edgar:${hosts["data.sec.gov"]! + 1},news:${hosts["news.google.com"]},nasdaq:${hosts["api.nasdaq.com"]}}`,
      );
      expect(line).toContain("fail{edgar:0,news:1,nasdaq:0}");
    } finally {
      log.mockRestore();
    }
  });
});

function dispatch(url: string, body: string) {
  if (url === "https://scanner.tradingview.com/america/scan") {
    if (body.includes("AMEX:SPY")) return json({ data: [{ s: "AMEX:SPY", d: [0.6] }] });
    return json({ data: FIXTURES.map(scanHit) });
  }
  if (url === "https://www.sec.gov/files/company_tickers.json") {
    const tickers: Record<string, { ticker: string; cik_str: number }> = {};
    for (const [symbol, cik] of Object.entries(CIK)) tickers[symbol] = { ticker: symbol, cik_str: cik };
    return json(tickers);
  }
  if (url.startsWith("https://data.sec.gov/submissions/CIK")) return json({ filings: { recent: submissions(url) } });
  if (url === INSD_XML_URL) return text(FORM4_XML);
  if (url.startsWith("https://news.google.com/rss/search?")) return google(url);
  if (url.startsWith("https://feeds.finance.yahoo.com/rss/2.0/headline?")) return yahoo(url);
  if (url.startsWith("https://api.nasdaq.com/api/quote/") && url.includes("/historical?")) {
    return json({ data: { tradesTable: { rows: Array.from({ length: 31 }, () => ({})) } } });
  }
  if (url === "https://api.nasdaq.com/api/company/EARN/earnings-surprise") {
    return json({
      data: {
        earningsSurpriseTable: {
          rows: [{ dateReported: "10/22/2026", eps: "1.42", consensusForecast: "1.21", percentageSurprise: "17.36" }],
        },
      },
    });
  }
  throw new Error(`unexpected fetch ${url}`);
}

function google(url: string) {
  if (url.includes(encodedQuery("Quiet"))) return { ok: false, status: 429, text: async () => "", json: async () => ({}) };
  if (url.includes(encodedQuery("None"))) return text(rss());
  for (const fixture of FIXTURES) {
    const short = SHORT[fixture.symbol];
    if (short && url.includes(encodedQuery(short))) {
      return text(rss(`${short} mentioned yesterday`, "https://example.com/" + fixture.symbol, OUTSIDE));
    }
  }
  throw new Error(`unexpected fetch ${url}`);
}

function yahoo(url: string) {
  if (url.includes("s=QUIET")) return text(rss("Quiet Co volume spike", "https://example.com/quiet", INSIDE));
  if (url.includes("s=NONE")) return text(rss());
  throw new Error(`unexpected fetch ${url}`);
}

function encodedQuery(short: string): string {
  return encodeURIComponent(`"${short}" stock when:3d`);
}

function scanHit(fixture: Fixture) {
  const volume = ADV30 * fixture.rvol;
  const avg30 = (ADV30 * 29 + volume) / 30;
  return {
    s: `NASDAQ:${fixture.symbol}`,
    d: [
      fixture.symbol,
      fixture.name,
      "NASDAQ",
      fixture.sector,
      20,
      22,
      19,
      21,
      5,
      volume,
      avg30,
      5e9,
      5e7,
      fixture.earningsLast,
      null,
    ],
  };
}

function submissions(url: string) {
  const empty = { form: [] as string[], acceptanceDateTime: [] as string[], items: [] as string[], accessionNumber: [] as string[], primaryDocument: [] as string[] };
  if (url.endsWith(`CIK${pad(CIK.MNA)}.json`)) {
    return {
      form: ["8-K"],
      acceptanceDateTime: ["2026-10-23T13:00:00.000Z"],
      items: ["1.01"],
      accessionNumber: [MNA_ACCESSION],
      primaryDocument: ["mna-8k.htm"],
    };
  }
  if (url.endsWith(`CIK${pad(CIK.INSD)}.json`)) {
    return {
      form: ["4"],
      acceptanceDateTime: ["2026-10-23T16:00:00.000Z"],
      items: [""],
      accessionNumber: [INSD_ACCESSION],
      primaryDocument: ["xslF345X06/form4.xml"],
    };
  }
  if (url.endsWith(`CIK${pad(CIK.LATE)}.json`)) {
    return {
      form: ["8-K"],
      acceptanceDateTime: ["2026-10-23T21:30:00.000Z"],
      items: ["1.01"],
      accessionNumber: [LATE_ACCESSION],
      primaryDocument: ["late-8k.htm"],
    };
  }
  if (url.endsWith(`CIK${pad(CIK.EARN)}.json`) || url.endsWith(`CIK${pad(CIK.QUIET)}.json`) || url.endsWith(`CIK${pad(CIK.NONE)}.json`)) {
    return empty;
  }
  throw new Error(`unexpected fetch ${url}`);
}

function pad(cik: number): string {
  return String(cik).padStart(10, "0");
}

function filingUrl(cik: number, accession: string, primaryDocument: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, "")}/${primaryDocument}`;
}

function rss(title?: string, link?: string, pubDate?: string): string {
  const item = title ? `<item><title>${title}</title><link>${link}</link><pubDate>${pubDate}</pubDate></item>` : "";
  return `<?xml version="1.0"?><rss><channel>${item}</channel></rss>`;
}

function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function text(body: string) {
  return { ok: true, status: 200, text: async () => body, json: async () => ({}) };
}

function fakeRes(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

function getHandler() {
  const layer = (
    unusualVolumeRouter as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response) => unknown }> } }>;
    }
  ).stack.find((entry) => entry.route?.path === "/" && entry.route.methods.get);
  if (!layer?.route) throw new Error("no GET /");
  return layer.route.stack[0].handle;
}
