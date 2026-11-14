// SEC EDGAR — insider transactions (Form 4), straight from the primary source.
// Free, no key, no rate-limit games (SEC just asks for an identifying User-Agent
// and stays under ~10 req/s, both trivially satisfied here).
import { XMLParser } from "fast-xml-parser";
import { mapWithConcurrency } from "../concurrency.js";

// SEC rejects requests whose User-Agent doesn't look like "<app/company> <contact-email>" —
// a bare product name or URL gets a flat 403, so this exact shape matters. SEC uses it to
// reach whoever's operating a deployment if their traffic misbehaves, so self-hosters should
// set SEC_EDGAR_CONTACT to their own email; this default is just enough to pass the check.
const UA = `OpenTerminal ${process.env.SEC_EDGAR_CONTACT ?? "ertassellireplay@gmail.com"}`;
const parser = new XMLParser({ ignoreAttributes: false });

async function edgarFetch(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`sec edgar ${res.status} for ${url}`);
  return res.json();
}

let tickerMap: Map<string, string> | null = null;
let tickerMapLoading: Promise<void> | null = null;

/** Ticker -> zero-padded 10-digit CIK, from SEC's full company list (cached in-process). */
async function resolveCik(symbol: string): Promise<string | null> {
  if (!tickerMap) {
    // The enrich fan-out asks for several symbols at once. Without a shared
    // promise each of them would download the full ticker file before the map exists.
    if (!tickerMapLoading) {
      tickerMapLoading = edgarFetch("https://www.sec.gov/files/company_tickers.json")
        .then((data) => {
          const map = new Map<string, string>();
          for (const row of Object.values(data) as Array<{ ticker: string; cik_str: number }>) {
            map.set(row.ticker.toUpperCase(), String(row.cik_str).padStart(10, "0"));
          }
          tickerMap = map;
        })
        .finally(() => {
          tickerMapLoading = null;
        });
    }
    await tickerMapLoading;
  }
  return tickerMap?.get(symbol.toUpperCase()) ?? null;
}

export type InsiderTransaction = {
  filingDate: string; // ISO
  transactionDate: string; // ISO
  ownerName: string;
  ownerTitle: string | null;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercentOwner: boolean;
  transactionCode: string;
  acquiredDisposed: "A" | "D" | null;
  shares: number | null;
  pricePerShare: number | null;
  value: number | null;
  sharesOwnedAfter: number | null;
};

export type Filing = {
  form: string;
  acceptedAt: string; // ISO from filings.recent.acceptanceDateTime
  items: string[]; // split on comma, trimmed; [] when the field is absent or empty
  accessionNumber: string;
  primaryDocument: string;
  url: string; // https://www.sec.gov/Archives/edgar/data/{Number(cik)}/{accessionNoDashes}/{primaryDocument}
};

