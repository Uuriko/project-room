// Public receipts HTML. Script-free. Live records come from receipts-live.mjs.
// Every interpolated string is escaped: titles and names are room data.
import { DARK_DECLARATIONS, LIGHT_DECLARATIONS } from "../src/design-tokens.js";
import { ROOM_ORIGIN } from "./agent-discovery.mjs";
import { LEGAL_FOOTER_LINKS, reportHref } from "./legal-pages.mjs";

// These script-free pages share the marketing policy; the HTTP boundary adds
// the exact served-origin analytics endpoint. App/export policies stay separate.
export { PUBLIC_SEARCH_CSP as RECEIPTS_PAGE_CSP } from "./public-search.mjs";

const OG_IMAGE = `${ROOM_ORIGIN}/og/receipts.png`;

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const pageStyle = () => `:root{color-scheme:dark;${DARK_DECLARATIONS}}[data-theme="light"]{color-scheme:light;${LIGHT_DECLARATIONS}}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.55 var(--font-sans)}
main{max-width:42rem;margin:0 auto;padding:2rem 1.25rem 3rem}
h1{font-size:clamp(1.6rem,5vw,2.2rem);line-height:1.15;letter-spacing:-.03em}
a{color:var(--blue)}
.card,.detail{overflow-wrap:anywhere;word-break:break-word;max-width:100%}
.card{border-top:1px solid var(--line);padding:1rem 0}
.meta{color:var(--muted);font-size:.9rem}
.receipt-next{border-top:1px solid var(--line);margin-top:1.5rem;padding-top:1rem}
.receipt-next p{margin:0}
footer{margin-top:2rem;border-top:1px solid var(--line);padding-top:1rem;color:var(--muted)}
dl{margin:0}dt{color:var(--muted);margin-top:.8rem}dd{margin:0}
img,svg,table{max-width:100%}`;

function head({ title, description, path }) {
  const canonical = `${ROOM_ORIGIN}${path}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${OG_IMAGE}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${OG_IMAGE}">
<style>${pageStyle()}</style>
</head>`;
}

const names = list => list.length ? list.map(escapeHtml).join(", ") : "—";

const when = value => {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "";
};

export function renderReceiptsHtml(page) {
  const receipts = Array.isArray(page?.receipts) ? page.receipts : [];
  const description = "Public receipts of work done in Project Room: merged pull requests and completed work from rooms that chose to publish them.";
  const items = receipts.map(item => `<article class="card">
<h2><a href="/receipts/${escapeHtml(item.id)}">${escapeHtml(item.title)}</a></h2>
<p class="meta">${escapeHtml(when(item.at))}${item.room?.title ? ` · ${escapeHtml(item.room.title)}` : ""}${item.agents?.length ? ` · ${names(item.agents)}` : ""}</p>
</article>`).join("") || `<p>No published receipts yet. A receipt is the record of one settled run — what ran, what it read, what changed, and who signed off. One appears here when work is settled in a room whose owner turned on public receipts in room settings.</p>`;
  const next = page?.nextCursor ? `<p><a href="/receipts?cursor=${escapeHtml(page.nextCursor)}">Older receipts</a></p>` : "";
  return `${head({ title: "Project Room — public receipts", description, path: "/receipts" })}
<body><header><p><a href="/">Project Room</a></p></header>
<main>
<h1>Public receipts</h1>
<p>Merged work and completed work items from rooms whose owners turned publishing on, plus public-work receipts. Private rooms stay off this page until the owner publishes them.</p>
${items}
${next}
</main>
<footer><a href="https://room.trydemigod.com/?start=room">Made in Project Room — start your own room</a><p>${LEGAL_FOOTER_LINKS}</p></footer>
</body></html>`;
}

// The verdict block (charter Workstream B, P2): one graded verdict with
// its scope in the same first-screen block — what was checked, what was
// not, by whom, and when. Verification comes from server/receipt-verify.mjs
// (verify-at-read-time); this renderer is the only place a verdict is
// worded, so the per-room proof page consumes the same block rather than
// growing a parallel verdict UI. With no verification run, the block is
// a displayed "not yet verified" state with the action that runs one —
// absence is shown, never a blank. Raw hashes stay in the record below;
// the verdict never asks a reader to compare hex.
const CHECK_STATUS_WORDS = { pass: "matches", contradicted: "does not match", missing: "missing",
  "not-checked": "not checked", observed: "as reported" };

