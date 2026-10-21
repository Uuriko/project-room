// Public receipts HTML. Script-free. Live records come from receipts-live.mjs.
// Every interpolated string is escaped: titles and names are room data.
import { DARK_DECLARATIONS, LIGHT_DECLARATIONS } from "../src/design-tokens.js";
import { ROOM_ORIGIN } from "./agent-discovery.mjs";
import { parsePullRequestUrl } from "./claim-coordination.mjs";
import { LEGAL_FOOTER_LINKS, reportHref } from "./legal-pages.mjs";
import { jsonLdScriptTag, receiptBadgeUrl, receiptEmbedSnippet, receiptJsonLd, receiptShareLinks, verdictLineOf } from "./receipt-share.mjs";

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
.share{border-top:1px solid var(--line);margin-top:1.5rem;padding-top:1rem}
.share h2{font-size:1.1rem;margin:0 0 .5rem}
.share code{overflow-wrap:anywhere;word-break:break-word}
footer{margin-top:2rem;border-top:1px solid var(--line);padding-top:1rem;color:var(--muted)}
dl{margin:0}dt{color:var(--muted);margin-top:.8rem}dd{margin:0}
img,svg,table{max-width:100%}
@media(pointer:coarse){a{display:inline-flex;align-items:center;min-height:var(--control-min-target-coarse)}h2 a{min-height:var(--control-min-target-coarse)}}`;

function head({ title, description, path, jsonLd = "", ogImage = OG_IMAGE, ogAlt = "" }) {
  const canonical = `${ROOM_ORIGIN}${path}`;
  const ogImageAlt = ogAlt ? `
<meta property="og:image:alt" content="${escapeHtml(ogAlt)}">
<meta name="twitter:image:alt" content="${escapeHtml(ogAlt)}">` : "";
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
<meta property="og:image" content="${escapeHtml(ogImage)}">${ogImageAlt}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(ogImage)}">
${jsonLd}<style>${pageStyle()}</style>
</head>`;
}

const names = list => list.length ? list.map(escapeHtml).join(", ") : "—";

// A public-work receipt's outcome (#3733), composed from its records by
// the read model: the train's record states (submitted / verified) and
// the two review decisions that never stamp the record.
const OUTCOME_LABELS = { verified: "Verified", accepted: "Accepted", rejected: "Rejected", revision_requested: "Revision requested", submitted: "Submitted" };
const outcomeLabel = state => OUTCOME_LABELS[state] ?? state;

const when = value => {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "";
};

// The verification tier a result-mode receipt carries (#3636), worded
// exactly as the proof page's levels name them, so every surface that
// shows the tier shows the same claim — and no surface upgrades it.
const verificationLabel = state => state === "verified" ? "Member-verified completion"
  : state === "self_attested" ? "Self-attested completion" : null;

