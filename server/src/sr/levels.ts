import type { Candle } from "../providers/yahoo.js";

export type SrOptions = {
  atrLength: number; // n   = 14
  alpha: number; // α   = 0.5
  pivotHalfWindow: number; // k = 3
  qScan: number; // 4
  qKeep: number; // 6
  episodeGap: number; // g   = 10 (bars)
  beta: number; // 2
  windowDays: number; // 183 calendar days (FR-6)
  minBars: number; // 40 (FR-7)
  maxLevels: number; // 10 (FR-8)
};

export const SR_DEFAULTS: SrOptions = {
  atrLength: 14,
  alpha: 0.5,
  pivotHalfWindow: 3,
  qScan: 4,
  qKeep: 6,
  episodeGap: 10,
  beta: 2,
  windowDays: 183,
  minBars: 40,
  maxLevels: 10,
};

export type SrLevel = {
  price: number;
  zone: [number, number];
  type: "support" | "resistance";
  rank: number;
  label: string;
  nPiv: number;
  q: number;
  episodes: number;
  score: number;
  extreme: boolean;
  firstTouch: number;
  lastTouch: number;
};

export type SrResult = {
  symbol: string;
  asOf: number;
  windowStart: number;
  lastClose: number;
  eps: number;
  step: number;
  bars: number;
  levels: SrLevel[];
  reason: "insufficient_history" | null;
};

const GRID_CAP = 200_000;

type Pivot = { price: number; idx: number };

type Candidate = {
  price: number;
  a: number;
  b: number;
  nPiv: number;
  pivotIdx: number[];
};

