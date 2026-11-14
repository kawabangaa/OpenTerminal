// Phase-2 fan-out. Fetches filings, headlines, Form 4, and earnings detail,
// then hands the results to the pure tag and explain modules.
import { mapWithConcurrency } from "../concurrency.js";
import { earningsSurprise, type EarningsSurpriseRow } from "../providers/nasdaq.js";
import { companyNews, type NewsItem } from "../providers/news.js";
import { filingsSince, form4Transactions, type Filing, type InsiderTransaction } from "../providers/secedgar.js";
import { nyParts } from "../time.js";
import { buildCatalysts, catalystWindow, type EarningsDetail } from "./catalysts.js";
import { renderExplain } from "./explain.js";
import type { Catalysts, UnusualVolumeRow } from "./types.js";

const MINUS = "\u2212";
const CONTEXT_TAGS = new Set(["SECTOR", "OPEX", "REBAL", "RUSSELL"]);

export type EnrichCtx = {
  sessionDate: string;
  earlyClose: boolean;
  spyChangePct: number | null;
  flags: { opex: boolean; spRebalance: boolean; russell: boolean };
};

type Counts = Record<string, number>;

type Run = {
  ctx: EnrichCtx;
  requests: Counts;
  failures: Counts;
  sectorCounts: Map<string, number>;
  totalRows: number;
};

export async function enrichRows(
  rows: UnusualVolumeRow[],
  ctx: EnrichCtx,
): Promise<{ bySymbol: Map<string, Catalysts>; requests: Counts; failures: Counts }> {
  const requests: Counts = { edgar: 0, news: 0, nasdaq: 0 };
  const failures: Counts = { edgar: 0, news: 0, nasdaq: 0 };
  const sectorCounts = new Map<string, number>();
  for (const row of rows) sectorCounts.set(row.sector, (sectorCounts.get(row.sector) ?? 0) + 1);
  const run: Run = { ctx, requests, failures, sectorCounts, totalRows: rows.length };

  // Budget: 1 EDGAR submissions call per row, Form 4 fetches only for form "4",
  // 1 Google News call per row, 1 Nasdaq earnings-surprise call only when an EARN tag is possible.
  const enriched = await mapWithConcurrency(rows, 5, (row) => enrichRow(row, run));

  const bySymbol = new Map<string, Catalysts>();
  rows.forEach((row, index) => bySymbol.set(row.symbol, enriched[index]));
  return { bySymbol, requests, failures };
}

async function enrichRow(row: UnusualVolumeRow, run: Run): Promise<Catalysts> {
  const explainCtx = {
    spyChangePct: run.ctx.spyChangePct,
    totalMatches: run.totalRows,
    flags: run.ctx.flags,
    earlyClose: run.ctx.earlyClose,
  };
  try {
    const window = catalystWindow(run.ctx.sessionDate, run.ctx.earlyClose);
    // Count the attempt whether the provider fulfills or rejects.
    run.requests.edgar++;
    run.requests.news++;
    const [filingsSettled, newsSettled] = await Promise.allSettled([
      filingsSince(row.symbol, window.start.toISOString()),
      companyNews(row.name, row.symbol),
    ]);

    let filings: Filing[] | null = null;
    let edgarFailed = false;
    if (filingsSettled.status === "rejected") {
      // null would be "skipped" (no CIK). A rejection has to become "failed" after buildCatalysts.
      edgarFailed = true;
      run.failures.edgar++;
    } else if (Array.isArray(filingsSettled.value)) {
      filings = filingsSettled.value;
    } else if (filingsSettled.value != null) {
      edgarFailed = true;
      run.failures.edgar++;
    }

    let headlines: NewsItem[] = [];
    let newsSource: "google" | "yahoo" | "failed" = "failed";
    if (newsSettled.status === "fulfilled" && newsSettled.value) {
      const source = newsSettled.value.source;
      if (source === "google" || source === "yahoo" || source === "failed") newsSource = source;
      if (Array.isArray(newsSettled.value.items)) headlines = newsSettled.value.items;
    }
    if (newsSource === "failed") run.failures.news++;

    const form4: InsiderTransaction[] = [];
    if (filings) {
      for (const filing of filings) {
        if (filing.form !== "4") continue;
        const acceptedMs = Date.parse(filing.acceptedAt);
        if (!Number.isFinite(acceptedMs) || acceptedMs < window.start.getTime()) continue;
        const cik = cikFromFilingUrl(filing.url);
        if (!cik) {
          run.failures.edgar++;
          continue;
        }
        run.requests.edgar++;
        try {
          const txs = await form4Transactions(cik, filing);
          if (Array.isArray(txs)) form4.push(...txs);
        } catch {
          run.failures.edgar++;
        }
      }
    }

    const earningsLastMs = row.earningsLast == null ? null : row.earningsLast * 1000;
    const earningsLastInWindow =
      earningsLastMs != null && Number.isFinite(earningsLastMs) && earningsLastMs >= window.start.getTime();
    const eightK = filings ? newestEightK202(filings, window.start.getTime()) : undefined;

    let earnings: EarningsDetail | null = null;
    if (earningsLastInWindow || eightK) {
      run.requests.nasdaq++;
      try {
        const surprise = await earningsSurprise(row.symbol);
        earnings = toEarningsDetail(
          Array.isArray(surprise) ? surprise : [],
          row.earningsLast,
          eightK?.acceptedAt ?? null,
        );
      } catch {
        run.failures.nasdaq++;
        earnings = null;
      }
    }

    const sectorCount = run.sectorCounts.get(row.sector) ?? 0;
    const sectorShare = run.totalRows === 0 ? 0 : sectorCount / run.totalRows;
    const built = buildCatalysts({
      row: { symbol: row.symbol, earningsLast: row.earningsLast },
      filings,
      headlines,
      newsSource,
      form4,
      earnings,
      window,
      ctx: { sectorShare, sectorCount, flags: run.ctx.flags },
    });
    if (edgarFailed) dropUnfetchedFilings(built);
    const explain = renderExplain(row, built, explainCtx);
    return { ...built, explain };
  } catch {
    run.failures.row = (run.failures.row ?? 0) + 1;
    const empty = {
      tags: [] as Catalysts["tags"],
      evidence: [] as Catalysts["evidence"],
      sources: { edgar: "failed", news: "failed", earnings: "failed" } as Catalysts["sources"],
    };
    return { ...empty, explain: renderExplain(row, empty, explainCtx) };
  }
}

