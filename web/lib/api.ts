export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error ?? `HTTP ${res.status}`) as Error & {
      status: number;
      body: unknown;
    };
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return res.json();
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(path, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
}

export type Quote = {
  symbol: string;
  name: string | null;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  avgVolume: number | null;
  marketCap: number | null;
  pe: number | null;
  eps: number | null;
  dividendYield: number | null;
  week52High: number | null;
  week52Low: number | null;
  beta: number | null;
  sharesOutstanding: number | null;
  currency: string | null;
  exchange: string | null;
  marketState: string | null;
  source: string;
  sector?: string;
  label?: string;
};

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtBig(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

export function pctClass(n: number | null | undefined): string {
  if (n === null || n === undefined) return "dim";
  return n >= 0 ? "up" : "down";
}

export type TagId =
  | "EARN"
  | "M&A"
  | "ACTIVIST"
  | "INSIDER_BUY"
  | "FDA"
  | "ANALYST"
  | "GUIDANCE"
  | "CONTRACT"
  | "INDEX"
  | "8K"
  | "NEWS"
  | "SECTOR"
  | "OPEX"
  | "REBAL"
  | "RUSSELL";

export type Strength = "strong" | "medium" | "weak" | "context";

export type Evidence = {
  kind: "headline" | "filing" | "earnings" | "insider";
  time: string;
  afterClose: boolean;
  title: string;
  url: string | null;
  publisher?: string;
  form?: string;
  items?: string[];
  detail?: string;
  tags: TagId[];
};

export type Tag = { id: TagId; strength: Strength; afterClose?: boolean; detail?: string };

export type Catalysts = {
  tags: Tag[];
  evidence: Evidence[];
  explain: string[];
  sources: Partial<Record<"edgar" | "news" | "earnings", "ok" | "fallback" | "failed" | "skipped">>;
};

export type UnusualVolumeRow = {
  symbol: string;
  name: string;
  exchange: string;
  sector: string;
  open: number;
  high: number;
  low: number;
  close: number;
  changePct: number;
  volume: number;
  avg30: number;
  marketCap: number | null;
  float: number | null;
  earningsLast: number | null;
  earningsNext: number | null;
  prevClose: number;
  adv30: number;
  rvol: number;
  candlePct: number;
  dayChangePct: number;
  gapPct: number;
  closeLocation: number | null;
  dollarVolume: number;
  turnover: number | null;
  sectorMedianChangePct: number;
  sectorPeersOnList: number;
  catalysts: Catalysts | null;
};

export type UnusualVolumeResponse = {
  sessionDate: string;
  sessionLabel: string;
  earlyClose: boolean;
  runAt: string;
  enrichmentStatus: "complete" | "pending";
  spyChangePct: number | null;
  totalMatches: number;
  flags: { opex: boolean; spRebalance: boolean; russell: boolean };
  rows: UnusualVolumeRow[];
};
