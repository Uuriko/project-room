// Counts tools/call hits on legacy dotted aliases (wake.pause, bond.accept...).
// Aliases stay callable for one release; when these counts stay at zero the
// alias field can be removed from src/mcp-tool-registry.js.
const counts = new Map();

export function countAliasCall(alias) {
  counts.set(alias, (counts.get(alias) ?? 0) + 1);
  console.log(JSON.stringify({ event: "mcp_alias_call", alias }));
}

export function aliasCallCounts() {
  return Object.fromEntries(counts);
}

export function resetAliasCallCounts() {
  counts.clear();
}
