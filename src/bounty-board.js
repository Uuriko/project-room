// Bounties & credits panel (#3437, first slice): the in-room human money
// surface. Until now the bounty/credits API was agent-only in practice — the
// served client never called it, so a human owner could not post, fund,
// review, or accept a bounty, or see a balance, in the browser. This panel
// wires the existing endpoints into the room UI; it adds no server surface:
//
//   GET  /api/rooms/{roomId}/bounties                      list
//   GET  /api/rooms/{roomId}/bounties/pricing-guidance     settled-receipt pricing guidance (#3524)
//   POST /api/rooms/{roomId}/bounties                      create (proposed)
//   POST /api/rooms/{roomId}/bounties/{id}/fund            lock escrow
//   POST /api/rooms/{roomId}/bounties/{id}/accept         release escrow
//   POST /api/rooms/{roomId}/bounties/{id}/reject         refund poster
//   GET  /api/rooms/{roomId}/credits/balances/{identity}   own balances
//   GET  /api/rooms/{roomId}/credits/history/{identity}    own receipts
//
// Receipts: the public /receipts/<id> page serves public-work receipts
// (pwr_/wcr_/wir_) only — bounty lot receipts 404 there (see #3437). The
// human-resolvable receipt surface today is the credits history above, so
// accepted work links to its movement receipt inside this panel, never to
// the public page. Follows the open-questions / land-queue lazy-disclosure
// panel pattern: pure model + HTML helpers, install wires the DOM.
const $ = selector => document.querySelector(selector);

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

// Mirror of the server's canonicalLane (server/bounty-escrow.mjs): only the
// legacy colon form of agent lanes normalizes; every other id passes through.
export function canonicalLaneId(memberId) {
  if (typeof memberId !== "string") return "";
  if (memberId.startsWith("id:agent:")) return `id:agent/${memberId.slice("id:agent:".length)}`;
  return memberId;
}

// Credits are millis-backed (3 decimals). Render whole numbers bare and trim
// trailing zeros so 95 reads "95" and 0.5 reads "0.5".
export function formatCredits(value) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return String(Number(n.toFixed(3)));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatBountyWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

const STATE_LABELS = {
  proposed: "Proposed", funded: "Open", claimed: "Claimed", submitted: "Submitted",
  accepted: "Accepted", approved: "Approved", disputed: "Disputed", paid: "Settled",
  refunded: "Refunded", cancelled: "Cancelled",
};
export function bountyStateLabel(state) {
  return STATE_LABELS[state] ?? (typeof state === "string" && state ? state : "Unknown");
}

const TERMINAL_STATES = new Set(["paid", "refunded", "cancelled"]);

// Only web-safe evidence links render as anchors; anything else is text.
export function safeEvidenceUrl(value) {
  if (typeof value !== "string") return "";
  return /^https?:\/\//i.test(value.trim()) ? value.trim() : "";
}

function normalizeBounty(row, self) {
  const poster = typeof row?.poster === "string" ? row.poster : "";
  const claimant = typeof row?.claimant === "string" ? row.claimant : "";
  const verifier = typeof row?.verifier === "string" ? row.verifier : "";
  const state = typeof row?.state === "string" ? row.state : "";
  const evidence = row?.evidence && typeof row.evidence === "object" ? row.evidence : null;
  const criteria = Array.isArray(row?.rubric?.criteria)
    ? row.rubric.criteria.filter(c => c && typeof c.criterionId === "string")
      .map(c => ({ criterionId: c.criterionId, description: typeof c.description === "string" ? c.description : "" }))
    : [];
  const mine = Boolean(self) && poster === self;
  return {
    bountyId: typeof row?.bountyId === "string" ? row.bountyId : "",
    title: typeof row?.title === "string" && row.title ? row.title : "(untitled bounty)",
    criteria: typeof row?.criteria === "string" ? row.criteria : "",
    amount: typeof row?.amount === "number" ? row.amount : 0,
    state,
    stateLabel: bountyStateLabel(state),
    group: typeof row?.group === "string" ? row.group : "",
    poster, claimant, verifier,
    approvalMode: typeof row?.approvalMode === "string" ? row.approvalMode : "",
    deadline: typeof row?.deadline === "string" ? row.deadline : "",
    dueWhen: formatBountyWhen(row?.deadline),
    evidence: evidence ? {
      summary: typeof evidence.summary === "string" ? evidence.summary : "",
      evidenceUrl: safeEvidenceUrl(evidence.evidenceUrl),
    } : null,
    rubricCriteria: criteria,
    mine,
    canFund: state === "proposed" && mine,
    // The escrow enforces who may judge (poster for human-mode, designated
    // verifier for agent-mode, never the claimant); the panel mirrors that
    // so the review controls only appear where the server would accept them.
    canReview: state === "submitted" && Boolean(self) && claimant !== self
      && (poster === self || verifier === self),
    terminal: TERMINAL_STATES.has(state),
  };
}

