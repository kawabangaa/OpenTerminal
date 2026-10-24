import { db } from "../db.js";
import type { Catalysts, RunSummary, UnusualVolumeRow } from "./types.js";

export type StoredRun = {
  sessionDate: string;
  runAt: string;
  enrichedAt: string | null;
  status: "list" | "complete";
  earlyClose: boolean;
  spyChangePct: number | null;
  universeSize: number;
  summary: RunSummary;
};

export type ListPhaseRun = {
  sessionDate: string;
  runAt: string;
  earlyClose: boolean;
  spyChangePct: number | null;
  universeSize: number;
  summary: RunSummary;
};

type RunSql = {
  session_date: string;
  run_at: string;
  enriched_at: string | null;
  status: string;
  early_close: number;
  spy_change_pct: number | null;
  universe_size: number;
  summary_json: string;
};

type RowSql = {
  row_json: string;
  catalyst_json: string | null;
};

const RUN_COLUMNS = `session_date, run_at, enriched_at, status, early_close, spy_change_pct, universe_size, summary_json`;

const selectRun = db.prepare(
  `SELECT ${RUN_COLUMNS} FROM unusual_volume_runs WHERE session_date = ?`
);

const selectLatestRun = db.prepare(
  `SELECT ${RUN_COLUMNS} FROM unusual_volume_runs ORDER BY session_date DESC LIMIT 1`
);

const upsertRun = db.prepare(
  `INSERT INTO unusual_volume_runs (
     session_date, run_at, enriched_at, status, early_close, spy_change_pct, universe_size, summary_json
   ) VALUES (?, ?, NULL, 'list', ?, ?, ?, ?)
   ON CONFLICT(session_date) DO UPDATE SET
     run_at = excluded.run_at,
     enriched_at = NULL,
     status = 'list',
     early_close = excluded.early_close,
     spy_change_pct = excluded.spy_change_pct,
     universe_size = excluded.universe_size,
     summary_json = excluded.summary_json`
);

const deleteSessionRows = db.prepare(
  `DELETE FROM unusual_volume_rows WHERE session_date = ?`
);

const insertRow = db.prepare(
  `INSERT INTO unusual_volume_rows (session_date, symbol, rvol, row_json, catalyst_json)
   VALUES (?, ?, ?, ?, NULL)`
);

const updateCatalyst = db.prepare(
  `UPDATE unusual_volume_rows SET catalyst_json = ? WHERE session_date = ? AND symbol = ?`
);

const completeRun = db.prepare(
  `UPDATE unusual_volume_runs
   SET status = 'complete', enriched_at = ?, summary_json = ?
   WHERE session_date = ?`
);

const selectRows = db.prepare(
  `SELECT row_json, catalyst_json
   FROM unusual_volume_rows
   WHERE session_date = ?
   ORDER BY rvol DESC`
);

const selectSeasoned = db.prepare(
  `SELECT 1 AS ok FROM unusual_volume_seasoned WHERE symbol = ?`
);

const upsertSeasoned = db.prepare(
  `INSERT INTO unusual_volume_seasoned (symbol, checked_at) VALUES (?, ?)
   ON CONFLICT(symbol) DO UPDATE SET checked_at = excluded.checked_at`
);

const selectRefresh = db.prepare(
  `SELECT last_refresh FROM unusual_volume_refresh WHERE session_date = ?`
);

const upsertRefresh = db.prepare(
  `INSERT INTO unusual_volume_refresh (session_date, last_refresh) VALUES (?, ?)
   ON CONFLICT(session_date) DO UPDATE SET last_refresh = excluded.last_refresh`
);

const deleteRunsBefore = db.prepare(
  `DELETE FROM unusual_volume_runs WHERE session_date < ?`
);

const saveListTx = db.transaction((run: ListPhaseRun, rows: UnusualVolumeRow[]) => {
  upsertRun.run(
    run.sessionDate,
    run.runAt,
    run.earlyClose ? 1 : 0,
    run.spyChangePct,
    run.universeSize,
    JSON.stringify(run.summary)
  );
  deleteSessionRows.run(run.sessionDate);
  for (const row of rows) {
    insertRow.run(run.sessionDate, row.symbol, row.rvol, rowJson(row));
  }
});

