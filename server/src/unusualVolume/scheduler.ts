// In-process daily timer. The container clock is UTC, so "06:00" is interpreted
// in UNUSUAL_VOLUME_TZ (default Asia/Jerusalem), not in the process zone.
import { isValidHhmm, isValidTimeZone, wallClock } from "../time.js";
import type { RunOutcome } from "./types.js";

const DEFAULT_RUN_AT = "06:00";
const DEFAULT_TZ = "Asia/Jerusalem";

export type ScheduledRun = (opts?: { now?: Date }) => Promise<RunOutcome>;

let timer: ReturnType<typeof setInterval> | undefined;
let firedDate: string | undefined;

async function defaultRun(opts?: { now?: Date }): Promise<RunOutcome> {
  const { runUnusualVolume } = await import("./run.js");
  return runUnusualVolume(opts);
}

function pickTz(raw: string | undefined): string {
  if (!raw) return DEFAULT_TZ;
  if (isValidTimeZone(raw)) return raw;
  console.error(`[unusual-volume] invalid timezone "${raw}", using ${DEFAULT_TZ}`);
  return DEFAULT_TZ;
}

function pickRunAt(raw: string | undefined): string {
  if (!raw) return DEFAULT_RUN_AT;
  if (isValidHhmm(raw)) return raw;
  console.error(`[unusual-volume] invalid run time "${raw}", using ${DEFAULT_RUN_AT}`);
  return DEFAULT_RUN_AT;
}

async function safeRun(run: ScheduledRun, now: Date): Promise<void> {
  try {
    await run({ now });
  } catch (err) {
    console.error("[unusual-volume] run failed", err instanceof Error ? err.message : err);
  }
}

export function startScheduler(opts?: {
  runAt?: string;
  tz?: string;
  run?: ScheduledRun;
  now?: () => Date;
}): void {
  if (process.env.UNUSUAL_VOLUME_SCHEDULER === "0") return;
  stopScheduler();
  const tz = pickTz(opts?.tz ?? process.env.UNUSUAL_VOLUME_TZ);
  const runAt = pickRunAt(opts?.runAt ?? process.env.UNUSUAL_VOLUME_RUN_AT);
  const now = opts?.now ?? (() => new Date());
  const run = opts?.run ?? defaultRun;
  firedDate = undefined;
  void safeRun(run, now());
  timer = setInterval(() => {
    const clock = wallClock(tz, now());
    if (clock.hhmm !== runAt || firedDate === clock.date) return;
    firedDate = clock.date;
    void safeRun(run, now());
  }, 60_000);
  timer.unref?.();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
