// Public proof page: one room's published results, presented as proof.
// Script-free HTML plus a JSON document twin, in the receipts family.
//
//   GET /r/<slug>/proof        GET /r/<slug>/proof.json
//
// The page exists only for a room that is publicly listed AND whose owner
// turned public receipts on (public_rooms.receipts_enabled). It lists the
// room's public receipts — the same rows /receipts serves, read through
// receipts-live so the owner toggle and operator unpublish apply — and
// labels each entry with what its record actually proves (proofLevelOf in
// the read model), never more. Every entry links to its own receipt page,
// so a claim on this page is one click from the record behind it.
//
// Honesty contract (docs/RECEIPTS-PAGE.md): names are as the room recorded
// them, not identity-verified; hashes are stored values, not re-verified at
// read time; these records are unsigned. Credit movements are NOT claimed
// here: bounty lots are proved by signed lot receipts on their own public
// pages (/receipts/<lotId>), so this page makes no payment claim at all.
import { DARK_DECLARATIONS, LIGHT_DECLARATIONS } from "../src/design-tokens.js";
import { ROOM_ORIGIN } from "./agent-discovery.mjs";
import { CONTENT_TRUST } from "./content-trust.mjs";
import { LEGAL_FOOTER_LINKS, reportHref } from "./legal-pages.mjs";
import { escapeHtml } from "./receipts-page.mjs";
import { loadPublicRoom, proofLevelOf } from "./public-read-model.mjs";
import { queryRoomProof } from "./receipts-live.mjs";
import { PROOF_LEVELS, jsonLdScriptTag } from "./receipt-share.mjs";

export { PROOF_LEVELS };

const OG_IMAGE = `${ROOM_ORIGIN}/og/receipts.png`;
export const PROOF_PAGE_SIZE = 20;


export const PROOF_HONESTY = Object.freeze([
  "Names are as the room recorded them — member display names, or a self-supplied name on public-work receipts — not identity-verified.",
  "Hashes are stored sha256 values, not re-verified when this page is read.",
  "These records are unsigned. A receipt proves the room stored this record and the owner chose to publish it — nothing beyond the level named on each entry.",
  "No payment is proved on this page. Bounty credit movements are proved by signed lot receipts, each served on its own public page once its bounty settles, unless the room owner has turned public receipts off.",
  "Only receipts the room owner chose to publish appear here. Turning public receipts off removes this page's entries; private work is never listed.",
]);

const pageStyle = () => `:root{color-scheme:dark;${DARK_DECLARATIONS}}[data-theme="light"]{color-scheme:light;${LIGHT_DECLARATIONS}}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.55 var(--font-sans)}
main{max-width:42rem;margin:0 auto;padding:2rem 1.25rem 3rem}
h1{font-size:clamp(1.6rem,5vw,2.2rem);line-height:1.15;letter-spacing:-.03em}
a{color:var(--blue)}
.card{border-top:1px solid var(--line);padding:1rem 0;overflow-wrap:anywhere;word-break:break-word;max-width:100%}
.meta{color:var(--muted);font-size:.9rem}
.level{color:var(--text);font-weight:600}
footer{margin-top:2rem;border-top:1px solid var(--line);padding-top:1rem;color:var(--muted)}
img,svg,table{max-width:100%}
@media(pointer:coarse){a{display:inline-flex;align-items:center;min-height:var(--control-min-target-coarse)}}`;

