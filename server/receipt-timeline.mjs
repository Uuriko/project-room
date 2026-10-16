// Replay timelines for public receipts: the ordered public events behind
// one receipt — posted, submitted, merged, verified, settled — derived
// only from what the static public views already serve (the proof-page
// entry and the receipt detail record), plus, for a public-work receipt,
// the creation time of its public task, read from the public board's own
// tables (public_work_tasks / public_work_receipts). No member-side
// record is read: no room state, no claim history, no member ids. Actor
// names are exactly the display names and ledger accounts the static
// views already print, and lot receipts keep their exclusion from the
// proof page — a lot's timeline lives on its own receipt record, the one
// place the lot is public at all.
//
// Check state composes with the receipts-trust verifier
// (project-room-receipt-verification/1; verifyPublicReceipt, exported
// through receipts-live on its branch): each stop names the verifier
// check ids that speak to it (checkIds), and when a verdict is supplied,
// the matching statuses ride along as checks. This module runs no check
// itself — it renders the same events the verifier checks, nothing more.
import { escapeHtml } from "./receipts-page.mjs";

export const TIMELINE_CSS = `.replay{list-style:none;margin:.75rem 0 0;padding:0;border-top:1px dashed var(--line)}
.replay .stop{padding:.6rem 0;border-bottom:1px dashed var(--line)}
.replay .stop:target{outline:2px solid var(--blue);outline-offset:3px;border-radius:4px}
.replay .stop-head{margin:0}
.replay .stop p{margin:.15rem 0}`;

const TYPE_LABELS = Object.freeze({
  posted: "Posted", claimed: "Claimed", woken: "Woken", submitted: "Submitted",
  challenged: "Challenged", verified: "Verified", settled: "Settled",
  merged: "Merged", recorded: "Receipt recorded",
});
export const timelineLabel = type => TYPE_LABELS[type] ?? String(type).replace(/[-_]/g, " ").replace(/^./, c => c.toUpperCase());

const accountRole = (lot, account) =>
  account === lot.worker ? "worker" : account === lot.poster ? "poster" : account === "pool" ? "pool" : "ledger";

function pushLot(events, receipt) {
  const lot = receipt.lot;
  if (lot.bountyCreatedAt) {
    events.push({ type: "posted", at: lot.bountyCreatedAt,
      actor: lot.poster ? { role: "poster", name: lot.poster } : null, detail: null, checkIds: ["journal"] });
  }
  const settlement = lot.settlement;
  if (settlement && (settlement.settledAt || settlement.kind)) {
    events.push({ type: "verified", at: settlement.settledAt ?? null,
      actor: settlement.settledBy?.id
        ? { role: settlement.settledBy.kind ?? "verifier", name: settlement.settledBy.id }
        : lot.verifier ? { role: "verifier", name: lot.verifier } : null,
      detail: { settlement: settlement.kind ?? null, ...(settlement.reason ? { reason: settlement.reason } : {}) },
      checkIds: ["journal"] });
  }
  (lot.movements ?? []).forEach((movement, index) => {
    events.push({
      type: movement.kind === "payout" || movement.kind === "refund" ? "settled" : movement.kind,
      // The public record timestamps the lot (receipt.at is its first
      // entry); later legs carry their journal order, not invented times.
      at: index === 0 ? receipt.at : null,
      actor: { role: accountRole(lot, movement.account), name: movement.account },
      detail: { kind: movement.kind, account: movement.account, lotState: movement.lotState, amountMillis: movement.amountMillis },
      checkIds: ["journal"],
    });
  });
}

