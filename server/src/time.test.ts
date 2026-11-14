import { describe, expect, it } from "vitest";
import { isValidHhmm, isValidTimeZone, nyDateTime, nyParts, wallClock, zonedParts } from "./time.js";

describe("zonedParts", () => {
  it("maps one UTC instant to New York and Jerusalem wall clocks", () => {
    // 2026-07-15T12:00:00Z. Intl on this runtime: New York EDT 08:00, Jerusalem IDT 15:00.
    const instant = new Date("2026-07-15T12:00:00Z");
    expect(nyParts(instant)).toEqual({ date: "2026-07-15", hhmm: "08:00", minutes: 8 * 60, weekday: 3 });
    expect(zonedParts(instant, "Asia/Jerusalem")).toEqual({
      date: "2026-07-15",
      hhmm: "15:00",
      minutes: 15 * 60,
      weekday: 3,
    });
  });

  it("wallClock and nyParts are zonedParts for their zones", () => {
    const instant = new Date("2026-07-15T12:00:00Z");
    expect(wallClock("Asia/Jerusalem", instant)).toEqual(zonedParts(instant, "Asia/Jerusalem"));
    expect(nyParts(instant)).toEqual(zonedParts(instant, "America/New_York"));
  });

  it("is after US DST and before Israel DST on 2026-03-15", () => {
    // US DST started 2026-03-08; Israel DST starts 2026-03-27, so the zones disagree.
    // Intl reports New York 00:00 and Jerusalem 06:00, both on 2026-03-15.
    const instant = new Date("2026-03-15T04:00:00Z");
    expect(nyParts(instant)).toMatchObject({ date: "2026-03-15", hhmm: "00:00", weekday: 0 });
    expect(zonedParts(instant, "Asia/Jerusalem")).toMatchObject({
      date: "2026-03-15",
      hhmm: "06:00",
      weekday: 0,
    });
  });

  it("is on standard time in both zones on 2026-11-05", () => {
    // US DST ended 2026-11-01 and Israel DST ended 2026-10-25.
    // Intl reports New York 23:00 on 2026-11-04 and Jerusalem 06:00 on 2026-11-05.
    const instant = new Date("2026-11-05T04:00:00Z");
    expect(nyParts(instant)).toMatchObject({ date: "2026-11-04", hhmm: "23:00", weekday: 3 });
    expect(zonedParts(instant, "Asia/Jerusalem")).toMatchObject({
      date: "2026-11-05",
      hhmm: "06:00",
      weekday: 4,
    });
  });
});

describe("nyDateTime", () => {
  it("converts a New York close to the UTC instant Intl round-trips", () => {
    // 2026-10-23 is still EDT (US DST ends 2026-11-01): 16:00 ET is 20:00Z.
    expect(nyDateTime("2026-10-23", "16:00").toISOString()).toBe("2026-10-23T20:00:00.000Z");
  });

  it("uses a 4-hour offset for a July afternoon", () => {
    expect(nyDateTime("2026-07-15", "16:00").toISOString()).toBe("2026-07-15T20:00:00.000Z");
  });

  it("uses a 5-hour offset for a January afternoon", () => {
    expect(nyDateTime("2026-01-15", "16:00").toISOString()).toBe("2026-01-15T21:00:00.000Z");
  });
});

describe("zone and clock validation", () => {
  it("accepts IANA names Intl knows", () => {
    expect(isValidTimeZone("Asia/Jerusalem")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });

  it("accepts only zero-padded HH:MM in 00:00–23:59", () => {
    expect(isValidHhmm("06:00")).toBe(true);
    expect(isValidHhmm("00:00")).toBe(true);
    expect(isValidHhmm("23:59")).toBe(true);
    expect(isValidHhmm("6:00")).toBe(false);
    expect(isValidHhmm("24:00")).toBe(false);
    expect(isValidHhmm("23:60")).toBe(false);
  });
});