export function srLevels(symbol: string, candles: Candle[], opts: SrOptions = SR_DEFAULTS): SrResult {
  const N = candles.length;
  const asOf = N > 0 ? candles[N - 1].time : 0;
  const lastClose = N > 0 ? candles[N - 1].close : 0;
  const blank = (reason: SrResult["reason"], eps = 0, step = 0, windowStart = asOf): SrResult => ({
    symbol,
    asOf,
    windowStart,
    lastClose,
    eps,
    step,
    bars: N,
    levels: [],
    reason,
  });

  if (N < opts.minBars) return blank("insufficient_history");

  const h = new Float64Array(N);
  const l = new Float64Array(N);
  const c = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    h[i] = candles[i].high;
    l[i] = candles[i].low;
    c[i] = candles[i].close;
  }

  const cutoff = asOf - opts.windowDays * 86400;
  const W: number[] = [];
  for (let i = 0; i < N; i++) if (candles[i].time >= cutoff) W.push(i);
  if (W.length < opts.minBars) return blank("insufficient_history", 0, 0, W.length ? candles[W[0]].time : asOf);
  const windowStart = candles[W[0]].time;

  // Step 1 — simple-mean ATR over the last n true ranges of the full series.
  const trCount = N - 1;
  if (trCount <= 0) return blank(null, 0, 0, windowStart);
  const atrN = Math.min(opts.atrLength, trCount);
  let atrSum = 0;
  for (let t = N - atrN; t < N; t++) {
    const tr = Math.max(h[t] - l[t], Math.abs(h[t] - c[t - 1]), Math.abs(l[t] - c[t - 1]));
    atrSum += tr;
  }
  const eps = opts.alpha * (atrSum / atrN);
  if (eps === 0) return blank(null, 0, 0, windowStart);

  let lo = Infinity;
  let hi = -Infinity;
  for (const t of W) {
    if (l[t] < lo) lo = l[t];
    if (h[t] > hi) hi = h[t];
  }
  const span = hi - lo + 2 * eps;
  let step = Number((eps / 30).toPrecision(1));
  if (!(step > 0)) return blank(null, eps, 0, windowStart);
  if (Math.floor(span / step) + 1 > GRID_CAP) {
    step = Number((span / GRID_CAP).toPrecision(1));
    if (!(step > 0)) return blank(null, eps, 0, windowStart);
  }

  const k = opts.pivotHalfWindow;
  const pivots: Pivot[] = [];
  // Pivots stay inside the 6-month window. The side window is clamped so a bar
  // older than W is never read, even to confirm the first pivot.
  for (let t = W[0]; t < N - k; t++) {
    const from = Math.max(W[0], t - k);
    const to = t + k;
    let maxH = -Infinity;
    let minL = Infinity;
    for (let j = from; j <= to; j++) {
      if (h[j] > maxH) maxH = h[j];
      if (l[j] < minL) minL = l[j];
    }
    if (h[t] === maxH) pivots.push({ price: h[t], idx: t });
    if (l[t] === minL) pivots.push({ price: l[t], idx: t });
  }

  // Step 3 — cluster anchored to the group's first (lowest) price, so a group cannot grow wider than ε.
  pivots.sort((a, b) => a.price - b.price);
  const cands: Candidate[] = [];
  let group: Pivot[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const prices = group.map((p) => p.price);
    cands.push({
      price: median(prices),
      a: prices[0],
      b: prices[prices.length - 1],
      nPiv: group.length,
      pivotIdx: group.map((p) => p.idx),
    });
    group = [];
  };
  for (const p of pivots) {
    if (group.length > 0 && p.price - group[0].price > eps) flush();
    group.push(p);
  }
  flush();

  const half = eps / 2;
  const rejDays = (x: number): number[] => {
    const days: number[] = [];
    for (const t of W) {
      const top = Math.abs(h[t] - x) <= half && c[t] < x - half;
      const bot = Math.abs(l[t] - x) <= half && c[t] > x + half;
      if (top || bot) days.push(t);
    }
    return days;
  };

  // Step 4 — rejection scan. Grid is capped so a tiny ATR after a large range cannot explode the loop.
  const gridStart = lo - eps;
  const gridStop = hi + eps;
  const gridLen = Math.max(0, Math.ceil((gridStop - gridStart) / step - 1e-9));
  const grid = new Float64Array(gridLen);
  for (let i = 0; i < gridLen; i++) grid[i] = gridStart + i * step;
  const Q = new Float64Array(gridLen);
  for (let i = 0; i < gridLen; i++) Q[i] = rejDays(grid[i]).length;

  const order = Array.from({ length: gridLen }, (_, i) => i);
  order.sort((i, j) => Q[j] - Q[i] || i - j);
  const used = new Uint8Array(gridLen);
  for (const i of order) {
    if (Q[i] < opts.qScan) break;
    if (used[i]) continue;
    let a = i;
    let b = i;
    while (a > 0 && Q[a - 1] >= Q[i]) a--;
    while (b < gridLen - 1 && Q[b + 1] >= Q[i]) b++;
    const x = grid[b] - grid[a] <= eps ? (grid[a] + grid[b]) / 2 : grid[i];
    used.fill(1, a, b + 1);
    for (let g = 0; g < gridLen; g++) if (Math.abs(grid[g] - x) <= eps) used[g] = 1;
    cands.push({ price: x, a: x - half, b: x + half, nPiv: 0, pivotIdx: [] });
  }

  // Step 5 — merge anchored to the level's first member at ε/2.
  cands.sort((p, q) => p.price - q.price);
  type Merged = { first: number; prices: number[]; a: number; b: number; nPiv: number; pivotIdx: number[] };
  const merged: Merged[] = [];
  for (const cand of cands) {
    const m = merged[merged.length - 1];
    if (m && cand.price - m.first <= half) {
      m.prices.push(cand.price);
      m.a = Math.min(m.a, cand.a);
      m.b = Math.max(m.b, cand.b);
      m.nPiv += cand.nPiv;
      m.pivotIdx.push(...cand.pivotIdx);
    } else {
      merged.push({
        first: cand.price,
        prices: [cand.price],
        a: cand.a,
        b: cand.b,
        nPiv: cand.nPiv,
        pivotIdx: [...cand.pivotIdx],
      });
    }
  }

  type Kept = {
    price: number;
    zone: [number, number];
    nPiv: number;
    q: number;
    episodes: number;
    score: number;
    extreme: boolean;
    firstTouch: number;
    lastTouch: number;
  };
  const kept: Kept[] = [];
  for (const m of merged) {
    const price = m.prices.reduce((s, v) => s + v, 0) / m.prices.length;
    const days = rejDays(price);
    const q = days.length;
    let episodes = 0;
    if (q > 0) {
      episodes = 1;
      for (let i = 1; i < days.length; i++) if (days[i] - days[i - 1] > opts.episodeGap) episodes++;
    }
    const extreme = Math.abs(price - hi) <= half || Math.abs(price - lo) <= half;
    if (m.nPiv >= 2 || (q >= opts.qKeep && episodes >= 2) || extreme) {
      const touches = [...m.pivotIdx, ...days];
      let first = asOf;
      let last = asOf;
      if (touches.length > 0) {
        let minT = Infinity;
        let maxT = -Infinity;
        for (const idx of touches) {
          const time = candles[idx].time;
          if (time < minT) minT = time;
          if (time > maxT) maxT = time;
        }
        first = minT;
        last = maxT;
      }
      kept.push({
        price,
        zone: [m.a, m.b],
        nPiv: m.nPiv,
        q,
        episodes,
        score: m.nPiv + q + opts.beta * (episodes - 1),
        extreme,
        firstTouch: first,
        lastTouch: last,
      });
    }
  }

  kept.sort((a, b) => b.score - a.score || Math.abs(a.price - lastClose) - Math.abs(b.price - lastClose));
  const capped = kept.slice(0, opts.maxLevels);

  const roundPx = (x: number) => (lastClose >= 1 ? roundDp(x, 2) : Number(x.toPrecision(4)));
  const resistances = capped.filter((lv) => lv.price > lastClose).sort((a, b) => a.price - b.price);
  const supports = capped.filter((lv) => lv.price <= lastClose).sort((a, b) => b.price - a.price);
  const ranked = new Map<Kept, { rank: number; type: SrLevel["type"] }>();
  resistances.forEach((lv, i) => ranked.set(lv, { rank: i + 1, type: "resistance" }));
  supports.forEach((lv, i) => ranked.set(lv, { rank: i + 1, type: "support" }));

  const levels: SrLevel[] = capped
    .map((lv) => {
      const meta = ranked.get(lv)!;
      return {
        price: roundPx(lv.price),
        zone: [roundPx(lv.zone[0]), roundPx(lv.zone[1])] as [number, number],
        type: meta.type,
        rank: meta.rank,
        label: (meta.type === "resistance" ? "R" : "S") + meta.rank,
        nPiv: lv.nPiv,
        q: lv.q,
        episodes: lv.episodes,
        score: lv.score,
        extreme: lv.extreme,
        firstTouch: lv.firstTouch,
        lastTouch: lv.lastTouch,
      };
    })
    .sort((a, b) => b.price - a.price);

  return { symbol, asOf, windowStart, lastClose, eps, step, bars: N, levels, reason: null };
}

function median(sorted: number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function roundDp(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
