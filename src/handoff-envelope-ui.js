// Typed handoff envelope renderer (RC-2026-09-19-072). The envelope API
// (server/work-handoff.mjs) stores every delegation as a journal receipt:
//   { envelopeId, roomId, status, fromAgent, toAgent, createdAt, updatedAt,
//     envelope, history }
// where envelope carries the seven sections (objective, inputs, authority,
// expectedOutput, acceptanceTest, termination, provenance) and history is
// the journal's proposed→accepted→completed (or terminal) trail. This
// module turns a receipt into room-client HTML: a lifecycle badge, the
// status trail, and every section. Pure functions only — no DOM, no fetch —
// so node:test covers the render output directly; app.js mounts the HTML
// in the work view and owns the fetch.

const esc = value => String(value ?? "").replace(/[&<>"']/g, ch =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

const STATUS_LABELS = Object.freeze({
  proposed: "Proposed", accepted: "Accepted", completed: "Completed",
  rejected: "Rejected", expired: "Expired", escalated: "Escalated", cancelled: "Cancelled",
});
const STATUS_TONES = Object.freeze({
  proposed: "warn", accepted: "info", completed: "done", rejected: "muted",
  expired: "muted", escalated: "alert", cancelled: "muted",
});
export const statusLabel = status => STATUS_LABELS[status] ?? (typeof status === "string" && status.length ? status : "Unknown");
export const statusTone = status => STATUS_TONES[status] ?? "muted";

// Lifecycle badge: the envelope's current journal status.
export function envelopeStatusBadge(status) {
  return `<span class="handoff-badge handoff-badge-${statusTone(status)}" data-handoff-status="${esc(status ?? "")}">${esc(statusLabel(status))}</span>`;
}

const INPUT_KIND_LABELS = Object.freeze({ work: "Work", message: "Message", file: "File", url: "Link", note: "Note" });
const OUTPUT_KIND_LABELS = Object.freeze({ text_result: "Text result", verification: "Verification", decision: "Decision", artifact: "Artifact", report: "Report" });
const CHECK_KIND_LABELS = Object.freeze({ work_completed: "Work completed", result_submitted: "Result submitted",
  verification_recorded: "Verification recorded", manual_review: "Manual review" });

const fmtWhen = value => {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : String(value ?? "");
};
// Every other externally-authored URL in this app goes through a scheme gate
// before it becomes an href (safeUrl in src/app.js). esc() is not that gate: it
// escapes HTML metacharacters, and "javascript:alert(1)" contains none of them.
// server/work-handoff.mjs does validate url inputs as https today, so this is
// not a live hole - it is the difference between two independent checks and
// one, for a field an agent authors and a person clicks.
const safeHref = value => {
  try { const url = new URL(String(value)); return url.protocol === "https:" ? esc(url.href) : "#"; }
  catch { return "#"; }
};
const section = (title, body) => body
  ? `<div class="handoff-section"><h5>${esc(title)}</h5>${body}</div>` : "";
const kvRow = (term, value) => value == null || value === ""
  ? "" : `<div><dt>${esc(term)}</dt><dd>${value}</dd></div>`;

function inputsHtml(inputs) {
  if (!Array.isArray(inputs) || !inputs.length) return "";
  return `<ul class="handoff-inputs">${inputs.map(input => {
    const kind = INPUT_KIND_LABELS[input?.kind] ?? esc(input?.kind ?? "input");
    const ref = input?.kind === "url"
      ? `<a class="source-link" href="${safeHref(input.ref)}" target="_blank" rel="noopener noreferrer">${esc(input.label ?? input.ref)}</a>`
      : esc(input.label ?? input.ref);
    const sha = input?.sha ? ` · <code>sha ${esc(input.sha.slice(0, 12))}</code>` : "";
    const detail = input?.detail ? `<p class="handoff-note">${esc(input.detail)}</p>` : "";
    return `<li><span class="handoff-chip">${kind}</span> ${ref}${sha}${detail}</li>`;
  }).join("")}</ul>`;
}

function authorityHtml(authority) {
  if (!authority || typeof authority !== "object") return "";
  const permissions = Array.isArray(authority.permissions) && authority.permissions.length
    ? authority.permissions.map(p => `<span class="handoff-chip">${esc(p)}</span>`).join(" ") : "None listed";
  const rooms = Array.isArray(authority.scope?.rooms) ? authority.scope.rooms : [];
  const workIds = Array.isArray(authority.scope?.workIds) ? authority.scope.workIds : [];
  return `<dl class="work-facts">${kvRow("Permissions", permissions)}`
    + `${kvRow("Rooms", rooms.map(esc).join(", "))}`
    + `${kvRow("Work items", workIds.map(esc).join(", "))}`
    + `${kvRow("Expires", esc(fmtWhen(authority.expiresAt)))}`
    + `${authority.note ? kvRow("Note", esc(authority.note)) : ""}</dl>`;
}

function expectedOutputHtml(expectedOutput) {
  if (!expectedOutput || typeof expectedOutput !== "object") return "";
  const kind = OUTPUT_KIND_LABELS[expectedOutput.kind] ?? esc(expectedOutput.kind ?? "");
  const schema = expectedOutput.schema ? `<p class="handoff-note">Schema: <code>${esc(expectedOutput.schema)}</code></p>` : "";
  return `<p><span class="handoff-chip">${kind}</span></p><p class="definition">${esc(expectedOutput.description ?? "")}</p>${schema}`;
}

function acceptanceTestHtml(acceptanceTest, checksPassed) {
  const checks = Array.isArray(acceptanceTest?.checks) ? acceptanceTest.checks : [];
  if (!checks.length) return "";
  const passed = new Set(Array.isArray(checksPassed) ? checksPassed : []);
  return `<ol class="handoff-checks">${checks.map(check => {
    const kind = CHECK_KIND_LABELS[check?.kind] ?? esc(check?.kind ?? "check");
    const target = check?.workId ? `work <code>${esc(check.workId)}</code>${check?.verdict ? ` · verdict ${esc(check.verdict)}` : ""}`
      : check?.reviewer ? `reviewer ${esc(check.reviewer)}`
      : check?.verdict ? `verdict ${esc(check.verdict)}` : "";
    const mark = passed.has(check?.kind) ? ` <span class="handoff-pass">passed</span>` : "";
    const description = check?.description ? `<p class="handoff-note">${esc(check.description)}</p>` : "";
    return `<li><span class="handoff-chip">${kind}</span>${target ? ` ${target}` : ""}${mark}${description}</li>`;
  }).join("")}</ol>`;
}

function terminationHtml(termination) {
  if (!termination || typeof termination !== "object") return "";
  const onExpiry = termination.onExpiry === "escalate"
    ? `Escalate${termination.escalateTo ? ` to ${esc(termination.escalateTo)}` : ""}`
    : termination.onExpiry === "release" ? "Release the work" : esc(termination.onExpiry ?? "");
  return `<dl class="work-facts">${kvRow("Expires", esc(fmtWhen(termination.expiresAt)))}`
    + `${kvRow("On expiry", onExpiry)}`
    + `${termination.maxRounds != null ? kvRow("Max rounds", esc(termination.maxRounds)) : ""}</dl>`;
}

function provenanceHtml(provenance) {
  if (!provenance || typeof provenance !== "object") return "";
  const chain = Array.isArray(provenance.chain) ? provenance.chain : [];
  return `<dl class="work-facts">${kvRow("Created by", esc(provenance.createdBy))}`
    + `${provenance.claimId ? kvRow("Claim", `<code>${esc(provenance.claimId)}</code>`) : ""}`
    + `${provenance.taskId ? kvRow("Task", esc(provenance.taskId)) : ""}`
    + `${provenance.parentEnvelopeId ? kvRow("Parent", `<code>${esc(provenance.parentEnvelopeId)}</code>`) : ""}`
    + `${chain.length ? kvRow("Chain", chain.map(id => `<code>${esc(id)}</code>`).join(" → ")) : ""}</dl>`;
}

function lifecycleTrailHtml(receipt) {
  const history = Array.isArray(receipt?.history) ? receipt.history : [];
  // Supported lifecycles have at most three entries: proposal, optional
  // acceptance, and a terminal state. Keep the card compact.
  const recent = history.slice(-3);
  if (!recent.length) return "";
  return `<ol class="handoff-trail" aria-label="Envelope lifecycle">${recent.map(entry => {
    const note = entry?.note ? ` — ${esc(entry.note)}` : "";
    const by = entry?.by ? ` by ${esc(entry.by)}` : "";
    const reason = entry?.reason === "termination.expiresAt reached" ? "Handoff deadline reached" : entry?.reason;
    const why = reason ? ` — ${esc(reason)}` : "";
    const to = entry?.escalatedTo ? ` to ${esc(entry.escalatedTo)}` : "";
    return `<li><span class="handoff-badge handoff-badge-${statusTone(entry?.status)}">${esc(statusLabel(entry?.status))}</span>`
      + `<span class="handoff-trail-meta">${esc(fmtWhen(entry?.at))}${by}${to}${why}${note}</span></li>`;
  }).join("")}</ol>`;
}

// Full envelope card: badge + route line, the status trail, and all seven
// sections. Missing optional sections are skipped, never rendered empty.
export function handoffEnvelopeHtml(receipt) {
  const envelope = receipt?.envelope;
  if (!envelope || typeof envelope !== "object")
    return `<article class="handoff-envelope" data-handoff-envelope="${esc(receipt?.envelopeId ?? "")}">`
      + `<p class="form-hint">This handoff's details are unavailable.</p></article>`;
  const completedEntry = Array.isArray(receipt.history)
    ? [...receipt.history].reverse().find(entry => entry?.status === "completed") : null;
  const sections = [
    section("Objective", `<p class="definition">${esc(envelope.objective)}</p>`),
    section("Inputs", inputsHtml(envelope.inputs)),
    section("Authority", authorityHtml(envelope.authority)),
    section("Expected output", expectedOutputHtml(envelope.expectedOutput)),
    section("Acceptance test", acceptanceTestHtml(envelope.acceptanceTest, completedEntry?.checksPassed)),
    section("Termination", terminationHtml(envelope.termination)),
    section("Provenance", provenanceHtml(envelope.provenance)),
  ].join("");
  return `<article class="handoff-envelope" data-handoff-envelope="${esc(receipt.envelopeId)}">`
    + `<div class="handoff-envelope-header">${envelopeStatusBadge(receipt.status)}`
    + `<span class="handoff-route">${esc(receipt.fromAgent ?? envelope.from)} → ${esc(receipt.toAgent ?? envelope.to)}</span></div>`
    + `<h5 class="handoff-objective">${esc(envelope.objective)}</h5>`
    + lifecycleTrailHtml(receipt)
    + `<details class="handoff-details"><summary data-focus-key="handoff-details:${esc(receipt.envelopeId)}">Envelope sections</summary>${sections}</details>`
    + `</article>`;
}

// List wrapper: empty rooms render a hint, never a blank region.
export function handoffEnvelopeListHtml(receipts) {
  const list = Array.isArray(receipts) ? receipts : [];
  if (!list.length) return `<p class="form-hint">No handoffs reference this work yet.</p>`;
  return `<div class="handoff-envelope-list">${list.map(handoffEnvelopeHtml).join("")}</div>`;
}

// An envelope references a work item through a work input ref, an
// acceptance check's workId, or the authority scope's workIds.
export function envelopesForWork(receipts, workId) {
  if (!workId || !Array.isArray(receipts)) return [];
  return receipts.filter(receipt => {
    const envelope = receipt?.envelope;
    if (!envelope) return false;
    const inputRef = (envelope.inputs ?? []).some(input => input?.kind === "work" && input.ref === workId);
    const checkRef = (envelope.acceptanceTest?.checks ?? []).some(check => check?.workId === workId);
    const scopeRef = (envelope.authority?.scope?.workIds ?? []).includes(workId);
    return inputRef || checkRef || scopeRef;
  });
}
