// Catalyst tags and the evidence behind them. Pure: callers pass filings,
// headlines, Form 4 rows, and earnings; this module does not fetch.
import { previousTradingDay } from "../marketCalendar.js";
import { dedupe, type NewsItem } from "../providers/news.js";
import type { Filing, InsiderTransaction } from "../providers/secedgar.js";
import { nyDateTime } from "../time.js";
import type { Catalysts, Evidence, Strength, Tag, TagId } from "./types.js";

export type KeywordRule = { tag: TagId; strength: Strength; pattern: RegExp };

// Headline rules, first match wins. Every rule needs a test case in
// catalysts.test.ts — a pattern change without a matching title is incomplete.
export const RULES: readonly KeywordRule[] = [
  { tag: "M&A", strength: "medium", pattern: /acquir|merger|buyout|takeover|to be acquired|deal to buy/i },
  { tag: "FDA", strength: "medium", pattern: /FDA|approval|PDUFA|phase [123]|trial results|topline/i },
  { tag: "ANALYST", strength: "medium", pattern: /upgrade|initiat|price target|raises target|outperform|overweight|buy rating/i },
  { tag: "GUIDANCE", strength: "medium", pattern: /guidance|raises outlook|raises forecast|preannounce/i },
  { tag: "CONTRACT", strength: "medium", pattern: /contract|awarded|partnership|agreement with|collaboration/i },
  { tag: "INDEX", strength: "medium", pattern: /added to (the )?S&P|join.*index|Russell reconstitution/i },
];

/** Short 8-K item labels. Unknown codes stay as the code itself. */
export const ITEM_NAMES: Record<string, string> = {
  "1.01": "Entry into a material agreement",
  "2.01": "Completion of acquisition",
  "2.02": "Results of operations",
  "5.02": "Departure or appointment of officers",
  "8.01": "Other events",
};

const MA_FORMS = new Set(["SC TO-T", "DEFM14A", "425"]);
const ACTIVIST_FORMS = new Set(["SC 13D", "SC 13D/A"]);
const AFTER_CLOSE_NOTE = "reported after close, reaction expected next session";
const HEADLINE_CAP = 5;

const STRENGTH_RANK: Record<Strength, number> = {
  strong: 3,
  medium: 2,
  weak: 1,
  context: 0,
};

export function strengthRank(s: Strength): number {
  return STRENGTH_RANK[s];
}

/** Prior close of D-1 through the cash close of D. Upper bound of evidence is the run, not closeOfD. */
export function catalystWindow(sessionDate: string, earlyClose: boolean): { start: Date; closeOfD: Date } {
  return {
    start: nyDateTime(previousTradingDay(sessionDate), "16:00"),
    closeOfD: nyDateTime(sessionDate, earlyClose ? "13:00" : "16:00"),
  };
}

export type EarningsDetail = { time: string; detail: string; afterClose?: boolean };

