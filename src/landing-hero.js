// Landing hero refresh (#3548): the front door's facts are server-rendered
// into the served page (server/landing-page.mjs), so this module is a
// refresh, not the source — it re-reads GET /api/public/landing after
// boot and re-fills the same slots, which also honors a receipt being
// unpublished between page serve and boot. Numbers are never hand-typed:
// if the feed fails, the server-rendered values simply stand.

import { uiText } from "./strings.js";

function fillCounters(root, counters) {
  if (!counters) return;
  for (const node of root.querySelectorAll("[data-landing-counter]")) {
    const value = counters[node.dataset.landingCounter];
    if (Number.isSafeInteger(value) && value >= 0) node.textContent = String(value);
  }
}

const SOURCE_LABEL = {
  "work-claim": uiText("landing.source.workClaim"),
  "public-work": uiText("landing.source.publicWork"),
  "work-item": uiText("landing.source.workItem"),
};

function composeMeta(receipt) {
  const people = [...(receipt.agents ?? []), ...(receipt.humans ?? [])].filter(Boolean);
  const parts = [];
  if (receipt.room?.title) parts.push(receipt.room.title);
  if (people.length) parts.push(people.join(", "));
  if (typeof receipt.at === "string" && receipt.at) parts.push(receipt.at.slice(0, 10));
  const label = SOURCE_LABEL[receipt.source];
  if (label) parts.push(label);
  return parts.join(" · ");
}

function fillReceipt(root, receipt) {
  const card = root.querySelector("#landing-receipt-card");
  const cta = root.querySelector("#landing-receipt-cta");
  if (!receipt?.id) {
    // The feed is fresher than the served page: a receipt unpublished in
    // between must disappear from both the card and the primary door.
    if (card) card.hidden = true;
    if (cta) cta.href = "/receipts";
    return;
  }
  const href = `/receipts/${encodeURIComponent(receipt.id)}`;
  if (cta) cta.href = href;
  if (!card) return;
  const link = card.querySelector("#landing-receipt-link");
  link.href = href;
  link.textContent = receipt.title || uiText("landing.receiptFallback");
  card.querySelector("#landing-receipt-meta").textContent =
    typeof receipt.meta === "string" ? receipt.meta : composeMeta(receipt);
  const hashNode = card.querySelector("#landing-receipt-hash");
  const hash = typeof receipt.hashLabel === "string" && receipt.hashLabel ? receipt.hashLabel
    : (Array.isArray(receipt.hashes) ? receipt.hashes.find(value => typeof value === "string" && value) : null);
  if (hash) {
    hashNode.textContent = hash.startsWith("sha256") ? hash : `sha256 ${hash}`;
    hashNode.hidden = false;
  } else {
    hashNode.hidden = true;
  }
  card.hidden = false;
}

export function mountLandingHero({ loadLanding } = {}) {
  const hero = document.querySelector("#landing-hero");
  if (!hero) return () => {};
  let disposed = false;
  const load = loadLanding ?? (async () => {
    const response = await fetch("/api/public/landing", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("landing_feed_failed");
    return response.json();
  });
  Promise.resolve()
    .then(load)
    .then(data => {
      if (disposed || !data) return;
      fillCounters(hero, data.counters);
      fillReceipt(hero, data.featuredReceipt);
    })
    .catch(() => { /* the server-rendered facts stand */ });
  return () => {
    disposed = true;
    hero.hidden = true;
  };
}
