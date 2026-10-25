import { uiText } from "./strings.js";
// #3342 Owner Cockpit slice 1 — the account-home shell for the cross-room
// Decisions queue + Exceptions feed served by GET /api/owner/overview.
// The server merges and sorts; this module only renders what it is given
// and executes the #662 decide actions verbatim against the existing
// per-room decide endpoint (account-mode room credentials). No client-side
// currency math exists here because the document never mixes currencies.
// #3343 slice 2 — the Money snapshot + full views and the Roster render
// the server's money/roster sections the same way: Panel C (cents) and
// Panel R (milli-credits) are separate blocks with separate units, spend
// marked agent-reported, and "unknown" spend rendered as the word, never
// as a zero the server did not send.
//
// #3340 — the account-home Needs Attention badge + per-room deep lines in
// this same shell are fed by that same overview document: the badge count
// is the document's Decisions total verbatim (the one attentionReport-based
// count; nothing here recounts the underlying per-room sources), and the
// per-room lines group the Decisions items the document already carries.

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const KIND_LABEL = {
  access_request: "Join request",
  verification: "Verify",
  decision: "Decision",
  dispute: "Dispute",
  claim_lease: "Claim lease",
  spend: "Spend",
};

const SEVERITY_LABEL = { critical: "Critical", warn: "Warning", info: "Note" };

