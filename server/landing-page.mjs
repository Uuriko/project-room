// Landing feed + server-side hero rendering (#3548, charter D5).
//
// One source for the front door's facts, used by both the JSON feed
// (GET /api/public/landing) and the server-rendered hero in the served
// index.html: the SSR/indexing contract requires the facts in the raw
// HTML as visible text, computed — never hand-typed. Receipt counts come
// from the visible public-receipt set (publicReceiptCounts); work
// available is the public board's own claimableCount; the featured
// receipt is the newest visible public receipt — live settled work from
// the read model, never a fixture or a mock.

import { publicReceiptCounts, queryPublicReceipts } from "./public-read-model.mjs";

const SOURCE_LABEL = {
  "work-claim": "Merged pull request · settled by the server",
  "public-work": "Public work · artifact hash on record",
  "work-item": "Completed work · receipt recorded",
};

export function landingReceiptMeta(receipt) {
  if (!receipt) return "";
  const people = [...(receipt.agents ?? []), ...(receipt.humans ?? [])].filter(Boolean);
  const parts = [];
  if (receipt.room?.title) parts.push(receipt.room.title);
  if (people.length) parts.push(people.join(", "));
  if (typeof receipt.at === "string" && receipt.at) parts.push(receipt.at.slice(0, 10));
  const label = SOURCE_LABEL[receipt.source];
  if (label) parts.push(label);
  return parts.join(" · ");
}

export function landingReceiptHash(receipt) {
  const hash = Array.isArray(receipt?.hashes)
    ? receipt.hashes.find(value => typeof value === "string" && value) : null;
  if (!hash) return null;
  return hash.startsWith("sha256:") ? hash : `sha256 ${hash}`;
}

export function buildLandingFeed(store) {
  const counts = publicReceiptCounts(store);
  let workAvailableNow = 0;
  try { workAvailableNow = store.publicWorkClaims.list({ limit: 100 }).claimableCount; }
  catch { workAvailableNow = 0; }
  const featured = queryPublicReceipts(store, { limit: 1 }).receipts[0] ?? null;
  return {
    counters: {
      resultsVerified: counts.resultsVerified,
      receiptsIssued: counts.receiptsIssued,
      workAvailableNow,
    },
    featuredReceipt: featured ? {
      id: featured.id,
      title: featured.title,
      source: featured.source,
      room: featured.room,
      agents: featured.agents,
      humans: featured.humans,
      pullRequest: featured.pullRequest,
      mergedAt: featured.mergedAt,
      hashes: featured.hashes,
      at: featured.at,
      meta: landingReceiptMeta(featured),
      hashLabel: landingReceiptHash(featured),
    } : null,
  };
}

const escapeHtml = value => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

// Fill the hero section of the served shell with the computed facts. The
// shell ships with the same slots empty (dash counters, hidden card), so
// a transform failure degrades to the client-filled page, never to wrong
// numbers: every replacement targets the exact empty-slot markup.
export function renderLandingHtml(html, feed) {
  let out = String(html);
  for (const [key, value] of Object.entries(feed.counters ?? {})) {
    if (!Number.isSafeInteger(value) || value < 0) continue;
    out = out.replace(`<strong data-landing-counter="${key}">–</strong>`,
      `<strong data-landing-counter="${key}">${value}</strong>`);
  }
  const receipt = feed.featuredReceipt;
  if (!receipt?.id) return out;
  const href = `/receipts/${encodeURIComponent(receipt.id)}`;
  out = out.replace('<a class="button primary" id="landing-receipt-cta" href="/receipts">',
    `<a class="button primary" id="landing-receipt-cta" href="${href}">`);
  out = out.replace('<article id="landing-receipt-card" class="landing-receipt-card" hidden>',
    '<article id="landing-receipt-card" class="landing-receipt-card">');
  out = out.replace('<a id="landing-receipt-link" href="/receipts">Receipt</a>',
    `<a id="landing-receipt-link" href="${href}">${escapeHtml(receipt.title || "Receipt")}</a>`);
  out = out.replace('<p id="landing-receipt-meta" class="form-hint"></p>',
    `<p id="landing-receipt-meta" class="form-hint">${escapeHtml(receipt.meta ?? "")}</p>`);
  if (receipt.hashLabel) {
    out = out.replace('<p id="landing-receipt-hash" class="landing-receipt-hash" hidden></p>',
      `<p id="landing-receipt-hash" class="landing-receipt-hash">${escapeHtml(receipt.hashLabel)}</p>`);
  }
  return out;
}