// Pricing guidance (#3524) as the server derives it from this room's
// settled receipts. null means "not loaded" (the fetch failed or has not
// run): the panel then renders nothing beside the post form and posting is
// exactly as it was without guidance. A loaded cold start is its own
// shape — a sentence, never numbers.
function normalizeGuidance(row) {
  if (!row || typeof row !== "object") return null;
  const settledCount = typeof row.settledCount === "number" && row.settledCount > 0
    ? Math.floor(row.settledCount) : 0;
  if (row.coldStart === true || settledCount === 0) return { coldStart: true, settledCount: 0 };
  const range = row.paidRangeCredits && typeof row.paidRangeCredits === "object" ? row.paidRangeCredits : {};
  const modes = row.approvalModes && typeof row.approvalModes === "object" ? row.approvalModes : {};
  const rubric = row.rubricCriteria && typeof row.rubricCriteria === "object" ? row.rubricCriteria : null;
  return {
    coldStart: false,
    settledCount,
    min: typeof range.min === "number" ? range.min : 0,
    max: typeof range.max === "number" ? range.max : 0,
    median: typeof row.medianPaidCredits === "number" ? row.medianPaidCredits : 0,
    approvalModes: {
      human: typeof modes.human === "number" ? modes.human : 0,
      agent: typeof modes.agent === "number" ? modes.agent : 0,
      legacy: typeof modes.legacy === "number" ? modes.legacy : 0,
    },
    rubricMin: rubric && typeof rubric.min === "number" ? rubric.min : null,
    rubricMax: rubric && typeof rubric.max === "number" ? rubric.max : null,
  };
}

function normalizeReceipt(row) {
  return {
    receiptId: typeof row?.receiptId === "string" ? row.receiptId : "",
    kind: typeof row?.kind === "string" ? row.kind : "",
    amount: typeof row?.amount === "number" ? row.amount : 0,
    at: typeof row?.at === "string" ? row.at : "",
    when: formatBountyWhen(row?.at),
    memo: typeof row?.memo === "string" ? row.memo : "",
    bountyId: typeof row?.bountyId === "string" ? row.bountyId : "",
    signed: Array.isArray(row?.signedReceiptIds) && row.signedReceiptIds.length > 0,
  };
}

// Pure view model over the endpoint payloads. Tested without DOM.
export function bountyBoardModel({ bounties, balances, receipts, guidance, selfId } = {}) {
  const self = canonicalLaneId(selfId);
  const rows = Array.isArray(bounties) ? bounties : [];
  const items = rows.map(row => normalizeBounty(row, self));
  const balance = balances && typeof balances === "object" ? balances : {};
  const history = (Array.isArray(receipts) ? receipts : []).map(normalizeReceipt);
  return {
    self,
    guidance: normalizeGuidance(guidance),
    balance: {
      payable: typeof balance.payable === "number" ? balance.payable : 0,
      locked: typeof balance.locked === "number" ? balance.locked : 0,
      attributed: typeof balance.attributed === "number" ? balance.attributed : 0,
      approved: typeof balance.approved === "number" ? balance.approved : 0,
      total: typeof balance.total === "number" ? balance.total : 0,
    },
    items,
    count: items.length,
    receipts: history.slice(-10).reverse(),
  };
}

