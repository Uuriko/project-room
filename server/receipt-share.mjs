// Share layer for public receipts: the graded verdict line every share
// surface speaks, the pre-filled share text, JSON-LD that mirrors the
// visible page, the embeddable badge, and the OG-card fields.
//
// Consent boundary: nothing here widens publicity. Every consumer resolves
// the receipt through receipts-live (publicReceiptById / queryRoomProof), so
// the owner toggle and operator unpublish gate the share surfaces exactly
// like the page itself — a non-public receipt has no OG card, no badge, and
// no share block; the routes 404 before this module is asked to render.
//
// Honesty: the verdict is graded, never a bare checkmark (proof-ux research,
// 2026-10-15: a single "Verified" mark reads as a blanket quality verdict).
// Each level's label travels with its scope in the same string, because the
// share text is the whole experience for most readers.
import { ROOM_ORIGIN } from "./agent-discovery.mjs";
import { proofLevelOf } from "./public-read-model.mjs";

// The proof vocabulary. Single-sourced here; the proof page imports and
// re-exports it, and proofLevelOf (public-read-model.mjs) assigns the key.
export const PROOF_LEVELS = Object.freeze({
  "server-verified-merge": Object.freeze({
    label: "Server-verified merge",
    note: "The server recorded the merge of the linked pull request before this receipt was published. This is the strongest claim a receipt on this page makes.",
  }),
  "member-verified-completion": Object.freeze({
    label: "Member-verified completion",
    note: "A room member other than the worker reviewed this delivery and recorded approval before it was marked done. No server-verified merge backs this entry.",
  }),
  "self-attested-completion": Object.freeze({
    label: "Self-attested completion",
    note: "The worker recorded this work as done; no other member reviewed it. No server-verified merge backs this entry.",
  }),
  "room-recorded-completion": Object.freeze({
    label: "Room-recorded completion",
    note: "The room recorded this work item as completed and issued a receipt. No server-verified merge backs this entry.",
  }),
  "artifact-hash-recorded": Object.freeze({
    label: "Artifact hash recorded",
    note: "A public-work delivery whose artifact sha256 was recorded when it was submitted. The checks listed on its receipt are reported by the worker (verification: hash_only) — not an acceptance, and not a payment.",
  }),
  "room-recorded": Object.freeze({
    label: "Room-recorded",
    note: "The room recorded this work and made the record public.",
  }),
});

// The scope half of the verdict line, one breath after the label: what the
// level does and does not establish, in share-sized prose.
const LEVEL_SCOPE = Object.freeze({
  "server-verified-merge": "this server confirmed the linked pull request merged",
  "member-verified-completion": "a member other than the worker reviewed and approved it; no server-verified merge backs it",
  "self-attested-completion": "the worker recorded it done; no other member reviewed it",
  "room-recorded-completion": "the room recorded it done; no server-verified merge backs it",
  "artifact-hash-recorded": "delivery hash recorded at submission; checks are worker-reported, not an acceptance",
  "room-recorded": "the room recorded this work and made the record public",
});

const isLot = receipt => receipt?.source === "bounty-lot" && !!receipt?.lot;

// The graded label alone (badge segment, OG badge row). Lot receipts are
// not proofLevelOf's vocabulary: their record is a ledger movement plus a
// settlement verdict, so the label names exactly that.
export function proofLabelOf(receipt) {
  if (isLot(receipt)) return "Ledger-recorded movement";
  return PROOF_LEVELS[proofLevelOf(receipt)].label;
}

// Label + scope in one line — the unit every share surface quotes.
export function verdictLineOf(receipt) {
  if (isLot(receipt)) {
    const kind = receipt.lot.settlement?.kind;
    return kind
      ? `Ledger-recorded movement — settlement verdict “${kind}”, recorded in the room's credit ledger`
      : "Ledger-recorded movement — recorded in the room's credit ledger";
  }
  const level = proofLevelOf(receipt);
  return `${PROOF_LEVELS[level].label} — ${LEVEL_SCOPE[level]}`;
}

