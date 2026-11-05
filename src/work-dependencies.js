// Shared Board dependency shape. IDs name Board claims, not message or session IDs.
export function normalizeWorkDependencies(value, selfId) {
  if (!Array.isArray(value) || value.length > 16) throw new Error("dependsOn must be an array of at most 16 claim ids");
  for (const id of value) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("each dependsOn entry must be a claim id");
    if (id === selfId) throw new Error("a claim cannot depend on itself");
  }
  return Object.freeze([...new Set(value)].sort());
}
