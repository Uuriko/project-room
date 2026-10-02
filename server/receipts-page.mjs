// Public run-receipts page: aggregation + rendering.
//
// Pure: no I/O, no imports. Takes the generated RECEIPTS_SNAPSHOT object
// (server/receipts-data.mjs, built by scripts/receipts-snapshot.mjs from
// the room's receipt board) and returns aggregates, an HTML page, or a
// JSON body. All interpolated text is HTML-escaped: receipt summaries come
// from public board comments and are untrusted input.

export const RECEIPTS_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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
  ":root { color-scheme: dark; --bg:#202127;--panel:#191a20;--panel-raised:#292b33;--panel-hover:#34363f;--line:#393b45;--line-soft:#30323a;--text:#eeedf1;--muted:#aaaab7;--blue:#a9b9ff;--blue-strong:#5555bd;--blue-strong-hover:#6a6ad4;--on-accent:#ffffff;--amber:#ffbf69;--green:#4fd09b;--red:#ff7b7b;--violet:#ad8cff;--card:#191a20;--border:#393b45;--shadow:0 20px 70px rgb(0 0 0 / 32%);--radius-sm:.35rem;--radius-md:.45rem;--radius-lg:.85rem;--radius-xl:1rem;--space-1:.25rem;--space-2:.5rem;--space-3:.75rem;--space-4:1rem;--space-5:1.5rem;--space-6:2rem;--text-xs:.75rem;--text-sm:.875rem;--text-md:1rem;--text-lg:1.25rem;--font-sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif; }",
  "[data-theme=\"light\"] { color-scheme: light; --bg:#f4f3f8;--panel:#fffbff;--panel-raised:#e8e7ef;--panel-hover:#dddce6;--line:#c9c8d4;--line-soft:#dddce6;--text:#1c1b22;--muted:#5c5b6a;--blue:#33339a;--blue-strong:#3f3fad;--blue-strong-hover:#33338f;--on-accent:#ffffff;--amber:#8a4b00;--green:#0f6b45;--red:#a32020;--violet:#5b3d99;--card:#fffbff;--border:#c9c8d4;--shadow:0 16px 40px rgb(28 27 34 / 12%); }",
  "body { font-family: var(--font-sans); background: var(--bg); color: var(--text); max-width: 72rem; margin: 0 auto; padding: 2rem 1rem; line-height: 1.5; }",
  "a { color: var(--blue); } a:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }",
  "header p.lede { color: var(--muted); max-width: 46rem; }",
  ".stats { display: flex; flex-wrap: wrap; gap: 1rem; margin: 1.5rem 0; }",
  ".stat { border: 1px solid var(--line); border-radius: var(--radius-md); padding: 0.6rem 1rem; min-width: 7rem; background: var(--panel); }",
  ".stat .n { display: block; font-size: 1.6rem; font-weight: 700; }",
  ".stat .l { font-size: 0.85rem; color: var(--muted); }",
  ".meta { font-size: 0.9rem; color: var(--muted); }",
  ".snapshot-banner { font-size: 1.05rem; border: 1px solid var(--amber); background: var(--panel); border-radius: var(--radius-md); padding: 0.75rem 1rem; }",
  ".table-scroll { overflow-x: auto; max-width: 100%; }",
  "html, body { overflow-x: clip; }",
  "table { border-collapse: collapse; width: max-content; min-width: 100%; margin: 1rem 0 2rem; font-size: 0.92rem; }",
  "th, td { border: 1px solid var(--line); padding: 0.45rem 0.6rem; text-align: left; vertical-align: top; }",
  "th { background: var(--panel-raised); }",
  ".result { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.8rem; font-weight: 600; }",
  ".result.verified { background: #12351f; color: #a7e8bd; }",
  ".result.failed { background: #3d1414; color: #f3b6b6; }",
  ".result.open { background: #16294d; color: #bcd3ff; }",
  ".result.reported { background: var(--panel-raised); color: var(--muted); }",
  ".links a { margin-right: 0.5rem; white-space: nowrap; }",
  ".empty { font-size: 1.1rem; color: var(--muted); padding: 2rem 0; }",
  "footer { margin-top: 3rem; font-size: 0.85rem; color: var(--muted); border-top: 1px solid var(--line); padding-top: 1rem; }",
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
    agg.upstreamMain ? `snapshot upstream main <code>${escapeHtml(agg.upstreamMain.slice(0, 12))}</code>` : null,
  ].filter(Boolean).join(" · ");

  const laneRows = agg.perLane
    .map((entry) => `<tr><td><code>${escapeHtml(entry.lane)}</code></td><td>${escapeHtml(entry.receipts)}</td><td>${escapeHtml(entry.verified)}</td></tr>`)
    .join("");

  const body = agg.receipts.length === 0
    ? `<p class="empty">no runs yet — no receipt posts found on the board.</p>`
    : `<h2>By lane</h2>
<div class="table-scroll"><table><thead><tr><th>Lane</th><th>Receipts</th><th>Verified</th></tr></thead><tbody>${laneRows}</tbody></table></div>
<h2>Receipts <span class="meta">(newest first)</span></h2>
<div class="table-scroll"><table><thead><tr><th>Date</th><th>Lane</th><th>Task</th><th>Result</th><th>Links</th><th>What ran</th></tr></thead>` +
      `<tbody>${agg.receipts.map(receiptRow).join("")}</tbody></table></div>`;

  const snapshotDate = agg.generatedAt ? agg.generatedAt.slice(0, 10) : null;
  const snapshotBanner = snapshotDate
    ? `<p class="snapshot-banner" role="note"><strong>Historical snapshot</strong> from <time datetime="${escapeHtml(agg.generatedAt)}">${escapeHtml(snapshotDate)}</time>. These figures are the coordination board's counts at that time, not a live read.</p>`
    : `<p class="snapshot-banner" role="note"><strong>Historical snapshot.</strong> The snapshot date was not recorded. These figures are not a live read.</p>`;
  const description = "Historical snapshot of measured Project Room runs: receipts from the coordination board, with each merge checked against the upstream repository.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Project Room — run receipts</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="https://room.trydemigod.com/receipts">
<meta property="og:type" content="website">
<meta property="og:url" content="https://room.trydemigod.com/receipts">
<meta property="og:title" content="Project Room — run receipts">
<meta property="og:description" content="${escapeHtml(description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>Run receipts</h1>
${snapshotBanner}
<p class="lede">Measured work from the Project Room. Every line below is a real receipt post from the room's coordination board — linked to the board post and the merge it claims, with the merge checked against the upstream repo. Not vibes: receipts.</p>
</header>
<section class="stats" aria-label="totals">
${statCell(t.receipts, "run receipts")}${statCell(t.verified, "verified")}${statCell(t.failed, "failed verification")}${statCell(t.open, "still open")}${statCell(t.reported, "reported")}
</section>
<p class="meta">${meta}</p>
${body}
<footer>
<p>Methodology: a receipt is one <code>[lane][receipt]</code> / <code>[lane][done]</code> board post. <em>Verified</em> means the receipt's merge SHA — or its PR's merge commit — exists in the upstream repo. This does not establish that the commit is on main or that its runtime behavior passed verification; <em>failed</em> means a merge was claimed but no merge commit could be confirmed; <em>open</em> means the receipt announces an opened PR with no merge claimed yet; <em>reported</em> means the run was reported complete with no merge artifact to check. Duplicate receipt posts for the same task and merge count once. Regenerate the snapshot with <code>node scripts/receipts-snapshot.mjs</code>; details in <code>docs/RECEIPTS-PAGE.md</code>.</p>
</footer>
</body>
</html>
`;
}