export function renderVerificationBlock(receipt, verification) {
  if (!verification) {
    return `<section class="receipt-verification" aria-label="Verification">
<h2>Verification</h2>
<p><strong>Not yet verified.</strong> This page shows the record as stored; nothing on it has been re-checked at read time.</p>
<p><a href="?verify=1">Verify this receipt now</a> — the server re-checks the record against its source${receipt.pullRequest ? " and re-fetches the linked pull request from GitHub" : ""}, and stamps the result with the time it ran.</p>
</section>`;
  }
  const checks = verification.checks.map(check =>
    `<li data-check="${escapeHtml(check.id)}" data-status="${escapeHtml(check.status)}"><strong>${escapeHtml(check.label)}</strong> — ${escapeHtml(CHECK_STATUS_WORDS[check.status] ?? check.status)}: ${escapeHtml(check.detail)}</li>`).join("");
  const notChecked = verification.scope.notChecked.map(item => `<li>${escapeHtml(item)}</li>`).join("");
  return `<section class="receipt-verification" aria-label="Verification">
<h2>Verification</h2>
<p class="verification-verdict" data-verdict="${escapeHtml(verification.verdict)}"><strong>${escapeHtml(verification.verdictLabel)}</strong></p>
<p>${escapeHtml(verification.summary)}</p>
<p class="verification-meta">Checked <time datetime="${escapeHtml(verification.checkedAt)}">${escapeHtml(verification.checkedAt)}</time> by ${escapeHtml(verification.scope.by)}.</p>
<h3>What was checked</h3>
<ul>${checks}</ul>
<h3>What was not checked</h3>
<ul>${notChecked}</ul>
</section>`;
}

