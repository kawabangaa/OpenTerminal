# Support & Resistance Detection — Formal Spec

Oct 30, 2026 · Yaron Scherf

## Overview and notation

Two detectors run on daily candles and their outputs are merged: **swing pivots** find peak-type levels (one sharp turn), and a **rejection count** finds shelf-type levels (many failed attempts at the same price). Each surviving level gets a zone, a score and a support/resistance label relative to the last close.

**Inputs**

- Daily candles t = 1 … N with open O_t, high H_t, low L_t, close C_t.
- Analysis window W ⊆ {1 … N}, e.g. all days since Aug 1. Load at least 14 + k days before W starts so ATR and pivots are defined.
- Price basis: **wick** (H_t, L_t) or **body** (B⁺_t = max(O_t, C_t), B⁻_t = min(O_t, C_t)). Wick is the default; body was tested on REAL and did worse (Step 2).

**Output** — a list of levels, each with: price ℓ, zone [a, b], type (support | resistance), number of pivots n_piv, number of rejections Q, score s, and state (intact | broken | flipped).

## Step 1 — Tolerance ε from ATR

Every "same price" test in this spec uses one tolerance ε, scaled to the stock's volatility so the method works across tickers and price ranges.

$$
TR_t = \max\left(H_t - L_t,\ |H_t - C_{t-1}|,\ |L_t - C_{t-1}|\right)
$$

$$
ATR = \frac{1}{n}\sum_{t=N-n+1}^{N} TR_t \qquad \varepsilon = \alpha \cdot ATR
$$

Defaults: n = 14, α = 0.5. ATR is taken at the last candle N (simple mean; Wilder smoothing is an acceptable substitute).

## Step 2 — Confirmed swing pivots

A candle is a swing high if its high is the highest of the k candles on each side, and a swing low if its low is the lowest.

$$
\text{SwingHigh}(t) \iff H_t = \max_{|j| \le k} H_{t+j} \quad \text{and} \quad t + k \le N
$$

$$
\text{SwingLow}(t) \iff L_t = \min_{|j| \le k} L_{t+j} \quad \text{and} \quad t + k \le N
$$

- The condition t + k ≤ N means a pivot is **confirmed** only after k later candles exist. The last k candles can never be pivots yet.
- Collect all pivot prices (highs and lows together) into one multiset P. Levels do not care which side the turn came from; that is decided in Step 6.
- Body basis: replace H_t with B⁺_t and L_t with B⁻_t. Tested on REAL, it did worse than wicks: R1 at 11.95 dropped out. Wick stays the default.

Default k = 3 on daily candles. k = 5 gave the same main levels on REAL.

## Step 3 — Cluster pivots, with a width cap

Sort the pivot prices p₁ ≤ p₂ ≤ … ≤ p_m and group them greedily. A pivot joins the current group only if it is within ε of the group's **first** member, so no group can be wider than ε.

$$
p_j \in G \iff p_j - \min G \le \varepsilon \quad \text{(else start a new group)}
$$

$$
\ell_G = \operatorname{median}(G) \qquad [a_G, b_G] = [\min G,\ \max G] \qquad n_{piv}(G) = |G|
$$

Anchoring to the first member (not the previous one) is the fix for the original S1 problem: chaining let 10.62 lows and 11.15 highs end up in one 0.53-wide zone.

## Step 4 — Rejection-count scan

This detector finds shelf levels: prices that many candles reached but could not close beyond. For every candidate price x on a grid (step δ = 0.01), count the rejection days inside W.

$$
R(x) = \#\{\, t \in W : |H_t - x| \le \tfrac{\varepsilon}{2},\ C_t < x - \tfrac{\varepsilon}{2} \,\}
$$

$$
S(x) = \#\{\, t \in W : |L_t - x| \le \tfrac{\varepsilon}{2},\ C_t > x + \tfrac{\varepsilon}{2} \,\}
$$

$$
Q(x) = R(x) + S(x)
$$

R counts tops that touched x and closed clearly below it; S counts bottoms that touched x and closed clearly above it.

**Peak picking** (greedy, highest Q first):

1. Take the unused grid point i with the largest Q. Stop when Q(x_i) < q_scan.
2. Find its plateau [x_a, x_b]: the contiguous run of grid points around i with Q ≥ Q(x_i).
3. Level price: the plateau center (x_a + x_b) / 2 if the plateau is at most ε wide, else x_i itself.
4. Mark the plateau and everything within ε of the level as used. Repeat.

Each peak becomes a candidate with ℓ = that price, zone [ℓ − ε/2, ℓ + ε/2], n_piv = 0.

