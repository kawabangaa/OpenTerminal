import { afterEach, describe, expect, it, vi } from "vitest";
import { companyNews, shortName } from "./news.js";

function rss(titles: string[]): string {
  const items = titles
    .map((title, i) => `<item><title>${title}</title><link>https://example.com/${i}</link><pubDate>Wed, 22 Oct 2026 12:00:00 GMT</pubDate></item>`)
    .join("");
  return `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
}

function ok(xml: string) {
  return { ok: true as const, status: 200, text: async () => xml };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(pred: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(10);
  }
}

describe("news provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strips legal suffixes from the end", () => {
    expect(shortName("Ford Motor Company")).toBe("Ford Motor");
    expect(shortName("Agilent Technologies, Inc.")).toBe("Agilent Technologies");
    expect(shortName("Royal Dutch Shell plc")).toBe("Royal Dutch Shell");
    expect(shortName("AT&T Inc.")).toBe("AT&T");
    expect(shortName("Group")).toBe("Group");
  });

  it("queries Google News with the encoded short name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(rss(["Ford Motor raises guidance"])));
    vi.stubGlobal("fetch", fetchMock);

    const result = await companyNews("Ford Motor Company", "F");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url.startsWith("https://news.google.com/rss/search?")).toBe(true);
    expect(url).toContain(encodeURIComponent(`"Ford Motor" stock when:3d`));
    expect(url).toContain("%22Ford%20Motor%22%20stock%20when%3A3d");
    expect(result.source).toBe("google");
    expect(result.items.map((item) => item.title)).toEqual(["Ford Motor raises guidance"]);
    expect(result.items[0]?.symbol).toBe("F");
  });

  it("ignores a 1-character ticker and keeps the company name (A14c)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(rss([
      "F leads the session",
      "ford beats estimates",
    ])));
    vi.stubGlobal("fetch", fetchMock);

    const result = await companyNews("Ford", "F");

    expect(result.source).toBe("google");
    expect(result.items.map((item) => item.title)).toEqual(["ford beats estimates"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a ticker of 3+ characters only as a whole word (A14c)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(rss([
      "Chipmaker AMD rallies",
      "AMDR debuts a new chip",
    ])));
    vi.stubGlobal("fetch", fetchMock);

    const result = await companyNews("Advanced Micro Devices, Inc.", "AMD");

    expect(result.source).toBe("google");
    expect(result.items.map((item) => item.title)).toEqual(["Chipmaker AMD rallies"]);
  });

  it("falls back to Yahoo when Google returns 429 (A14b)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("news.google.com")) return { ok: false, status: 429, text: async () => "" };
      return ok(rss(["Yahoo says the stock is up"]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await companyNews("Ford Motor Company", "F");

    expect(result.source).toBe("yahoo");
    expect(result.items.map((item) => item.title)).toEqual(["Yahoo says the stock is up"]);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("news.google.com"))).toBe(true);
    expect(urls.some((url) => url.includes("https://feeds.finance.yahoo.com/rss/2.0/headline?s=F"))).toBe(true);
  });

  it("returns failed when Google and Yahoo both fail (A14b)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" }));

    await expect(companyNews("Ford Motor Company", "F")).resolves.toEqual({ items: [], source: "failed" });
  });

  it("never has more than 2 Google fetches in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let started = 0;
    const pending: Array<() => void> = [];

    vi.stubGlobal("fetch", vi.fn(() => {
      started++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        pending.push(() => {
          inFlight--;
          resolve(ok(rss(["Ford Motor update"])));
        });
      });
    }));

    const all = Promise.all(Array.from({ length: 5 }, () => companyNews("Ford Motor Company", "F")));
    let settled = false;
    void all.then(() => {
      settled = true;
    });

    try {
      await waitUntil(() => started >= 2, 2000);
      await sleep(400);
      expect(started).toBe(2);
      expect(inFlight).toBe(2);
      expect(maxInFlight).toBeLessThanOrEqual(2);

      const deadline = Date.now() + 4000;
      while (!settled) {
        if (Date.now() > deadline) throw new Error(`timed out with ${started} Google fetches started`);
        expect(maxInFlight).toBeLessThanOrEqual(2);
        if (pending.length > 0) pending.shift()!();
        else await sleep(10);
      }

      expect(started).toBe(5);
      expect(maxInFlight).toBeLessThanOrEqual(2);
      const results = await all;
      expect(results.every((result) => result.source === "google" && result.items.length === 1)).toBe(true);
    } finally {
      const deadline = Date.now() + 4000;
      while (!settled && Date.now() < deadline) {
        while (pending.length > 0) pending.shift()!();
        await sleep(10);
      }
    }
  });
});