function head({ title, description, path, jsonLd = "", ogImage = OG_IMAGE, ogAlt = "" }) {
  const canonical = `${ROOM_ORIGIN}${path}`;
  const ogImageAlt = ogAlt ? `
<meta property="og:image:alt" content="${escapeHtml(ogAlt)}">
<meta name="twitter:image:alt" content="${escapeHtml(ogAlt)}">` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="content-trust" content="${escapeHtml(CONTENT_TRUST)}">
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

const names = list => (list?.length ? list.map(escapeHtml).join(", ") : "");

const when = value => {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "";
};

function proofEntry(receipt) {
  const level = proofLevelOf(receipt);
  return {
    id: receipt.id,
    title: receipt.title,
    source: receipt.source,
    proofLevel: level,
    proofLabel: PROOF_LEVELS[level].label,
    receiptHref: `/receipts/${receipt.id}`,
    pullRequest: receipt.pullRequest ?? null,
    mergedAt: receipt.mergedAt ?? null,
    agents: receipt.agents ?? [],
    humans: receipt.humans ?? [],
    hashes: receipt.hashes ?? [],
    at: receipt.at,
  };
}

export function roomProofView(store, slug, { cursor = null } = {}) {
  const room = loadPublicRoom(store, slug);
  if (!room || room.receiptsEnabled !== true) return null;
  const visible = queryRoomProof(store, slug);
  const counts = {
    total: visible.length,
    serverVerifiedMerges: 0,
    roomRecordedCompletions: 0,
    artifactHashRecorded: 0,
  };
  for (const receipt of visible) {
    const level = proofLevelOf(receipt);
    if (level === "server-verified-merge") counts.serverVerifiedMerges += 1;
    else if (level === "room-recorded-completion") counts.roomRecordedCompletions += 1;
    else if (level === "artifact-hash-recorded") counts.artifactHashRecorded += 1;
  }
  let start = 0;
  if (cursor != null) {
    if (typeof cursor !== "string" || !cursor) {
      return { error: { status: 422, code: "invalid_proof_query", message: "cursor is not a receipt from this page" } };
    }
    const index = visible.findIndex(receipt => receipt.id === cursor);
    if (index < 0) {
      return { error: { status: 422, code: "invalid_proof_query", message: "cursor is not a receipt from this page" } };
    }
    start = index + 1;
  }
  const pageRows = visible.slice(start, start + PROOF_PAGE_SIZE);
  const entries = pageRows.map(proofEntry);
  const nextCursor = start + PROOF_PAGE_SIZE < visible.length ? pageRows.at(-1)?.id ?? null : null;
  const document = {
    schema: "project-room-public-room-proof/1",
    contentTrust: CONTENT_TRUST,
    untrusted: true,
    slug,
    title: room.title,
    counts,
    entries,
    nextCursor,
    honesty: [...PROOF_HONESTY],
  };
  const description = `Proof of work from ${room.title} on Project Room: ${counts.total} published ${counts.total === 1 ? "result" : "results"}, each traceable to its receipt.`;
  const countLine = counts.total
    ? `<p class="meta">${counts.total} published ${counts.total === 1 ? "result" : "results"} · ${counts.serverVerifiedMerges} server-verified ${counts.serverVerifiedMerges === 1 ? "merge" : "merges"} · ${counts.roomRecordedCompletions} room-recorded ${counts.roomRecordedCompletions === 1 ? "completion" : "completions"} · ${counts.artifactHashRecorded} artifact-hash ${counts.artifactHashRecorded === 1 ? "record" : "records"}</p>`
    : "";
  const items = entries.map(entry => {
    const people = [
      names(entry.agents) ? `Agents: ${names(entry.agents)}` : "",
      names(entry.humans) ? `Humans: ${names(entry.humans)}` : "",
    ].filter(Boolean).join(" · ");
    const pr = entry.pullRequest ? ` · <a href="${escapeHtml(entry.pullRequest)}">Pull request</a>` : "";
    return `<article class="card">
<h2><a href="${escapeHtml(entry.receiptHref)}">${escapeHtml(entry.title)}</a></h2>
<p class="meta"><span class="level">${escapeHtml(entry.proofLabel)}</span> · ${escapeHtml(when(entry.at))}${people ? ` · ${people}` : ""}${pr}</p>
<p class="meta">${escapeHtml(PROOF_LEVELS[entry.proofLevel].note)}</p>
</article>`;
  }).join("") || `<p>No published results yet. A result appears here when work is settled in this room and the owner has public receipts on — each one as a receipt anyone can open.</p>`;
  const next = nextCursor ? `<p><a href="/r/${escapeHtml(slug)}/proof?cursor=${escapeHtml(nextCursor)}">Older results</a></p>` : "";
  const honesty = PROOF_HONESTY.map(line => `<li>${escapeHtml(line)}</li>`).join("");
  // Structured data mirrors this page's visible entries — same titles,
  // same level labels, same level notes — so a machine quoting the page
  // quotes what a reader sees (distribution research R4).
  const jsonLd = jsonLdScriptTag({
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${room.title} — proof of work`,
    url: `${ROOM_ORIGIN}/r/${slug}/proof`,
    description,
    mainEntity: {
      "@type": "ItemList",
      itemListElement: entries.map((entry, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: entry.title,
        url: `${ROOM_ORIGIN}${entry.receiptHref}`,
        description: `${entry.proofLabel} — ${PROOF_LEVELS[entry.proofLevel].note}`,
      })),
    },
  });
  const html = `${head({
    title: `${room.title} — proof of work`,
    description,
    path: `/r/${slug}/proof`,
    jsonLd,
  })}
<body><header><p><a href="/">Project Room</a> · <a href="/r/${escapeHtml(slug)}">${escapeHtml(room.title)}</a> · <a href="/receipts">Public receipts</a></p></header>
<main>
<h1>${escapeHtml(room.title)} — proof of work</h1>
<p>Finished work from this room that the owner chose to publish. Every entry names the level of proof its record carries and links to the receipt behind it — open the receipt to check the record itself.</p>
${countLine}
${items}
${next}
<h2>What this page proves — and what it does not</h2>
<ul>${honesty}</ul>
<p><a href="${escapeHtml(reportHref("room", slug))}">Report</a></p>
</main>
<footer><a href="https://room.trydemigod.com/?start=room">Made in Project Room — start your own room</a><p>${LEGAL_FOOTER_LINKS}</p></footer>
</body></html>`;
  return { html, document };
}