function filingUrl(cik: string, accessionNumber: string, primaryDocument: string): string {
  const accessionNoDashes = accessionNumber.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNoDashes}/${primaryDocument}`;
}

function splitItems(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** `items` is optional on older filings; a missing array is an empty list for every row. */
function itemsAt(recent: { items?: unknown }, index: number): string[] {
  const items = recent.items;
  if (!Array.isArray(items)) return [];
  return splitItems(items[index]);
}

async function fetchSubmissions(cik: string): Promise<any> {
  return edgarFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
}

/**
 * Filings whose acceptanceDateTime is at or after `sinceIso`, newest first.
 * `null` when the ticker has no CIK — submissions is not requested in that case.
 */
export async function filingsSince(symbol: string, sinceIso: string): Promise<Filing[] | null> {
  const cik = await resolveCik(symbol);
  if (!cik) return null;
  const data = await fetchSubmissions(cik);
  const recent = data?.filings?.recent;
  const accepted = recent?.acceptanceDateTime;
  if (!Array.isArray(accepted)) return [];
  const out: Filing[] = [];
  // Newest-first. The first acceptance before the window ends the scan so later
  // indexes (often absent, sometimes malformed) are never read.
  for (let i = 0; i < accepted.length; i++) {
    const acceptedAt = accepted[i];
    if (typeof acceptedAt !== "string" || acceptedAt < sinceIso) break;
    const accessionNumber: string = recent.accessionNumber[i];
    const primaryDocument: string = recent.primaryDocument[i];
    out.push({
      form: recent.form[i],
      acceptedAt,
      items: itemsAt(recent, i),
      accessionNumber,
      primaryDocument,
      url: filingUrl(cik, accessionNumber, primaryDocument),
    });
  }
  return out;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

export async function form4Transactions(cik: string, filing: Filing): Promise<InsiderTransaction[]> {
  const accessionNoDashes = filing.accessionNumber.replace(/-/g, "");
  // primaryDocument is the XSLT-rendered viewer path (e.g. "xslF345X06/form4.xml") —
  // the raw data XML sits at the accession folder root under its own filename.
  // Filing.url keeps the full primaryDocument; this fetch does not.
  const filename = filing.primaryDocument.split("/").pop();
  const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNoDashes}/${filename}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return [];
  const xml = await res.text();
  const doc = parser.parse(xml)?.ownershipDocument;
  if (!doc) return [];

  const filingDate = filing.acceptedAt.slice(0, 10);
  const owner = doc.reportingOwner;
  const ownerName: string = owner?.reportingOwnerId?.rptOwnerName ?? "Unknown";
  const rel = owner?.reportingOwnerRelationship ?? {};
  const isDirector = rel.isDirector === "1" || rel.isDirector === true;
  const isOfficer = rel.isOfficer === "1" || rel.isOfficer === true;
  const isTenPercentOwner = rel.isTenPercentOwner === "1" || rel.isTenPercentOwner === true;
  const ownerTitle: string | null = rel.officerTitle || null;

  // Open-market buys/sells only (nonDerivativeTable) — grants/option exercises live in
  // derivativeTable and are routine compensation, not the signal people watch this for.
  const raw = doc.nonDerivativeTable?.nonDerivativeTransaction;
  if (!raw) return [];
  const rows = Array.isArray(raw) ? raw : [raw];

  return rows.map((r: any): InsiderTransaction => {
    const shares = num(r.transactionAmounts?.transactionShares?.value);
    const price = num(r.transactionAmounts?.transactionPricePerShare?.value);
    return {
      filingDate,
      transactionDate: r.transactionDate?.value ?? filingDate,
      ownerName,
      ownerTitle,
      isDirector,
      isOfficer,
      isTenPercentOwner,
      transactionCode: r.transactionCoding?.transactionCode ?? "?",
      acquiredDisposed: r.transactionAmounts?.transactionAcquiredDisposedCode?.value ?? null,
      shares,
      pricePerShare: price,
      value: shares !== null && price !== null ? shares * price : null,
      sharesOwnedAfter: num(r.postTransactionAmounts?.sharesOwnedFollowingTransaction?.value),
    };
  });
}

// Bounds how many of a single request's Form 4 filings are fetched from
// sec.gov at once, so one call to insiderTransactions() can't burst past the
// ~10 req/s SEC asks callers to stay under (see file header).
const SEC_FETCH_CONCURRENCY = 5;

/** Most recent open-market insider transactions for a symbol, newest first. */
export async function insiderTransactions(symbol: string, filingLimit = 20): Promise<InsiderTransaction[]> {
  const cik = await resolveCik(symbol);
  if (!cik) return [];
  // filingsSince is windowed and would drop older Form 4s. This stays the newest
  // `filingLimit` submissions whose form is "4", then the same open-market parse.
  const data = await fetchSubmissions(cik);
  const recent = data?.filings?.recent;
  const forms: unknown[] = Array.isArray(recent?.form) ? recent.form : [];
  const filings: Filing[] = [];
  for (let i = 0; i < forms.length && filings.length < filingLimit; i++) {
    if (forms[i] !== "4") continue;
    const filingDate: string = recent.filingDate[i];
    const accessionNumber: string = recent.accessionNumber[i];
    const primaryDocument: string = recent.primaryDocument[i];
    filings.push({
      form: "4",
      // form4Transactions takes filingDate from acceptedAt's calendar day.
      // submissions filingDate is already YYYY-MM-DD, so the previous field is unchanged.
      acceptedAt: filingDate,
      items: itemsAt(recent, i),
      accessionNumber,
      primaryDocument,
      url: filingUrl(cik, accessionNumber, primaryDocument),
    });
  }
  const parsed = await mapWithConcurrency(filings, SEC_FETCH_CONCURRENCY, (f) =>
    form4Transactions(cik, f).catch(() => []),
  );
  return parsed.flat().sort((a, b) => b.transactionDate.localeCompare(a.transactionDate));
}
