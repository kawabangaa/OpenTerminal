import { XMLParser } from "fast-xml-parser";

export type NewsItem = {
  title: string;
  link: string;
  publisher: string;
  publishedAt: string | null;
  symbol: string | null;
};

const parser = new XMLParser({ ignoreAttributes: false });
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

// Google News only. Yahoo fallback and the existing symbolNews/topNews callers stay unlimited.
const MAX_CONCURRENT = 2;
const START_GAP_MS = 300;
let active = 0;
let lastStart = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
  const now = Date.now();
  const startAt = Math.max(now, lastStart + START_GAP_MS);
  lastStart = startAt;
  const wait = startAt - now;
  if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
}
function release(): void {
  active--;
  waiters.shift()?.();
}

// Whole tokens only, stripped repeatedly from the end. A suffix that is the entire string stays.
const TRAILING_SUFFIX = /^(.*\S)\s+(corporation|company|holdings|group|inc|corp|ltd|plc|n\.v|s\.a|co)$/i;

export function shortName(name: string): string {
  let s = name.replace(/\s+/g, " ").trim();
  while (s) {
    s = s.replace(/[,.\s]+$/g, "").trim();
    if (!s) return "";
    const match = s.match(TRAILING_SUFFIX);
    if (!match) return s;
    s = match[1];
  }
  return "";
}

function headlineRelevant(title: string, short: string, symbol: string): boolean {
  if (short && title.toLowerCase().includes(short.toLowerCase())) return true;
  if (symbol.length < 3) return false;
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(title);
}

async function fetchRss(url: string, publisher: string, symbol: string | null): Promise<NewsItem[]> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`rss ${res.status} ${url}`);
  const xml = await res.text();
  const doc = parser.parse(xml);
  const items = doc?.rss?.channel?.item ?? [];
  const list = Array.isArray(items) ? items : [items];
  return list
    .filter((i: any) => i?.title && i?.link)
    .map((i: any) => ({
      title: String(i.title),
      link: String(i.link),
      publisher: i.source?.["#text"] ?? publisher,
      publishedAt: i.pubDate ? new Date(i.pubDate).toISOString() : null,
      symbol,
    }));
}

export async function symbolNews(symbol: string): Promise<NewsItem[]> {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
  return fetchRss(url, "Yahoo Finance", symbol);
}

export async function topNews(query = "stock market"): Promise<NewsItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  return fetchRss(url, "Google News", null);
}

export async function companyNews(name: string, symbol: string): Promise<{ items: NewsItem[]; source: "google" | "yahoo" | "failed" }> {
  try {
    const short = shortName(name);
    const query = `"${short}" stock when:3d`;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    await acquire();
    let relevant: NewsItem[] = [];
    try {
      const items = await fetchRss(url, "Google News", symbol);
      relevant = items.filter((item) => headlineRelevant(item.title, short, symbol));
    } finally {
      release();
    }
    if (relevant.length > 0) return { items: relevant, source: "google" };
  } catch {
    // HTTP error or a parse/throw from Google — Yahoo below.
  }

  try {
    const items = await symbolNews(symbol);
    if (items.length > 0) return { items, source: "yahoo" };
  } catch {
    // Yahoo failed too.
  }
  return { items: [], source: "failed" };
}

/** Merge, de-duplicate by normalized title, newest first. */
export function dedupe(lists: NewsItem[][]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const item of lists.flat()) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
}
