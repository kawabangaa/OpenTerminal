import { afterEach, describe, expect, it, vi } from "vitest";

const TICKERS = { "0": { ticker: "AAPL", cik_str: 320193 } };
const SINCE = "2024-06-03T20:00:00.000Z";

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
      <transactionDate><value>2024-06-01</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>200</value></transactionShares>
        <transactionPricePerShare><value>15</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>5000</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function textResponse(body: string) {
  return { ok: true, status: 200, text: async () => body, json: async () => ({}) };
}

/** Parallel submissions arrays whose index past `head` throws if read. */
function explodeAfter(head: unknown[]): unknown[] {
  const boomAt = head.length;
  return new Proxy(head.concat([null]), {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^[0-9]+$/.test(prop) && Number(prop) >= boomAt) {
        throw new Error(`inspected filings.recent index ${prop}`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function loadSecedgar() {
  vi.resetModules();
  return import("./secedgar.js");
}

describe("secedgar filings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("returns in-window filings and stops before older malformed rows", async () => {
    const recent = {
      form: explodeAfter(["8-K", "4", "10-Q"]),
      acceptanceDateTime: explodeAfter([
        "2024-06-03T21:00:00.000Z",
        SINCE,
        "2024-06-03T19:59:59.000Z",
      ]),
      items: explodeAfter(["1.01,9.01", "", "1.01"]),
      accessionNumber: explodeAfter([
        "0000320193-24-000050",
        "0000320193-24-000049",
        "0000320193-24-000048",
      ]),
      primaryDocument: explodeAfter(["aapl-8k.htm", "xslF345X06/form4.xml", "aapl-10q.htm"]),
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("company_tickers.json")) return jsonResponse(TICKERS);
      if (url.includes("/submissions/")) return jsonResponse({ filings: { recent } });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { filingsSince } = await loadSecedgar();

    const filings = await filingsSince("AAPL", SINCE);

    expect(filings).toEqual([
      {
        form: "8-K",
        acceptedAt: "2024-06-03T21:00:00.000Z",
        items: ["1.01", "9.01"],
        accessionNumber: "0000320193-24-000050",
        primaryDocument: "aapl-8k.htm",
        url: "https://www.sec.gov/Archives/edgar/data/320193/000032019324000050/aapl-8k.htm",
      },
      {
        form: "4",
        acceptedAt: SINCE,
        items: [],
        accessionNumber: "0000320193-24-000049",
        primaryDocument: "xslF345X06/form4.xml",
        url: "https://www.sec.gov/Archives/edgar/data/320193/000032019324000049/xslF345X06/form4.xml",
      },
    ]);
    const submissions = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/submissions/"));
    expect(submissions).toHaveLength(1);
  });

  it("treats a missing items field as an empty list", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("company_tickers.json")) return jsonResponse(TICKERS);
      if (url.includes("/submissions/")) {
        return jsonResponse({
          filings: {
            recent: {
              form: ["8-K"],
              acceptanceDateTime: ["2024-06-03T21:00:00.000Z"],
              accessionNumber: ["0000320193-24-000050"],
              primaryDocument: ["aapl-8k.htm"],
            },
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { filingsSince } = await loadSecedgar();

    const filings = await filingsSince("AAPL", SINCE);
    expect(filings).toHaveLength(1);
    expect(filings?.[0].items).toEqual([]);
  });

  it("returns null for an unknown ticker and does not request submissions", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("company_tickers.json")) return jsonResponse(TICKERS);
      if (url.includes("submissions")) throw new Error(`submissions requested: ${url}`);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { filingsSince } = await loadSecedgar();

    expect(await filingsSince("NOCIK", SINCE)).toBeNull();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("submissions"))).toBe(false);
  });

  it("keeps open-market Form 4 rows with code, shares, and value", async () => {
    const xmlUrl = "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/form4.xml";
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("company_tickers.json")) return jsonResponse(TICKERS);
      if (url.includes("/submissions/")) {
        return jsonResponse({
          filings: {
            recent: {
              form: ["10-K", "4"],
              filingDate: ["2024-05-01", "2024-06-01"],
              acceptanceDateTime: ["2024-05-01T16:00:00.000Z", "2024-06-01T16:00:00.000Z"],
              accessionNumber: ["0000320193-24-000001", "0000320193-24-000123"],
              primaryDocument: ["aapl-10k.htm", "xslF345X06/form4.xml"],
            },
          },
        });
      }
      if (url === xmlUrl) return textResponse(FORM4_XML);
      return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const { insiderTransactions } = await loadSecedgar();

    const rows = await insiderTransactions("AAPL");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ transactionCode: "P", shares: 200, value: 3000 });
    expect(fetchMock.mock.calls.some((call) => call[0] === xmlUrl)).toBe(true);
  });
});