export function buildCatalysts(input: {
  row: { symbol: string; earningsLast: number | null };
  filings: Filing[] | null;
  headlines: NewsItem[];
  newsSource: "google" | "yahoo" | "failed";
  form4: InsiderTransaction[];
  earnings: EarningsDetail | null;
  window: { start: Date; closeOfD: Date };
  ctx: { sectorShare: number; sectorCount: number; flags: { opex: boolean; spRebalance: boolean; russell: boolean } };
}): Omit<Catalysts, "explain"> {
  const { window } = input;
  const evidence: Evidence[] = [];
  const drafts: TagDraft[] = [];

  if (input.filings) {
    for (const filing of input.filings) {
      const time = parseInstant(filing.acceptedAt);
      if (!time || time.getTime() < window.start.getTime()) continue;
      const classified = classifyFiling(filing);
      if (!classified) continue;
      const afterClose = time.getTime() > window.closeOfD.getTime();
      const detail = afterClose ? withAfterCloseNote(classified.detail) : classified.detail;
      evidence.push({
        kind: "filing",
        time: time.toISOString(),
        afterClose,
        title: classified.title,
        url: filing.url,
        form: filing.form,
        items: filing.items,
        ...(detail ? { detail } : {}),
        tags: classified.tags,
      });
      for (const id of classified.tags) {
        drafts.push({
          id,
          strength: afterClose ? "context" : filingStrength(id),
          ...(afterClose ? { afterClose: true } : {}),
          ...(detail ? { detail } : {}),
          time: time.toISOString(),
        });
      }
    }
  }

  const earningsLastAt = earningsInstant(input.row.earningsLast);
  const earningsLastInWindow = earningsLastAt !== null && earningsLastAt.getTime() >= window.start.getTime();

  if (input.earnings) {
    const time = parseInstant(input.earnings.time);
    if (time && time.getTime() >= window.start.getTime()) {
      pushEarnings(drafts, evidence, window, time, input.earnings.detail);
    }
  } else if (earningsLastInWindow && earningsLastAt) {
    pushEarnings(drafts, evidence, window, earningsLastAt, undefined);
  }

  for (const tx of input.form4) {
    if (tx.transactionCode !== "P") continue;
    const time = insiderInstant(tx.filingDate);
    if (!time || time.getTime() < window.start.getTime()) continue;
    const afterClose = time.getTime() > window.closeOfD.getTime();
    const detail = afterClose ? withAfterCloseNote(insiderDetail(tx)) : insiderDetail(tx);
    const iso = time.toISOString();
    evidence.push({
      kind: "insider",
      time: iso,
      afterClose,
      title: "Form 4",
      url: null,
      detail,
      tags: ["INSIDER_BUY"],
    });
    drafts.push({
      id: "INSIDER_BUY",
      strength: afterClose ? "context" : "strong",
      ...(afterClose ? { afterClose: true } : {}),
      detail,
      time: iso,
    });
  }

  const inWindowHeadlines = input.headlines.flatMap((item) => {
    if (!item.publishedAt) return [];
    const time = parseInstant(item.publishedAt);
    if (!time || time.getTime() < window.start.getTime()) return [];
    return [{ ...item, publishedAt: time.toISOString() }];
  });
  for (const item of dedupe([inWindowHeadlines]).slice(0, HEADLINE_CAP)) {
    const time = parseInstant(item.publishedAt ?? "");
    if (!time) continue;
    const rule = RULES.find((candidate) => candidate.pattern.test(item.title));
    const id: TagId = rule?.tag ?? "NEWS";
    const strength: Strength = rule?.strength ?? "weak";
    const afterClose = time.getTime() > window.closeOfD.getTime();
    evidence.push({
      kind: "headline",
      time: time.toISOString(),
      afterClose,
      title: item.title,
      url: item.link,
      publisher: item.publisher,
      tags: [id],
    });
    drafts.push({ id, strength, time: time.toISOString() });
  }

  if (input.ctx.sectorShare >= 0.25 && input.ctx.sectorCount >= 5) {
    drafts.push({ id: "SECTOR", strength: "context" });
  }
  if (input.ctx.flags.opex) drafts.push({ id: "OPEX", strength: "context" });
  if (input.ctx.flags.spRebalance) drafts.push({ id: "REBAL", strength: "context" });
  if (input.ctx.flags.russell) drafts.push({ id: "RUSSELL", strength: "context" });

  evidence.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));

  return {
    tags: collapseTags(drafts),
    evidence,
    sources: {
      edgar: input.filings === null ? "skipped" : "ok",
      news: input.newsSource === "google" ? "ok" : input.newsSource === "yahoo" ? "fallback" : "failed",
      earnings: input.earnings ? "ok" : earningsLastInWindow ? "failed" : "skipped",
    },
  };
}

type TagDraft = {
  id: TagId;
  strength: Strength;
  afterClose?: boolean;
  detail?: string;
  time?: string;
};

