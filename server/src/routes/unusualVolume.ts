// Saved-run API. The request path does not call a provider except a catch-up
// when today's session has no row and the clock is inside the scan window.
import { Router } from "express";
import { z } from "zod";
import { cacheGet, cacheSet } from "../cache.js";
import { flagsFor, inScanWindow, resolveSignalSession } from "../marketCalendar.js";
import { strengthRank } from "../unusualVolume/catalysts.js";
import { runUnusualVolume } from "../unusualVolume/run.js";
import { getLastRefresh, getLatestRun, getRows, getRun, setLastRefresh, type StoredRun } from "../unusualVolume/store.js";
import type { UnusualVolumeRow } from "../unusualVolume/types.js";

export const unusualVolumeRouter = Router();

const FIRST_RUN =
  "First run has not happened yet. It runs daily at 06:00 or on the next startup outside US market hours.";
const REFRESH_COOLDOWN_MS = 10 * 60_000;
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

function toResponse(run: StoredRun, rows: UnusualVolumeRow[], query: z.infer<typeof querySchema>) {
  const threshold = Math.max(2.5, query.threshold ?? 2.5);
  const marketCapMin = Math.max(3e8, query.marketCapMin ?? 3e8);
  const sort = query.sort ?? "rvol";
  const dir = query.dir ?? "desc";
  const filtered = rows.filter((row) => {
    if (row.rvol < threshold) return false;
    if ((row.marketCap ?? 0) < marketCapMin) return false;
    if (query.sector && row.sector !== query.sector) return false;
    return true;
  });
  filtered.sort((a, b) => compareRows(a, b, sort, dir));
  return {
    sessionDate: run.sessionDate,
    sessionLabel: sessionLabel(run.sessionDate),
    earlyClose: run.earlyClose,
    runAt: run.runAt,
    enrichmentStatus: run.status === "complete" ? "complete" : "pending",
    spyChangePct: run.spyChangePct,
    totalMatches: rows.length,
    flags: flagsFor(run.sessionDate),
    rows: filtered,
  };
}

async function loadRun(now: Date): Promise<StoredRun | undefined> {
  const { sessionDate } = resolveSignalSession(now);
  const current = getRun(sessionDate);
  if (current) return current;
  if (inScanWindow(now)) {
    await runUnusualVolume({ now });
    return getRun(sessionDate) ?? getLatestRun();
  }
  return getLatestRun();
}

unusualVolumeRouter.get("/", async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
  try {
    const now = nowFn();
    const run = await loadRun(now);
    if (!run) return res.status(503).json({ error: FIRST_RUN });
    const key = `uv:${run.sessionDate}:${run.status}:${run.enrichedAt ?? ""}:${JSON.stringify(parsed.data)}`;
    const hit = cacheGet<ReturnType<typeof toResponse>>(key);
    if (hit) return res.json(hit);
    const body = toResponse(run, getRows(run.sessionDate), parsed.data);
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
    res.status(202).json({ enrichmentStatus: "pending" });
    void runUnusualVolume({ now, reenrichOnly: true }).catch((err: unknown) => {
      console.error("[unusual-volume] refresh failed", err instanceof Error ? err.message : err);
    });
  } catch (err) {
    fail(req, res, err);
  }
});