export function formatAge(ageMs) {
  if (typeof ageMs !== "number" || !Number.isFinite(ageMs) || ageMs < 0) return "";
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 60) return `waiting ${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `waiting ${hours}h`;
  const days = Math.floor(hours / 24);
  return `waiting ${days}d ${hours % 24}h`;
}

// #3340: the badge count is the overview Decisions total, taken verbatim.
// It is never derived from items.length (the items array is capped by the
// server) and never recomputed from per-room sources.
export function attentionBadgeCount(doc) {
  const total = doc?.decisions?.total;
  return Number.isSafeInteger(total) && total > 0 ? total : 0;
}

export function perRoomAttention(doc) {
  const lines = [];
  const byRoom = new Map();
  for (const item of doc?.decisions?.items ?? []) {
    if (!item || typeof item.roomId !== "string" || item.roomId.length === 0) continue;
    let line = byRoom.get(item.roomId);
    if (!line) {
      line = { roomId: item.roomId, roomName: item.roomName ?? item.roomId, count: 0 };
      byRoom.set(item.roomId, line);
      lines.push(line);
    }
    line.count++;
  }
  return lines;
}

export function attentionLinesTruncated(doc) {
  const total = doc?.decisions?.total;
  const shown = Array.isArray(doc?.decisions?.items) ? doc.decisions.items.length : 0;
  return Number.isSafeInteger(total) && total > shown;
}

export function roomAttentionHref(roomId) {
  return `./?room=${encodeURIComponent(roomId)}`;
}

export function roomAttentionLinesHtml(doc) {
  const lines = perRoomAttention(doc);
  if (lines.length === 0) return "";
  const rows = lines.map(line => uiText("cockpit.attentionRoomHtml", {
    href: esc(roomAttentionHref(line.roomId)),
    name: esc(line.roomName),
    count: line.count,
    verb: line.count === 1 ? "needs" : "need",
  }));
  if (attentionLinesTruncated(doc)) {
    rows.push(uiText("cockpit.attentionTruncatedHtml", {
      shown: doc.decisions.items.length,
      total: doc.decisions.total,
    }));
  }
  return rows.join("");
}

const cents = value => typeof value === "number" ? `$${(value / 100).toFixed(2)}` : "unknown";
const millis = value => typeof value === "number" ? `${value} mcr` : "unknown";

export function renderMoney(money) {
  if (!money) return "";
  const { cents: panelC, credits: panelR } = money;
  const roomLines = panelC.rooms.map(room => {
    const bar = room.burnFraction === null ? ""
      : uiText("cockpit.moneyBurnBar", { percent: Math.round(room.burnFraction * 100) });
    const headroom = room.headroomCents === null
      ? uiText("cockpit.moneyHeadroomUnknown")
      : uiText("cockpit.moneyHeadroom", { amount: cents(room.headroomCents) });
    return uiText("cockpit.moneyRoomHtml", {
      name: esc(room.roomName ?? room.roomId),
      committed: cents(room.committedCents),
      spent: cents(room.spentCents),
      reserved: cents(room.reservedCents),
      held: cents(room.heldCents),
      headroom,
      bar,
      burn: cents(room.burnRateCentsPerDay),
    });
  }).join("");
  const outcome = panelC.costPerAcceptedOutcome;
  const outcomeLine = outcome.status === "ok"
    ? uiText("cockpit.moneyOutcomeHtml", { label: esc(outcome.label) })
    : uiText(outcome.status === "unknown" ? "cockpit.moneyOutcomeUnknown" : "cockpit.moneyOutcomeNone");
  const unreported = panelC.totals.unreportedAttempts > 0
    ? uiText("cockpit.moneyUnreportedHtml", {
      count: panelC.totals.unreportedAttempts,
      noun: panelC.totals.unreportedAttempts === 1 ? "attempt" : "attempts",
    }) : "";
  const taskLines = panelC.tasks.map(task => uiText("cockpit.moneyTaskHtml", {
    title: esc(task.title),
    spend: cents(task.spendCents),
    room: esc(task.roomName ?? task.roomId),
    attempts: task.attempts,
    noun: task.attempts === 1 ? "attempt" : "attempts",
  })).join("");
  const creditLines = panelR.rooms.map(room => uiText("cockpit.moneyCreditHtml", {
    name: esc(room.roomName ?? room.roomId),
    locked: millis(room.lockedMillis),
    pool: millis(room.poolBalanceMillis),
    disputed: millis(room.disputedMillis),
  })).join("");
  return uiText("cockpit.moneyHtml", {
    rooms: roomLines,
    outcome: outcomeLine,
    unreported,
    tasks: taskLines,
    credits: creditLines || uiText("cockpit.moneyCreditsEmpty"),
  });
}

export function renderRoster(roster) {
  if (!roster) return "";
  if (roster.total === 0) return uiText("cockpit.rosterEmptyHtml");
  const counts = roster.counts;
  const summaryLine = uiText("cockpit.rosterSummary", {
    total: counts.total,
    agents: counts.total === 1 ? "agent" : "agents",
    working: counts.working,
    stalled: counts.stalled,
    offline: counts.offline,
  });
  const rows = roster.rows.slice(0, 5).map(row => {
    const receipt = row.lastReceipt
      ? uiText("cockpit.rosterReceiptHtml", {
        href: `./?room=${encodeURIComponent(row.roomId)}`,
        id: esc(String(row.lastReceipt.receiptId).slice(0, 24)),
      }) : "";
    const work = row.currentWork ? ` — ${esc(row.currentWork.title)}` : "";
    return uiText("cockpit.rosterRowHtml", {
      state: esc(row.workState),
      name: esc(row.displayName),
      work,
      room: esc(row.roomName ?? row.roomId),
      tier: esc(row.autonomyTier),
      cost: cents(row.periodCostCents),
      receipt,
    });
  }).join("");
  return uiText("cockpit.rosterHtml", { summary: esc(summaryLine), rows });
}

export function createOwnerCockpit({ accountClient, section, decide }) {
  const summary = section.querySelector("#cockpit-summary");
  const badge = section.querySelector("#cockpit-attention-badge");
  const roomLines = section.querySelector("#cockpit-room-lines");
  const decisionsBox = section.querySelector("#cockpit-decisions");
  const exceptionsBox = section.querySelector("#cockpit-exceptions");
  const moneyBox = section.querySelector("#cockpit-money");
  const rosterBox = section.querySelector("#cockpit-roster");
  const stubsBox = section.querySelector("#cockpit-room-stubs");
  let epoch = 0, busy = false;

  function renderAttentionBadge(doc) {
    if (badge) {
      const count = doc ? attentionBadgeCount(doc) : 0;
      badge.textContent = count > 0 ? String(count) : "";
      badge.hidden = count === 0;
      if (typeof badge.setAttribute === "function") {
        badge.setAttribute("aria-label", count > 0 ? uiText("cockpit.attentionWaiting", { count }) : "Needs attention");
      }
    }
    if (roomLines) roomLines.innerHTML = doc ? roomAttentionLinesHtml(doc) : "";
  }

  function renderItem(item) {
    const label = KIND_LABEL[item.kind] ?? item.kind;
    const age = formatAge(item.ageMs);
    const actions = (item.actions ?? []).map(action => {
      if (action.method === "POST") {
        return `<button type="button" class="button ${action.action === "approve" ? "primary" : "ghost"}" data-cockpit-decide="${esc(action.action)}" data-item-id="${esc(item.id)}">${esc(action.action === "approve" ? "Approve" : "Deny")}</button>`;
      }
      return `<a class="text-button" href="./?room=${encodeURIComponent(item.roomId)}">Review in room</a>`;
    }).join(" ");
    return `<article class="cockpit-item" data-kind="${esc(item.kind)}">
      <header><strong>${esc(label)}</strong> <span>${esc(item.title)}</span></header>
      <p class="form-hint">${esc(item.roomName ?? item.roomId)}${age ? ` · ${esc(age)}` : ""}</p>
      ${item.consequence ? `<p class="form-hint">${esc(item.consequence)}</p>` : ""}
      <div class="cockpit-actions">${actions}</div>
    </article>`;
  }

  function renderException(item) {
    const where = item.roomName ?? item.roomId ?? "Deployment";
    return `<article class="cockpit-item" data-kind="${esc(item.kind)}" data-severity="${esc(item.severity)}">
      <header><strong>${esc(SEVERITY_LABEL[item.severity] ?? item.severity)}</strong> <span>${esc(item.detail)}</span></header>
      <p class="form-hint">${esc(where)}</p>
    </article>`;
  }

  function renderJobs(jobs) {
    if (!Array.isArray(jobs) || !jobs.length) return "";
    const alerts = jobs.filter(job => job.alert);
    const never = uiText("cockpit.jobNever");
    const rows = jobs.map(job => uiText("cockpit.jobRowHtml", {
      name: esc(job.name), result: esc(job.result), alert: job.alert ? "true" : "false",
      label: esc(uiText(`cockpit.jobResult.${job.result}`)),
      failures: job.consecutiveFailures ? esc(uiText("cockpit.jobFailedInRow", { count: job.consecutiveFailures })) : "",
      times: esc(uiText("cockpit.jobTimes", { run: job.lastRunAt ?? never, success: job.lastSuccessAt ?? never }))
    })).join("");
    const title = alerts.length ? uiText("cockpit.jobsAttention", { count: alerts.length }) : uiText("cockpit.jobsTitle");
    return uiText("cockpit.jobsHtml", { open: alerts.length ? "open" : "", title: esc(title), rows });
  }

  function render(doc) {
    renderAttentionBadge(doc);
    const { decisions, exceptions, rooms } = doc;
    const notesOpen = exceptionsBox.querySelector("details")?.open;
    const notices = exceptions.items.filter(item => item.severity === "info");
    const actionable = exceptions.items.filter(item => item.severity !== "info");
    const showLedger = Boolean(doc.money) || Boolean(doc.roster);
    section.hidden = decisions.total === 0 && exceptions.total === 0 && !(doc.roomErrors?.length) && !(doc.jobs?.length) && !showLedger;
    const heading = section.querySelector("h3");
    if (heading) heading.hidden = !decisions.total && !actionable.length && !doc.roomErrors?.length && !showLedger;
    section.setAttribute("aria-labelledby", heading?.hidden ? "cockpit-notes-title" : "owner-cockpit-title");
    const parts = [`${decisions.waiting} waiting`];
    if (decisions.oldestAgeMs > 0) parts.push(`oldest ${formatAge(decisions.oldestAgeMs).replace("waiting ", "")}`);
    if (decisions.overdue > 0) parts.push(`${decisions.overdue} overdue`);
    if (rooms.label) parts.push(`across ${rooms.label}`);
    summary.textContent = decisions.total ? parts.join(" · ") : "";
    decisionsBox.innerHTML = decisions.total === 0
      ? ""
      : decisions.items.map(renderItem).join("");
    exceptionsBox.innerHTML = (exceptions.total === 0
      ? ""
      : (actionable.length ? `<h4>Exceptions</h4>` + actionable.map(renderException).join("") : "")
        + (notices.length ? uiText("human.roomNotesHtml", { open: notesOpen ? "open" : "", content: notices.map(renderException).join("") }) : ""))
      + renderJobs(doc.jobs);
    if (moneyBox) moneyBox.innerHTML = renderMoney(doc.money);
    if (rosterBox) rosterBox.innerHTML = renderRoster(doc.roster);
    stubsBox.innerHTML = (doc.roomErrors ?? []).map(stub =>
      `<p class="form-hint">Couldn't read room ${esc(stub.roomId)} (${esc(stub.error)}) — it is excluded from these totals.</p>`).join("");
    for (const button of decisionsBox.querySelectorAll("[data-cockpit-decide]")) {
      button.addEventListener("click", () => onDecide(button, doc));
    }
  }

  async function onDecide(button, doc) {
    if (busy) return;
    const item = doc.decisions.items.find(entry => entry.id === button.dataset.itemId);
    const action = item?.actions?.find(entry => entry.action === button.dataset.cockpitDecide && entry.method === "POST");
    if (!item || !action) return;
    busy = true;
    button.disabled = true;
    try {
      await decide(action);
      await refresh();
    } catch {
      summary.textContent = "That decision didn't go through. Refresh to see the current queue.";
      button.disabled = false;
    } finally { busy = false; }
  }

  async function refresh() {
    const mine = ++epoch;
    let doc;
    try { doc = await accountClient.ownerOverview(); }
    catch (error) {
      if (mine !== epoch) return;
      // A non-owner account simply has no cockpit; the room list below is
      // still their home. Any other failure says so once, quietly.
      section.hidden = error?.code === "owner_required" || error?.status === 403;
      if (!section.hidden) {
        section.hidden = false;
        renderAttentionBadge(null);
        const heading = section.querySelector("h3");
        if (heading) heading.hidden = false;
        section.setAttribute("aria-labelledby", "owner-cockpit-title");
        summary.textContent = "Couldn't load what needs you. Refresh to retry.";
        decisionsBox.innerHTML = "";
        exceptionsBox.innerHTML = "";
        if (moneyBox) moneyBox.innerHTML = "";
        if (rosterBox) rosterBox.innerHTML = "";
        stubsBox.innerHTML = "";
      }
      return;
    }
    if (mine !== epoch || !doc) return;
    render(doc);
  }

  return Object.freeze({ refresh });
}
