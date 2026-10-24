"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  apiGet,
  apiPost,
  fmt,
  fmtBig,
  pctClass,
  type Catalysts,
  type Evidence,
  type Strength,
  type UnusualVolumeResponse,
  type UnusualVolumeRow,
} from "../../lib/api";
import { normalizeSymbol } from "../../lib/symbol";
import { useTerminal } from "../../store/terminal";

const EXPLAIN_PROMPT =
  'Explain this unusual volume in at most 2 sentences, using only the evidence in the context. If the evidence is thin, reply exactly "No clear catalyst in available sources".';

const FIRST_RUN_MESSAGE =
  "First run has not happened yet. It runs daily at 06:00 or on the next startup outside US market hours.";

const AI_TIMEOUT_MS = 15_000;
const REFRESH_COOLDOWN_SEC = 10 * 60;
const THRESHOLDS = [2.5, 3, 5] as const;

export type ColumnKey =
  | "symbol"
  | "close"
  | "candlePct"
  | "rvol"
  | "catalyst"
  | "dayChangePct"
  | "volume"
  | "adv30"
  | "dollarVolume"
  | "marketCap"
  | "sector"
  | "name";

const COLUMN_LABEL: Record<ColumnKey, string> = {
  symbol: "Sym",
  close: "Close",
  candlePct: "Candle %",
  rvol: "RVOL",
  catalyst: "Catalyst",
  dayChangePct: "Day Chg%",
  volume: "Vol",
  adv30: "ADV30",
  dollarVolume: "$ Vol",
  marketCap: "MCap",
  sector: "Sector",
  name: "Name",
};

const ALWAYS_COLUMNS: ColumnKey[] = ["symbol", "close", "candlePct", "rvol", "catalyst"];

/**
 * Columns after the first five, and the widget width (px) at which each appears.
 * symbol, close, candlePct, rvol, and catalyst are always visible.
 *
 * dayChangePct   560
 * volume         660
 * adv30          760
 * dollarVolume   860
 * marketCap      980
 * sector        1140
 * name          1320
 */
const EXTRA_COLUMNS: Array<{ key: ColumnKey; minWidth: number }> = [
  { key: "dayChangePct", minWidth: 560 },
  { key: "volume", minWidth: 660 },
  { key: "adv30", minWidth: 760 },
  { key: "dollarVolume", minWidth: 860 },
  { key: "marketCap", minWidth: 980 },
  { key: "sector", minWidth: 1140 },
  { key: "name", minWidth: 1320 },
];

export function visibleColumns(widthPx: number): ColumnKey[] {
  return [
    ...ALWAYS_COLUMNS,
    ...EXTRA_COLUMNS.filter((col) => widthPx >= col.minWidth).map((col) => col.key),
  ];
}

const STRENGTH_RANK: Record<Strength, number> = {
  strong: 4,
  medium: 3,
  weak: 2,
  context: 1,
};

const EVIDENCE_KINDS: Evidence["kind"][] = ["filing", "earnings", "insider", "headline"];

const KIND_LABEL: Record<Evidence["kind"], string> = {
  filing: "Filing",
  earnings: "Earnings",
  insider: "Insider",
  headline: "Headline",
};

function commitNumber(raw: string, min: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return min;
  return n;
}

function clock(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function rvolClass(rvol: number): string {
  if (rvol >= 5) return "rvol-5";
  if (rvol >= 3) return "rvol-3";
  if (rvol >= 2) return "rvol-2";
  return "";
}

function strongestTagId(catalysts: Catalysts | null): string {
  if (catalysts === null) return "…";
  if (catalysts.tags.length === 0) return "—";
  let best = catalysts.tags[0];
  for (const tag of catalysts.tags) {
    if (STRENGTH_RANK[tag.strength] > STRENGTH_RANK[best.strength]) best = tag;
  }
  return best.id;
}

function loadErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "HTTP 503") return FIRST_RUN_MESSAGE;
  if (message && !/^HTTP \d+$/.test(message)) return message;
  return `Error: ${message || "Request failed"}`;
}

