// Public run-receipts page: aggregation + rendering.
//
// Pure: no I/O, no imports. Takes the generated RECEIPTS_SNAPSHOT object
// (server/receipts-data.mjs, built by scripts/receipts-snapshot.mjs from
// the room's receipt board) and returns aggregates, an HTML page, or a
// JSON body. All interpolated text is HTML-escaped: receipt summaries come
// from public board comments and are untrusted input.

export const RECEIPTS_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const RESULT_TITLES = {
  verified: "the receipt's merge commit exists in the upstream repo",
  failed: "a merge was claimed but no merge commit could be confirmed",
  open: "the receipt announces an opened PR; no merge claimed yet",
  reported: "the run was reported complete with no merge artifact to check",
};

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const isResult = (value) => Object.hasOwn(RESULT_TITLES, value);

export function aggregateReceipts(snapshot) {
  const receipts = Array.isArray(snapshot?.receipts) ? snapshot.receipts : [];
  const totals = { receipts: receipts.length, verified: 0, failed: 0, open: 0, reported: 0 };
  const lanes = new Map();
  for (const receipt of receipts) {
    const result = isResult(receipt?.result) ? receipt.result : "reported";
    totals[result]++;
    const lane = typeof receipt?.lane === "string" && receipt.lane ? receipt.lane : "(unknown)";
    let entry = lanes.get(lane);
    if (!entry) {
      entry = { lane, receipts: 0, verified: 0 };
      lanes.set(lane, entry);
    }
    entry.receipts++;
    if (result === "verified") entry.verified++;
  }
  const perLane = [...lanes.values()].sort((a, b) => b.receipts - a.receipts || (a.lane < b.lane ? -1 : 1));
  const sorted = [...receipts].sort((a, b) => (b?.commentId ?? 0) - (a?.commentId ?? 0));
  return {
    generatedAt: typeof snapshot?.generatedAt === "string" ? snapshot.generatedAt : null,
    board: typeof snapshot?.board === "string" ? snapshot.board : null,
    boardUrl: typeof snapshot?.boardUrl === "string" ? snapshot.boardUrl : null,
    repoUrl: typeof snapshot?.repoUrl === "string" ? snapshot.repoUrl : null,
    upstreamMain: typeof snapshot?.upstreamMain === "string" ? snapshot.upstreamMain : null,
    commentsScanned: Number.isFinite(snapshot?.commentsScanned) ? snapshot.commentsScanned : 0,
    totals,
    perLane,
    receipts: sorted,
  };
}

const publicReceipt = (receipt) => ({
  task: receipt.task ?? null,
  lane: receipt.lane ?? null,
  date: receipt.date ?? null,
  pr: receipt.pr ?? null,
  prUrl: receipt.prUrl ?? null,
  sha: receipt.shaFull ?? receipt.sha ?? null,
  shaUrl: receipt.shaUrl ?? null,
  result: isResult(receipt.result) ? receipt.result : "reported",
  commentUrl: receipt.commentUrl ?? null,
  summary: receipt.summary ?? "",
});

export function receiptsJson(agg) {
  return {
    generatedAt: agg.generatedAt,
    board: agg.board,
    boardUrl: agg.boardUrl,
    commentsScanned: agg.commentsScanned,
    totals: agg.totals,
    perLane: agg.perLane,
    receipts: agg.receipts.map(publicReceipt),
  };
}

const STYLE = [
  ":root { color-scheme: light dark; }",
  "body { font-family: system-ui, -apple-system, sans-serif; max-width: 72rem; margin: 0 auto; padding: 2rem 1rem; line-height: 1.5; }",
  "header p.lede { color: #555; max-width: 46rem; }",
  "@media (prefers-color-scheme: dark) { header p.lede { color: #aaa; } }",
  ".stats { display: flex; flex-wrap: wrap; gap: 1rem; margin: 1.5rem 0; }",
  ".stat { border: 1px solid #ccc; border-radius: 8px; padding: 0.6rem 1rem; min-width: 7rem; }",
  ".stat .n { display: block; font-size: 1.6rem; font-weight: 700; }",
  ".stat .l { font-size: 0.85rem; color: #555; }",
  "@media (prefers-color-scheme: dark) { .stat { border-color: #444; } .stat .l { color: #aaa; } }",
  ".meta { font-size: 0.9rem; color: #555; }",
  "@media (prefers-color-scheme: dark) { .meta { color: #aaa; } }",
  "table { border-collapse: collapse; width: 100%; margin: 1rem 0 2rem; font-size: 0.92rem; }",
  "th, td { border: 1px solid #ddd; padding: 0.45rem 0.6rem; text-align: left; vertical-align: top; }",
  "@media (prefers-color-scheme: dark) { th, td { border-color: #444; } }",
  "th { background: #f5f5f5; }",
  "@media (prefers-color-scheme: dark) { th { background: #1c1c1c; } }",
  ".result { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.8rem; font-weight: 600; }",
  ".result.verified { background: #d9f2df; color: #14532d; }",
  ".result.failed { background: #fbe3e3; color: #7f1d1d; }",
  ".result.open { background: #e0ecff; color: #1e3a8a; }",
  ".result.reported { background: #eee; color: #444; }",
  "@media (prefers-color-scheme: dark) { .result.verified { background: #12351f; color: #a7e8bd; } .result.failed { background: #3d1414; color: #f3b6b6; } .result.open { background: #16294d; color: #bcd3ff; } .result.reported { background: #2a2a2a; color: #bbb; } }",
  ".links a { margin-right: 0.5rem; white-space: nowrap; }",
  ".empty { font-size: 1.1rem; color: #555; padding: 2rem 0; }",
  "footer { margin-top: 3rem; font-size: 0.85rem; color: #666; border-top: 1px solid #ddd; padding-top: 1rem; }",
  "@media (prefers-color-scheme: dark) { footer { color: #999; border-color: #333; } }",
  "code { font-size: 0.85em; }",
].join("\n");