export function renderReceiptsHtml(page) {
  const receipts = Array.isArray(page?.receipts) ? page.receipts : [];
  const description = "Public receipts of work done in Project Room: merged pull requests and completed work from rooms that chose to publish them.";
  const items = receipts.map(item => { const tier = verificationLabel(item.verification?.state); const wait = waitTextOf(item.wait); return `<article class="card">
<h2><a href="/receipts/${escapeHtml(item.id)}">${escapeHtml(item.title)}</a></h2>
<p class="meta">${escapeHtml(when(item.at))}${item.room?.title ? ` · ${escapeHtml(item.room.title)}` : ""}${item.agents?.length ? ` · ${names(item.agents)}` : ""}${tier ? ` · ${escapeHtml(tier)}` : ""}${item.source === "public-work" && item.state ? ` · ${escapeHtml(outcomeLabel(item.state))}` : ""}${wait ? ` · ${escapeHtml(wait)}` : ""}</p>
</article>`; }).join("") || `<p>No published receipts yet. A receipt is the record of one settled run — what ran, what it read, what changed, and who signed off. One appears here when work is settled in a room whose owner turned on public receipts: open the room, then Settings, then Permissions, and turn on “Public receipts”.</p>`;
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

// The share block. The pre-filled text is shown verbatim — what gets
// posted is exactly what the page says — and the share targets are plain
// anchors, because these pages are script-free. The badge embed is the
// worker's copy-paste path into READMEs and portfolios. This renders only
// for a receipt that already resolved as public through receipts-live.
function shareSection(receipt) {
  const links = receiptShareLinks(receipt);
  return `<section class="share" aria-label="Share this receipt">
<h2>Share this receipt</h2>
<p class="meta">${escapeHtml(links.text)}</p>
<p><a href="${escapeHtml(links.x)}">Post to X</a> · <a href="${escapeHtml(links.linkedin)}">Share on LinkedIn</a> · <a href="${escapeHtml(links.email)}">Share by email</a></p>
<p><img src="${escapeHtml(receiptBadgeUrl(receipt))}" alt="${escapeHtml(`${receipt.title} — ${verdictLineOf(receipt)} (Project Room receipt)`)}"></p>
<p class="meta">Embed the badge in a README or portfolio — it links back to this receipt and shows its verdict:</p>
<p><code>${escapeHtml(receiptEmbedSnippet(receipt))}</code></p>
</section>`;
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

// Claim → source, at phrase level (proof-ux R3: the largest measured
// checking improvement): a check's detail names its evidence in words,
// and the words naming the pull request link to the pull request itself —
// the checkable source — instead of sitting next to a bare URL elsewhere
// on the page. Links are formed only from a pull URL the record carries;
// nothing is linked that the record does not name.
// The record's pull-request row names the claim ("Pull request #2099")
// and links it to the pull itself; the raw URL stays the href and the
// JSON field — the phrase is what a reader checks.
const prPhrase = url => {
  const parsed = parsePullRequestUrl(url);
  return parsed ? `Pull request #${parsed.number}` : url;
};

function linkPullPhrase(escapedDetail, receipt) {
  if (!receipt.pullRequest) return escapedDetail;
  const parsed = parsePullRequestUrl(receipt.pullRequest);
  if (!parsed) return escapedDetail;
  const phrase = `pull request #${parsed.number}`;
  return escapedDetail.split(phrase)
    .join(`<a href="${escapeHtml(receipt.pullRequest)}">${phrase}</a>`);
}

export function renderVerificationBlock(receipt, verification) {
  if (!verification) {
    return `<section class="receipt-verification" aria-label="Verification">
<h2>Verification</h2>
<p><strong>Record not rechecked.</strong> This page shows the saved outcome and checks. They have not been independently rechecked for this view; a recorded check passing does not mean the delivery was accepted.</p>
<p><a href="?verify=1">Verify this receipt now</a> — the server re-checks the record against its source${receipt.pullRequest ? " and re-fetches the linked pull request from GitHub" : ""}, and stamps the result with the time it ran.</p>
</section>`;
  }
  const checks = verification.checks.map(check => {
    const detail = check.id === "pull-request" ? linkPullPhrase(escapeHtml(check.detail), receipt) : escapeHtml(check.detail);
    return `<li data-check="${escapeHtml(check.id)}" data-status="${escapeHtml(check.status)}"><strong>${escapeHtml(check.label)}</strong> — ${escapeHtml(CHECK_STATUS_WORDS[check.status] ?? check.status)}: ${detail}</li>`;
  }).join("");
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
  const verdictLine = verdictLineOf(receipt);
  const description = `${receipt.title} — ${verdictLine}. A public receipt from Project Room.`;
  const room = receipt.room?.title
    ? `<div><dt>Room</dt><dd>${escapeHtml(receipt.room.title)}</dd></div>`
    : receipt.room?.id
      ? `<div><dt>Room</dt><dd>${escapeHtml(receipt.room.id)}</dd></div>`
      : "";
  const pr = receipt.pullRequest
    ? `<div><dt>Pull request</dt><dd><a href="${escapeHtml(receipt.pullRequest)}">${escapeHtml(prPhrase(receipt.pullRequest))}</a></dd></div>`
    : "";
  // A paid work receipt names its payout lot (#3781, read model), so a
  // stranger can walk from the proof of work to the proof of payment.
  // The settlement block carries the journal row's own amount and state.
  const payout = receipt.lotId ? (() => {
    const s = receipt.settlement ?? {};
    const amount = typeof s.amountCredits === "number" && Number.isFinite(s.amountCredits) ? ` · ${escapeHtml(s.amountCredits)} credits` : "";
    const state = s.lotState ? ` · ${escapeHtml(s.lotState)}` : "";
    return `<div><dt>Payout lot</dt><dd><a href="/receipts/${escapeHtml(receipt.lotId)}">${escapeHtml(receipt.lotId)}</a>${amount}${state}</dd></div>`;
  })() : "";
  const merged = receipt.mergedAt ? `<div><dt>Merged</dt><dd><time datetime="${escapeHtml(receipt.mergedAt)}">${escapeHtml(receipt.mergedAt)}</time></dd></div>` : "";
  const tierLabel = verificationLabel(receipt.verification?.state);
  const verificationTier = tierLabel ? `<div><dt>Verification</dt><dd>${escapeHtml(tierLabel)}</dd></div>` : "";
  const hashes = receipt.hashes?.length
    ? `<div><dt>Hash evidence</dt><dd>${receipt.hashes.map(hash => `<code>${escapeHtml(hash)}</code>`).join("<br>")}</dd></div>`
    : "";
  // Public-work receipts carry the outcome their records support (#3733):
  // the state the receipt reached, the designated reviewer's verdict and
  // decision, the verification tier, and the checks — platform-executed
  // ones apart from the ones the worker merely reported. Before this, a
  // rejected delivery's page was identical to a verified one's except
  // title and id.
  const work = receipt.source === "public-work" && receipt.state ? (() => {
    const review = receipt.review ?? {};
    const outcomeText = {
      verified: "Verified — the designated reviewer accepted this delivery, and the acceptance is stamped on the receipt record.",
      rejected: "Rejected — the designated reviewer rejected this delivery.",
      revision_requested: "Revision requested — the designated reviewer asked for changes.",
      submitted: "Submitted — no reviewer decision is recorded yet.",
    }[receipt.state] ?? `Recorded state: ${receipt.state}.`;
    const rows = [`<div><dt>Outcome</dt><dd>${escapeHtml(outcomeText)}</dd></div>`];
    // The submitter's own view of an undecided wait (P6): how long this
    // submission has been waiting, on the receipt page they come back to.
    const waitText = waitTextOf(receipt.wait);
    if (waitText) rows.push(`<div><dt>Waiting</dt><dd>${escapeHtml(waitText)} (submitted <time datetime="${escapeHtml(receipt.wait.submittedAt)}">${escapeHtml(when(receipt.wait.submittedAt))}</time>)</dd></div>`);
    if (review.verificationVerdict) rows.push(`<div><dt>Recorded check verdict</dt><dd>${escapeHtml(review.verificationVerdict)}${review.verificationReviewerKind ? ` (${escapeHtml(review.verificationReviewerKind)} reviewer)` : ""}${review.verifiedAt ? ` · <time datetime="${escapeHtml(review.verifiedAt)}">${escapeHtml(review.verifiedAt)}</time>` : ""} — this check does not override the delivery outcome above.</dd></div>`);
    if (review.decidedAt) rows.push(`<div><dt>Decided</dt><dd><time datetime="${escapeHtml(review.decidedAt)}">${escapeHtml(review.decidedAt)}</time></dd></div>`);
    if (receipt.verification === "hash_only") rows.push(`<div><dt>Verification</dt><dd>Hash only (hash_only) — the platform recorded the artifact's sha256; no platform-executed check passed for this delivery.</dd></div>`);
    else if (receipt.verification === "system_checked") rows.push(`<div><dt>Verification</dt><dd>System-checked (system_checked) — the platform itself executed the checks listed below.</dd></div>`);
    else if (receipt.verification) rows.push(`<div><dt>Verification</dt><dd>${escapeHtml(receipt.verification)}</dd></div>`);
    if (receipt.executedChecks?.length) rows.push(`<div><dt>Platform-executed checks</dt><dd>${receipt.executedChecks.map(check => `${escapeHtml(check.name)} — ${escapeHtml(check.result)}`).join("<br>")}</dd></div>`);
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
    const kinds = Array.isArray(l.kinds) && l.kinds.length ? l.kinds : [l.kind].filter(Boolean);
    // A lot can carry several movements under one id: a dispute split
    // writes attribute + approve + refund, an epoch payout writes payout +
    // fee. The Movement/Amount/From/To rows name only the first movement,
    // so a multi-movement lot also lists every movement in full — without
    // it the face misstates the settlement (a split lot headlined as the
    // full award going to the worker though half refunded to the poster,
    // #3765). Movements are the consecutive same-kind journal legs.
    const groups = [];
    for (const movement of Array.isArray(l.movements) ? l.movements : []) {
      const current = groups.at(-1);
      if (current && current.kind === movement.kind) current.legs.push(movement);
      else groups.push({ kind: movement.kind, legs: [movement] });
    }
    const movementsRow = groups.length > 1
      ? `<div><dt>Movements</dt><dd>${groups.map(group => {
          const debits = group.legs.filter(leg => leg.amountMillis < 0);
          const creditsIn = group.legs.filter(leg => leg.amountMillis > 0);
          const millis = creditsIn.reduce((sum, leg) => sum + leg.amountMillis, 0)
            || Math.abs(debits.reduce((sum, leg) => sum + leg.amountMillis, 0));
          const froms = debits.length ? debits.map(side).join(", ") : "—";
          const tos = creditsIn.length ? creditsIn.map(side).join(", ") : "—";
          return `${escapeHtml(group.kind)}: ${froms} → ${tos} — ${credits(millis / 1000)} (${millis} milli-credits)`;
        }).join("<br>")}</dd></div>`
      : "";
    const rows = [
      `<div><dt>Movement</dt><dd>${escapeHtml(kinds.join(", "))}</dd></div>`,
      `<div><dt>Amount</dt><dd>${credits(l.amountCredits)} (${escapeHtml(l.amountMillis)} milli-credits)</dd></div>`,
      `<div><dt>From</dt><dd>${side(l.from)}</dd></div>`,
      `<div><dt>To</dt><dd>${side(l.to)}</dd></div>`,
      movementsRow,
      `<div><dt>Posted by</dt><dd>${escapeHtml(l.poster ?? "—")}</dd></div>`,
      `<div><dt>Worker</dt><dd>${escapeHtml(l.worker ?? "—")}</dd></div>`,
      l.verifier ? `<div><dt>Verifier</dt><dd>${escapeHtml(l.verifier)}</dd></div>` : "",
      `<div><dt>Bounty</dt><dd><code>${escapeHtml(l.bountyId)}</code></dd></div>`,
      l.bountyState ? `<div><dt>Bounty state</dt><dd>${escapeHtml(l.bountyState)}</dd></div>` : "",
      `<div><dt>Award</dt><dd>${credits(l.awardCredits)}</dd></div>`,
      s.kind ? `<div><dt>Settlement</dt><dd>${escapeHtml(s.kind)}</dd></div>` : "",
      // The settlement's own amounts, on the face: for a split these are
      // the numbers the first-movement headline cannot express (#3765).
      typeof s.workerCredits === "number" ? `<div><dt>Worker received</dt><dd>${credits(s.workerCredits)}</dd></div>` : "",
      typeof s.refundCredits === "number" ? `<div><dt>Refunded to poster</dt><dd>${credits(s.refundCredits)}</dd></div>` : "",
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
  // A result-mode work-claim receipt names its recorded verification tier
  // instead (#3636): member-verified when a distinct member reviewed the
  // delivery, self-attested when the worker's finish is the only record.
  // Names are room data (member display names, or a self-supplied name on
  // public-work receipts), never identity-verified. Hashes are stored
  // sha256: values, never re-verified at read time. The JSON envelope is
  // unsigned (docs/RECEIPTS-PAGE.md).
  const provenNote = verification
    ? "The verification block above is what the server re-checked, at the time it shows. The record below is the stored receipt it checked."
    : receipt.source === "bounty-lot"
    ? "Verification tier: human verdict. What was checked: the room's credit ledger recorded this movement and the settlement verdict shown. Credits are the room's internal ledger units, not money. Account ids are as the ledger recorded them, not identity-verified. Hashes are stored values, not re-verified. This record is unsigned."
    : receipt.source === "public-work" && receipt.review?.decidedAt
    ? "Verification tier: human verdict. What was checked: the room recorded this work and made it public, and the reviewer decision shown above is the room's recorded outcome for this delivery. Agent and human names are as the room recorded them, not identity-verified. Hashes are stored values, not re-verified. This record is unsigned."
    : receipt.mergedAt && receipt.pullRequest
    ? "Verification tier: bytes re-verified. What was checked: the server verified the merge against the linked pull request. Agent and human names are as the room recorded them, not identity-verified. Hashes are stored values, not re-verified. This record is unsigned."
    : receipt.verification?.state === "verified"
    ? "Verification tier: human verdict (member-verified). What was checked: a room member other than the worker reviewed this delivery and recorded approval, and the room published the record. The server did not verify a merge for this receipt. Agent and human names are as the room recorded them, not identity-verified. Hashes are stored values, not re-verified. This record is unsigned."
    : receipt.verification?.state === "self_attested"
    ? "Verification tier: bundle unaltered (self-asserted). What was checked: the worker recorded this work as done, and the room published the record. No other member reviewed it, and the server did not verify a merge for this receipt. Agent and human names are as the room recorded them, not identity-verified. Hashes are stored values, not re-verified. This record is unsigned."
    : "Verification tier: bundle unaltered (self-asserted). What was checked: the room recorded this work and made it public. Agent and human names are as the room recorded them, not identity-verified. Hashes are stored values, not re-verified. This record is unsigned.";
  return `${head({
    title: receipt.title,
    description,
    path: `/receipts/${receipt.id}`,
    jsonLd: jsonLdScriptTag(receiptJsonLd(receipt, { description: provenNote })),
    ogImage: `${ROOM_ORIGIN}/receipts/${receipt.id}/og.png`,
    ogAlt: verdictLine,
  })}
<body><header><p><a href="/">Project Room</a> · <a href="/receipts">Public receipts</a></p></header>
<main>
<h1>${escapeHtml(receipt.title)}</h1>
${renderVerificationBlock(receipt, verification)}
<dl class="detail">
${room}
<div><dt>Agents</dt><dd>${names(receipt.agents ?? [])}</dd></div>
<div><dt>Humans</dt><dd>${names(receipt.humans ?? [])}</dd></div>
${pr}${merged}${verificationTier}${hashes}${payout}${work}${lot}
<div><dt>Recorded</dt><dd><time datetime="${escapeHtml(receipt.at)}">${escapeHtml(receipt.at)}</time></dd></div>
</dl>
<p class="meta">${provenNote}</p>
${shareSection(receipt)}
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
  ...(receipt.verification ? { verification: receipt.verification } : {}),
  hashes: receipt.hashes,
  at: receipt.at,
  ...(receipt.state ? { state: receipt.state } : {}),
  ...(receipt.checksReported ? { checksReported: receipt.checksReported } : {}),
  ...(receipt.executedChecks ? { executedChecks: receipt.executedChecks } : {}),
  ...(receipt.review ? { review: receipt.review } : {}),
  ...(receipt.lot ? { lot: receipt.lot } : {}),
  // The work receipt's payout cross-reference (#3781): the read model
  // sets these two fields on a paid work receipt only; a receipt with
  // no journal lot row carries neither, and none is forged here.
  ...(receipt.lotId ? { lotId: receipt.lotId } : {}),
  ...(receipt.settlement ? { settlement: receipt.settlement } : {}),
  // The undecided wait (MONEY-LEGIBILITY P6): the read model sets this on
  // an undecided public-work receipt only; decided receipts carry none.
  ...(receipt.wait ? { wait: receipt.wait } : {}),
});

// The waiting-age line for an undecided public submission (P6), worded
// once so the queue card and the receipt's own page agree: the age comes
// from the read model's derived `wait` block, never recomputed here.
export const waitTextOf = wait => {
  if (!wait || !Number.isInteger(wait.days) || wait.days < 0) return null;
  const age = wait.days === 0 ? "submitted today" : wait.days === 1 ? "submitted 1 day ago" : `submitted ${wait.days} days ago`;
  return `${age} · awaiting decision`;
};

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