## Step 5 — Merge, filter, score

**Merge.** Put Step 3 groups and Step 4 peaks in one list sorted by ℓ. A candidate joins the current merged level if it is within ε/2 of that level's first member (same anchoring as Step 3). The merged level takes the mean of its members' prices, the union of their zones, and the sum of their n_piv.

**Re-count and split into episodes.** For each merged level ℓ, recompute its rejection days D = the t values counted in Q(ℓ). Split D into episodes wherever two consecutive rejection days are more than g trading days apart.

$$
E(\ell) = 1 + \#\{\, i : d_{i+1} - d_i > g \,\} \qquad D = \{d_1 < d_2 < \dots\}
$$

**Keep rule.** A level survives if any one of these holds:

- n_piv ≥ 2 (two or more confirmed turns), or
- Q(ℓ) ≥ q_keep and E(ℓ) ≥ 2 (repeated rejections in at least two separate periods, like the Aug and Oct ceiling), or
- ℓ is within ε/2 of the window's highest high or lowest low (kept as a reference extreme, like the 13.82 spike).

**Score** for ranking and for showing only the top few near price:

$$
s(\ell) = n_{piv} + Q(\ell) + \beta \,(E(\ell) - 1)
$$

Suggested β = 2. The score was not needed to reproduce the REAL result (the keep rule did that), so treat β as a starting point to tune.

## Step 6 — Support or resistance, breaks and flips

A level's label comes only from where price is now, measured from the last close C_N.

$$
\text{type}(\ell) = \begin{cases} \text{resistance} & \ell > C_N \\ \text{support} & \ell < C_N \end{cases}
$$

**Break.** A level is broken upward on day t when m consecutive closes sit above its zone; downward is the mirror.

$$
\text{BreakUp}(\ell, t) \iff C_{t-i} > b_\ell + \tfrac{\varepsilon}{2} \ \ \forall\, i = 0 \dots m-1
$$

$$
\text{BreakDown}(\ell, t) \iff C_{t-i} < a_\ell - \tfrac{\varepsilon}{2} \ \ \forall\, i = 0 \dots m-1
$$

**Flip and retest.** After a break up, the level is a flipped support. A retest is a later day whose low comes back into the zone but closes above it.

$$
\text{Retest}(\ell, t) \iff a_\ell - \tfrac{\varepsilon}{2} \le L_t \le b_\ell \ \wedge\ C_t > b_\ell
$$

Default m = 2. This step is a definition only; it was not run on REAL. On Oct 29 the low of 11.17 sat inside the 10.99–11.44 zone, but with one candle closing just inside the zone it does not yet qualify as a break under m = 2.

## Parameters and REAL validation

With the defaults below, the spec returns all five levels you agreed on for REAL (Aug 3 – Oct 29, 2026), plus two it keeps that you did not draw.

| Symbol | Meaning | Default |
| --- | --- | --- |
| n | ATR length (days) | 14 |
| α | ε = α × ATR | 0.5 |
| k | pivot half-window (candles) | 3 |
| basis | wick or body | wick |
| δ | scan grid step (price) | 0.01 |
| q_scan | min Q to pick a scan peak | 4 |
| — | merge distance | ε / 2 |
| g | gap that splits episodes (trading days) | 10 |
| q_keep | min Q for a rejection-only level | 6 |
| β | episode weight in score | 2 |
| m | closes beyond zone to confirm a break | 2 |

**REAL run** — ε = 0.31, last close 11.31.

| Level | Zone | n_piv | Q | E | Kept | Your set |
| --- | --- | --- | --- | --- | --- | --- |
| 13.82 | 13.82 | 1 | 1 | 1 | yes (extreme) | R3 ✓ |
| 11.94 | 11.78–12.09 | 1 | 6 | 2 | yes | R1 ✓ |
| 11.45 | 11.30–11.61 | 0 | 5 | 1 | no | — |
| 11.22 | 10.99–11.44 | 2 | 11 | 2 | yes | Aug/Oct ceiling ✓ |
| 10.70 | 10.60–10.91 | 2 | 6 | 2 | yes | not drawn |
| 10.37 | 10.22–10.53 | 0 | 4 | 2 | no | — |
| 10.09 | 9.91–10.21 | 3 | 8 | 2 | yes | S2 ✓ |
| 9.59 | 9.44–9.75 | 0 | 11 | 1 | no | — |
| 9.17 | 9.02–9.39 | 2 | 9 | 1 | yes | S3 ✓ |
| 8.57 | 8.45–8.76 | 1 | 4 | 1 | yes (extreme) | not drawn |