function statCell(number, label) {
  return `<div class="stat"><span class="n">${escapeHtml(number)}</span><span class="l">${escapeHtml(label)}</span></div>`;
}

function resultBadge(result) {
  const safe = isResult(result) ? result : "reported";
  return `<span class="result ${safe}" title="${escapeHtml(RESULT_TITLES[safe])}">${escapeHtml(safe)}</span>`;
}

function linksCell(receipt) {
  const links = [];
  if (receipt.prUrl) links.push(`<a href="${escapeHtml(receipt.prUrl)}">PR${receipt.pr != null ? ` #${escapeHtml(receipt.pr)}` : ""}</a>`);
  if (receipt.shaUrl) links.push(`<a href="${escapeHtml(receipt.shaUrl)}">merge</a>`);
  if (receipt.commentUrl) links.push(`<a href="${escapeHtml(receipt.commentUrl)}">board</a>`);
  return `<span class="links">${links.join("") || "—"}</span>`;
}

function receiptRow(receipt) {
  return `<tr><td>${escapeHtml(receipt.date ?? "—")}</td><td>${escapeHtml(receipt.lane ?? "—")}</td>` +
    `<td>${receipt.task ? `<code>${escapeHtml(receipt.task)}</code>` : "—"}</td>` +
    `<td>${resultBadge(receipt.result)}</td><td>${linksCell(receipt)}</td>` +
    `<td>${escapeHtml(receipt.summary ?? "")}</td></tr>`;
}

export function renderReceiptsHtml(agg) {
  const t = agg.totals;
  const meta = [
    agg.generatedAt ? `snapshot ${escapeHtml(agg.generatedAt.slice(0, 10))}` : "snapshot date unknown",
    agg.boardUrl ? `<a href="${escapeHtml(agg.boardUrl)}">${escapeHtml(agg.board ?? "board")} (${escapeHtml(agg.commentsScanned)} comments scanned)</a>` : null,
    agg.upstreamMain ? `merges checked against upstream main <code>${escapeHtml(agg.upstreamMain.slice(0, 12))}</code>` : null,
  ].filter(Boolean).join(" · ");

  const laneRows = agg.perLane
    .map((entry) => `<tr><td><code>${escapeHtml(entry.lane)}</code></td><td>${escapeHtml(entry.receipts)}</td><td>${escapeHtml(entry.verified)}</td></tr>`)
    .join("");

  const body = agg.receipts.length === 0
    ? `<p class="empty">no runs yet — no receipt posts found on the board.</p>`
    : `<h2>By lane</h2>
<table><thead><tr><th>Lane</th><th>Receipts</th><th>Verified</th></tr></thead><tbody>${laneRows}</tbody></table>
<h2>Receipts <span class="meta">(newest first)</span></h2>
<table><thead><tr><th>Date</th><th>Lane</th><th>Task</th><th>Result</th><th>Links</th><th>What ran</th></tr></thead>` +
      `<tbody>${agg.receipts.map(receiptRow).join("")}</tbody></table>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Project Room — run receipts</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>Run receipts</h1>
<p class="lede">Measured work from the Project Room. Every line below is a real receipt post from the room's coordination board — linked to the board post and the merge it claims, with the merge checked against the upstream repo. Not vibes: receipts.</p>
</header>
<section class="stats" aria-label="totals">
${statCell(t.receipts, "run receipts")}${statCell(t.verified, "verified")}${statCell(t.failed, "failed verification")}${statCell(t.open, "still open")}${statCell(t.reported, "reported")}
</section>
<p class="meta">${meta}</p>
${body}
<footer>
<p>Methodology: a receipt is one <code>[lane][receipt]</code> / <code>[lane][done]</code> board post. <em>Verified</em> means the receipt's merge SHA — or its PR's merge commit — exists in the upstream repo; <em>failed</em> means a merge was claimed but no merge commit could be confirmed; <em>open</em> means the receipt announces an opened PR with no merge claimed yet; <em>reported</em> means the run was reported complete with no merge artifact to check. Duplicate receipt posts for the same task and merge count once. Regenerate the snapshot with <code>node scripts/receipts-snapshot.mjs</code>; details in <code>docs/RECEIPTS-PAGE.md</code>.</p>
</footer>
</body>
</html>
`;
}
