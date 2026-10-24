// Rule-based Explain lines (requirements §4.7). Pure: no provider or web imports.
// Negative amounts use Unicode minus U+2212 (−), never an ASCII hyphen.

import type { Catalysts, Evidence, Tag, UnusualVolumeRow } from "./types.js";

const MINUS = "\u2212";

/** After-close demotion wording. Added when the strongest tag was demoted and the detail does not already say it. */
const AFTER_CLOSE_SUFFIX = "reported after close, reaction expected next session";

/**
 * The only hedge this renderer may emit. `minDays` is exclusive of today and of the past;
 * `maxDays` is the last day that still gets the phrase (N = 8 is omitted).
 */
const HEDGES = [{ phrase: "possible run-up", minDays: 1, maxDays: 7 }] as const;

/** Display names for the 8-K items line 1 translates. 1.01 matches the §4.7 sentence (no "a"). */
const ITEM_NAMES: Record<string, string> = {
  "1.01": "Entry into material agreement",
  "2.01": "Completion of acquisition",
  "2.02": "Results of operations",
  "5.02": "Departure/appointment of officers",
  "8.01": "Other events",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type ExplainCtx = {
  spyChangePct: number | null;
  totalMatches: number;
  flags: { opex: boolean; spRebalance: boolean; russell: boolean };
  earlyClose: boolean;
};

type CatalystInput = Omit<Catalysts, "explain">;

type NyParts = { year: number; month: number; day: number; hour: number; minute: number };

export function renderExplain(row: UnusualVolumeRow, catalysts: CatalystInput, ctx: ExplainCtx): string[] {
  // `ctx.earlyClose` is part of the run context. Demotion for a 13:00 close is the
  // evidence `afterClose` flag set upstream; the clock fallback below stays 16:00.
  void ctx.earlyClose;
  return [lineCatalyst(catalysts), lineMove(row), lineWho(row), lineContext(row, catalysts, ctx)].filter(
    (line): line is string => typeof line === "string" && line.length > 0,
  );
}

function lineCatalyst(catalysts: CatalystInput): string {
  const tag = catalysts.tags[0];
  const described = tag ? describeTag(tag, catalysts) : null;
  if (described) return described;
  const headline = newest(catalysts.evidence.filter((ev) => ev.kind === "headline"));
  if (headline) return formatHeadline(headline, true);
  return "No catalyst found in news, filings or earnings.";
}

function describeTag(tag: Tag, catalysts: CatalystInput): string | null {
  if (tag.id === "EARN") return describeEarn(tag, catalysts);
  if (tag.id === "INSIDER_BUY") return describeInsider(tag, catalysts);
  if (tag.id === "M&A" || tag.id === "ACTIVIST" || tag.id === "8K") return describeFiling(tag, catalysts);
  return null;
}

function describeEarn(tag: Tag, catalysts: CatalystInput): string | null {
  const ev =
    catalysts.evidence.find((e) => e.kind === "earnings") ??
    catalysts.evidence.find((e) => e.tags.includes("EARN"));
  const detail = (ev?.detail ?? tag.detail)?.trim();
  const lead = ev ? earnLead(ev) : null;
  let sentence: string | null = null;
  if (detail && hasNumericEarnings(detail)) {
    // Upstream owns the beat/miss clause. A detail that already leads with the quarter is used whole.
    sentence = lead && !alreadyHasEarnLead(detail) ? `${lead} — ${detail}` : detail;
  } else if (lead) {
    sentence = lead;
  }
  if (!sentence) return null;
  sentence = withDemotion(sentence, tag);
  const headline = newest(catalysts.evidence.filter((e) => e.kind === "headline"));
  if (!headline) return sentence;
  return `${sentence}; ${formatHeadline(headline, false)}.`;
}

function describeInsider(tag: Tag, catalysts: CatalystInput): string | null {
  const ev =
    catalysts.evidence.find((e) => e.kind === "insider" && e.tags.includes("INSIDER_BUY")) ??
    catalysts.evidence.find((e) => e.kind === "insider");
  const detail = (tag.detail ?? ev?.detail)?.trim();
  if (!detail) return null;
  return withDemotion(detail, tag);
}

function describeFiling(tag: Tag, catalysts: CatalystInput): string | null {
  if (tag.id === "ACTIVIST") return withDemotion("13D: new activist stake filed", tag);
  const ev =
    catalysts.evidence.find((e) => e.kind === "filing" && e.tags.includes(tag.id)) ??
    catalysts.evidence.find((e) => e.kind === "filing");
  const text = ev ? filingSentence(ev.form ?? "", ev.items ?? []) : tag.id === "8K" ? "8-K" : null;
  if (!text) return null;
  return withDemotion(text, tag);
}

function filingSentence(form: string, items: string[]): string | null {
  if (/13D/i.test(form)) return "13D: new activist stake filed";
  const codes = items.map((item) => item.trim()).filter(Boolean);
  const eightK = /^8-K/i.test(form);
  if (eightK || codes.length > 0) {
    const known = codes.find((code) => ITEM_NAMES[code]);
    if (known) return `8-K: ${ITEM_NAMES[known]} (${known})`;
    if (codes.length > 0) return `8-K (${codes.join(", ")})`;
    if (eightK) return "8-K";
  }
  if (form === "SC TO-T") return "SC TO-T: tender offer filed";
  if (form === "DEFM14A") return "DEFM14A: merger proxy filed";
  if (form === "425") return "425: merger communication filed";
  return form ? form : null;
}

function earnLead(ev: Evidence): string | null {
  const parts = nyFromIso(ev.time);
  if (!parts) return null;
  const session = sessionPhrase(ev, parts);
  const when = `${MONTHS[parts.month - 1]} ${parts.day}`;
  return [`Q${fiscalQuarter(parts.month)} earnings`, session, when].filter(Boolean).join(" ");
}

/** Oct–Dec Q3, Jan–Mar Q4, Apr–Jun Q1, Jul–Sep Q2 — the quarter being reported, from the NY month. */
function fiscalQuarter(month: number): number {
  if (month >= 10) return 3;
  if (month >= 7) return 2;
  if (month >= 4) return 1;
  return 4;
}

function sessionPhrase(ev: Evidence, parts: NyParts): "after close" | "before the open" | null {
  const minutes = parts.hour * 60 + parts.minute;
  if (ev.afterClose || minutes >= 16 * 60) return "after close";
  if (minutes < 9 * 60 + 30) return "before the open";
  return null;
}

function hasNumericEarnings(detail: string): boolean {
  return /\b(beat|miss)\b/i.test(detail) || /EPS\s*\$/i.test(detail);
}

function alreadyHasEarnLead(detail: string): boolean {
  return /^Q\d/.test(detail) || /\bearnings\b/i.test(detail);
}

function withDemotion(text: string, tag: Tag): string {
  const demoted = tag.strength === "context" || tag.afterClose === true;
  if (!demoted || text.includes(AFTER_CLOSE_SUFFIX)) return text;
  return `${text} — ${AFTER_CLOSE_SUFFIX}`;
}

function formatHeadline(ev: Evidence, etLabel: boolean): string {
  const parts = nyFromIso(ev.time);
  const hhmm = parts ? `${pad2(parts.hour)}:${pad2(parts.minute)}` : null;
  const time = hhmm ? (etLabel ? `${hhmm} ET` : hhmm) : null;
  const publisher = ev.publisher?.trim() || null;
  const inside = [publisher, time].filter((part): part is string => part != null).join(", ");
  return inside ? `"${ev.title}" (${inside})` : `"${ev.title}"`;
}

function lineMove(row: UnusualVolumeRow): string | null {
  const head = isNum(row.rvol) ? `${row.rvol.toFixed(1)}× its 29-session average` : null;
  const tail: string[] = [];
  // gapPct / candlePct are percentage points (6.2 means +6.2%). Sub-0.05pp gaps are noise.
  if (isNum(row.gapPct) && Math.abs(row.gapPct) >= 0.05) tail.push(`gapped ${fmtSignedPct(row.gapPct)}%`);
  if (isNum(row.candlePct)) {
    const dir = row.candlePct < 0 ? "below" : "above";
    tail.push(`closed ${fmtSignedPct(row.candlePct)}% ${dir} open`);
  }
  if (isNum(row.closeLocation)) {
    if (row.closeLocation >= 0.8) tail.push("near day high");
    else if (row.closeLocation <= 0.4) tail.push("faded from high");
  }
  if (!head && tail.length === 0) return null;
  if (head && tail.length > 0) return `${head} · ${tail.join(", ")}.`;
  return `${head ?? tail.join(", ")}.`;
}

function lineWho(row: UnusualVolumeRow): string | null {
  const bits: string[] = [];
  if (isNum(row.turnover)) bits.push(`Traded ${Math.round(row.turnover * 100)}% of float`);
  if (isNum(row.dollarVolume)) bits.push(`$${fmtMag(row.dollarVolume)} traded`);
  if (bits.length === 0) return null;
  return `${bits.join(" · ")}.`;
}

function lineContext(row: UnusualVolumeRow, catalysts: CatalystInput, ctx: ExplainCtx): string | null {
  const bits: string[] = [];
  if (row.sector && isNum(row.sectorMedianChangePct) && isNum(row.sectorPeersOnList)) {
    bits.push(
      `${row.sector} median ${fmtSignedPct(row.sectorMedianChangePct)}%, ${row.sectorPeersOnList} on the list`,
    );
  }
  if (isNum(ctx.spyChangePct)) bits.push(`SPY ${fmtSignedPct(ctx.spyChangePct)}%`);
  if (isNum(ctx.totalMatches)) bits.push(`${ctx.totalMatches} matches today`);
  if (ctx.flags.opex) bits.push("OPEX");
  if (ctx.flags.spRebalance) bits.push("S&P rebalance");
  if (ctx.flags.russell) bits.push("Russell reconstitution");
  const runUp = earningsNextFact(row, catalysts);
  if (runUp) bits.push(runUp);
  if (bits.length === 0) return null;
  return `${bits.join(" · ")}.`;
}

function earningsNextFact(row: UnusualVolumeRow, catalysts: CatalystInput): string | null {
  if (!isNum(row.earningsNext)) return null;
  const session = sessionYmd(catalysts);
  if (!session) return null;
  const nextDate = epochToDate(row.earningsNext);
  if (!nextDate) return null;
  const next = nyYmd(nextDate);
  if (!next) return null;
  const days = calendarDays(session, next);
  const hedge = HEDGES[0];
  if (days < hedge.minDays || days > hedge.maxDays) return null;
  return `Earnings in ${days} days (${hedge.phrase})`;
}

/** Session date is the EARN evidence's NY date, else the strongest tag's evidence, else nothing. */
function sessionYmd(catalysts: CatalystInput): string | null {
  const earn =
    catalysts.evidence.find((e) => e.kind === "earnings") ??
    catalysts.evidence.find((e) => e.tags.includes("EARN"));
  if (earn) return nyYmdFromIso(earn.time);
  const tag = catalysts.tags[0];
  const tagged = tag ? catalysts.evidence.filter((e) => e.tags.includes(tag.id)) : [];
  const ev = newest(tagged.length > 0 ? tagged : catalysts.evidence);
  return ev ? nyYmdFromIso(ev.time) : null;
}

function fmtSignedPct(n: number): string {
  const body = Math.abs(n).toFixed(1);
  return n < 0 ? MINUS + body : `+${body}`;
}

/** 1.2M / 480M / 1.2B. Under 1e6 the plain number, no K suffix and no trailing .0. */
function fmtMag(n: number): string {
  const sign = n < 0 ? MINUS : "";
  const abs = Math.abs(n);
  if (abs >= 1e9) return sign + trim1(abs / 1e9) + "B";
  if (abs >= 1e6) return sign + trim1(abs / 1e6) + "M";
  return sign + trim1(abs);
}

function trim1(n: number): string {
  const text = n.toFixed(1);
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

function isNum(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function newest(list: Evidence[]): Evidence | undefined {
  let best: Evidence | undefined;
  let bestMs = -Infinity;
  for (const ev of list) {
    const ms = Date.parse(ev.time);
    if (Number.isFinite(ms) && ms >= bestMs) {
      best = ev;
      bestMs = ms;
    }
  }
  return best;
}

function nyFromIso(iso: string): NyParts | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return nyParts(date);
}

function nyYmdFromIso(iso: string): string | null {
  const parts = nyFromIso(iso);
  return parts ? ymd(parts) : null;
}

function nyYmd(date: Date): string | null {
  const parts = nyParts(date);
  return parts ? ymd(parts) : null;
}

function ymd(parts: NyParts): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function nyParts(date: Date): NyParts | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = Number(read("year"));
  const month = Number(read("month"));
  const day = Number(read("day"));
  let hour = Number(read("hour"));
  const minute = Number(read("minute"));
  if (hour === 24) hour = 0;
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
  return { year, month, day, hour, minute };
}

function epochToDate(epoch: number): Date | null {
  const ms = Math.abs(epoch) < 1e12 ? epoch * 1000 : epoch;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

function calendarDays(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split("-").map(Number);
  const [ty, tm, td] = toYmd.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
