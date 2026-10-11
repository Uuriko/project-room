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

// Avatar initials for the default tiles: first letter or digit of each of the
// first two words, so "Maya (tester)" is "MT". Astral-plane safe (regex match,
// never UTF-16 indexing — a lone surrogate would render as �); words with no
// letter or digit (emoji, punctuation) contribute nothing; a missing or blank
// name falls back to "?".
export function avatarInitials(displayName) {
  const parts = String(displayName ?? "").replace(/^@/, "").trim().split(/\s+/).filter(Boolean);
  const firstLetter = part => part.match(/[\p{L}\p{N}]/u)?.[0] ?? "";
  const letters = `${firstLetter(parts[0] ?? "")}${firstLetter(parts[1] ?? "")}`;
  return letters.toUpperCase() || "?";
}
