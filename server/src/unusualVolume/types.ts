// Shared contract for the unusual-volume pipeline. Pure modules and the store
// import these; provider modules keep their own response types.

export type ScanRow = {
  symbol: string;
  exchange: string;
  name: string;
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
};

export type Metrics = {
  prevClose: number;
  adv30: number;
  rvol: number;
  candlePct: number;
  dayChangePct: number;
  gapPct: number;
  closeLocation: number | null;
  dollarVolume: number;
  turnover: number | null;
};

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

/** `"fallback"` is the Yahoo News path. `"skipped"` means the source was not asked. */
export type SourceStatus = "ok" | "fallback" | "failed" | "skipped";

export type Catalysts = {
  tags: Tag[];
  evidence: Evidence[];
  explain: string[];
  sources: Partial<Record<"edgar" | "news" | "earnings", SourceStatus>>;
};

export type UnusualVolumeRow = ScanRow &
  Metrics & {
    sectorMedianChangePct: number;
    sectorPeersOnList: number;
    catalysts: Catalysts | null;
  };

export type RunCounts = {
  universe: number;
  /** Survivors of ADV30 ≥ 1_000_000. */
  liquid: number;
  /** Survivors of the market-cap floor (after the price floor, which has no field of its own). */
  mcap: number;
  rvol: number;
  green: number;
  seasoned: number;
  matches: number;
};

export type RunSummary = {
  sessionDate: string;
  earlyClose: boolean;
  spyChangePct: number | null;
  counts: RunCounts;
  requests: Record<string, number>;
  failures: Record<string, number>;
  durationMs: number;
};

export type RunOutcome =
  | { kind: "skipped"; reason: "market-hours" | "exists" }
  | { kind: "ran"; summary: RunSummary };