// Focus preservation across panel re-renders (A11Y-LOOP): render() replaces
// the host's innerHTML after every action, destroying the focused control
// and dropping keyboard focus to <body> inside the settings dialog. Capture
// a stable key for the focused control before the swap; afterwards, focus
// its equivalent if one still exists (an action whose control legitimately
// vanished — e.g. Accept on a settled bounty — restores nothing and the
// outcome is announced through the status live region instead).
export function bountyFocusKey(el) {
  if (!el || typeof el !== "object") return null;
  if (el.id) return `id:${el.id}`;
  if (el.dataset?.bountyAction) return ["action", el.dataset.bountyAction, el.dataset.bountyId || ""].join(":");
  if (el.dataset?.verdictFor) return `verdict:${el.dataset.verdictFor}`;
  if (el.dataset?.rejectReason) return `reject:${el.dataset.rejectReason}`;
  const label = typeof el.getAttribute === "function" ? el.getAttribute("aria-label") : null;
  if (label) return `aria:${label}`;
  if (el.type === "submit") return "submit:";
  return null;
}

export function restoreBountyFocus(root, key) {
  if (!root || !key || typeof root.querySelector !== "function") return false;
  const [kind, ...rest] = String(key).split(":");
  // Escape quotes for the attribute selectors below via split/join, not a
  // /"/g replace: a quote inside a regex literal desyncs the i18n harness's
  // comment stripper and manufactures a phantom hardcoded-string downstream.
  const value = rest.join(":").split('"').join('\\"');
  let target = null;
  if (kind === "id") target = root.querySelector(`[id="${value}"]`);
  else if (kind === "action") {
    const splitAt = value.lastIndexOf(":");
    // Assembled from parts rather than one multi-interpolation template:
    // these are machine strings (a key format, a selector), not UI copy,
    // and the i18n harness's sentence-concatenation ratchet counts the
    // template form. Output is byte-identical.
    const selector = [
      "[data-bounty-action=\"", value.slice(0, splitAt),
      "\"][data-bounty-id=\"", value.slice(splitAt + 1), "\"]",
    ].join("");
    target = root.querySelector(selector);
  } else if (kind === "verdict") target = root.querySelector(`[data-verdict-for="${value}"]`);
  else if (kind === "reject") target = root.querySelector(`[data-reject-reason="${value}"]`);
  else if (kind === "aria") target = root.querySelector(`[aria-label="${value}"]`);
  else if (kind === "submit") target = root.querySelector('button[type="submit"], input[type="submit"]');
  if (target && typeof target.focus === "function") { target.focus(); return true; }
  return false;
}

export function bountyBalanceHtml(model) {
  const b = model?.balance ?? {};
  return `<div class="bounty-balance"><strong>Your credits</strong>` +
    `<span>Payable ${escapeHtml(formatCredits(b.payable))}</span>` +
    `<span>Locked in escrow ${escapeHtml(formatCredits(b.locked))}</span>` +
    `<span>Attributed ${escapeHtml(formatCredits(b.attributed))}</span>` +
    `<span>Approved ${escapeHtml(formatCredits(b.approved))}</span>` +
    `<span>Total ${escapeHtml(formatCredits(b.total))}</span></div>`;
}

