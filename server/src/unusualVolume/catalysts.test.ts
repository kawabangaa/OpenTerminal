import { describe, expect, it } from "vitest";
import type { NewsItem } from "../providers/news.js";
import type { Filing, InsiderTransaction } from "../providers/secedgar.js";
import {
  ITEM_NAMES,
  RULES,
  buildCatalysts,
  catalystWindow,
  strengthRank,
  type EarningsDetail,
} from "./catalysts.js";

const START = "2026-10-22T20:00:00.000Z";
const CLOSE = "2026-10-23T20:00:00.000Z";

function filing(overrides: Partial<Filing> = {}): Filing {
  return {
    form: "8-K",
    acceptedAt: "2026-10-23T13:00:00.000Z",
    items: ["1.01"],
    accessionNumber: "0000320193-26-000001",
    primaryDocument: "d8k.htm",
    url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/d8k.htm",
    ...overrides,
  };
}

function headline(title: string, publishedAt: string | null, link?: string): NewsItem {
  return {
    title,
    link: link ?? `https://news.example/${encodeURIComponent(title)}`,
    publisher: "Reuters",
    publishedAt,
    symbol: "XYZ",
  };
}

function insider(overrides: Partial<InsiderTransaction> = {}): InsiderTransaction {
  return {
    filingDate: "2026-10-23",
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
    ...overrides,
  };
}

function build(
  overrides: {
    earningsLast?: number | null;
    filings?: Filing[] | null;
    headlines?: NewsItem[];
    newsSource?: "google" | "yahoo" | "failed";
    form4?: InsiderTransaction[];
    earnings?: EarningsDetail | null;
    sectorShare?: number;
    sectorCount?: number;
    flags?: { opex?: boolean; spRebalance?: boolean; russell?: boolean };
  } = {},
) {
  return buildCatalysts({
    row: { symbol: "XYZ", earningsLast: overrides.earningsLast ?? null },
    filings: overrides.filings === undefined ? [] : overrides.filings,
    headlines: overrides.headlines ?? [],
    newsSource: overrides.newsSource ?? "google",
    form4: overrides.form4 ?? [],
    earnings: overrides.earnings ?? null,
    window: catalystWindow("2026-10-23", false),
    ctx: {
      sectorShare: overrides.sectorShare ?? 0,
      sectorCount: overrides.sectorCount ?? 0,
      flags: { opex: false, spRebalance: false, russell: false, ...overrides.flags },
    },
  });
}

describe("catalystWindow", () => {
  it("opens at the prior session close and closes at 16:00 ET", () => {
    const window = catalystWindow("2026-10-23", false);
    expect(window.start.toISOString()).toBe(START);
    expect(window.closeOfD.toISOString()).toBe(CLOSE);
  });

  it("uses 13:00 ET on an early close and skips the weekend for the prior session", () => {
    expect(catalystWindow("2026-10-23", true).closeOfD.toISOString()).toBe("2026-10-23T17:00:00.000Z");
    expect(catalystWindow("2026-10-26", false).start.toISOString()).toBe(CLOSE);
  });
});

describe("strengthRank", () => {
  it("orders strong > medium > weak > context", () => {
    expect(strengthRank("strong")).toBe(3);
    expect(strengthRank("medium")).toBe(2);
    expect(strengthRank("weak")).toBe(1);
    expect(strengthRank("context")).toBe(0);
  });
});

