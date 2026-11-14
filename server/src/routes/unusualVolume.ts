// Saved-run API. The request path does not call a provider except a catch-up
// when today's session has no row and the clock is inside the scan window.
import { Router } from "express";
import { z } from "zod";
import { cacheGet, cacheSet } from "../cache.js";
import { flagsFor, inScanWindow, isTradingDay, resolveSignalSession, tradingDaysEndingAt } from "../marketCalendar.js";
import { strengthRank } from "../unusualVolume/catalysts.js";
import { runUnusualVolume } from "../unusualVolume/run.js";
import {
  getLastRefresh,
  getLatestRun,
  getRowsBetween,
  getRun,
  listRuns,
  setLastRefresh,
  type StoredRun,
} from "../unusualVolume/store.js";
import type { SessionMeta, UnusualVolumeRow } from "../unusualVolume/types.js";

export const unusualVolumeRouter = Router();

const FIRST_RUN =
  "First run has not happened yet. It runs daily at 06:00 or on the next startup outside US market hours.";
const REFRESH_COOLDOWN_MS = 10 * 60_000;
const SPAN_ERROR = "span must be between 1 and 10";
const TO_ERROR = "to must be a closed trading session";
const SORT_KEYS = [
  "symbol",
  "close",
  "candlePct",
  "rvol",
  "catalyst",
  "dayChangePct",
  "volume",
  "adv30",
  "dollarVolume",
  "marketCap",
  "sector",
  "name",
] as const;

const querySchema = z.object({
  threshold: z.coerce.number().optional(),
  marketCapMin: z.coerce.number().optional(),
  sector: z.string().min(1).optional(),
  sort: z.enum(SORT_KEYS).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  span: z.preprocess(
    (value) => (value === undefined || value === "" ? 1 : value),
    z.coerce.number().refine((n) => Number.isInteger(n) && n >= 1 && n <= 10, { message: SPAN_ERROR }),
  ),
});

const sessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(60).default(20),
});

let nowFn = (): Date => new Date();

/** Tests pin the clock. Production never calls this. */
export function setUnusualVolumeNow(fn: () => Date): void {
  nowFn = fn;
}

function fail(req: { path?: string }, res: { status: (code: number) => { json: (body: unknown) => void } }, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.error("[unusual-volume]", req.path, detail);
  res.status(502).json({ error: "All data providers are temporarily unavailable. Try again shortly." });
}

