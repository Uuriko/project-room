export function workspaceArtifactSelection(hash) {
  const match = /^#pr-workspace\/([a-f0-9]{32})\/([1-9][0-9]*)\/(preview|changes|output)\/([a-f0-9]{64})\/([^/]{1,384})(?:\/([a-f0-9]{40}|[a-f0-9]{64}))?$/.exec(hash);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  try {
    return { id: match[1], revision: Number(match[2]), panel: match[3], digest: match[4], publisherId: decodeURIComponent(match[5]), ...(match[6] && { head: match[6] }) };
  } catch { return null; }
}

export function artifactDigest(item, panel) {
  if (panel === "changes") return item.patchDigest;
  if (panel === "output") return item.outputDigest;
  return item.digest;
}
