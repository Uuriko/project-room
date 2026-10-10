// Work panel: one place that answers "what needs me, what is running, what
// finished". Presentation only. It reads the same selectors as the catch-up
// brief and the agent client (work-selectors.js, workflow.js) and never
// decides attention, permissions or state on its own. Every button routes to
// an existing form or record link; the service still validates each action.
import { contributionSteps, completedResults } from "./work-selectors.js";
import { nextWorkStep, presentedWorkActions, terminalWork } from "./workflow.js";

const OPEN_STATES = new Set(["proposed", "accepted", "working", "blocked", "completed"]);
const DAY_MS = 24 * 60 * 60 * 1000;
export const IN_PROGRESS_LIMIT = 12;
export const DONE_LIMIT = 5;

// Short labels for a narrow column. The long next-step text stays on the card
// in the conversation; here a person scans.
const STATUS = Object.freeze({
  triaged_handoff: "Handoff to review", accept: "Waiting to be accepted", start: "Ready to start",
  claim: "Needs write scope", in_progress: "Working", revise: "Blocked", unknown: "Needs a look",
  provide_evidence: "Needs a result", establish_provenance: "Producer unknown",
  resolve_independence: "Reviewer conflict", verify: "Waiting for review",
  decide: "Waiting for a decision", complete: "Done", superseded: "Replaced"
});
const BUTTON = Object.freeze({ verify: "Review", decide: "Decide", accept: "Accept", start: "Start", resolve: "Resolve", claim: "Set scope", complete: "Post result" });

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clip = (text, max) => { const s = String(text ?? "").replace(/\s+/g, " ").trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
const at = value => { const ms = Date.parse(value ?? ""); return Number.isFinite(ms) ? ms : 0; };

function person(state, memberId) {
  const member = memberId ? state.members?.[memberId] : null;
  if (!member) return memberId ? { id: memberId, name: "Unknown member", kind: "unknown" } : null;
  return { id: member.id, name: member.displayName || member.id, kind: member.kind === "agent" ? "agent" : "human" };
}

// Who a reader should see on the card: the producer once a result exists,
// otherwise the member accountable for the work.
function ownerOf(state, item) {
  const producer = item.receipt?.producerId;
  return person(state, producer && state.members?.[producer] ? producer : item.accountableMemberId);
}

function proofOf(state, item) {
  if (!item.receipt) return [];
  const proof = (item.receipt.checksClaimed ?? []).slice(0, 3).map(check => ({ kind: "check", text: clip(check, 48) }));
  const verification = item.verification;
  if (verification?.completionEventId === item.receipt.eventId && ["pass", "fail"].includes(verification.result)) {
    const who = person(state, verification.verifierId)?.name ?? "a reviewer";
    proof.push({ kind: verification.result === "pass" ? "pass" : "fail", text: `${verification.result === "pass" ? "Checked" : "Failed check"} by ${clip(who, 32)}` });
  }
  return proof;
}

function card(state, item, member, now) {
  const next = nextWorkStep(item, now, state.room?.ownerId ?? null);
  const primary = member ? presentedWorkActions(item, member, now).primary : null;
  const blocked = item.state === "blocked" && item.blocker?.nextAction ? clip(item.blocker.nextAction, 80) : null;
  return {
    id: item.id,
    title: clip(item.title || item.id, 120),
    owner: ownerOf(state, item),
    status: blocked ?? STATUS[next.action] ?? clip(next.label, 60),
    tone: next.action === "complete" ? "done" : next.action === "revise" ? "blocked" : next.action === "in_progress" ? "working" : "waiting",
    proof: proofOf(state, item),
    action: primary ? { action: primary.action, label: BUTTON[primary.action] ?? clip(primary.label, 24) } : null,
    updatedAt: item.updatedAt ?? null
  };
}

// Pure model: the same state always gives the same panel. Returns null when
// there is no signed-in, active member in this room.
export function workPanelModel(state, memberId, now = Date.now()) {
  const member = memberId ? state?.members?.[memberId] : null;
  if (!state?.workItems || !member || member.active === false) return null;
  const steps = contributionSteps(state, memberId, now);
  const needIds = new Set(steps.filter(step => step.kind === "work").map(step => step.id));
  const needsYou = steps.map(step => {
    if (step.kind !== "work") return { kind: "request", id: step.id, title: clip(step.title, 120), status: step.label, owner: null, proof: [], action: null };
    const item = state.workItems[step.id];
    const base = card(state, item, member, now);
    // contributionSteps already checked the permission; keep its action only.
    return { ...base, kind: "work", status: step.label, draftMessageId: step.draftCount > 1 ? null : step.draftMessageId ?? null,
      action: step.action ? { action: step.action, label: BUTTON[step.action] ?? "Open" } : null };
  });
  const inProgress = Object.values(state.workItems)
    .filter(item => item && !needIds.has(item.id) && !item.supersededBy && OPEN_STATES.has(item.state) && !terminalWork(item))
    .sort((a, b) => at(b.updatedAt) - at(a.updatedAt) || String(a.id).localeCompare(String(b.id)))
    .map(item => ({ ...card(state, item, member, now), kind: "work", action: null }));
  const done = completedResults(state)
    .filter(item => !needIds.has(item.id) && now - at(item.updatedAt) <= DAY_MS)
    .slice(0, DONE_LIMIT)
    .map(item => ({ ...card(state, item, member, now), kind: "work", action: null }));
  // Catch-up counts the whole list, not just the capped cards.
  const working = inProgress.filter(entry => entry.tone === "working");
  return {
    needsYou,
    working: { count: working.length, first: working[0]?.title ?? null, owners: [...new Set(working.map(entry => entry.owner?.name).filter(Boolean))] },
    inProgress: inProgress.slice(0, IN_PROGRESS_LIMIT),
    inProgressMore: Math.max(0, inProgress.length - IN_PROGRESS_LIMIT),
    done,
    counts: { needsYou: needsYou.length, inProgress: inProgress.length, done: done.length }
  };
}

function avatar(owner) {
  if (!owner) return "";
  const initial = esc((owner.name.trim()[0] ?? "?").toUpperCase());
  return `<span class="wp-avatar wp-${esc(owner.kind)}" aria-hidden="true">${initial}</span><span class="wp-owner">${esc(owner.name)}${owner.kind === "agent" ? ' <span class="wp-kind">agent</span>' : ""}</span>`;
}

function renderCard(entry, section) {
  const link = entry.kind === "request"
    ? `<a class="wp-link" href="#pr-record/message/${esc(encodeURIComponent(entry.id))}" data-open-message="${esc(entry.id)}">Show in chat</a>`
    : entry.draftMessageId
      ? `<a class="wp-link" href="#pr-record/message/${esc(encodeURIComponent(entry.draftMessageId))}" data-open-message="${esc(entry.draftMessageId)}">Show draft</a>`
      : `<a class="wp-link" href="#pr-record/work/${esc(encodeURIComponent(entry.id))}" data-open-work="${esc(entry.id)}">Show in chat</a>`;
  const button = entry.action
    ? `<button type="button" class="button primary wp-action" data-wp-action="${esc(entry.action.action)}" data-wp-work="${esc(entry.id)}">${esc(entry.action.label)}</button>` : "";
  const proof = entry.proof.length
    ? `<ul class="wp-proof">${entry.proof.map(p => `<li class="wp-proof-${esc(p.kind)}">${esc(p.text)}</li>`).join("")}</ul>` : "";
  return `<li class="wp-card wp-${section} wp-tone-${esc(entry.tone ?? "waiting")}" data-wp-id="${esc(entry.id)}">
    <p class="wp-title">${esc(entry.title)}</p>
    ${entry.owner ? `<p class="wp-meta">${avatar(entry.owner)}</p>` : ""}
    <p class="wp-status">${esc(entry.status)}</p>${proof}
    <div class="wp-actions">${button}${link}</div></li>`;
}

const SECTIONS = [
  ["needsYou", "Needs you", "Nothing is waiting on you."],
  ["inProgress", "In progress", "Nothing is running."],
  ["done", "Done today", "Nothing finished today."]
];

// Room-full phase 5: the catch-up in three plain lines, from the same model.
// Templates only; no model call, nothing inferred beyond the sections.
const names = list => [...new Set(list.map(entry => entry.owner?.name).filter(Boolean))];
const andMore = (n, noun = "more") => n > 0 ? ` and ${n} ${noun}` : "";
export function catchUpLines(model) {
  if (!model) return [];
  const lines = [];
  const [first, ...rest] = model.needsYou;
  if (first) lines.push({ kind: "needs", text: `Waiting on you: ${first.title}${andMore(rest.length)}.` });
  // Work state as reported by its owner, not a live observation (that is the
  // presence strip's job), so the line says "In progress", not "Running".
  const working = model.working ?? { count: 0, owners: [] };
  if (working.count) {
    const who = working.owners;
    lines.push({ kind: "running", text: `In progress: ${working.count === 1 ? working.first : `${working.count} pieces of work`}${who.length ? ` (${who.slice(0, 3).join(", ")}${who.length > 3 ? ", …" : ""})` : ""}.` });
  }
  if (model.done.length) {
    const [latest, ...older] = model.done;
    lines.push({ kind: "done", text: `Finished today: ${latest.title}${latest.owner ? ` by ${latest.owner.name}` : ""}${andMore(older.length)}.` });
  }
  return lines;
}

export function renderCatchUp(model) {
  const lines = catchUpLines(model);
  if (!lines.length) return "";
  return `<section class="wp-catchup" aria-label="Catch up"><ul>${lines.map(line => `<li class="wp-catchup-${line.kind}">${esc(line.text)}</li>`).join("")}</ul></section>`;
}

export function renderWorkPanel(model) {
  if (!model) return "";
  return renderCatchUp(model) + SECTIONS.map(([key, label, empty]) => {
    const list = model[key];
    const more = key === "inProgress" && model.inProgressMore ? `<p class="wp-more">${model.inProgressMore} more in the room</p>` : "";
    return `<section class="wp-section" aria-label="${esc(label)}"><h3 class="wp-heading">${esc(label)} <span class="wp-count">${model.counts[key]}</span></h3>
      ${list.length ? `<ol class="wp-list">${list.map(entry => renderCard(entry, key)).join("")}</ol>${more}` : `<p class="wp-empty">${esc(empty)}</p>`}</section>`;
  }).join("");
}

export function workPanelSummary(model) {
  if (!model) return "";
  const parts = [];
  if (model.counts.needsYou) parts.push(`${model.counts.needsYou} need${model.counts.needsYou === 1 ? "s" : ""} you`);
  if (model.counts.inProgress) parts.push(`${model.counts.inProgress} in progress`);
  return parts.join(" · ") || "All clear";
}

// DOM controller. The panel is a column on wide screens and a drawer on
// narrow ones; the Work button in the room header opens and closes it.
// Preference is per browser only and never required for correctness.
export function createWorkPanel({ panel, body, summary, toggle, count, shell, onAction, storage = globalThis.localStorage }) {
  const KEY = "pr.workPanel.open";
  let lastModel = null;
  const read = () => { try { return storage?.getItem(KEY); } catch { return null; } };
  const write = value => { try { storage?.setItem(KEY, value); } catch { /* optional */ } };
  const wide = () => typeof matchMedia === "function" && matchMedia("(min-width: 1200px)").matches;
  let open = read() === null ? null : read() === "1";
  function isOpen() { return open ?? (wide() && Boolean(lastModel && (lastModel.counts.needsYou || lastModel.counts.inProgress))); }
  function apply() {
    const visible = Boolean(lastModel) && isOpen();
    panel.hidden = !visible;
    shell?.classList.toggle("has-work-panel", visible);
    toggle.hidden = !lastModel;
    toggle.setAttribute("aria-expanded", String(visible));
  }
  function setOpen(value, { focus = false } = {}) {
    open = value; write(value ? "1" : "0"); apply();
    if (focus) (value ? panel.querySelector("#work-panel-title") ?? panel : toggle).focus?.({ preventScroll: true });
  }
  toggle.addEventListener("click", () => setOpen(!isOpen(), { focus: true }));
  panel.querySelector("[data-wp-close]")?.addEventListener("click", () => setOpen(false, { focus: true }));
  panel.addEventListener("keydown", event => { if (event.key === "Escape" && !wide()) setOpen(false, { focus: true }); });
  body.addEventListener("click", event => {
    const button = event.target.closest("[data-wp-action]");
    if (button) { onAction?.(button.dataset.wpWork, button.dataset.wpAction); return; }
    if (!wide() && event.target.closest("[data-open-work], [data-open-message]")) setOpen(false);
  });
  return {
    render(model) {
      lastModel = model;
      const html = model ? renderWorkPanel(model) : "";
      // Unchanged panel: leave the DOM alone so focus and hover stay put.
      if (html !== body._html) {
        // Changed panel: remember which control had focus and put it back on
        // the same record's control after the redraw.
        const active = body.contains(document.activeElement) ? document.activeElement : null;
        const key = active?.matches?.("[data-wp-action]") ? `[data-wp-action="${active.dataset.wpAction}"][data-wp-work="${CSS.escape(active.dataset.wpWork)}"]`
          : active?.matches?.("[data-open-work]") ? `[data-open-work="${CSS.escape(active.dataset.openWork)}"]`
          : active?.matches?.("[data-open-message]") ? `[data-open-message="${CSS.escape(active.dataset.openMessage)}"]` : null;
        body.innerHTML = html; body._html = html;
        if (active) (key && body.querySelector(key) || panel.querySelector("#work-panel-title"))?.focus?.({ preventScroll: true });
      }
      summary.textContent = model ? workPanelSummary(model) : "";
      count.textContent = model?.counts.needsYou ? String(model.counts.needsYou) : "";
      count.hidden = !model?.counts.needsYou;
      apply();
    },
    isOpen,
    setOpen
  };
}
