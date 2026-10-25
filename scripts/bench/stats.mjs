// Statistics for A/B benchmark runs, after Go's benchstat: report medians with
// a 95% confidence interval, and call a change only when an exact two-sided
// Mann-Whitney test says the two samples differ AND the median moved past a
// noise floor. Shared runners are noisy; small moves are not reported.

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const logChoose = (n, k) => {
  let sum = 0;
  for (let i = 1; i <= k; i++) sum += Math.log(n - k + i) - Math.log(i);
  return sum;
};

// Distribution-free 95% CI for the median from order statistics. With fewer
// than 6 samples no interval reaches 95%, so the full range is returned and
// marked as such.
export function medianInterval(values, confidence = 0.95) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  if (!n) return { low: NaN, high: NaN, exact: false };
  // P(X_(k) <= median <= X_(n-k+1)) = 1 - 2 * P(Binomial(n, 0.5) <= k - 1)
  let best = null, cumulative = 0;
  for (let k = 1; k <= n >> 1; k++) {
    cumulative += Math.exp(logChoose(n, k - 1) - n * Math.LN2);
    if (1 - 2 * cumulative >= confidence) best = k; else break;
  }
  if (best === null) return { low: sorted[0], high: sorted[n - 1], exact: false };
  return { low: sorted[best - 1], high: sorted[n - best], exact: true };
}

// Exact two-sided Mann-Whitney U (permutation of ranks), with average ranks for
// ties. Exact enumeration is cheap for the run counts used here (<= 12 + 12);
// larger samples use the normal approximation with tie correction.
export function mannWhitney(a, b) {
  const n1 = a.length, n2 = b.length, n = n1 + n2;
  if (!n1 || !n2) return { u: NaN, p: 1 };
  const all = [...a.map(v => ({ v, g: 0 })), ...b.map(v => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const ranks = new Array(n);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && all[j + 1].v === all[i].v) j++;
    for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1;
    i = j + 1;
  }
  const rankSumA = ranks.reduce((sum, r, i) => sum + (all[i].g === 0 ? r : 0), 0);
  const u = rankSumA - n1 * (n1 + 1) / 2, expected = n1 * n2 / 2;
  if (n <= 24) {
    // Enumerate every way to pick n1 of the n ranks; count those at least as
    // far from the expected rank sum as the observed one.
    const target = Math.abs(rankSumA - n1 * (n + 1) / 2) - 1e-9;
    let extreme = 0, total = 0;
    const walk = (start, picked, sum) => {
      if (picked === n1) { total++; if (Math.abs(sum - n1 * (n + 1) / 2) >= target) extreme++; return; }
      for (let i = start; i <= n - (n1 - picked); i++) walk(i + 1, picked + 1, sum + ranks[i]);
    };
    walk(0, 0, 0);
    return { u, p: extreme / total };
  }
  const tieGroups = new Map();
  for (const { v } of all) tieGroups.set(v, (tieGroups.get(v) ?? 0) + 1);
  const tieTerm = [...tieGroups.values()].reduce((s, t) => s + (t ** 3 - t), 0);
  const variance = n1 * n2 / 12 * ((n + 1) - tieTerm / (n * (n - 1)));
  const z = variance > 0 ? (Math.abs(u - expected) - 0.5) / Math.sqrt(variance) : 0;
  return { u, p: Math.min(1, 2 * (1 - normalCdf(Math.max(0, z)))) };
}

function normalCdf(z) {
  // Abramowitz-Stegun 26.2.17
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp(-z * z / 2);
  return 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
}

// Holm-Bonferroni step-down adjustment: with many metrics per size, an
// unadjusted p < 0.05 flags about one in twenty unchanged metrics. Returns
// adjusted p values in the input order (non-finite p stay as they are).
export function holm(pValues) {
  const order = pValues.map((p, i) => [p, i]).filter(([p]) => Number.isFinite(p)).sort((a, b) => a[0] - b[0]);
  const adjusted = [...pValues];
  let running = 0;
  order.forEach(([p, i], rank) => { running = Math.max(running, Math.min(1, p * (order.length - rank))); adjusted[i] = running; });
  return adjusted;
}

export function verdict(ratio, p, { alpha = 0.05, floor = 0.1, lowerIsBetter = true } = {}) {
  if (!Number.isFinite(ratio) || !Number.isFinite(p)) return "n/a";
  if (p >= alpha || Math.abs(ratio - 1) < floor) return "~";
  return (ratio < 1) === lowerIsBetter ? "better" : "worse";
}

// Compare base and head samples of one metric. lowerIsBetter decides which way
// is "faster". Returns medians, intervals, the head/base ratio, p, and a
// verdict: "faster", "slower" or "~" (no change past noise).
export function compare(base, head, { alpha = 0.05, floor = 0.1, lowerIsBetter = true } = {}) {
  const b = base.filter(Number.isFinite), h = head.filter(Number.isFinite);
  if (!b.length || !h.length) return { verdict: "n/a", base: median(b), head: median(h), ratio: NaN, p: NaN };
  const mb = median(b), mh = median(h);
  const ratio = mb === 0 ? (mh === 0 ? 1 : Infinity) : mh / mb;
  const { p } = mannWhitney(b, h);
  return { verdict: verdict(ratio, p, { alpha, floor, lowerIsBetter }), base: mb, head: mh, baseCi: medianInterval(b), headCi: medianInterval(h), ratio, p };
}
