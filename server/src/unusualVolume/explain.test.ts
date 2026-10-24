// Negative numbers in expectations use Unicode minus U+2212 (−), the same character explain.ts emits.
// An ASCII hyphen-minus is not a negative sign in these lines.

import { describe, expect, it } from "vitest";
import { renderExplain, type ExplainCtx } from "./explain.js";
import type { Catalysts, Evidence, Tag, UnusualVolumeRow } from "./types.js";

const MINUS = "\u2212";

const EXAMPLE = [
  'Q3 earnings after close Oct 22 — EPS $1.42 vs $1.21 est (beat +17%); "XYZ raises full-year guidance" (Reuters, 16:12).',
  "3.8× its 29-session average · gapped +6.2%, closed +4.1% above open, near day high.",
  "Traded 4% of float · $480M traded.",
  "Electronic Technology median +2.4%, 7 on the list · SPY +0.6% · 41 matches today.",
];

function row(over: Partial<UnusualVolumeRow> = {}): UnusualVolumeRow {
  return {
    symbol: "XYZ",
    exchange: "NYSE",
    name: "XYZ Corp",
    sector: "Electronic Technology",
    open: 106.2,
    high: 112,
    low: 105,
    close: 110.5,
    changePct: 4.1,
    volume: 4_000_000,
    avg30: 1_100_000,
    marketCap: 2e9,
    float: 100_000_000,
    earningsLast: null,
    earningsNext: null,
    prevClose: 100,
    adv30: 1_034_482,
    rvol: 3.8,
    candlePct: 4.1,
    dayChangePct: 4.1,
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

function ctx(over: Partial<ExplainCtx> = {}): ExplainCtx {
  return {
    spyChangePct: 0.6,
    totalMatches: 41,
    flags: { opex: false, spRebalance: false, russell: false },
    earlyClose: false,
    ...over,
  };
}

function evidence(over: Partial<Evidence> & Pick<Evidence, "kind" | "time" | "title">): Evidence {
  return {
    afterClose: false,
    url: null,
    tags: [],
    ...over,
  };
}

function catalysts(tags: Tag[] = [], evidenceList: Evidence[] = []): Omit<Catalysts, "explain"> {
  return { tags, evidence: evidenceList, sources: {} };
}

const earnEv = evidence({
  kind: "earnings",
  time: "2026-10-22T20:12:00.000Z",
  afterClose: true,
  title: "Q3 earnings",
  detail: "EPS $1.42 vs $1.21 est (beat +17%)",
  tags: ["EARN"],
});

const guidance = evidence({
  kind: "headline",
  time: "2026-10-22T20:12:00.000Z",
  afterClose: true,
  title: "XYZ raises full-year guidance",
  publisher: "Reuters",
  tags: ["GUIDANCE"],
});

describe("renderExplain", () => {
  it("reproduces the §4.7 example lines", () => {
    const lines = renderExplain(
      row(),
      catalysts(
        [
          { id: "EARN", strength: "strong" },
          { id: "GUIDANCE", strength: "medium" },
        ],
        [earnEv, guidance],
      ),
      ctx(),
    );
    expect(lines).toEqual(EXAMPLE);
  });

  it("passes beat and miss wording through the earnings detail", () => {
    const beat = renderExplain(row(), catalysts([{ id: "EARN", strength: "strong" }], [earnEv]), ctx());
    expect(beat[0]).toBe("Q3 earnings after close Oct 22 — EPS $1.42 vs $1.21 est (beat +17%)");

    const missDetail = `EPS $0.90 vs $0.98 est (miss ${MINUS}8%)`;
    const miss = renderExplain(
      row(),
      catalysts(
        [{ id: "EARN", strength: "strong" }],
        [evidence({ ...earnEv, detail: missDetail })],
      ),
      ctx(),
    );
    expect(miss[0]).toBe(`Q3 earnings after close Oct 22 — ${missDetail}`);
    expect(miss[0]).not.toMatch(/NaN|undefined/);
  });

  it("omits an EPS fragment when EARN has no numeric detail", () => {
    const lines = renderExplain(
      row(),
      catalysts(
        [{ id: "EARN", strength: "strong" }],
        [evidence({ ...earnEv, detail: undefined })],
      ),
      ctx(),
    );
    expect(lines[0]).toBe("Q3 earnings after close Oct 22");
    expect(lines[0]).not.toMatch(/EPS|beat|miss/);
  });

  it("labels the quarter from the NY month of the release", () => {
    const at = (iso: string) =>
      renderExplain(
        row(),
        catalysts(
          [{ id: "EARN", strength: "strong" }],
          [evidence({ kind: "earnings", time: iso, title: "earnings", afterClose: false, tags: ["EARN"] })],
        ),
        ctx(),
      )[0];
    expect(at("2026-01-15T18:00:00.000Z")).toBe("Q4 earnings Jan 15");
    expect(at("2026-04-15T18:00:00.000Z")).toBe("Q1 earnings Apr 15");
    expect(at("2026-07-15T18:00:00.000Z")).toBe("Q2 earnings Jul 15");
    expect(at("2026-10-15T18:00:00.000Z")).toBe("Q3 earnings Oct 15");
    expect(at("2026-10-22T12:00:00.000Z")).toBe("Q3 earnings before the open Oct 22");
    expect(at("2026-10-22T13:30:00.000Z")).toBe("Q3 earnings Oct 22");
  });

  it("uses an insider sentence and translates filing items", () => {
    const insider = renderExplain(
      row(),
      catalysts(
        [{ id: "INSIDER_BUY", strength: "strong", detail: "CEO bought 50,000 sh ($2.1M) on Oct 22" }],
        [],
      ),
      ctx(),
    );
    expect(insider[0]).toBe("CEO bought 50,000 sh ($2.1M) on Oct 22");

    const filing = (items: string[], id: Tag["id"] = "M&A") =>
      renderExplain(
        row(),
        catalysts(
          [{ id, strength: "strong" }],
          [evidence({ kind: "filing", time: "2026-10-22T14:00:00.000Z", title: "8-K", form: "8-K", items, tags: [id] })],
        ),
        ctx(),
      )[0];
    expect(filing(["1.01"])).toBe("8-K: Entry into material agreement (1.01)");
    expect(filing(["2.01"])).toBe("8-K: Completion of acquisition (2.01)");
    expect(filing(["2.02"], "8K")).toBe("8-K: Results of operations (2.02)");
    expect(filing(["5.02"], "8K")).toBe("8-K: Departure/appointment of officers (5.02)");
    expect(filing(["8.01"], "8K")).toBe("8-K: Other events (8.01)");
    expect(filing(["7.01"], "8K")).toBe("8-K (7.01)");
    expect(
      renderExplain(row(), catalysts([{ id: "ACTIVIST", strength: "strong" }], []), ctx())[0],
    ).toBe("13D: new activist stake filed");
  });

  it("still describes a context tag and does not repeat the after-close suffix", () => {
    const suffix = "reported after close, reaction expected next session";
    const demoted = renderExplain(
      row(),
      catalysts(
        [{ id: "EARN", strength: "context", afterClose: true }],
        [evidence({ ...earnEv, detail: undefined })],
      ),
      ctx(),
    );
    expect(demoted[0]).toBe(`Q3 earnings after close Oct 22 — ${suffix}`);

    const already = renderExplain(
      row(),
      catalysts(
        [{ id: "EARN", strength: "context", afterClose: true }],
        [evidence({ ...earnEv, detail: `EPS $1.42 vs $1.21 est (beat +17%) — ${suffix}` })],
      ),
      ctx(),
    );
    expect(already[0].split(suffix).length - 1).toBe(1);
  });

  it("quotes the newest headline when nothing stronger is present", () => {
    const lines = renderExplain(
      row(),
      catalysts(
        [{ id: "NEWS", strength: "weak" }],
        [
          evidence({
            kind: "headline",
            time: "2026-10-22T13:00:00.000Z",
            title: "Earlier note",
            publisher: "Bloomberg",
            tags: ["NEWS"],
          }),
          evidence({
            kind: "headline",
            time: "2026-10-22T20:12:00.000Z",
            title: "XYZ raises full-year guidance",
            publisher: "Reuters",
            tags: ["NEWS"],
          }),
        ],
      ),
      ctx(),
    );
    expect(lines[0]).toBe('"XYZ raises full-year guidance" (Reuters, 16:12 ET)');
  });

  it("drops the float fragment when turnover is null (A17)", () => {
    const lines = renderExplain(row({ turnover: null }), catalysts(), ctx());
    expect(lines[2]).toBe("$480M traded.");
    expect(lines.join(" ")).not.toMatch(/of float/);
  });

  it("formats millions, billions, and amounts under 1e6", () => {
    const who = (dollarVolume: number) => renderExplain(row({ dollarVolume, turnover: null }), catalysts(), ctx())[2];
    expect(who(1_200_000)).toBe("$1.2M traded.");
    expect(who(1_000_000)).toBe("$1M traded.");
    expect(who(1_200_000_000)).toBe("$1.2B traded.");
    expect(who(3_000_000_000)).toBe("$3B traded.");
    expect(who(250_000)).toBe("$250000 traded.");
    expect(renderExplain(row({ turnover: 0.14 }), catalysts(), ctx())[2]).toBe("Traded 14% of float · $480M traded.");
  });

  it("omits the SPY fragment when spyChangePct is null", () => {
    const lines = renderExplain(row(), catalysts(), ctx({ spyChangePct: null }));
    expect(lines[3]).toBe("Electronic Technology median +2.4%, 7 on the list · 41 matches today.");
    expect(lines.join(" ")).not.toMatch(/SPY/);
  });

  it("words close location only at the 0.8 and 0.4 thresholds", () => {
    const move = (closeLocation: number) => renderExplain(row({ closeLocation }), catalysts(), ctx())[1];
    expect(move(0.85)).toBe("3.8× its 29-session average · gapped +6.2%, closed +4.1% above open, near day high.");
    expect(move(0.3)).toBe("3.8× its 29-session average · gapped +6.2%, closed +4.1% above open, faded from high.");
    expect(move(0.6)).toBe("3.8× its 29-session average · gapped +6.2%, closed +4.1% above open.");
    expect(move(0.6)).not.toMatch(/near day high|faded from high/);

    const down = renderExplain(row({ gapPct: -1.2, candlePct: -1.2, closeLocation: 0.3 }), catalysts(), ctx())[1];
    expect(down).toBe(
      `3.8× its 29-session average · gapped ${MINUS}1.2%, closed ${MINUS}1.2% below open, faded from high.`,
    );
    const tinyGap = renderExplain(row({ gapPct: 0.04 }), catalysts(), ctx())[1];
    expect(tinyGap).not.toMatch(/gapped/);
  });

  it("adds possible run-up only when earningsNext is 1 to 7 days out", () => {
    const session = [earnEv];
    const tags: Tag[] = [{ id: "EARN", strength: "strong" }];
    const at = (iso: string) =>
      renderExplain(row({ earningsNext: Math.floor(Date.parse(iso) / 1000) }), catalysts(tags, session), ctx())[3];
    expect(at("2026-10-28T16:00:00.000Z")).toBe(
      "Electronic Technology median +2.4%, 7 on the list · SPY +0.6% · 41 matches today · Earnings in 6 days (possible run-up).",
    );
    expect(at("2026-10-29T16:00:00.000Z")).toContain("Earnings in 7 days (possible run-up)");
    expect(at("2026-10-30T16:00:00.000Z")).toBe(EXAMPLE[3]);
    expect(at("2026-10-30T16:00:00.000Z")).not.toMatch(/possible run-up|Earnings in/);
    expect(at("2026-10-20T16:00:00.000Z")).toBe(EXAMPLE[3]);
    expect(at("2026-10-22T16:00:00.000Z")).toBe(EXAMPLE[3]);

    const noSession = renderExplain(row({ earningsNext: Math.floor(Date.parse("2026-10-28T16:00:00.000Z") / 1000) }), catalysts(), ctx());
    expect(noSession.join(" ")).not.toMatch(/possible run-up/);
  });

  it("renders the move, float, and context lines when catalysts are empty", () => {
    const lines = renderExplain(row(), catalysts(), ctx());
    expect(lines[0]).toBe("No catalyst found in news, filings or earnings.");
    expect(lines.slice(1)).toEqual(EXAMPLE.slice(1));
    expect(lines.join(" ")).not.toMatch(/NaN|undefined/);
  });

  it("lists calendar flags and signs a down SPY with the unicode minus", () => {
    const lines = renderExplain(
      row({ sectorMedianChangePct: -1.2 }),
      catalysts(),
      ctx({
        spyChangePct: -0.4,
        flags: { opex: true, spRebalance: true, russell: true },
      }),
    );
    expect(lines[3]).toBe(
      `Electronic Technology median ${MINUS}1.2%, 7 on the list · SPY ${MINUS}0.4% · 41 matches today · OPEX · S&P rebalance · Russell reconstitution.`,
    );
  });
});