export function renderReceiptDetailHtml(receipt, { verification = null } = {}) {
  const description = `${receipt.title}. A public receipt from Project Room.`;
  const room = receipt.room?.title
    ? `<div><dt>Room</dt><dd>${escapeHtml(receipt.room.title)}</dd></div>`
    : receipt.room?.id
      ? `<div><dt>Room</dt><dd>${escapeHtml(receipt.room.id)}</dd></div>`
      : "";
  const pr = receipt.pullRequest
    ? `<div><dt>Pull request</dt><dd><a href="${escapeHtml(receipt.pullRequest)}">${escapeHtml(receipt.pullRequest)}</a></dd></div>`
    : "";
  const merged = receipt.mergedAt ? `<div><dt>Merged</dt><dd><time datetime="${escapeHtml(receipt.mergedAt)}">${escapeHtml(receipt.mergedAt)}</time></dd></div>` : "";
  const hashes = receipt.hashes?.length
    ? `<div><dt>Hash evidence</dt><dd>${receipt.hashes.map(hash => `<code>${escapeHtml(hash)}</code>`).join("<br>")}</dd></div>`
    : "";
  // Bounty lot receipts carry the escrow movement and the settlement
  // verdict. Parties are ledger account ids (poster / worker lanes), not
  // display names, and credits are the room's internal ledger units.
  const lot = receipt.lot ? (() => {
    const l = receipt.lot;
    const s = l.settlement ?? {};
    const credits = value => typeof value === "number" && Number.isFinite(value) ? `${escapeHtml(value)} credits` : "—";
    const side = entry => entry ? `${escapeHtml(entry.account)} · ${escapeHtml(entry.lotState)}` : "—";
    const rows = [
      `<div><dt>Movement</dt><dd>${escapeHtml(l.kind ?? "")}</dd></div>`,
      `<div><dt>Amount</dt><dd>${credits(l.amountCredits)} (${escapeHtml(l.amountMillis)} milli-credits)</dd></div>`,
      `<div><dt>From</dt><dd>${side(l.from)}</dd></div>`,
      `<div><dt>To</dt><dd>${side(l.to)}</dd></div>`,
      `<div><dt>Posted by</dt><dd>${escapeHtml(l.poster ?? "—")}</dd></div>`,
      `<div><dt>Worker</dt><dd>${escapeHtml(l.worker ?? "—")}</dd></div>`,
      l.verifier ? `<div><dt>Verifier</dt><dd>${escapeHtml(l.verifier)}</dd></div>` : "",
      `<div><dt>Bounty</dt><dd><code>${escapeHtml(l.bountyId)}</code></dd></div>`,
      l.bountyState ? `<div><dt>Bounty state</dt><dd>${escapeHtml(l.bountyState)}</dd></div>` : "",
      `<div><dt>Award</dt><dd>${credits(l.awardCredits)}</dd></div>`,
      s.kind ? `<div><dt>Settlement</dt><dd>${escapeHtml(s.kind)}</dd></div>` : "",
      s.reason ? `<div><dt>Settlement reason</dt><dd>${escapeHtml(s.reason)}</dd></div>` : "",
      s.settledAt ? `<div><dt>Settled</dt><dd><time datetime="${escapeHtml(s.settledAt)}">${escapeHtml(s.settledAt)}</time></dd></div>` : "",
      s.settledBy?.id ? `<div><dt>Settled by</dt><dd>${escapeHtml(s.settledBy.id)}${s.settledBy.kind ? ` (${escapeHtml(s.settledBy.kind)})` : ""}</dd></div>` : "",
      l.rubricHash ? `<div><dt>Rubric hash</dt><dd><code>sha256:${escapeHtml(l.rubricHash)}</code>${l.rubricVersion ? ` · version ${escapeHtml(l.rubricVersion)}` : ""}</dd></div>` : "",
      l.submissionHash ? `<div><dt>Submission hash</dt><dd><code>sha256:${escapeHtml(l.submissionHash)}</code></dd></div>` : "",
      l.journalHash ? `<div><dt>Ledger entry hash</dt><dd><code>sha256:${escapeHtml(l.journalHash)}</code></dd></div>` : "",
      l.signedReceiptIds?.length ? `<div><dt>Signed receipt</dt><dd>${l.signedReceiptIds.map(entry => `<code>${escapeHtml(entry)}</code>`).join("<br>")}</dd></div>` : "",
      l.memo ? `<div><dt>Memo</dt><dd>${escapeHtml(l.memo)}</dd></div>` : "",
    ];
    return rows.join("");
  })() : "";
  // Receipt honesty: say precisely what this record proves, no more. Only a
  // work-claim receipt carries a server-verified merge (the server's own
  // poll wrote pr_merged + syncedAt; a member-supplied outcome "merged"
  // never qualifies — server/public-read-model.mjs serverVerifiedMerge).
  // Names are room data (member display names, or a self-supplied name on
  // public-work receipts), never identity-verified. Hashes are stored
  // sha256: values, never re-verified at read time. The JSON envelope is
  // unsigned (docs/RECEIPTS-PAGE.md).
  const provenNote = verification
    ? "The verification block above is what the server re-checked, at the time it shows. The record below is the stored receipt it checked."
    : receipt.source === "bounty-lot"
    ? "What this record proves: the room's credit ledger recorded this movement and the settlement verdict shown. Credits are the room's internal ledger units, not money. Account ids are as the ledger recorded them, not identity-verified. Hashes are stored values, not re-verified. This record is unsigned."
    : receipt.mergedAt && receipt.pullRequest
    ? "What this record proves: the server verified the merge against the linked pull request. Agent and human names are as the room recorded them, not identity-verified. Hashes are stored values, not re-verified. This record is unsigned."
    : "What this record proves: the room recorded this work and made it public. Agent and human names are as the room recorded them, not identity-verified. Hashes are stored values, not re-verified. This record is unsigned.";
  return `${head({ title: receipt.title, description, path: `/receipts/${receipt.id}` })}
<body><header><p><a href="/">Project Room</a> · <a href="/receipts">Public receipts</a></p></header>
<main>
<h1>${escapeHtml(receipt.title)}</h1>
${renderVerificationBlock(receipt, verification)}
<dl class="detail">
${room}
<div><dt>Agents</dt><dd>${names(receipt.agents ?? [])}</dd></div>
<div><dt>Humans</dt><dd>${names(receipt.humans ?? [])}</dd></div>
${pr}${merged}${hashes}${lot}
<div><dt>Recorded</dt><dd><time datetime="${escapeHtml(receipt.at)}">${escapeHtml(receipt.at)}</time></dd></div>
</dl>
<p class="meta">${provenNote}</p>
<nav class="receipt-next" aria-label="Keep going"><p><a href="/offers">See open work</a> · <a href="/join">Post a bounty</a> · <a href="/receipts">More receipts</a></p></nav>
<p><a href="${escapeHtml(reportHref("receipt", receipt.id))}">Report</a></p>
</main>
<footer><a href="${escapeHtml(receipt.startHref)}">Made in Project Room — start your own room</a><p>${LEGAL_FOOTER_LINKS}</p></footer>
</body></html>`;
}

const publicJson = receipt => ({
  schema: receipt.schema,
  id: receipt.id,
  title: receipt.title,
  source: receipt.source,
  room: receipt.room,
  agents: receipt.agents,
  humans: receipt.humans,
  pullRequest: receipt.pullRequest,
  mergedAt: receipt.mergedAt,
  hashes: receipt.hashes,
  at: receipt.at,
  ...(receipt.lot ? { lot: receipt.lot } : {}),
});

export function receiptsListJson(page) {
  return {
    schema: "project-room-public-receipt-list/1",
    receipts: (page.receipts ?? []).map(publicJson),
    nextCursor: page.nextCursor ?? null,
  };
}

export function receiptJson(receipt, verification = null) {
  // The verification (project-room-receipt-verification/1) rides the JSON
  // shape only when a verify run produced it — readers can tell a fresh
  // check ("checked just now") apart from stored values without parsing
  // the verdict.
  return { ...publicJson(receipt), ...(verification ? { verification } : {}) };
}
