// Derived once from the current authorized Room snapshot, including inactive
// members: an old attribution must remain distinct from a duplicate new name.
export function createMemberDisplayNames(members) {
  const folded = new Map(), counts = new Map();
  for (const member of Object.values(members)) {
    const key = member.displayName.trim().toLocaleLowerCase();
    folded.set(member.id, key);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return id => {
    const member = members[id];
    if (!member) return id == null ? "Unassigned" : `Unknown member (${id})`;
    return counts.get(folded.get(member.id)) > 1
      ? id == null ? "Unassigned" : `${member.displayName} (${id})`
      : member.displayName;
  };
}
