// Weekly room health report (G004). A pure report generator: given
// per-room weekly stats (from the K030 rollup), produce a health report
// with scores, trends, and highlights. The module is pure and dependency-
// free. Frozen outputs; malformed inputs throw HealthError. Auto-posting
// is a later slice.
class HealthError extends Error { constructor(code, message) { super(message); this.name = "HealthError"; this.code = code; } }
const fail = (code, message) => { throw new HealthError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_health", message); };
// Score a room's health 0-100 from weekly stats.
// stats: { messages, reactions, activeUsers, workItems, joins }
function scoreHealth(stats) {
  let score = 50; // baseline
  score += Math.min(20, stats.messages / 10); // activity
  score += Math.min(15, stats.activeUsers * 3); // participation
  score += Math.min(10, stats.workItems * 2); // productivity
  score += Math.min(5, stats.reactions / 5); // engagement
  return Math.round(Math.min(100, Math.max(0, score)));
}
// Generate a weekly health report.
// rooms: [{ roomId, roomName, stats, prevStats }]
export function healthReport({ rooms, weekEnding }) {
  check(Array.isArray(rooms), "rooms must be an array");
  check(typeof weekEnding === "string" && /^\d{4}-\d{2}-\d{2}$/.test(weekEnding),
    "weekEnding must be YYYY-MM-DD");
  const reports = rooms.map(r => {
    check(typeof r.roomId === "string" && r.roomId.length > 0, "roomId must be non-empty");
    check(r.stats !== null && typeof r.stats === "object", "stats must be an object");
    const score = scoreHealth(r.stats);
    const prevScore = r.prevStats ? scoreHealth(r.prevStats) : null;
    const trend = prevScore === null ? "new" : score > prevScore ? "up" : score < prevScore ? "down" : "flat";
    return Object.freeze({ roomId: r.roomId, roomName: r.roomName || r.roomId,
      score, trend, stats: Object.freeze({ ...r.stats }) });
  });
  reports.sort((a, b) => b.score - a.score);
  const avgScore = reports.length > 0
    ? Math.round(reports.reduce((sum, r) => sum + r.score, 0) / reports.length)
    : 0;
  return Object.freeze({ weekEnding, roomCount: reports.length, avgScore,
    rooms: Object.freeze(reports) });
}
export { HealthError, scoreHealth };
