import { describe, expect, it } from "vitest";
import {
  EARLY_CLOSES,
  HOLIDAYS,
  closeTimeHhmm,
  flagsFor,
  inScanWindow,
  isTradingDay,
  opexSession,
  resolveSignalSession,
} from "./marketCalendar.js";

describe("resolveSignalSession", () => {
  it("A9: Saturday maps to the Friday session", () => {
    // 2026-10-24T10:00Z is Saturday morning in New York. Markets were open Friday.
    const session = resolveSignalSession(new Date("2026-10-24T10:00:00Z"));
    expect(session).toEqual({ sessionDate: "2026-10-23", earlyClose: false });
  });

  it("A10: the morning after Thanksgiving is still Wednesday's session", () => {
    // 2026-11-27T13:00Z is 08:00 ET on the early-close Friday. Thursday Nov 26
    // is closed, so the last fully closed session is Wednesday Nov 25.
    const session = resolveSignalSession(new Date("2026-11-27T13:00:00Z"));
    expect(session).toEqual({ sessionDate: "2026-11-25", earlyClose: false });
  });

  it("the morning after MLK Day is still the previous Friday", () => {
    // 2026-01-20T13:00Z is 08:00 ET Tuesday. Monday Jan 19 is closed.
    const session = resolveSignalSession(new Date("2026-01-20T13:00:00Z"));
    expect(session).toEqual({ sessionDate: "2026-01-16", earlyClose: false });
  });

  it("stays on the previous session until the regular close", () => {
    // 19:59Z is 15:59 ET, one minute before the 16:00 close.
    expect(resolveSignalSession(new Date("2026-10-23T19:59:00Z"))).toEqual({
      sessionDate: "2026-10-22",
      earlyClose: false,
    });
    // 20:00Z is 16:00 ET: the close print belongs to that session.
    expect(resolveSignalSession(new Date("2026-10-23T20:00:00Z"))).toEqual({
      sessionDate: "2026-10-23",
      earlyClose: false,
    });
  });

  it("accepts an early close at 13:00 ET", () => {
    // 2026-11-27T18:00Z is 13:00 ET, the early close the day after Thanksgiving.
    expect(resolveSignalSession(new Date("2026-11-27T18:00:00Z"))).toEqual({
      sessionDate: "2026-11-27",
      earlyClose: true,
    });
    expect(closeTimeHhmm("2026-11-27")).toBe("13:00");
    expect(closeTimeHhmm("2026-10-23")).toBe("16:00");
  });

  it("treats Christmas Eve 2027 as a full close, not a 13:00 close", () => {
    expect(isTradingDay("2027-12-24")).toBe(false);
    expect(closeTimeHhmm("2027-12-24")).toBe("16:00");
    expect(EARLY_CLOSES[2027]).toEqual(["2027-11-26"]);
  });
});

describe("inScanWindow", () => {
  it("includes 20:00 ET and excludes 04:00 ET", () => {
    // January is standard time. These instants are 03:59, 04:00, 19:59, and 20:00 ET.
    expect(inScanWindow(new Date("2026-01-15T08:59:00Z"))).toBe(true);
    expect(inScanWindow(new Date("2026-01-15T09:00:00Z"))).toBe(false);
    expect(inScanWindow(new Date("2026-01-16T00:59:00Z"))).toBe(false);
    expect(inScanWindow(new Date("2026-01-16T01:00:00Z"))).toBe(true);
  });
});

describe("flagsFor", () => {
  it("A19: the third Friday of March 2027 is OPEX and an S&P rebalance", () => {
    expect(flagsFor("2027-03-19")).toEqual({ opex: true, spRebalance: true, russell: false });
  });

  it("moves OPEX to the Thursday before a holiday third Friday", () => {
    // No 2026–2027 third Friday is Good Friday, so the shift test injects one.
    // flagsFor asks opexSession for that year's real holiday set, which is how
    // the flag follows the shifted date: 2026-06-19 is Juneteenth and the
    // third Friday, so June's rebalance lands on Thursday the 18th.
    expect(opexSession(2027, 3, new Set(["2027-03-19"]))).toBe("2027-03-18");
    expect(flagsFor("2026-06-18")).toEqual({ opex: true, spRebalance: true, russell: false });
    expect(flagsFor("2026-06-19")).toEqual({ opex: false, spRebalance: false, russell: false });
  });

  it("flags the published Russell sessions and leaves December 2027 unset", () => {
    expect(flagsFor("2026-06-26").russell).toBe(true);
    expect(flagsFor("2026-12-11").russell).toBe(true);
    expect(flagsFor("2027-06-25")).toEqual({ opex: false, spRebalance: false, russell: true });
    expect(flagsFor("2027-12-10").russell).toBe(false);
  });
});

describe("holiday table coverage", () => {
  it("has an entry for the current UTC year", () => {
    // Yearly reminder: extend HOLIDAYS (and EARLY_CLOSES) when this fails.
    expect(HOLIDAYS[new Date().getUTCFullYear()]).toBeDefined();
  });
});
