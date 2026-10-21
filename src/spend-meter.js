// Spend meter: the live tally behind the hard caps (Town-style).
// Pure figures: used, cap, percent, and paused once the cap is reached.
// The caps themselves already refuse at the trust boundary (per-agent spend
// grants, the room allowance); this is the meter people and agents read.
export function meterLine({ usedCents, capCents }) {
  if (!Number.isSafeInteger(capCents) || capCents <= 0) return { usedCents, capCents: null, leftCents: null, percent: null, paused: false, warn: false };
  const leftCents = Math.max(0, capCents - usedCents);
  const percent = Math.min(100, Math.floor((usedCents * 100) / capCents));
  return { usedCents, capCents, leftCents, percent, paused: leftCents === 0, warn: percent >= 80 && leftCents > 0 };
}

export const formatCents = cents => `$${(cents / 100).toFixed(2)}`;

// "$4.10 of $5.00 (82%)" / "paused at $5.00 cap" / "$1.20, no cap".
export function meterLabel(line) {
  if (line.capCents === null) return `${formatCents(line.usedCents)}, no cap`;
  if (line.paused) return `paused at ${formatCents(line.capCents)} cap`;
  return `${formatCents(line.usedCents)} of ${formatCents(line.capCents)} (${line.percent}%)`;
}