/** buildCatalysts only distinguishes null ("skipped") from an array ("ok"). */
function dropUnfetchedFilings(built: Omit<Catalysts, "explain">): void {
  built.sources.edgar = "failed";
  built.evidence = built.evidence.filter((ev) => ev.kind !== "filing" && ev.kind !== "insider");
  const evidenced = new Set(built.evidence.flatMap((ev) => ev.tags));
  built.tags = built.tags.filter((tag) => evidenced.has(tag.id) || CONTEXT_TAGS.has(tag.id));
}

function newestEightK202(filings: Filing[], startMs: number): Filing | undefined {
  let best: Filing | undefined;
  let bestMs = -Infinity;
  for (const filing of filings) {
    if (filing.form !== "8-K" || !filing.items?.includes("2.02")) continue;
    const ms = Date.parse(filing.acceptedAt);
    if (!Number.isFinite(ms) || ms < startMs || ms < bestMs) continue;
    best = filing;
    bestMs = ms;
  }
  return best;
}

function cikFromFilingUrl(url: string): string | null {
  const match = /\/data\/(\d+)\//.exec(url);
  return match?.[1] ?? null;
}

function toEarningsDetail(
  surprise: EarningsSurpriseRow[],
  earningsLast: number | null,
  eightKAcceptedAt: string | null,
): EarningsDetail | null {
  const target =
    earningsLast != null ? nyYmd(new Date(earningsLast * 1000)) : eightKAcceptedAt ? nyYmd(new Date(eightKAcceptedAt)) : null;
  if (!target) return null;
  const match = surprise.find((row) => utcYmd(row.dateReported) === target);
  if (!match) return null;
  const detail = formatSurprise(match);
  if (!detail) return null;
  const time = earningsLast != null ? isoFromEpochSeconds(earningsLast) : isoFromString(eightKAcceptedAt ?? "");
  if (!time) return null;
  return { time, detail };
}

function formatSurprise(row: EarningsSurpriseRow): string | null {
  const eps = row.eps;
  const est = row.consensusForecast;
  if (eps == null || est == null || !Number.isFinite(eps) || !Number.isFinite(est)) return null;
  let pct: number;
  if (typeof row.surprisePercent === "number" && Number.isFinite(row.surprisePercent)) {
    pct = row.surprisePercent;
  } else if (est === 0) {
    return null;
  } else {
    pct = ((eps - est) / Math.abs(est)) * 100;
  }
  if (!Number.isFinite(pct)) return null;
  const pctBody = formatPctPoints(pct);
  const clause = pct < 0 ? `miss ${MINUS}${pctBody}%` : `beat +${pctBody}%`;
  return `EPS ${formatMoney(eps)} vs ${formatMoney(est)} est (${clause})`;
}

function formatMoney(n: number): string {
  const body = Math.abs(n).toFixed(2);
  return n < 0 ? `${MINUS}$${body}` : `$${body}`;
}

function formatPctPoints(value: number): string {
  const rounded = Math.round(Math.abs(value) * 100) / 100;
  return String(rounded);
}

function utcYmd(epochSeconds: number): string | null {
  if (!Number.isFinite(epochSeconds)) return null;
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function nyYmd(date: Date): string | null {
  if (Number.isNaN(date.getTime())) return null;
  return nyParts(date).date;
}

function isoFromEpochSeconds(epochSeconds: number): string | null {
  if (!Number.isFinite(epochSeconds)) return null;
  const date = new Date(epochSeconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isoFromString(iso: string): string | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
