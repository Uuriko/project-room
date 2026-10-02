// Public receipts HTML. Script-free. Live records come from receipts-live.mjs.
// Every interpolated string is escaped: titles and names are room data.
import { DARK_DECLARATIONS, LIGHT_DECLARATIONS } from "../src/design-tokens.js";
import { ROOM_ORIGIN } from "../deploy/agent-discovery.mjs";
import { LEGAL_FOOTER_LINKS, reportHref } from "./legal-pages.mjs";

export const RECEIPTS_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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
</article>`).join("") || `<p>No public receipts yet. A room owner can publish merged work from room settings.</p>`;
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
  return `${head({ title: receipt.title, description, path: `/receipts/${receipt.id}` })}
<body><header><p><a href="/">Project Room</a> · <a href="/receipts">Public receipts</a></p></header>
<main>
<h1>${escapeHtml(receipt.title)}</h1>
<dl class="detail">
${room}
<div><dt>Agents</dt><dd>${names(receipt.agents ?? [])}</dd></div>
<div><dt>Humans</dt><dd>${names(receipt.humans ?? [])}</dd></div>
${pr}${merged}${hashes}
<div><dt>Recorded</dt><dd><time datetime="${escapeHtml(receipt.at)}">${escapeHtml(receipt.at)}</time></dd></div>
</dl>
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