type RefreshBody = {
  error?: string;
  retryAfterSec?: number;
  refreshedAgoSec?: number;
  enrichmentStatus?: "pending" | "complete";
};

function cooldownNote(body: RefreshBody): string {
  const retry = body.retryAfterSec;
  if (typeof retry === "number" && Number.isFinite(retry)) {
    const ago =
      typeof body.refreshedAgoSec === "number" && Number.isFinite(body.refreshedAgoSec)
        ? Math.max(0, Math.round(body.refreshedAgoSec))
        : Math.max(0, REFRESH_COOLDOWN_SEC - Math.round(retry));
    return `Refreshed ${ago}s ago · Available in ${Math.max(0, Math.round(retry))}s`;
  }
  return body.error ?? "Refresh is cooling down";
}

function publisherOrForm(item: Evidence): string {
  if (item.publisher) return item.publisher;
  if (!item.form) return "";
  return item.items && item.items.length > 0 ? `${item.form} ${item.items.join(", ")}` : item.form;
}

export default function UnusualVolumeWidget() {
  const setActiveSymbol = useTerminal((s) => s.setActiveSymbol);
  const queryClient = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);
  const [widthPx, setWidthPx] = useState(Number.POSITIVE_INFINITY);
  const [threshold, setThreshold] = useState(2.5);
  const [thresholdDraft, setThresholdDraft] = useState("2.5");
  const [marketCapMinB, setMarketCapMinB] = useState(0.3);
  const [marketCapDraft, setMarketCapDraft] = useState("0.3");
  const [sector, setSector] = useState("");
  const [sort, setSort] = useState<ColumnKey>("rvol");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [useAi, setUseAi] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pollFast, setPollFast] = useState(false);
  const seenAt = useRef(0);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      if (next > 0) setWidthPx(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { data: sectors = [] } = useQuery({
    queryKey: ["sectors", "us"],
    queryFn: () => apiGet<string[]>("/api/sectors?market=us"),
    staleTime: 600_000,
  });

  const { data: status } = useQuery({
    queryKey: ["status"],
    queryFn: () => apiGet<{ ai: boolean }>("/api/status"),
  });
  const aiAvailable = status?.ai === true;

  const { data, isLoading, error, dataUpdatedAt } = useQuery({
    queryKey: ["unusual-volume", threshold, marketCapMinB, sector, sort, dir],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("threshold", String(threshold));
      params.set("marketCapMin", String(Math.round(marketCapMinB * 1e9)));
      if (sector) params.set("sector", sector);
      params.set("sort", sort);
      params.set("dir", dir);
      return apiGet<UnusualVolumeResponse>(`/api/unusual-volume?${params}`);
    },
    refetchInterval: (query) =>
      pollFast || query.state.data?.enrichmentStatus === "pending" ? 10_000 : 15 * 60_000,
  });

  useEffect(() => {
    if (!pollFast) return;
    if (dataUpdatedAt <= seenAt.current) return;
    if (data?.enrichmentStatus === "complete") setPollFast(false);
  }, [pollFast, dataUpdatedAt, data?.enrichmentStatus]);

  const columns = visibleColumns(widthPx);

  const commitThreshold = () => {
    const next = commitNumber(thresholdDraft, 2.5);
    setThreshold(next);
    setThresholdDraft(String(next));
  };

  const commitMarketCap = () => {
    const next = commitNumber(marketCapDraft, 0.3);
    setMarketCapMinB(next);
    setMarketCapDraft(String(next));
  };

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshNote(null);
    try {
      await apiPost<{ enrichmentStatus: "pending" }>("/api/unusual-volume/refresh", {});
      seenAt.current = dataUpdatedAt;
      setPollFast(true);
      await queryClient.invalidateQueries({ queryKey: ["unusual-volume"] });
    } catch (err) {
      const status = typeof err === "object" && err && "status" in err ? err.status : undefined;
      const body = (typeof err === "object" && err && "body" in err ? err.body : {}) as RefreshBody;
      if (status === 429) {
        setRefreshNote(cooldownNote(body ?? {}));
        return;
      }
      setRefreshNote(err instanceof Error && err.message ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div ref={rootRef} className="min-w-0">
      <div className="flex gap-2 p-1 flex-wrap items-center">
        <div className="flex gap-1">
          {THRESHOLDS.map((value) => (
            <button
              key={value}
              type="button"
              className={`term-btn ${threshold === value ? "active" : ""}`}
              onClick={() => {
                setThreshold(value);
                setThresholdDraft(String(value));
              }}
            >
              {value}×
            </button>
          ))}
        </div>
        <input
          className="w-16"
          type="number"
          min={2.5}
          step={0.1}
          aria-label="RVOL threshold"
          value={thresholdDraft}
          onChange={(e) => setThresholdDraft(e.target.value)}
          onBlur={commitThreshold}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        <label className="dim flex items-center gap-1">
          MCap $B
          <input
            className="w-16"
            type="number"
            min={0.3}
            step={0.1}
            aria-label="Market cap minimum in billions"
            value={marketCapDraft}
            onChange={(e) => setMarketCapDraft(e.target.value)}
            onBlur={commitMarketCap}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </label>
        <select value={sector} onChange={(e) => setSector(e.target.value)} aria-label="Sector">
          <option value="">All sectors</option>
          {sectors.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <button type="button" className="term-btn" onClick={() => void refresh()} disabled={refreshing}>
          Refresh
        </button>
        {refreshNote && <span className="dim">{refreshNote}</span>}
        <button
          type="button"
          className={`term-btn ${useAi && aiAvailable ? "active" : ""}`}
          disabled={!aiAvailable}
          title={!aiAvailable ? "AI not configured" : "Use AI for Explain"}
          onClick={() => setUseAi((on) => !on)}
        >
          AI
        </button>
        {data && (
          <span className="dim ml-auto">
            Session: {data.sessionLabel}
            {data.earlyClose && (
              <span className="ml-1 border border-[var(--amber-dim)] text-[var(--amber)] px-1">early close</span>
            )}
            {" · "}
            {data.totalMatches} matches · run {clock(data.runAt, "Asia/Jerusalem")}
          </span>
        )}
      </div>
      {isLoading && !data && <div className="p-2 dim">Loading…</div>}
      {error && <div className="p-2 down">{loadErrorText(error)}</div>}
      {data && data.rows.length === 0 && !error && (
        <div className="p-2 dim">
          No unusual volume for {data.sessionLabel} at ≥ {threshold}×
        </div>
      )}
      {data && data.rows.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((key) => (
                <th
                  key={key}
                  onClick={() => {
                    if (sort === key) setDir(dir === "asc" ? "desc" : "asc");
                    else setSort(key);
                  }}
                  className={sort === key ? "!text-[var(--amber)]" : ""}
                >
                  {COLUMN_LABEL[key]} {sort === key ? (dir === "desc" ? "▼" : "▲") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <Fragment key={row.symbol}>
                <tr
                  onClick={() => {
                    const sym = normalizeSymbol(row.symbol);
                    if (sym) setActiveSymbol(sym);
                  }}
                >
                  {columns.map((key) => (
                    <Cell
                      key={key}
                      column={key}
                      row={row}
                      expanded={expanded === row.symbol}
                      onToggle={() => setExpanded(expanded === row.symbol ? null : row.symbol)}
                    />
                  ))}
                </tr>
                {expanded === row.symbol && (
                  <tr>
                    <td colSpan={columns.length} className="!text-left !whitespace-normal">
                      {row.catalysts === null ? (
                        <div className="dim px-2 py-1">…</div>
                      ) : (
                        <ExpandedDetail
                          row={row}
                          sessionDate={data.sessionDate}
                          useAi={useAi}
                          aiAvailable={aiAvailable}
                        />
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Cell({
  column,
  row,
  expanded,
  onToggle,
}: {
  column: ColumnKey;
  row: UnusualVolumeRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  switch (column) {
    case "symbol":
      return (
        <td className="font-bold">
          <button
            type="button"
            className="dim mr-1"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse row" : "Expand row"}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            {expanded ? "▼" : "▶"}
          </button>
          {row.symbol}
        </td>
      );
    case "close":
      return <td>{fmt(row.close)}</td>;
    case "candlePct":
      return <td className={pctClass(row.candlePct)}>{fmt(row.candlePct)}%</td>;
    case "rvol":
      return <td className={rvolClass(row.rvol)}>{fmt(row.rvol, 2)}×</td>;
    case "catalyst":
      return <td>{strongestTagId(row.catalysts)}</td>;
    case "dayChangePct":
      return <td className={pctClass(row.dayChangePct)}>{fmt(row.dayChangePct)}%</td>;
    case "volume":
      return <td>{fmtBig(row.volume)}</td>;
    case "adv30":
      return <td>{fmtBig(row.adv30)}</td>;
    case "dollarVolume":
      return <td>{fmtBig(row.dollarVolume)}</td>;
    case "marketCap":
      return <td>{fmtBig(row.marketCap)}</td>;
    case "sector":
      return <td className="!text-left dim">{row.sector}</td>;
    case "name":
      return <td className="!text-left max-w-40 truncate">{row.name}</td>;
  }
}

function ExpandedDetail({
  row,
  sessionDate,
  useAi,
  aiAvailable,
}: {
  row: UnusualVolumeRow;
  sessionDate: string;
  useAi: boolean;
  aiAvailable: boolean;
}) {
  const catalysts = row.catalysts;
  const ai = useQuery({
    queryKey: ["uv-ai", sessionDate, row.symbol],
    staleTime: Infinity,
    retry: false,
    enabled: useAi && aiAvailable && catalysts !== null,
    queryFn: () => requestExplain(row, sessionDate),
  });

  if (catalysts === null) return <div className="dim px-2 py-1">…</div>;

  const aiText = useAi && aiAvailable && ai.isSuccess && ai.data ? ai.data : null;
  const groups = EVIDENCE_KINDS.map((kind) => ({
    kind,
    items: catalysts.evidence.filter((item) => item.kind === kind),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="px-2 py-1 space-y-1">
      <div>
        <span className={aiText ? "up" : "dim"}>{aiText ? "AI" : "RULES"}</span>
        {useAi && aiAvailable && ai.isFetching && !aiText && <span className="dim"> …</span>}
        {aiText ? (
          <div className="whitespace-pre-wrap">{aiText}</div>
        ) : (
          catalysts.explain.map((line, i) => <div key={i}>{line}</div>)
        )}
      </div>
      {groups.map((group) => (
        <div key={group.kind}>
          <div className="dim">{KIND_LABEL[group.kind]}</div>
          {group.items.map((item, i) => (
            <div key={`${item.time}-${item.title}-${i}`}>
              <span className="dim">{clock(item.time, "America/New_York")}</span>
              {item.afterClose && (
                <span className="ml-1 border border-[var(--amber-dim)] text-[var(--amber)] px-1">after close</span>
              )}
              {publisherOrForm(item) && <span className="ml-1">{publisherOrForm(item)}</span>}
              {item.url ? (
                <a href={item.url} target="_blank" rel="noopener" className="ml-1 underline">
                  {item.title || item.url}
                </a>
              ) : (
                item.title && <span className="ml-1">{item.title}</span>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

async function requestExplain(row: UnusualVolumeRow, sessionDate: string): Promise<string> {
  const catalysts = row.catalysts;
  if (!catalysts) throw new Error("no catalysts");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      apiPost<{ text: string }>("/api/ai/chat", {
        messages: [{ role: "user", content: EXPLAIN_PROMPT }],
        context: {
          symbol: row.symbol,
          sessionDate,
          metrics: {
            prevClose: row.prevClose,
            adv30: row.adv30,
            rvol: row.rvol,
            candlePct: row.candlePct,
            dayChangePct: row.dayChangePct,
            gapPct: row.gapPct,
            closeLocation: row.closeLocation,
            dollarVolume: row.dollarVolume,
            turnover: row.turnover,
          },
          tags: catalysts.tags,
          evidence: catalysts.evidence,
          explainRules: catalysts.explain,
        },
      }).then((res) => (res.text ?? "").trim()),
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), AI_TIMEOUT_MS);
      }),
    ]);
    if (!text) throw new Error("empty");
    return text;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