// What this record proves, no more. Moved verbatim from receipts-page so
// the page and the JSON-LD description state the same facts.
export function receiptProvenNote(receipt) {
  if (receipt.source === "bounty-lot")
    return "What this record proves: the room's credit ledger recorded this movement and the settlement verdict shown. Credits are the room's internal ledger units, not money. Account ids are as the ledger recorded them, not identity-verified. Hashes are stored values, not re-verified. This record is unsigned.";
  if (receipt.mergedAt && receipt.pullRequest)
    return "What this record proves: the server verified the merge against the linked pull request. Agent and human names are as the room recorded them, not identity-verified. Hashes are stored values, not re-verified. This record is unsigned.";
  return "What this record proves: the room recorded this work and made it public. Agent and human names are as the room recorded them, not identity-verified. Hashes are stored values, not re-verified. This record is unsigned.";
}

const cleanText = (value, limit) => {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

// The pre-filled share text. The verdict line rides in the same string so
// the grade and its scope survive forwarding; the page shows this exact
// text visibly, so nothing is shared that the page does not say.
export function shareTextOf(receipt) {
  return `Work, verified: ${cleanText(receipt.title, 110)} — ${verdictLineOf(receipt)}`;
}

export const receiptCanonical = receipt => `${ROOM_ORIGIN}/receipts/${receipt.id}`;

// JSON-LD for one receipt. Structured data only mirrors the visible page
// (distribution research R4): title, verdict, hashes, pull request, and
// the proven note as the description. No ratings or review markup — a
// receipt is a record, not a review. Names are omitted on purpose: the
// page qualifies them as room-recorded, not identity-verified, and this
// vocabulary has no honest way to carry that qualifier.
export function receiptJsonLd(receipt) {
  const property = (name, value) => ({ "@type": "PropertyValue", name, value });
  const additionalProperty = [property("Proof level", proofLabelOf(receipt))];
  if (receipt.pullRequest) additionalProperty.push(property("Pull request", receipt.pullRequest));
  for (const hash of receipt.hashes ?? []) {
    additionalProperty.push(property("Hash evidence (stored sha256, not re-verified)", hash));
  }
  if (isLot(receipt)) {
    const lot = receipt.lot;
    if (lot.kind) additionalProperty.push(property("Ledger movement", lot.kind));
    if (typeof lot.amountCredits === "number") additionalProperty.push(property("Amount (room credits, not money)", String(lot.amountCredits)));
    if (lot.settlement?.kind) additionalProperty.push(property("Settlement verdict", lot.settlement.kind));
  }
  return {
    "@context": "https://schema.org",
    "@type": "CreativeWork",
    name: cleanText(receipt.title, 200),
    url: receiptCanonical(receipt),
    identifier: receipt.id,
    ...(receipt.at ? { dateCreated: receipt.at } : {}),
    description: receiptProvenNote(receipt).replace(/^What this record proves: /, ""),
    ...(receipt.room?.title
      ? { isPartOf: { "@type": "Organization", name: receipt.room.title, url: `${ROOM_ORIGIN}/r/${receipt.room.id}` } }
      : {}),
    additionalProperty,
  };
}

// Serialize JSON-LD for inline embedding: `<` must never survive into the
// HTML stream, where a room-supplied title could close the script block.
export function jsonLdScriptTag(data) {
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
  return `<script type="application/ld+json">${json}</script>`;
}

const when = value => {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "";
};

// Fields for the runtime OG renderer (server/og-render.mjs): the work,
// the verdict on its own line, and the honesty footer — the card states
// the grade before the click, like the page does after it.
export function receiptOgFields(receipt) {
  return {
    title: receipt.title ?? "",
    subtitle: verdictLineOf(receipt),
    badges: [proofLabelOf(receipt), receipt.room?.title ?? "", when(receipt.at)].filter(Boolean),
    footer: "Project Room receipt · hashes are stored values, not re-verified",
  };
}
