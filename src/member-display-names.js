// Conversation author labels use normal whitespace rendering.
const labelKey = label => label.trim().replace(/[ \t\r\n]+/g, " ").toLocaleLowerCase();

// Derived once from the current authorized Room snapshot, including inactive
// members: an old attribution must remain distinct from a duplicate new name.
export function createMemberDisplayNames(members) {
  const folded = new Map(), counts = new Map();
  for (const member of Object.values(members)) {
    const key = labelKey(member.displayName);
    folded.set(member.id, key);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  // A saved literal name can already look like a generated qualifier.
  // Preserve literal names and keep every displayed member distinct.
  const used = new Set(counts.keys());
  const labels = new Map();
  for (const member of Object.values(members)) {
    if (counts.get(folded.get(member.id)) < 2) {
      labels.set(member.id, member.displayName);
      continue;
    }
    const base = `${member.displayName} (${member.id})`;
    let label = base;
    for (let suffix = 2; used.has(labelKey(label)); suffix++) {
      label = `${base} [${suffix}]`;
    }
    used.add(labelKey(label));
    labels.set(member.id, label);
  }
  return id => labels.get(id) ?? (id == null ? "Unassigned" : `Unknown member (${id})`);
}