describe("buildCatalysts", () => {
  it("A12: earnings at 16:05 ET on D-1 is a strong EARN inside the window", () => {
    const earningsLast = Date.parse("2026-10-22T20:05:00.000Z") / 1000;
    const result = build({ earningsLast });
    const earn = result.tags.find((tag) => tag.id === "EARN");
    expect(earn).toMatchObject({ id: "EARN", strength: "strong" });
    expect(earn?.afterClose).toBeUndefined();
    expect(result.evidence).toEqual([
      expect.objectContaining({ kind: "earnings", title: "Earnings", time: "2026-10-22T20:05:00.000Z", afterClose: false }),
    ]);
    expect(result.evidence[0]?.detail).toBeUndefined();
    expect(result.sources.earnings).toBe("failed");
  });

  it("A12b: earnings at 16:05 ET on D is context and after close", () => {
    const earningsLast = Date.parse("2026-10-23T20:05:00.000Z") / 1000;
    const result = build({ earningsLast });
    expect(result.tags.filter((tag) => tag.id === "EARN" && tag.strength === "strong")).toEqual([]);
    expect(result.tags).toEqual([
      {
        id: "EARN",
        strength: "context",
        afterClose: true,
        detail: "reported after close, reaction expected next session",
      },
    ]);
    expect(result.evidence[0]).toMatchObject({ kind: "earnings", afterClose: true });
  });

  it("prefers the earnings detail string when the enricher supplies one", () => {
    const earningsLast = Date.parse("2026-10-22T20:05:00.000Z") / 1000;
    const result = build({
      earningsLast,
      earnings: {
        time: "2026-10-22T20:05:00.000Z",
        detail: "EPS $1.42 vs $1.21 est (beat +17%)",
      },
    });
    expect(result.tags[0]).toMatchObject({
      id: "EARN",
      strength: "strong",
      detail: "EPS $1.42 vs $1.21 est (beat +17%)",
    });
    expect(result.evidence[0]?.detail).toBe("EPS $1.42 vs $1.21 est (beat +17%)");
    expect(result.sources.earnings).toBe("ok");
  });

  it("A13: 8-K item 1.01 during the session is strong M&A with the filing url", () => {
    const url = "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/d8k.htm";
    const result = build({ filings: [filing({ items: ["1.01"], url, acceptedAt: "2026-10-23T13:00:00Z" })] });
    expect(result.tags).toEqual([
      expect.objectContaining({ id: "M&A", strength: "strong" }),
    ]);
    expect(result.evidence).toEqual([
      expect.objectContaining({
        kind: "filing",
        url,
        form: "8-K",
        items: ["1.01"],
        afterClose: false,
        tags: ["M&A"],
      }),
    ]);
    expect(result.evidence[0]?.detail).toContain("Entry into a material agreement");
  });

  it("A12c: 8-K item 1.01 at 17:30 ET is context and after close", () => {
    const result = build({
      filings: [filing({ items: ["1.01"], acceptedAt: "2026-10-23T21:30:00Z" })],
    });
    expect(result.tags.filter((tag) => tag.strength === "strong")).toEqual([]);
    expect(result.tags[0]).toMatchObject({ id: "M&A", strength: "context", afterClose: true });
    expect(result.tags[0]?.detail).toContain("reported after close, reaction expected next session");
    expect(result.evidence[0]).toMatchObject({ kind: "filing", afterClose: true });
  });

  it("keeps an in-window strong EARN when a later 8-K 2.02 is only after close", () => {
    const result = build({
      earningsLast: Date.parse("2026-10-22T20:05:00.000Z") / 1000,
      filings: [filing({ items: ["2.02"], acceptedAt: "2026-10-23T21:30:00Z" })],
    });
    expect(result.tags.filter((tag) => tag.id === "EARN")).toEqual([
      expect.objectContaining({ id: "EARN", strength: "strong" }),
    ]);
    const filingEvidence = result.evidence.find((item) => item.kind === "filing");
    expect(filingEvidence).toMatchObject({ afterClose: true, tags: ["EARN"] });
  });

  it("maps 8-K items and the other filing forms", () => {
    const earn = build({ filings: [filing({ items: ["2.02"], acceptedAt: "2026-10-23T14:00:00Z" })] });
    expect(earn.tags).toEqual([expect.objectContaining({ id: "EARN", strength: "strong" })]);
    expect(earn.tags.some((tag) => tag.id === "8K")).toBe(false);

    const both = build({
      filings: [filing({ items: ["2.02", "1.01"], acceptedAt: "2026-10-23T14:00:00Z" })],
    });
    expect(both.tags.map((tag) => tag.id).sort()).toEqual(["EARN", "M&A"]);
    expect(both.evidence).toHaveLength(1);

    const other = build({ filings: [filing({ items: ["5.02", "8.01"], acceptedAt: "2026-10-23T14:00:00Z" })] });
    expect(other.tags).toEqual([
      expect.objectContaining({
        id: "8K",
        strength: "weak",
        detail: "Departure or appointment of officers (5.02), Other events (8.01)",
      }),
    ]);

    const bare = build({ filings: [filing({ items: [], acceptedAt: "2026-10-23T14:00:00Z" })] });
    expect(bare.tags).toEqual([{ id: "8K", strength: "weak" }]);

    for (const form of ["SC TO-T", "DEFM14A", "425"] as const) {
      const result = build({ filings: [filing({ form, items: [], acceptedAt: "2026-10-23T14:00:00Z" })] });
      expect(result.tags.map((tag) => tag.id)).toEqual(["M&A"]);
      expect(result.tags[0]?.strength).toBe("strong");
    }
    for (const form of ["SC 13D", "SC 13D/A"] as const) {
      const result = build({ filings: [filing({ form, items: [], acceptedAt: "2026-10-23T14:00:00Z" })] });
      expect(result.tags).toEqual([expect.objectContaining({ id: "ACTIVIST", strength: "strong" })]);
    }

    const amendment = build({ filings: [filing({ form: "8-K/A", items: ["1.01"] })] });
    expect(amendment.tags).toEqual([]);
    const lower = build({ filings: [filing({ form: "8-k", items: ["2.02"] })] });
    expect(lower.tags).toEqual([]);
  });

  it("A14: an in-window upgrade is ANALYST and a pre-close headline on D-1 is ignored", () => {
    const result = build({
      headlines: [
        headline("Analyst upgrades XYZ to Buy", "2026-10-23T14:00:00Z"),
        headline("Yesterday's note", "2026-10-22T19:00:00Z"),
        headline("Undated desk note", null),
      ],
    });
    expect(result.tags).toEqual([expect.objectContaining({ id: "ANALYST", strength: "medium" })]);
    expect(result.evidence.map((item) => item.title)).toEqual(["Analyst upgrades XYZ to Buy"]);
    expect(result.evidence[0]).toMatchObject({
      kind: "headline",
      url: "https://news.example/Analyst%20upgrades%20XYZ%20to%20Buy",
      publisher: "Reuters",
      afterClose: false,
      tags: ["ANALYST"],
    });
  });

  it("does not demote a headline that prints after the close", () => {
    const result = build({
      headlines: [headline("Analyst upgrades XYZ to Buy", "2026-10-23T21:00:00Z")],
    });
    expect(result.tags).toEqual([expect.objectContaining({ id: "ANALYST", strength: "medium" })]);
    expect(result.tags[0]?.afterClose).toBeUndefined();
    expect(result.evidence[0]).toMatchObject({ afterClose: true, tags: ["ANALYST"] });
  });

  it("A15: empty inputs produce no tags and no evidence", () => {
    const result = build();
    expect(result.tags).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.sources).toEqual({ edgar: "ok", news: "ok", earnings: "skipped" });
    expect(result).not.toHaveProperty("explain");
  });

  it("names the 8-K items the panel translates", () => {
    expect(ITEM_NAMES["1.01"]).toBe("Entry into a material agreement");
    expect(ITEM_NAMES["2.01"]).toBe("Completion of acquisition");
    expect(ITEM_NAMES["2.02"]).toBe("Results of operations");
    expect(ITEM_NAMES["5.02"]).toBe("Departure or appointment of officers");
    expect(ITEM_NAMES["8.01"]).toBe("Other events");
  });

  it("matches each headline rule once, and the first rule wins", () => {
    const titles: Record<(typeof RULES)[number]["tag"], string> = {
      "M&A": "Board agrees to a MERGER with Peer",
      FDA: "Topline phase 2 data published",
      ANALYST: "Brokerage upgrades XYZ to overweight",
      GUIDANCE: "Company raises forecast ahead of the quarter",
      CONTRACT: "XYZ awarded partnership on the program",
      INDEX: "Name added to the S&P 500",
    };
    expect(RULES.map((rule) => rule.tag)).toEqual(["M&A", "FDA", "ANALYST", "GUIDANCE", "CONTRACT", "INDEX"]);
    for (const rule of RULES) {
      const result = build({ headlines: [headline(titles[rule.tag], "2026-10-23T15:00:00Z")] });
      expect(result.tags.map((tag) => [tag.id, tag.strength])).toEqual([[rule.tag, "medium"]]);
    }
    const first = build({ headlines: [headline("FDA approves the merger", "2026-10-23T15:00:00Z")] });
    expect(first.tags.map((tag) => tag.id)).toEqual(["M&A"]);
  });

  it("sends an unmatched headline to NEWS", () => {
    const result = build({ headlines: [headline("Volume spike lifts XYZ in afternoon trade", "2026-10-23T15:00:00Z")] });
    expect(result.tags).toEqual([{ id: "NEWS", strength: "weak" }]);
    expect(result.evidence[0]?.tags).toEqual(["NEWS"]);
  });

  it("Form 4 code S is not an insider buy; code P carries shares and dollars", () => {
    const sale = build({ form4: [insider({ transactionCode: "S", acquiredDisposed: "D" })] });
    expect(sale.tags.some((tag) => tag.id === "INSIDER_BUY")).toBe(false);
    expect(sale.evidence).toEqual([]);

    const buy = build({ form4: [insider()] });
    expect(buy.tags).toEqual([
      expect.objectContaining({ id: "INSIDER_BUY", strength: "strong" }),
    ]);
    const detail = `${buy.tags[0]?.detail ?? ""} ${buy.evidence[0]?.detail ?? ""}`;
    expect(detail.includes("50,000") || detail.includes("50000")).toBe(true);
    expect(detail.includes("$2.1M") || detail.includes("$2100000")).toBe(true);
    expect(buy.evidence[0]).toMatchObject({ kind: "insider", tags: ["INSIDER_BUY"] });
  });

  it("demotes a Form 4 accepted after the close", () => {
    const result = build({ form4: [insider({ filingDate: "2026-10-23T21:30:00Z" })] });
    expect(result.tags[0]).toMatchObject({ id: "INSIDER_BUY", strength: "context", afterClose: true });
    expect(result.tags[0]?.detail).toContain("$2.1M");
    expect(result.tags[0]?.detail).toContain("reported after close, reaction expected next session");
  });

  it("tags SECTOR at a quarter of a five-name sector and not below that count", () => {
    const tagged = build({ sectorShare: 0.3, sectorCount: 5 });
    expect(tagged.tags).toEqual([{ id: "SECTOR", strength: "context" }]);
    expect(tagged.evidence).toEqual([]);

    const short = build({ sectorShare: 0.3, sectorCount: 4 });
    expect(short.tags).toEqual([]);

    const thin = build({ sectorShare: 0.24, sectorCount: 5 });
    expect(thin.tags).toEqual([]);
  });

  it("sorts EARN, NEWS, OPEX by strength and collapses duplicate ids", () => {
    const result = build({
      earningsLast: Date.parse("2026-10-22T20:05:00.000Z") / 1000,
      filings: [filing({ items: ["2.02"], acceptedAt: "2026-10-23T14:00:00Z" })],
      headlines: [
        headline("Volume spike lifts XYZ in afternoon trade", "2026-10-23T15:00:00Z"),
        headline("Second note on the same tape", "2026-10-23T16:00:00Z"),
      ],
      flags: { opex: true },
    });
    expect(result.tags.map((tag) => [tag.id, tag.strength])).toEqual([
      ["EARN", "strong"],
      ["NEWS", "weak"],
      ["OPEX", "context"],
    ]);
    expect(new Set(result.tags.map((tag) => tag.id)).size).toBe(result.tags.length);
  });

  it("emits calendar context tags only for the flags that are set", () => {
    const result = build({ flags: { opex: true, spRebalance: true, russell: true } });
    expect(result.tags.map((tag) => tag.id)).toEqual(["OPEX", "REBAL", "RUSSELL"]);
    expect(result.tags.every((tag) => tag.strength === "context")).toBe(true);
  });

  it("keeps the five newest headlines and still lists filings and earnings", () => {
    const headlines = Array.from({ length: 7 }, (_, i) =>
      headline(`Tape note ${i}`, new Date(Date.parse("2026-10-23T12:00:00Z") + i * 60_000).toISOString()),
    );
    const result = build({
      headlines,
      filings: [filing({ acceptedAt: "2026-10-23T18:00:00Z" })],
      earningsLast: Date.parse("2026-10-22T20:05:00.000Z") / 1000,
    });
    const headlineEvidence = result.evidence.filter((item) => item.kind === "headline");
    expect(headlineEvidence).toHaveLength(5);
    expect(headlineEvidence.map((item) => item.title)).toEqual([
      "Tape note 6",
      "Tape note 5",
      "Tape note 4",
      "Tape note 3",
      "Tape note 2",
    ]);
    expect(result.evidence.some((item) => item.kind === "filing")).toBe(true);
    expect(result.evidence.some((item) => item.kind === "earnings")).toBe(true);
    const times = result.evidence.map((item) => Date.parse(item.time));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("collapses duplicate headlines before the cap", () => {
    const result = build({
      headlines: [
        headline("Same desk headline", "2026-10-23T15:00:00Z", "https://news.example/1"),
        headline("Same desk headline", "2026-10-23T15:05:00Z", "https://news.example/2"),
      ],
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.tags).toEqual([{ id: "NEWS", strength: "weak" }]);
  });

  it("records edgar skipped when filings were not requested", () => {
    const skipped = build({ filings: null });
    expect(skipped.sources.edgar).toBe("skipped");
    expect(skipped.tags).toEqual([]);

    expect(build({ filings: [] }).sources.edgar).toBe("ok");
    expect(build({ newsSource: "yahoo" }).sources.news).toBe("fallback");
    expect(build({ newsSource: "failed" }).sources.news).toBe("failed");
  });

  it("includes the close instant and excludes the instant before the window", () => {
    const atClose = build({ earningsLast: Date.parse(CLOSE) / 1000 });
    expect(atClose.tags).toEqual([expect.objectContaining({ id: "EARN", strength: "strong" })]);

    const atStart = build({
      filings: [filing({ items: ["2.01"], acceptedAt: START })],
    });
    expect(atStart.tags.map((tag) => tag.id)).toEqual(["M&A"]);
    expect(atStart.evidence[0]?.detail).toContain("Completion of acquisition");

    const before = build({
      headlines: [headline("Analyst upgrades XYZ to Buy", "2026-10-22T19:59:59Z")],
      filings: [filing({ acceptedAt: "2026-10-22T19:59:59Z" })],
    });
    expect(before.tags).toEqual([]);
    expect(before.evidence).toEqual([]);
  });
});
