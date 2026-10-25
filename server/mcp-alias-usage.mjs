// Counts tools/call hits on names that are leaving the catalog: dotted
// aliases (wake.pause) and folded snake_case tools (room_propose_work).
// Both stay callable for one release. When a name stays at zero it can go.
const counts = new Map();

export function noteDeprecatedCall(called, canonical) {
  counts.set(called, (counts.get(called) ?? 0) + 1);
  console.log(JSON.stringify({ event: "mcp_deprecated_tool", called, canonical, removeAfter: "one release" }));
}

export function deprecatedCallCounts() {
  return Object.fromEntries(counts);
}

export function resetDeprecatedCallCounts() {
  counts.clear();
}