const saveEnrichmentTx = db.transaction(
  (sessionDate: string, catalystsBySymbol: Map<string, Catalysts>, summary: RunSummary, enrichedAt: string) => {
    for (const [symbol, catalysts] of catalystsBySymbol) {
      updateCatalyst.run(JSON.stringify(catalysts), sessionDate, symbol);
    }
    completeRun.run(enrichedAt, JSON.stringify(summary), sessionDate);
  }
);

const markSeasonedTx = db.transaction((symbols: string[], checkedAt: string) => {
  for (const symbol of symbols) upsertSeasoned.run(symbol, checkedAt);
});

function emptySummary(): RunSummary {
  return {
    sessionDate: "",
    earlyClose: false,
    spyChangePct: null,
    counts: { universe: 0, liquid: 0, mcap: 0, rvol: 0, green: 0, seasoned: 0, matches: 0 },
    requests: {},
    failures: {},
    durationMs: 0,
  };
}

function parseSummary(json: string): RunSummary {
  if (json === "") return emptySummary();
  return JSON.parse(json) as RunSummary;
}

function mapRun(row: RunSql | undefined): StoredRun | undefined {
  if (!row) return undefined;
  const status = row.status === "complete" ? "complete" : "list";
  return {
    sessionDate: row.session_date,
    runAt: row.run_at,
    enrichedAt: row.enriched_at,
    status,
    earlyClose: row.early_close !== 0,
    spyChangePct: row.spy_change_pct,
    universeSize: row.universe_size,
    summary: parseSummary(row.summary_json),
  };
}

/** row_json holds the row without catalysts; those live in catalyst_json until phase 2. */
function rowJson(row: UnusualVolumeRow): string {
  const stored: Record<string, unknown> = { ...row };
  delete stored.catalysts;
  return JSON.stringify(stored);
}

function toUnusualVolumeRow(record: RowSql): UnusualVolumeRow {
  const stored = JSON.parse(record.row_json) as Omit<UnusualVolumeRow, "catalysts">;
  const catalysts = record.catalyst_json == null ? null : (JSON.parse(record.catalyst_json) as Catalysts);
  return { ...stored, catalysts };
}

export function getRun(sessionDate: string): StoredRun | undefined {
  return mapRun(selectRun.get(sessionDate) as RunSql | undefined);
}

export function getLatestRun(): StoredRun | undefined {
  return mapRun(selectLatestRun.get() as RunSql | undefined);
}

export function saveListPhase(run: ListPhaseRun, rows: UnusualVolumeRow[]): void {
  saveListTx(run, rows);
}

export function saveEnrichmentPhase(
  sessionDate: string,
  catalystsBySymbol: Map<string, Catalysts>,
  summary: RunSummary,
  enrichedAt: string
): void {
  saveEnrichmentTx(sessionDate, catalystsBySymbol, summary, enrichedAt);
}

export function getRows(sessionDate: string): UnusualVolumeRow[] {
  return (selectRows.all(sessionDate) as RowSql[]).map(toUnusualVolumeRow);
}

export function isSeasoned(symbol: string): boolean {
  return selectSeasoned.get(symbol) !== undefined;
}

export function markSeasoned(symbols: string[], checkedAt: string): void {
  markSeasonedTx(symbols, checkedAt);
}

export function getLastRefresh(sessionDate: string): string | undefined {
  const row = selectRefresh.get(sessionDate) as { last_refresh: string } | undefined;
  return row?.last_refresh;
}

export function setLastRefresh(sessionDate: string, iso: string): void {
  upsertRefresh.run(sessionDate, iso);
}

/**
 * Drop runs whose session_date is strictly before the UTC calendar date `days`
 * before `now`. Computed in JS so tests can pass a fixed clock; SQLite
 * date('now') would follow the machine clock. Rows cascade.
 */
export function pruneOlderThan(days: number, now = new Date()): void {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  deleteRunsBefore.run(cutoff.toISOString().slice(0, 10));
}