// The ordered public event list for one public receipt. `postedAt` is the
// public-work task creation time (publicWorkPostedAt); `verification` is
// an optional receipts-trust verdict whose check statuses attach to the
// stops those checks speak to.
export function timelineForReceipt(receipt, { postedAt = null, verification = null } = {}) {
  if (!receipt || typeof receipt.id !== "string") return [];
  const events = [];
  const agent = receipt.agents?.[0] ? { role: "agent", name: receipt.agents[0] } : null;
  const human = receipt.humans?.[0] ? { role: "human", name: receipt.humans[0] } : null;
  if (receipt.lot) pushLot(events, receipt);
  else if (receipt.source === "public-work") {
    if (postedAt) events.push({ type: "posted", at: postedAt, actor: { role: "room", name: null }, detail: null, checkIds: [] });
    events.push({ type: "submitted", at: receipt.at, actor: agent,
      detail: receipt.hashes?.[0] ? { artifactHash: receipt.hashes[0] } : null, checkIds: ["artifact", "source-record"] });
  } else if (receipt.source === "work-claim" && receipt.mergedAt) {
    events.push({ type: "merged", at: receipt.mergedAt, actor: agent,
      detail: receipt.pullRequest ? { pullRequest: receipt.pullRequest } : null, checkIds: ["pull-request", "source-record"] });
    events.push({ type: "recorded", at: receipt.at, actor: null, detail: null, checkIds: ["source-record"] });
  } else {
    events.push({ type: "recorded", at: receipt.at, actor: agent ?? human, detail: null, checkIds: ["source-record"] });
  }
  const stepped = events.map((event, index) => ({ step: index + 1, ...event }));
  if (!verification || !Array.isArray(verification.checks)) return stepped;
  const status = new Map(verification.checks.filter(check => check && typeof check.id === "string").map(check => [check.id, check.status]));
  return stepped.map(event => ({
    ...event,
    checks: event.checkIds.filter(id => status.has(id)).map(id => ({ id, status: status.get(id) })),
  }));
}

// A public-work receipt's posted time: when its task entered the public
// board. Null when the store has no public-work tables or no such task.
export function publicWorkPostedAt(store, receiptId) {
  try {
    const row = store.db.prepare(`SELECT pwt.created_at AS createdAt FROM public_work_receipts pwr
      JOIN public_work_tasks pwt ON pwt.offer_id = pwr.offer_id WHERE pwr.receipt_id=?`).get(receiptId);
    return row && Number.isFinite(row.createdAt) ? new Date(row.createdAt).toISOString() : null;
  } catch { return null; }
}

function detailHtml(event) {
  const detail = event.detail;
  if (!detail) return "";
  if (detail.pullRequest) return `<p class="meta">Pull request: <a href="${escapeHtml(detail.pullRequest)}">${escapeHtml(detail.pullRequest)}</a></p>`;
  if (detail.artifactHash) return `<p class="meta">Artifact: <code>${escapeHtml(detail.artifactHash)}</code></p>`;
  if (detail.kind) return `<p class="meta">${escapeHtml(detail.kind)} · ${escapeHtml(detail.account)} · ${escapeHtml(detail.lotState)} · ${escapeHtml(detail.amountMillis)} milli-credits</p>`;
  if (detail.settlement) return `<p class="meta">Verdict: ${escapeHtml(detail.settlement)}${detail.reason ? ` — ${escapeHtml(detail.reason)}` : ""}</p>`;
  return "";
}

// The scrubber: a fragment-addressed step list. These pages are
// script-free by family policy, so stepping is link navigation — every
// stop is a deep link (#t-<receiptId>-<step>), :target highlights the
// chosen stop, and prev/next links walk the chain. The static verdict
// above the list needs none of it.
export function renderTimelineHtml(events, receiptId) {
  if (!Array.isArray(events) || !events.length) return "";
  const stops = events.map((event, index) => {
    const id = `t-${receiptId}-${index}`;
    const when = event.at
      ? `<time datetime="${escapeHtml(event.at)}">${escapeHtml(event.at)}</time>`
      : "time not in the public record";
    const actor = event.actor
      ? ` · ${escapeHtml(timelineLabel(event.actor.role))}${event.actor.name ? ` ${escapeHtml(event.actor.name)}` : ""}`
      : "";
    const checks = event.checks?.length
      ? `<p class="meta">Checks: ${event.checks.map(check => `${escapeHtml(check.id)}: ${escapeHtml(check.status)}`).join(" · ")}</p>`
      : "";
    const prev = index > 0 ? `<a href="#t-${receiptId}-${index - 1}">‹ Prev: ${escapeHtml(timelineLabel(events[index - 1].type))}</a>` : "";
    const next = index < events.length - 1 ? `<a href="#t-${receiptId}-${index + 1}">Next: ${escapeHtml(timelineLabel(events[index + 1].type))} ›</a>` : "";
    const nav = prev || next ? `<p class="meta">${prev}${prev && next ? " · " : ""}${next}</p>` : "";
    return `<li class="stop" id="${escapeHtml(id)}"><p class="stop-head"><a href="#${escapeHtml(id)}">${escapeHtml(timelineLabel(event.type))}</a> <span class="meta">Step ${index + 1} of ${events.length} · ${when}${actor}</span></p>${detailHtml(event)}${checks}${nav}</li>`;
  }).join("");
  return `<ol class="replay">${stops}</ol>`;
}