function sessionLabel(ymd: string): string {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${ymd}T12:00:00Z`));
  return formatted.replace(",", "");
}

function catalystSortKey(row: UnusualVolumeRow): { none: boolean; rank: number; id: string } {
  const tag = row.catalysts?.tags[0];
  if (!tag) return { none: true, rank: -1, id: "" };
  return { none: false, rank: strengthRank(tag.strength), id: tag.id };
}

function compareRows(a: UnusualVolumeRow, b: UnusualVolumeRow, sort: (typeof SORT_KEYS)[number], dir: "asc" | "desc"): number {
  if (sort === "catalyst") {
    const ka = catalystSortKey(a);
    const kb = catalystSortKey(b);
    if (ka.none !== kb.none) return ka.none ? 1 : -1;
    if (ka.rank !== kb.rank) return dir === "desc" ? kb.rank - ka.rank : ka.rank - kb.rank;
    return dir === "desc" ? kb.id.localeCompare(ka.id) : ka.id.localeCompare(kb.id);
  }
  const av = a[sort];
  const bv = b[sort];
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (typeof av === "number" && typeof bv === "number") return dir === "desc" ? bv - av : av - bv;
  const as = String(av);
  const bs = String(bv);
  return dir === "desc" ? bs.localeCompare(as) : as.localeCompare(bs);
}

function passesFilters(row: UnusualVolumeRow, query: z.infer<typeof querySchema>): boolean {
  const threshold = Math.max(2.5, query.threshold ?? 2.5);
  const marketCapMin = Math.max(3e8, query.marketCapMin ?? 3e8);
  if (row.rvol < threshold) return false;
  if ((row.marketCap ?? 0) < marketCapMin) return false;
  if (query.sector && row.sector !== query.sector) return false;
  return true;
}

function toSessionMeta(date: string, run: StoredRun | undefined, matches: number): SessionMeta {
  if (!run) {
    return {
      sessionDate: date,
      sessionLabel: sessionLabel(date),
      status: "missing",
      earlyClose: false,
      runAt: null,
      spyChangePct: null,
      flags: flagsFor(date),
      matches: 0,
    };
  }
  return {
    sessionDate: date,
    sessionLabel: sessionLabel(date),
    status: run.status === "complete" ? "complete" : "pending",
    earlyClose: run.earlyClose,
    runAt: run.runAt,
    spyChangePct: run.spyChangePct,
    flags: flagsFor(date),
    matches,
  };
}

function runStateKey(runs: StoredRun[]): string {
  return runs.map((run) => `${run.sessionDate}/${run.status}/${run.enrichedAt ?? ""}`).join(",");
}

unusualVolumeRouter.get("/sessions", (req, res) => {
  const parsed = sessionsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
  try {
    const now = nowFn();
    const currentSession = resolveSignalSession(now).sessionDate;
    const dates = tradingDaysEndingAt(currentSession, parsed.data.limit);
    const from = dates[dates.length - 1];
    const runs = listRuns(from, currentSession);
    const key = `uv-sessions:${parsed.data.limit}:${runStateKey(runs)}:${getLatestRun()?.sessionDate ?? ""}`;
    const hit = cacheGet<unknown>(key);
    if (hit) return res.json(hit);
    const byDate = new Map(runs.map((run) => [run.sessionDate, run]));
    const body = {
      currentSession,
      latestSession: getLatestRun()?.sessionDate ?? null,
      sessions: dates.map((date) => toSessionMeta(date, byDate.get(date), 0)),
    };
    cacheSet(key, body, 60_000);
    res.json(body);
  } catch (err) {
    fail(req, res, err);
  }
});

unusualVolumeRouter.get("/", async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
  try {
    const now = nowFn();
    const currentSession = resolveSignalSession(now).sessionDate;
    let to = parsed.data.to;
    if (!to) {
      if (!getRun(currentSession) && inScanWindow(now)) {
        await runUnusualVolume({ now });
      }
      to = getRun(currentSession)?.sessionDate ?? getLatestRun()?.sessionDate;
      if (!to) return res.status(503).json({ error: FIRST_RUN });
    } else if (to > currentSession || !isTradingDay(to)) {
      return res.status(400).json({ error: TO_ERROR });
    }

    let dates: string[];
    try {
      dates = tradingDaysEndingAt(to, parsed.data.span);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("not a trading day:")) {
        return res.status(400).json({ error: TO_ERROR });
      }
      throw err;
    }
    const from = dates[dates.length - 1];
    const runs = listRuns(from, to);
    const key = `uv:${from}:${to}:${runStateKey(runs)}:${JSON.stringify(parsed.data)}`;
    const hit = cacheGet<unknown>(key);
    if (hit) return res.json(hit);

    const storedRows = getRowsBetween(from, to);
    const matchesByDate = new Map<string, number>();
    for (const row of storedRows) matchesByDate.set(row.sessionDate, (matchesByDate.get(row.sessionDate) ?? 0) + 1);
    const byDate = new Map(runs.map((run) => [run.sessionDate, run]));
    const sessions = dates.map((date) => toSessionMeta(date, byDate.get(date), matchesByDate.get(date) ?? 0));

    const sort = parsed.data.sort ?? "rvol";
    const dir = parsed.data.dir ?? "desc";
    const filtered = storedRows.filter((row) => passesFilters(row, parsed.data));
    const repeats = new Map<string, number>();
    for (const row of filtered) repeats.set(row.symbol, (repeats.get(row.symbol) ?? 0) + 1);
    const rows = filtered
      .map((row) => ({ ...row, repeats: repeats.get(row.symbol) ?? 1 }))
      .sort((a, b) => {
        if (a.sessionDate !== b.sessionDate) return a.sessionDate < b.sessionDate ? 1 : -1;
        return compareRows(a, b, sort, dir);
      });

    const body = {
      from,
      to,
      currentSession,
      latestSession: getLatestRun()?.sessionDate ?? null,
      sessions,
      totalMatches: sessions.reduce((sum, session) => sum + session.matches, 0),
      rows,
    };
    cacheSet(key, body, 60_000);
    res.json(body);
  } catch (err) {
    fail(req, res, err);
  }
});

unusualVolumeRouter.post("/refresh", (req, res) => {
  try {
    const now = nowFn();
    const { sessionDate } = resolveSignalSession(now);
    const run = getRun(sessionDate) ?? getLatestRun();
    if (!run) return res.status(503).json({ error: FIRST_RUN });
    const last = getLastRefresh(run.sessionDate);
    if (last) {
      const elapsed = now.getTime() - Date.parse(last);
      if (elapsed < REFRESH_COOLDOWN_MS) {
        const retryAfterSec = Math.max(1, Math.ceil((REFRESH_COOLDOWN_MS - elapsed) / 1000));
        return res.status(429).json({ error: "Refresh is cooling down", retryAfterSec });
      }
    }
    setLastRefresh(run.sessionDate, now.toISOString());
    res.status(202).json({ enrichmentStatus: "pending", sessionDate: run.sessionDate });
    void runUnusualVolume({ now, reenrichOnly: true }).catch((err: unknown) => {
      console.error("[unusual-volume] refresh failed", err instanceof Error ? err.message : err);
    });
  } catch (err) {
    fail(req, res, err);
  }
});