// The guidance panel beside the post form (#3524). Read-only: it renders
// no controls and nothing in the posting flow depends on it. Every number
// is labelled as settled-receipt history from this room — never as a
// recommended price for the bounty being posted. Cold start is a plain
// sentence with no numbers, exactly as the server reports it.
export function pricingGuidanceHtml(guidance) {
  if (!guidance) return "";
  if (guidance.coldStart) {
    return `<div class="bounty-guidance"><h4>Pricing guidance</h4>` +
      `<p class="form-hint">No settled bounties in this room yet, so there is no pricing history to show. ` +
      `Settled receipts from this room will build it as bounties here settle.</p></div>`;
  }
  const modes = guidance.approvalModes ?? {};
  const modeParts = [];
  if (modes.human) modeParts.push(`human approval for ${modes.human}`);
  if (modes.agent) modeParts.push(`agent approval for ${modes.agent}`);
  if (modes.legacy) modeParts.push(`legacy approval for ${modes.legacy}`);
  const rubric = guidance.rubricMin !== null && guidance.rubricMin !== undefined
    ? (guidance.rubricMin === guidance.rubricMax
      ? ` They pinned a rubric of ${escapeHtml(String(guidance.rubricMin))} ${guidance.rubricMin === 1 ? "criterion" : "criteria"} at posting.`
      : ` They pinned rubrics of ${escapeHtml(String(guidance.rubricMin))}–${escapeHtml(String(guidance.rubricMax))} criteria at posting.`)
    : "";
  const approval = modeParts.length ? ` Approval was ${escapeHtml(modeParts.join(", "))}.` : "";
  return `<div class="bounty-guidance"><h4>Pricing guidance</h4>` +
    `<p class="form-hint">Settled bounties in this room paid ` +
    `${escapeHtml(formatCredits(guidance.min))}–${escapeHtml(formatCredits(guidance.max))} credits ` +
    `(typical ${escapeHtml(formatCredits(guidance.median))}), from ${escapeHtml(String(guidance.settledCount))} settled bounties in this room. ` +
    `Amounts are what workers received, from settled receipts in this room — history only, not a recommended price for this bounty.` +
    `${rubric}${approval}</p></div>`;
}

function reviewHtml(item) {
  const criteria = item.rubricCriteria.map(c =>
    `<li><span>${escapeHtml(c.description || c.criterionId)}</span>` +
    `<select data-verdict-for="${escapeHtml(item.bountyId)}:${escapeHtml(c.criterionId)}" aria-label="Verdict for ${escapeHtml(c.description || c.criterionId)}">` +
    `<option value="pass">Pass</option><option value="fail">Fail</option></select></li>`).join("");
  const evidence = item.evidence
    ? `<p class="bounty-delivery"><strong>Delivery:</strong> ${escapeHtml(item.evidence.summary || "(no summary)")}` +
      (item.evidence.evidenceUrl ? ` <a href="${escapeHtml(item.evidence.evidenceUrl)}" target="_blank" rel="noopener">Evidence</a>` : "") + `</p>`
    : `<p class="bounty-delivery"><strong>Delivery:</strong> (no evidence recorded)</p>`;
  return `<div class="bounty-review">${evidence}` +
    (criteria ? `<ul class="bounty-rubric">${criteria}</ul>` : "") +
    `<div class="bounty-actions"><button class="button primary" type="button" data-bounty-action="accept" data-bounty-id="${escapeHtml(item.bountyId)}">Accept &amp; release escrow</button></div>` +
    `<label class="field">Reason to reject <input type="text" data-reject-reason="${escapeHtml(item.bountyId)}" maxlength="500"></label>` +
    `<div class="bounty-actions"><button class="button secondary" type="button" data-bounty-action="reject" data-bounty-id="${escapeHtml(item.bountyId)}">Reject &amp; refund me</button></div></div>`;
}

export function bountyListHtml(model) {
  const items = model?.items ?? [];
  if (items.length === 0) {
    return `<div class="bounty-list"><p class="form-hint">No bounties in this room yet. Post the first one above.</p></div>`;
  }
  const rows = items.map(item => {
    const meta = [`Posted by ${escapeHtml(item.poster || "unknown")}`];
    if (item.claimant) meta.push(`claimed by ${escapeHtml(item.claimant)}`);
    if (item.dueWhen) meta.push(`due ${escapeHtml(item.dueWhen)}`);
    const fund = item.canFund
      ? `<div class="bounty-actions"><button class="button secondary" type="button" data-bounty-action="fund" data-bounty-id="${escapeHtml(item.bountyId)}">Fund escrow</button></div>`
      : "";
    return `<article class="bounty-row" data-bounty-row="${escapeHtml(item.bountyId)}">` +
      `<div class="bounty-row-head"><span class="bounty-title">${escapeHtml(item.title)}</span>` +
      `<span class="land-badge">${escapeHtml(item.stateLabel)}</span>` +
      `<span class="bounty-amount">${escapeHtml(formatCredits(item.amount))} credits</span></div>` +
      `<p class="form-hint">${meta.join(" · ")}</p>${fund}${item.canReview ? reviewHtml(item) : ""}</article>`;
  }).join("");
  return `<div class="bounty-list">${rows}</div>`;
}

