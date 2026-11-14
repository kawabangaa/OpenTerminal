import { afterEach, describe, expect, it, vi } from "vitest";
import { startScheduler, stopScheduler, type ScheduledRun } from "./scheduler.js";

const skipped = { kind: "skipped" as const, reason: "exists" as const };

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("unusual-volume scheduler", () => {
  afterEach(() => {
    stopScheduler();
    vi.useRealTimers();
    delete process.env.UNUSUAL_VOLUME_SCHEDULER;
    vi.restoreAllMocks();
  });

  it("runs a catch-up on startup", async () => {
    const run = vi.fn<ScheduledRun>().mockResolvedValue(skipped);
    startScheduler({ run, now: () => new Date("2026-10-24T02:00:00Z"), tz: "Asia/Jerusalem", runAt: "06:00" });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fires at 06:00 Asia/Jerusalem and not at 06:00 UTC (A11d)", async () => {
    vi.useFakeTimers();
    const run = vi.fn<ScheduledRun>().mockResolvedValue(skipped);
    let current = new Date("2026-10-24T02:00:00Z"); // 05:00 in Jerusalem
    startScheduler({ run, now: () => current, tz: "Asia/Jerusalem", runAt: "06:00" });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);

    current = new Date("2026-10-24T06:00:00Z"); // 09:00 in Jerusalem, 06:00 UTC
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);

    current = new Date("2026-10-24T03:00:00Z"); // 06:00 in Jerusalem
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("fires once when two ticks land inside the same 06:00 minute", async () => {
    vi.useFakeTimers();
    const run = vi.fn<ScheduledRun>().mockResolvedValue(skipped);
    const atSix = new Date("2026-10-24T03:00:00Z");
    startScheduler({ run, now: () => atSix, tz: "Asia/Jerusalem", runAt: "06:00" });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not let a rejecting run escape the tick", async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn<ScheduledRun>().mockRejectedValue(new Error("scan down"));
    startScheduler({ run, now: () => new Date("2026-10-24T03:00:00Z"), tz: "Asia/Jerusalem", runAt: "06:00" });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(err).toHaveBeenCalled();
  });

  it("does nothing when UNUSUAL_VOLUME_SCHEDULER=0", async () => {
    vi.useFakeTimers();
    process.env.UNUSUAL_VOLUME_SCHEDULER = "0";
    const run = vi.fn<ScheduledRun>().mockResolvedValue(skipped);
    startScheduler({ run, now: () => new Date("2026-10-24T03:00:00Z"), tz: "Asia/Jerusalem", runAt: "06:00" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).not.toHaveBeenCalled();
  });
});
