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

const OUTCOME_LABELS = { accepted: "Accepted", rejected: "Rejected", revision_requested: "Revision requested", submitted: "Submitted" };
const outcomeLabel = state => OUTCOME_LABELS[state] ?? state;

const when = value => {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "";
};

export function renderReceiptsHtml(page) {
  const receipts = Array.isArray(page?.receipts) ? page.receipts : [];
  const description = "Public receipts of work done in Project Room: merged pull requests and completed work from rooms that chose to publish them.";
  const items = receipts.map(item => `<article class="card">
<h2><a href="/receipts/${escapeHtml(item.id)}">${escapeHtml(item.title)}</a></h2>
<p class="meta">${escapeHtml(when(item.at))}${item.room?.title ? ` · ${escapeHtml(item.room.title)}` : ""}${item.agents?.length ? ` · ${names(item.agents)}` : ""}${item.state ? ` · ${escapeHtml(outcomeLabel(item.state))}` : ""}</p>
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

export function renderReceiptDetailHtml(receipt) {
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
  // Public-work receipts carry the outcome their records support (#3733):
  // the state the receipt reached, the designated reviewer's verdict and
  // decision, the verification tier, and the checks — platform-executed
  // ones apart from the ones the worker merely reported. Before this, a
  // rejected delivery's page was identical to an accepted one's except
  // title and id.
  const work = receipt.source === "public-work" && receipt.state ? (() => {
    const review = receipt.review ?? {};
    const outcomeText = {
      accepted: "Accepted — the designated reviewer accepted this delivery.",
      rejected: "Rejected — the designated reviewer rejected this delivery.",
      revision_requested: "Revision requested — the designated reviewer asked for changes.",
      submitted: "Submitted — no reviewer decision is recorded yet.",
    }[receipt.state] ?? `Recorded state: ${receipt.state}.`;
    const rows = [`<div><dt>Outcome</dt><dd>${escapeHtml(outcomeText)}</dd></div>`];
    if (review.verificationVerdict) rows.push(`<div><dt>Reviewer verdict</dt><dd>${escapeHtml(review.verificationVerdict)}${review.verificationReviewerKind ? ` (${escapeHtml(review.verificationReviewerKind)} reviewer)` : ""}${review.verifiedAt ? ` · <time datetime="${escapeHtml(review.verifiedAt)}">${escapeHtml(review.verifiedAt)}</time>` : ""}</dd></div>`);
    if (review.decidedAt) rows.push(`<div><dt>Decided</dt><dd><time datetime="${escapeHtml(review.decidedAt)}">${escapeHtml(review.decidedAt)}</time></dd></div>`);
    if (receipt.verification) rows.push(`<div><dt>Verification</dt><dd>${escapeHtml(receipt.verification === "hash_only" ? "Artifact hash only (hash_only): the platform recorded the artifact's sha256; it did not run the checks itself." : receipt.verification)}</dd></div>`);
    if (receipt.executedChecks?.length) rows.push(`<div><dt>Platform-executed checks</dt><dd>${receipt.executedChecks.map(check => `${escapeHtml(check.name)} — ${escapeHtml(check.verdict)}`).join("<br>")}</dd></div>`);
    if (receipt.checksReported?.length) rows.push(`<div><dt>Checks the worker reported</dt><dd>${receipt.checksReported.map(entry => escapeHtml(entry)).join("<br>")}</dd></div>`);
    return rows.join("");
  })() : "";
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
  const provenNote = receipt.source === "bounty-lot"
    ? "What this record proves: the room's credit ledger recorded this movement and the settlement verdict shown. Credits are the room's internal ledger units, not money. Account ids are as the ledger recorded them, not identity-verified. Hashes are stored values, not re-verified. This record is unsigned."
    : receipt.source === "public-work" && receipt.review?.decidedAt
    ? "What this record proves: the room recorded this work and made it public, and the reviewer decision shown above is the room's recorded outcome for this delivery. Agent and human names are as the room recorded them, not identity-verified. Hashes are stored values, not re-verified. This record is unsigned."
    : receipt.mergedAt && receipt.pullRequest
    ? "What this record proves: the server verified the merge against the linked pull request. Agent and human names are as the room recorded them, not identity-verified. Hashes are stored values, not re-verified. This record is unsigned."
    : "What this record proves: the room recorded this work and made it public. Agent and human names are as the room recorded them, not identity-verified. Hashes are stored values, not re-verified. This record is unsigned.";
  return `${head({ title: receipt.title, description, path: `/receipts/${receipt.id}` })}
<body><header><p><a href="/">Project Room</a> · <a href="/receipts">Public receipts</a></p></header>
<main>
<h1>${escapeHtml(receipt.title)}</h1>
<dl class="detail">
${room}
<div><dt>Agents</dt><dd>${names(receipt.agents ?? [])}</dd></div>
<div><dt>Humans</dt><dd>${names(receipt.humans ?? [])}</dd></div>
${pr}${merged}${hashes}${work}${lot}
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
  ...(receipt.state ? { state: receipt.state } : {}),
  ...(receipt.verification ? { verification: receipt.verification } : {}),
  ...(receipt.checksReported ? { checksReported: receipt.checksReported } : {}),
  ...(receipt.executedChecks ? { executedChecks: receipt.executedChecks } : {}),
  ...(receipt.review ? { review: receipt.review } : {}),
  ...(receipt.lot ? { lot: receipt.lot } : {}),
});

export function receiptsListJson(page) {
  return {
    schema: "project-room-public-receipt-list/1",
    receipts: (page.receipts ?? []).map(publicJson),
    nextCursor: page.nextCursor ?? null,
  };
}

export function receiptJson(receipt) {
  return publicJson(receipt);
}
