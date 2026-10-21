// Renders a result card (server/result-card.mjs) to an HTML string for the
// room UI and the needs-you list. Every field is escaped; buttons carry data
// attributes only, the page wires the clicks. Reject opens a reason field
// because a reject without a reason is refused by the server.
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch]);
const LABEL = { approve: "Approve", request_edits: "Request edits", reject: "Reject" };

export function renderResultCardHtml(card, { proposalId = "" } = {}) {
  const steps = card.steps.map(s => `<li class="rc-step rc-${esc(s.status)}">${esc(s.label)}${s.waitingOn ? ` <span class="rc-wait">waiting on ${esc(s.waitingOn)}</span>` : ""}</li>`).join("");
  const actions = card.actions.map(a => `<button type="button" class="rc-action" data-action="${esc(a)}" data-proposal="${esc(proposalId)}">${LABEL[a] ?? esc(a)}</button>`).join("");
  const reason = card.rejectRequiresReason
    ? `<label class="rc-reason" hidden>Why? <input name="reason" maxlength="1000" required></label>` : "";
  return `<article class="result-card rc-state-${esc(card.state)}">`
    + `<h3>${esc(card.title)}</h3>`
    + (card.summary ? `<p class="rc-summary">${esc(card.summary)}</p>` : "")
    + `<ol class="rc-steps">${steps}</ol>`
    + (card.sent ? `<p class="rc-sent">${esc(card.sent)}</p>` : "")
    + (actions ? `<div class="rc-actions">${actions}${reason}</div>` : "")
    + `</article>`;
}