function collapseTags(drafts: TagDraft[]): Tag[] {
  const best = new Map<TagId, TagDraft>();
  for (const draft of drafts) {
    const current = best.get(draft.id);
    if (!current || wins(draft, current)) best.set(draft.id, draft);
  }
  return [...best.values()]
    .sort((a, b) => strengthRank(b.strength) - strengthRank(a.strength) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(toTag);
}

/** Higher strength wins. A tie keeps the later timestamp, and a detail beats an empty one. */
function wins(next: TagDraft, current: TagDraft): boolean {
  const rank = strengthRank(next.strength) - strengthRank(current.strength);
  if (rank !== 0) return rank > 0;
  if (!current.detail && next.detail) return true;
  if (current.detail && !next.detail) return false;
  return (next.time ?? "") > (current.time ?? "");
}

function toTag(draft: TagDraft): Tag {
  return {
    id: draft.id,
    strength: draft.strength,
    ...(draft.afterClose ? { afterClose: true } : {}),
    ...(draft.detail ? { detail: draft.detail } : {}),
  };
}

function filingStrength(id: TagId): Strength {
  return id === "8K" ? "weak" : "strong";
}

function classifyFiling(filing: Filing): { tags: TagId[]; title: string; detail?: string } | null {
  const tags: TagId[] = [];
  if (filing.form === "8-K") {
    const has = (code: string) => filing.items.includes(code);
    if (has("2.02")) tags.push("EARN");
    if (has("1.01") || has("2.01")) tags.push("M&A");
    if (!has("2.02") && !has("1.01") && !has("2.01")) tags.push("8K");
  } else if (MA_FORMS.has(filing.form)) {
    tags.push("M&A");
  } else if (ACTIVIST_FORMS.has(filing.form)) {
    tags.push("ACTIVIST");
  }
  if (tags.length === 0) return null;
  const detail = itemPhrase(filing.items);
  const title = detail ? `${filing.form}: ${detail}` : filing.form;
  return { tags, title, ...(detail ? { detail } : {}) };
}

function itemPhrase(items: string[]): string | undefined {
  if (items.length === 0) return undefined;
  return items.map((code) => (ITEM_NAMES[code] ? `${ITEM_NAMES[code]} (${code})` : code)).join(", ");
}

function pushEarnings(
  drafts: TagDraft[],
  evidence: Evidence[],
  window: { closeOfD: Date },
  time: Date,
  numericDetail: string | undefined,
): void {
  const afterClose = time.getTime() > window.closeOfD.getTime();
  const detail = afterClose ? withAfterCloseNote(numericDetail) : numericDetail;
  const iso = time.toISOString();
  evidence.push({
    kind: "earnings",
    time: iso,
    afterClose,
    title: "Earnings",
    url: null,
    ...(detail ? { detail } : {}),
    tags: ["EARN"],
  });
  drafts.push({
    id: "EARN",
    strength: afterClose ? "context" : "strong",
    ...(afterClose ? { afterClose: true } : {}),
    ...(detail ? { detail } : {}),
    time: iso,
  });
}

function insiderDetail(tx: InsiderTransaction): string {
  const who = tx.ownerTitle?.trim() ? tx.ownerTitle.trim() : tx.ownerName;
  if (tx.shares != null && tx.value != null) {
    return `${who} bought ${formatShares(tx.shares)} sh (${formatCompactDollars(tx.value)})`;
  }
  if (tx.shares != null) return `${who} bought ${formatShares(tx.shares)} sh`;
  if (tx.value != null) return `${who} bought (${formatCompactDollars(tx.value)})`;
  return `${who} bought`;
}

function formatShares(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatCompactDollars(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const tiers: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [div, suffix] of tiers) {
    if (abs >= div) {
      const text = (abs / div).toFixed(1).replace(/\.0$/, "");
      return `${sign}$${text}${suffix}`;
    }
  }
  return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function withAfterCloseNote(detail: string | undefined): string {
  if (!detail) return AFTER_CLOSE_NOTE;
  if (detail.includes(AFTER_CLOSE_NOTE)) return detail;
  return `${detail} — ${AFTER_CLOSE_NOTE}`;
}

function earningsInstant(earningsLast: number | null): Date | null {
  if (earningsLast == null) return null;
  const time = new Date(earningsLast * 1000);
  return Number.isNaN(time.getTime()) ? null : time;
}

/** Date-only Form 4 stamps have no clock; acceptance-with-time is kept as given. */
function insiderInstant(filingDate: string): Date | null {
  const trimmed = filingDate.trim();
  if (!trimmed) return null;
  return parseInstant(trimmed.includes("T") ? trimmed : `${trimmed}T00:00:00Z`);
}

function parseInstant(iso: string): Date | null {
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? null : time;
}
