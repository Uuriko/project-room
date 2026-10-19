// EXP-7 Variant B (rival hero, #3548): live facts for the /about front door.
// The static HTML carries a clearly labelled SAMPLE receipt (an example of
// the record every finished result gets), so the page is truthful with
// JavaScript off and on any deployment — including a fresh one with no
// receipts of its own. This script freshens the card from
// /api/public/front-door (computed per request from the public receipts
// and the public work board): with a real newest receipt it swaps the
// sample for that receipt; with none it swaps the card for the honest
// empty state. On any failure the labelled sample stays exactly as served.
(async () => {
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el && value != null && value !== "") el.textContent = String(value);
  };
  const hide = (id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  };
  const showEmptyState = () => {
    // No published receipts on this deployment: the sample must never be
    // presented as this deployment's record. Show the empty state instead.
    hide("fd-sample-badge");
    hide("fd-receipt-row");
    hide("fd-receipt-facts");
    hide("fd-card-note");
    hide("fd-receipt-cta");
    set("fd-card-title", "No receipts yet");
    const empty = document.getElementById("fd-empty");
    if (empty) empty.hidden = false;
  };
  try {
    const response = await fetch("/api/public/front-door", { headers: { accept: "application/json" } });
    if (!response.ok) return;
    const facts = await response.json();
    set("fd-verified", facts.counters?.resultsVerified);
    set("fd-receipts", facts.counters?.receiptsIssued);
    set("fd-work", facts.counters?.workAvailableNow);
    const receipt = facts.latestReceipt;
    if (!receipt?.id) { showEmptyState(); return; }
    const link = document.getElementById("fd-receipt-link");
    if (link) {
      link.href = `/receipts/${receipt.id}`;
      link.textContent = receipt.title ?? receipt.id;
    }
    const primary = document.getElementById("fd-receipt-cta");
    if (primary) {
      primary.href = `/receipts/${receipt.id}`;
      primary.textContent = "See a real receipt";
    }
    hide("fd-sample-badge");
    set("fd-who", [...(receipt.agents ?? []), ...(receipt.humans ?? [])].join(", "));
    const when = document.getElementById("fd-when");
    if (when && receipt.at) {
      when.textContent = String(receipt.at).slice(0, 10);
      when.dateTime = receipt.at;
    }
    // Same honesty ladder as the receipt page itself: only a receipt with a
    // server-verified merge may say so; anything else claims recording only.
    set("fd-proves", receipt.mergedAt && receipt.pullRequest
      ? "The server verified the merge against the linked pull request. Open the receipt for the checks, the evidence, and the full record."
      : "The room recorded this work and made it public. Open the receipt for the checks, the evidence, and the full record.");
    set("fd-card-note", "This card shows the newest verified published receipt, counted live.");
  } catch {
    // Static card stays — it is labelled a sample, so it stays honest.
  }
})();