- The two extras are defensible: 10.70 has two turns and rejections in both August and October; 8.57 is the window low (the Sep 28 bottom). Drop them only if your class consistently ignores such levels.
- The 9.59 shelf (11 rejections, all in the September chop) is correctly dropped by the two-episode rule.
- One ticker is not a validation set. Re-check the defaults on a few more charts your teacher has marked up before trusting them.

Data: daily OHLC from [FinancialContent](https://www.financialcontent.com/quote/NQ:REAL/historical) and [Twelve Data](https://twelvedata.com/markets/516930/stock/nasdaq/real/historical-data); the Oct 29 candle was an intraday snapshot.

## Reference implementation

This Python function implements Steps 1–5 and produced the REAL table above exactly. Step 6 (breaks, retests) is left to add.

```python
import numpy as np

def sr_levels(df, start, n=14, alpha=0.5, k=3, step=0.01,
              q_scan=4, q_keep=6, gap=10, beta=2):
    """df: daily candles, columns o,h,l,c, DatetimeIndex ascending.
    start: first date of the analysis window W."""
    o, h, l, c = (df[x].to_numpy(float) for x in "ohlc")
    N = len(c)
    # Step 1: tolerance
    tr = np.maximum(h[1:] - l[1:], np.maximum(abs(h[1:] - c[:-1]), abs(l[1:] - c[:-1])))
    eps = alpha * tr[-n:].mean()
    W = np.flatnonzero(df.index >= start)
    # Step 2: confirmed pivots (from k bars before W)
    P = []
    for t in range(max(0, W[0] - k), N - k):
        win = slice(max(0, t - k), t + k + 1)
        if h[t] == h[win].max(): P.append(h[t])
        if l[t] == l[win].min(): P.append(l[t])
    # Step 3: cluster, anchored to the first member
    cands, G = [], []
    for p in sorted(P):
        if G and p - G[0] > eps:
            cands.append((np.median(G), G[0], G[-1], len(G))); G = []
        G.append(p)
    if G: cands.append((np.median(G), G[0], G[-1], len(G)))
    # Step 4: rejection-count scan
    def rej_days(x):
        r = (abs(h[W] - x) <= eps/2) & (c[W] < x - eps/2)
        s = (abs(l[W] - x) <= eps/2) & (c[W] > x + eps/2)
        return W[r | s]
    grid = np.arange(l[W].min() - eps, h[W].max() + eps, step)
    Q = np.array([len(rej_days(x)) for x in grid])
    used = np.zeros(len(grid), bool)
    for i in np.argsort(-Q, kind="stable"):
        if Q[i] < q_scan: break
        if used[i]: continue
        a = b = i
        while a > 0 and Q[a-1] >= Q[i]: a -= 1
        while b < len(grid) - 1 and Q[b+1] >= Q[i]: b += 1
        x = (grid[a] + grid[b]) / 2 if grid[b] - grid[a] <= eps else grid[i]
        used[a:b+1] = True; used[abs(grid - x) <= eps] = True
        cands.append((x, x - eps/2, x + eps/2, 0))
    # Step 5: merge (anchored, eps/2), filter, score
    merged = []
    for lv, a, b, npv in sorted(cands):
        m = merged[-1] if merged else None
        if m and lv - m["first"] <= eps/2:
            m["ls"].append(lv); m["a"] = min(m["a"], a); m["b"] = max(m["b"], b); m["npiv"] += npv
        else:
            merged.append(dict(first=lv, ls=[lv], a=a, b=b, npiv=npv))
    hi_x, lo_x, last = h[W].max(), l[W].min(), c[-1]
    out = []
    for m in merged:
        lv = float(np.mean(m["ls"])); d = rej_days(lv); q = len(d)
        E = 1 + int((np.diff(d) > gap).sum()) if q else 0
        extreme = abs(lv - hi_x) <= eps/2 or abs(lv - lo_x) <= eps/2
        if m["npiv"] >= 2 or (q >= q_keep and E >= 2) or extreme:
            out.append(dict(level=round(lv, 2), zone=(round(m["a"], 2), round(m["b"], 2)),
                            npiv=m["npiv"], Q=q, E=E, score=m["npiv"] + q + beta*(E-1),
                            type="resistance" if lv > last else "support"))
    return eps, out
```

Notes for porting: episodes count gaps in trading days (array positions), not calendar days. The scan is O(grid × |W|), fine for daily data; vectorize it for intraday.
