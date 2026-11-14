// Wall-clock parts in an IANA zone. Callers that need "what time is it in
// New York" come through here so a fixed UTC offset cannot drift across DST.

export type ZonedParts = {
  /** Civil date in the zone, YYYY-MM-DD. */
  date: string;
  /** Zero-padded 24-hour clock, HH:MM. String comparison is chronological. */
  hhmm: string;
  /** Minutes since local midnight, so callers can compare without parsing. */
  minutes: number;
  /** Sunday = 0 … Saturday = 6. */
  weekday: number;
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const value = parts.find((p) => p.type === type)?.value;
  if (value === undefined) throw new Error(`Intl part missing: ${type}`);
  return value;
}

export function zonedParts(date: Date, tz: string): ZonedParts {
  // hourCycle "h23" asks for 00–23. weekday "short" under en-US is Sun…Sat,
  // which is what WEEKDAY_INDEX keys on — a server locale must not rename them.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(date);

  // A few ICU builds still label midnight as hour "24" with hourCycle "h23".
  // That is 00:00 on the date Intl already reported, not a 24th hour.
  let hour = part(parts, "hour");
  if (hour === "24") hour = "00";
  const minute = part(parts, "minute");
  const weekday = WEEKDAY_INDEX[part(parts, "weekday")];
  if (weekday === undefined) throw new Error(`unexpected weekday from Intl: ${part(parts, "weekday")}`);

  const hhmm = `${hour}:${minute}`;
  return {
    date: `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}`,
    hhmm,
    minutes: Number(hour) * 60 + Number(minute),
    weekday,
  };
}

export function nyParts(date: Date): ZonedParts {
  return zonedParts(date, "America/New_York");
}

export function wallClock(tz: string, now: Date = new Date()): ZonedParts {
  return zonedParts(now, tz);
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidHhmm(s: string): boolean {
  return HHMM_RE.test(s);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    // RangeError is how Intl rejects a name that is not a known IANA zone.
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * UTC instant of a New York wall time. US Eastern is 4h or 5h behind UTC
 * depending on DST, and the switch dates move, so the offset is not computed:
 * a 5h (standard-time) guess is only the center of a ±2h search, which covers
 * both offsets, and the instant we keep is the one `nyParts` round-trips.
 * The scan is linear because the fall-back hour exists twice; the earlier
 * instant is the one returned. A spring-forward gap matches nothing.
 */
export function nyDateTime(dateYmd: string, hhmm: string): Date {
  const [year, month, day] = dateYmd.split("-").map(Number);
  const [hour, minute] = hhmm.split(":").map(Number);
  const center = Date.UTC(year, month - 1, day, hour, minute) + 5 * 60 * 60 * 1000;
  const step = 60 * 1000;
  const radius = 2 * 60 * 60 * 1000;
  for (let offset = -radius; offset <= radius; offset += step) {
    const candidate = new Date(center + offset);
    const parts = nyParts(candidate);
    if (parts.date === dateYmd && parts.hhmm === hhmm) return candidate;
  }
  throw new Error(`no New York instant for ${dateYmd} ${hhmm}`);
}
