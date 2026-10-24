// NYSE session calendar: which dates trade, when the cash session closes, and
// which of those dates are OPEX, an S&P quarterly rebalance, or a Russell
// reconstitution. Signal session D is the most recent fully closed session.
// Zone math stays in time.ts; this module only compares the parts it returns.

import { nyParts } from "./time.js";

// NYSE Group calendar: https://www.nyse.com/trade/hours-calendars (announced 2025-12-23).
export const HOLIDAYS: Record<number, readonly string[]> = {
  2026: [
    "2026-01-01",
    "2026-01-19",
    "2026-02-16",
    "2026-04-03",
    "2026-05-25",
    "2026-06-19",
    "2026-07-03",
    "2026-09-07",
    "2026-11-26",
    "2026-12-25",
  ],
  2027: [
    "2027-01-01",
    "2027-01-18",
    "2027-02-15",
    "2027-03-26",
    "2027-05-31",
    "2027-06-18",
    "2027-07-05",
    "2027-09-06",
    "2027-11-25",
    "2027-12-24",
  ],
};

// Same NYSE Group calendar (announced 2025-12-23). Early closes are 13:00 ET.
// Christmas 2027 is a full close on Dec 24 (see HOLIDAYS), not an early close.
export const EARLY_CLOSES: Record<number, readonly string[]> = {
  2026: ["2026-11-27", "2026-12-24"],
  2027: ["2027-11-26"],
};

// FTSE Russell effective sessions — the session whose volume reflects the event.
// 2026-06-26 and 2026-12-11 are from the FTSE Russell press releases (June 26 and December 11, 2026).
// 2027-06-25 is the fourth Friday of June per Russell policy.
// December 2027 is not published; it is intentionally absent.
const RUSSELL_SESSIONS: Record<number, readonly string[]> = {
  2026: ["2026-06-26", "2026-12-11"],
  2027: ["2027-06-25"],
};

const REBALANCE_MONTHS = new Set([3, 6, 9, 12]);

function yearOf(ymd: string): number {
  return Number(ymd.slice(0, 4));
}

function listed(table: Record<number, readonly string[]>, ymd: string): boolean {
  return (table[yearOf(ymd)] ?? []).includes(ymd);
}

// Calendar-day arithmetic on the UTC fields. 12:00Z is still the same civil
// date in New York, and getUTC* does not consult the server's zone.
function addCalendarDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${m}-${d}`;
}

function utcNoon(ymd: string): Date {
  return new Date(`${ymd}T12:00:00.000Z`);
}

export function isTradingDay(ymd: string): boolean {
  const { weekday } = nyParts(utcNoon(ymd));
  if (weekday === 0 || weekday === 6) return false;
  return !listed(HOLIDAYS, ymd);
}

export function previousTradingDay(ymd: string): string {
  // A holiday glued to a weekend is at most four calendar days. The bound
  // turns a missing year or a bad date into an error instead of a spin.
  let cursor = addCalendarDays(ymd, -1);
  for (let i = 0; i < 14; i++) {
    if (isTradingDay(cursor)) return cursor;
    cursor = addCalendarDays(cursor, -1);
  }
  throw new Error(`no trading day within 14 days before ${ymd}`);
}

export function closeTimeHhmm(ymd: string): "13:00" | "16:00" {
  return listed(EARLY_CLOSES, ymd) ? "13:00" : "16:00";
}

export type SignalSession = { sessionDate: string; earlyClose: boolean };

export function resolveSignalSession(now: Date): SignalSession {
  const ny = nyParts(now);
  // Both clocks are zero-padded HH:MM, so lexicographic order is chronological.
  // Equal counts: the close print belongs to the session that just ended.
  const closed = isTradingDay(ny.date) && ny.hhmm >= closeTimeHhmm(ny.date);
  const sessionDate = closed ? ny.date : previousTradingDay(ny.date);
  return { sessionDate, earlyClose: listed(EARLY_CLOSES, sessionDate) };
}

export function inScanWindow(now: Date): boolean {
  const { hhmm } = nyParts(now);
  // [20:00, 24:00) ∪ [00:00, 04:00). 20:00 is inside; 04:00 is outside.
  return hhmm >= "20:00" || hhmm < "04:00";
}

export function opexSession(year: number, month: number, holidays: ReadonlySet<string>): string {
  const monthPadded = String(month).padStart(2, "0");
  const firstWeekday = nyParts(utcNoon(`${year}-${monthPadded}-01`)).weekday;
  const thirdFriday = 1 + ((5 - firstWeekday + 7) % 7) + 14;
  const day = String(thirdFriday).padStart(2, "0");
  let ymd = `${year}-${monthPadded}-${day}`;
  if (!holidays.has(ymd)) return ymd;
  // The Friday itself is closed (Good Friday, Juneteenth). Walk to the
  // preceding trading day, skipping weekends and any further holidays.
  for (let i = 0; i < 10; i++) {
    ymd = addCalendarDays(ymd, -1);
    const { weekday } = nyParts(utcNoon(ymd));
    if (weekday !== 0 && weekday !== 6 && !holidays.has(ymd)) return ymd;
  }
  throw new Error(`no trading day on or before opex ${year}-${monthPadded}`);
}

export function flagsFor(ymd: string): { opex: boolean; spRebalance: boolean; russell: boolean } {
  const year = yearOf(ymd);
  const month = Number(ymd.slice(5, 7));
  const opex = ymd === opexSession(year, month, new Set(HOLIDAYS[year] ?? []));
  return {
    opex,
    spRebalance: opex && REBALANCE_MONTHS.has(month),
    russell: (RUSSELL_SESSIONS[year] ?? []).includes(ymd),
  };
}
