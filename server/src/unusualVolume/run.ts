// Daily unusual-volume pipeline. One in-flight run is shared by concurrent callers.
import { flagsFor, inScanWindow, resolveSignalSession } from "../marketCalendar.js";
import { barCount } from "../providers/nasdaq.js";
import { spyChange, unusualVolumeScan } from "../providers/tradingview.js";
import { applyFilters, computeMetrics, sectorMedians } from "./compute.js";
import { enrichRows } from "./enrich.js";
import {
  getRun,
  getRows,
  isSeasoned,
  markSeasoned,
  pruneOlderThan,
  saveEnrichmentPhase,
  saveListPhase,
} from "./store.js";
import type { RunOutcome, RunSummary, UnusualVolumeRow } from "./types.js";

const ENRICH_KEYS = ["edgar", "news", "nasdaq"] as const;

let inFlight: Promise<RunOutcome> | null = null;

export async function runUnusualVolume(
  opts: { now?: Date; force?: boolean; reenrichOnly?: boolean } = {},
): Promise<RunOutcome> {
  if (inFlight) return inFlight;
  const run = execute(opts).finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}

async function execute(opts: { now?: Date; force?: boolean; reenrichOnly?: boolean }): Promise<RunOutcome> {
  const now = opts.now ?? new Date();
  const session = resolveSignalSession(now);
  const sessionDate = session.sessionDate;

  if (opts.reenrichOnly) return reenrich(sessionDate, now);

  if (!inScanWindow(now)) return { kind: "skipped", reason: "market-hours" };
  if (getRun(sessionDate) && !opts.force) return { kind: "skipped", reason: "exists" };

  const start = Date.now();
  // Both providers are attempted. A spy failure becomes a null print and still counts as a request.
  const [scanned, spyChangePct] = await Promise.all([
    unusualVolumeScan(),
    spyChange().catch(() => null),
  ]);

  const measured = scanned.rows.map((row) => ({ ...row, ...computeMetrics(row) }));
  const medians = sectorMedians(scanned.rows);
  const filtered = applyFilters(measured);

  const summary: RunSummary = {
    sessionDate,
    earlyClose: session.earlyClose,
    spyChangePct,
    counts: {
      universe: scanned.rows.length,
      liquid: filtered.counts.liquid,
      mcap: filtered.counts.mcap,
      rvol: filtered.counts.rvol,
      green: filtered.counts.green,
      seasoned: 0,
      matches: 0,
    },
    requests: { tv: 2, edgar: 0, news: 0, nasdaq: 0 },
    failures: { edgar: 0, news: 0, nasdaq: 0 },
    durationMs: 0,
  };

  const kept: Array<(typeof filtered.matches)[number] & { sectorMedianChangePct: number }> = [];
  let seasoned = 0;
  for (const match of filtered.matches) {
    const row = { ...match, sectorMedianChangePct: medians.get(match.sector) ?? 0 };
    if (isSeasoned(row.symbol)) {
      seasoned++;
      kept.push(row);
      continue;
    }
    summary.requests.nasdaq = (summary.requests.nasdaq ?? 0) + 1;
    try {
      const bars = await barCount(row.symbol, 31, sessionDate);
      if (bars >= 31) {
        markSeasoned([row.symbol], now.toISOString());
        seasoned++;
        kept.push(row);
      }
    } catch {
      summary.failures.nasdaq = (summary.failures.nasdaq ?? 0) + 1;
      console.warn(`[unusual-volume] seasoning ${row.symbol} failed`);
      kept.push(row);
    }
  }

  const peers = new Map<string, number>();
  for (const row of kept) peers.set(row.sector, (peers.get(row.sector) ?? 0) + 1);
  const rows: UnusualVolumeRow[] = kept.map((row) => ({
    ...row,
    sectorPeersOnList: peers.get(row.sector) ?? 0,
    catalysts: null,
  }));

  summary.counts.seasoned = seasoned;
  summary.counts.matches = rows.length;
  summary.durationMs = Date.now() - start;
  saveListPhase(
    {
      sessionDate,
      runAt: now.toISOString(),
      earlyClose: session.earlyClose,
      spyChangePct,
      universeSize: summary.counts.universe,
      summary,
    },
    rows,
  );

  let enriched: Awaited<ReturnType<typeof enrichRows>> | null = null;
  try {
    enriched = await enrichRows(rows, {
      sessionDate,
      earlyClose: session.earlyClose,
      spyChangePct,
      flags: flagsFor(sessionDate),
    });
  } catch {
    enriched = null;
  }

  if (enriched) mergeEnrich(summary, enriched);
  summary.durationMs = Date.now() - start;
  if (enriched) {
    saveEnrichmentPhase(sessionDate, enriched.bySymbol, summary, now.toISOString());
    pruneOlderThan(90, now);
  }

  logSummary(summary);
  return { kind: "ran", summary };
}

async function reenrich(sessionDate: string, now: Date): Promise<RunOutcome> {
  const stored = getRun(sessionDate);
  if (!stored) throw new Error("unusual-volume: no list to enrich");
  const rows = getRows(sessionDate);
  const enriched = await enrichRows(rows, {
    sessionDate,
    earlyClose: stored.earlyClose,
    spyChangePct: stored.spyChangePct,
    flags: flagsFor(sessionDate),
  });
  const summary = stored.summary;
  if (stored.status === "complete") {
    // The stored summary already includes a previous phase-2 merge. Replace the
    // filing and headline totals; keep tv and the nasdaq total (bar checks plus
    // any earnings calls already counted) so a manual refresh does not stack them.
    summary.requests.edgar = enriched.requests.edgar ?? 0;
    summary.requests.news = enriched.requests.news ?? 0;
    summary.failures.edgar = enriched.failures.edgar ?? 0;
    summary.failures.news = enriched.failures.news ?? 0;
  } else {
    mergeEnrich(summary, enriched);
  }
  saveEnrichmentPhase(sessionDate, enriched.bySymbol, summary, now.toISOString());
  pruneOlderThan(90, now);
  return { kind: "ran", summary };
}

function mergeEnrich(
  summary: RunSummary,
  extra: { requests: Record<string, number>; failures: Record<string, number> },
): void {
  for (const key of ENRICH_KEYS) {
    summary.requests[key] = (summary.requests[key] ?? 0) + (extra.requests[key] ?? 0);
    summary.failures[key] = (summary.failures[key] ?? 0) + (extra.failures[key] ?? 0);
  }
}

function logSummary(summary: RunSummary): void {
  const counts = summary.counts;
  const requests = summary.requests;
  const failures = summary.failures;
  const seconds = (summary.durationMs / 1000).toFixed(1);
  console.log(
    `[unusual-volume] D=${summary.sessionDate} universe=${counts.universe} liquid=${counts.liquid} mcap=${counts.mcap} rvol=${counts.rvol} green=${counts.green} seasoned=${counts.seasoned} matches=${counts.matches} req{tv:${requests.tv ?? 0},edgar:${requests.edgar ?? 0},news:${requests.news ?? 0},nasdaq:${requests.nasdaq ?? 0}} fail{edgar:${failures.edgar ?? 0},news:${failures.news ?? 0},nasdaq:${failures.nasdaq ?? 0}} ${seconds}s`,
  );
}
