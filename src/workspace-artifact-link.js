export function workspaceArtifactSelection(hash) {
  const match = /^#pr-workspace\/([a-f0-9]{32})\/([1-9][0-9]*)\/(preview|changes|output)\/([a-f0-9]{64})\/([^/]{1,384})(?:\/([a-f0-9]{40}|[a-f0-9]{64})(?:\/([^/]{1,2048}))?)?$/.exec(hash);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  try {
    const file = match[7] && decodeURIComponent(match[7]);
    if (file && (match[3] !== "changes" || /[\u0000-\u001f\u007f]/.test(file))) return null;
    return { id: match[1], revision: Number(match[2]), panel: match[3], digest: match[4], publisherId: decodeURIComponent(match[5]), ...(match[6] && { head: match[6] }), ...(file && { file }) };
  } catch { return null; }
}

export function artifactDigest(item, panel) {
  if (panel === "changes") return item.patchDigest;
  if (panel === "output") return item.outputDigest;
  return item.digest;
}

export function workspaceArtifactLink(base, roomId, item, panel, file) {
  const digest = artifactDigest(item, panel);
  if (!digest) return null;
  const url = new URL(base);
  url.search = "";
  url.searchParams.set("room", roomId);
  url.hash = ["pr-workspace", item.id, item.revision, panel, digest, encodeURIComponent(item.publisherId), item.head].join("/");
  if (panel === "changes" && file) {
    try {
      const encoded = encodeURIComponent(file);
      if (encoded.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(file)) url.hash = [url.hash, encoded].join("/");
    } catch { /* The patch link still works for a filename URL cannot encode. */ }
  }
  return url.href;
}
