// L4: reply-latency budgets (Linear parity). Linear requires an agent
// activity within 10 s of a mention; Room's target is wake delivered p95 < 2 s
// and first acknowledgement p95 < 10 s.
export const WAKE_BUDGET_MS = 2000;
export const ACK_BUDGET_MS = 10000;

export function percentile(values, p) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length === 0) return NaN;
  return xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
}

// samples: [{ postedAt, deliveredAt, ackedAt }] in ms.
export function latencyReport(samples) {
  const wake = samples.map(s => s.deliveredAt - s.postedAt);
  const ack = samples.map(s => s.ackedAt - s.postedAt);
  const r = { n: samples.length, wakeP50: percentile(wake, 50), wakeP95: percentile(wake, 95), ackP50: percentile(ack, 50), ackP95: percentile(ack, 95) };
  return { ...r, withinBudget: r.wakeP95 < WAKE_BUDGET_MS && r.ackP95 < ACK_BUDGET_MS };
}