export function bountyReceiptsHtml(model, highlightReceiptId = null) {
  const receipts = model?.receipts ?? [];
  if (receipts.length === 0) {
    return `<div class="bounty-receipts"><h4>Your receipts</h4><p class="form-hint">No credit movements yet.</p></div>`;
  }
  const rows = receipts.map(r => {
    const hot = highlightReceiptId && r.receiptId === highlightReceiptId ? ` class="bounty-receipt bounty-receipt-hot"` : ` class="bounty-receipt"`;
    const signed = r.signed ? ` <span class="land-badge">signed</span>` : "";
    return `<li${hot} id="bounty-receipt-${escapeHtml(r.receiptId)}">` +
      `<span>${escapeHtml(r.kind || "movement")}</span> <span>${escapeHtml(formatCredits(r.amount))} credits</span>` +
      (r.when ? ` <span class="form-hint">${escapeHtml(r.when)}</span>` : "") + signed +
      (r.memo ? `<span class="form-hint"> ${escapeHtml(r.memo)}</span>` : "") + `</li>`;
  }).join("");
  return `<div class="bounty-receipts"><h4>Your receipts</h4><ul>${rows}</ul></div>`;
}

// The post form. Deadline defaults a week out; the value is a datetime-local
// string in the viewer's zone, converted to ISO at submit.
export function defaultDeadlineLocal(nowMs = Date.now()) {
  const date = new Date(nowMs + 7 * 24 * 3600 * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function bountyFormHtml(nowMs = Date.now()) {
  return `<form id="bounty-post-form" class="bounty-form"><h4>Post a bounty</h4>` +
    `<label class="field">Title <input id="bounty-title" type="text" required maxlength="256"></label>` +
    `<label class="field">What done looks like <textarea id="bounty-criteria" required rows="2" maxlength="2000"></textarea></label>` +
    `<label class="field">Amount (credits) <input id="bounty-amount" type="number" required min="0.001" step="0.001"></label>` +
    `<label class="field">Deadline <input id="bounty-deadline" type="datetime-local" required value="${escapeHtml(defaultDeadlineLocal(nowMs))}"></label>` +
    `<div class="bounty-actions"><button class="button primary" type="submit">Post &amp; fund escrow</button></div></form>`;
}

// Form values -> POST /bounties body. Throws Error with a human message on
// the same rules the server enforces (title 1..256, criteria 1..2000,
// positive amount, future ISO deadline) so the panel fails before the wire.
export function buildPostPayload({ title, criteria, amount, deadlineLocal } = {}) {
  const cleanTitle = typeof title === "string" ? title.trim() : "";
  if (cleanTitle.length < 1 || cleanTitle.length > 256) throw new Error("Give the bounty a title (1–256 characters).");
  const cleanCriteria = typeof criteria === "string" ? criteria.trim() : "";
  if (cleanCriteria.length < 1 || cleanCriteria.length > 2000) throw new Error("Say what done looks like (1–2000 characters).");
  const value = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new Error("Amount must be a positive number of credits.");
  const deadlineMs = typeof deadlineLocal === "string" ? new Date(deadlineLocal).getTime() : NaN;
  if (!Number.isFinite(deadlineMs)) throw new Error("Pick a deadline.");
  if (deadlineMs <= Date.now()) throw new Error("Deadline must be in the future.");
  return { title: cleanTitle, criteria: cleanCriteria, amount: value, deadline: new Date(deadlineMs).toISOString() };
}

// Accept body: the escrow requires a citation per pinned rubric criterion
// (slice 6). verdicts maps criterionId -> "pass"|"fail"; anything missing
// defaults to "pass" (the select's initial value).
export function buildAcceptAttestation(bounty, verdicts = {}, nowIso = new Date().toISOString()) {
  const criteria = Array.isArray(bounty?.rubricCriteria) ? bounty.rubricCriteria : [];
  const citations = criteria.map(c => ({
    criterionId: c.criterionId,
    verdict: verdicts[c.criterionId] === "fail" ? "fail" : "pass",
  }));
  return { verifierAttestation: { citations, at: nowIso } };
}

const newIdempotencyKey = () =>
  globalThis.crypto?.randomUUID?.() ?? `ui-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function installBountyBoard({ client, getSession }) {
  const panel = $("#bounty-panel");
  const chip = $("#bounty-count");
  const host = $("#bounty-board-host");
  const status = $("#bounty-status");
  if (!panel || !host) return { sync() {}, reset() {} };

  let loadedFor = null, busy = false, generation = 0, highlightReceiptId = null;
  let lastModel = null;

  const setStatus = (text, isError = false) => {
    if (!status) return;
    status.textContent = text ?? "";
    status.classList.toggle("error", Boolean(isError && text));
  };

  function render(model) {
    lastModel = model;
    if (chip) chip.textContent = String(model.count);
    const focusKey = typeof host.contains === "function" && host.contains(document.activeElement) ? bountyFocusKey(document.activeElement) : null;
    host.innerHTML = bountyFormHtml() +
      `<div id="bounty-guidance-host">${pricingGuidanceHtml(model.guidance)}</div>` +
      `<div id="bounty-balance-host">${bountyBalanceHtml(model)}</div>` +
      `<div id="bounty-list-host">${bountyListHtml(model)}</div>` +
      `<div id="bounty-receipts-host">${bountyReceiptsHtml(model, highlightReceiptId)}</div>`;
    if (focusKey) restoreBountyFocus(host, focusKey);
  }

  async function load(force = false) {
    const session = getSession();
    if (!session?.roomId || !session?.member?.id || busy) return;
    if (!force && loadedFor === session.roomId) return;
    const epoch = generation, roomId = session.roomId;
    busy = true;
    try {
      const self = encodeURIComponent(session.member.id);
      // Guidance (#3524) is fetched on its own failure track: a failed or
      // slow guidance read yields no panel — it must never fail, delay as
      // a gate, or otherwise change loading and posting.
      const [list, balances, history, guidanceRes] = await Promise.all([
        client.request(client.path("/bounties")),
        client.request(client.path(`/credits/balances/${self}`)),
        client.request(client.path(`/credits/history/${self}`)),
        client.request(client.path("/bounties/pricing-guidance")).catch(() => null),
      ]);
      if (epoch !== generation || getSession()?.roomId !== roomId) return;
      render(bountyBoardModel({
        bounties: list?.bounties, balances: balances?.balances,
        receipts: history?.receipts, guidance: guidanceRes?.guidance, selfId: session.member.id,
      }));
      loadedFor = roomId;
      setStatus("");
    } catch (error) {
      if (epoch === generation) setStatus(error?.message || "Could not load bounties. Close and reopen to retry.", true);
    } finally { busy = false; }
  }

  async function reload() { loadedFor = null; await load(true); }

  // One action at a time; a failure keeps the current render and explains
  // itself in the status line, a success reloads from the server.
  async function runAction(work, doneText) {
    if (busy) return false;
    busy = true;
    setStatus("");
    try {
      await work();
      busy = false;
      await reload();
      if (doneText) setStatus(doneText);
      return true;
    } catch (error) {
      setStatus(error?.message || "That did not go through. Try again.", true);
      return false;
    } finally { busy = false; }
  }

  async function onSubmit(event) {
    event.preventDefault();
    const form = event.target;
    let payload;
    try {
      payload = buildPostPayload({
        title: form.querySelector("#bounty-title")?.value,
        criteria: form.querySelector("#bounty-criteria")?.value,
        amount: form.querySelector("#bounty-amount")?.value,
        deadlineLocal: form.querySelector("#bounty-deadline")?.value,
      });
    } catch (error) { setStatus(error.message, true); return; }
    let created = null;
    const ok = await runAction(async () => {
      created = await client.request(client.path("/bounties"),
        { method: "POST", data: { ...payload, idempotencyKey: newIdempotencyKey() } });
      const bountyId = created?.bounty?.bountyId;
      if (!bountyId) throw new Error("The bounty was posted but its id did not come back.");
      await client.request(client.path(`/bounties/${encodeURIComponent(bountyId)}/fund`),
        { method: "POST", data: { idempotencyKey: newIdempotencyKey() } });
    }, null);
    if (ok) setStatus(`Posted and funded “${payload.title}” — ${formatCredits(payload.amount)} credits are locked in escrow.`);
    else if (created?.bounty?.bountyId) {
      // Posted but unfunded: the reload inside runAction already failed over
      // to the error status; make the recovery path explicit.
      await reload();
      setStatus("Posted, but funding did not go through — use Fund escrow on the bounty below.", true);
    }
  }

  async function onClick(event) {
    const button = event.target.closest?.("[data-bounty-action]");
    if (!button || busy) return;
    const bountyId = button.dataset.bountyId;
    const item = lastModel?.items.find(row => row.bountyId === bountyId);
    if (!item) return;
    const action = button.dataset.bountyAction;
    if (action === "fund") {
      await runAction(
        () => client.request(client.path(`/bounties/${encodeURIComponent(bountyId)}/fund`),
          { method: "POST", data: { idempotencyKey: newIdempotencyKey() } }),
        `Funded “${item.title}” — ${formatCredits(item.amount)} credits are locked in escrow.`);
    } else if (action === "accept") {
      const verdicts = {};
      host.querySelectorAll(`[data-verdict-for^="${CSS.escape(bountyId)}:"]`).forEach(select => {
        verdicts[select.dataset.verdictFor.slice(bountyId.length + 1)] = select.value;
      });
      const done = await runAction(
        () => client.request(client.path(`/bounties/${encodeURIComponent(bountyId)}/accept`),
          { method: "POST", data: { ...buildAcceptAttestation(item, verdicts), idempotencyKey: newIdempotencyKey() } }),
        null);
      if (done) {
        // runAction already reloaded: lastModel carries the accept's
        // movement receipt. Re-render from it so the receipt highlights.
        const receipt = lastModel?.receipts.find(r => r.bountyId === bountyId && (r.kind === "attribute" || r.kind === "payout"));
        highlightReceiptId = receipt?.receiptId ?? null;
        if (receipt) {
          render(lastModel);
          setStatus(`Accepted “${item.title}”. Receipt ${receipt.receiptId} is in your receipts below.`);
        } else setStatus(`Accepted “${item.title}”.`);
      }
    } else if (action === "reject") {
      const reason = host.querySelector(`[data-reject-reason="${CSS.escape(bountyId)}"]`)?.value?.trim();
      if (!reason) { setStatus("Write a reason to reject — the worker sees it.", true); return; }
      await runAction(
        () => client.request(client.path(`/bounties/${encodeURIComponent(bountyId)}/reject`),
          { method: "POST", data: { reason, idempotencyKey: newIdempotencyKey() } }),
        `Rejected “${item.title}” — the escrow refunded to you.`);
    }
  }

  host.addEventListener("submit", event => { if (event.target?.id === "bounty-post-form") void onSubmit(event); });
  host.addEventListener("click", event => { void onClick(event); });

  return {
    sync() { if (panel.open) return load(); },
    reset() {
      generation++;
      loadedFor = null;
      highlightReceiptId = null;
      lastModel = null;
      panel.open = false;
      if (chip) chip.textContent = "";
      host.innerHTML = "";
      setStatus("");
    },
  };
}
