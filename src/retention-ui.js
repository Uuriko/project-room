// Retention dashboard panel (audit wave-2 item 9): read-only view of
// GET /api/rooms/{roomId}/work-claims/retention — first-contribution response
// SLA (research brief 2026-09-28, mechanics #1) and the no-zero-reply watchdog
// (#2). Deliberately non-punitive: queues for reviewers, never strikes or
// sanctions. Nothing here writes. Follows the referral-board lazy-disclosure
// install pattern.
const $ = selector => document.querySelector(selector);

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

// TZ-safe short date ("Oct 5"); absolute UTC so every viewer reads the same day.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatRetentionWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

// Human duration from milliseconds: "45m", "2h", "3h 30m", "3d". An honest
// em dash when there is nothing measured yet. Tested without DOM.
export function formatLatency(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 48) {
    const rest = totalMinutes % 60;
    return rest === 0 ? `${totalHours}h` : `${totalHours}h ${rest}m`;
  }
  return `${Math.floor(totalHours / 24)}d`;
}

// Pure view model over the retentionReport payload served at
// GET /work-claims/retention. Tested without DOM.
export function retentionModel(data) {
  const sla = data?.sla ?? {};
  const zeroReply = data?.zeroReply ?? {};
  const latency = data?.latency ?? {};
  const queue = Array.isArray(sla.queue) ? sla.queue : [];
  const answered = Array.isArray(sla.answered) ? sla.answered : [];
  const watch = Array.isArray(zeroReply.watch) ? zeroReply.watch : [];
  return {
    slaHours: Number.isFinite(data?.slaHours) ? data.slaHours : 24,
    zeroReplyWindowHours: Number.isFinite(data?.zeroReplyWindowHours) ? data.zeroReplyWindowHours : 48,
    breached: Number.isFinite(sla.breached) ? sla.breached : 0,
    pending: Number.isFinite(sla.pending) ? sla.pending : 0,
    answered: answered.length,
    queue: queue.map(entry => ({
      memberId: typeof entry?.memberId === "string" ? entry.memberId : "",
      itemId: typeof entry?.itemId === "string" ? entry.itemId : "",
      status: typeof entry?.status === "string" ? entry.status : "",
      at: typeof entry?.at === "string" ? entry.at : "",
      dueAt: typeof entry?.dueAt === "string" ? entry.dueAt : "",
      when: formatRetentionWhen(entry?.at),
    })),
    answeredRows: answered.map(entry => ({
      memberId: typeof entry?.memberId === "string" ? entry.memberId : "",
      itemId: typeof entry?.itemId === "string" ? entry.itemId : "",
      answeredBy: typeof entry?.answeredBy === "string" ? entry.answeredBy : "",
      latency: formatLatency(entry?.latencyMs),
      when: formatRetentionWhen(entry?.at),
    })),
    watch: watch.map(entry => ({
      itemId: typeof entry?.itemId === "string" ? entry.itemId : "",
      memberId: typeof entry?.memberId === "string" ? entry.memberId : "",
      claimedAt: typeof entry?.claimedAt === "string" ? entry.claimedAt : "",
      unacked: entry?.unacked === true,
      when: formatRetentionWhen(entry?.claimedAt),
    })),
    contributions: Number.isFinite(zeroReply.contributions) ? zeroReply.contributions : 0,
    unanswered: Number.isFinite(zeroReply.unanswered) ? zeroReply.unanswered : 0,
    unacked: Number.isFinite(zeroReply.unacked) ? zeroReply.unacked : 0,
    zeroReplyRate: Number.isFinite(zeroReply.rate) ? zeroReply.rate : 0,
    alert: zeroReply.alert === true,
    latencyMedian: formatLatency(latency.medianMs),
    latencyMeasured: Number.isFinite(latency.measured) ? latency.measured : 0,
  };
}

// Pure HTML render of the model. Tested without DOM.
export function retentionHtml(model) {
  const m = model ?? retentionModel(null);
  const cap = s => (typeof s === "string" && s.length > 0) ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const queueRows = m.queue.map(entry =>
    `<li class="retention-row"><span class="retention-status-${escapeHtml(entry.status)}">${escapeHtml(cap(entry.status))}</span>` +
    ` <span>${escapeHtml(entry.memberId)}</span> <span class="form-hint">${escapeHtml(entry.itemId)}${entry.when ? ` · claimed ${escapeHtml(entry.when)}` : ""}</span></li>`
  ).join("");
  const answeredRows = m.answeredRows.map(entry =>
    `<li class="retention-row"><span class="retention-status-answered">answered</span>` +
    ` <span>${escapeHtml(entry.memberId)}</span> <span class="form-hint">by ${escapeHtml(entry.answeredBy)} · ${escapeHtml(entry.latency)}</span></li>`
  ).join("");
  const watchRows = m.watch.map(entry =>
    `<li class="retention-row"><span>${escapeHtml(entry.itemId)}</span>` +
    ` <span class="form-hint">${escapeHtml(entry.memberId)} · claimed ${escapeHtml(entry.when)}${entry.unacked ? " · no reply at all yet" : ""}</span></li>`
  ).join("");
  const ratePct = `${Math.round(m.zeroReplyRate * 100)}%`;
  return `<div id="retention-panel-body" class="retention-panel-body">` +
    `<p class="form-hint">First contributions get a response within ${escapeHtml(String(m.slaHours))}h. This is a reviewer queue, not a sanction list.</p>` +
    `<div class="retention-section"><h4>First-response SLA</h4>` +
    `<p class="form-hint">${m.breached} breached · ${m.pending} pending · ${m.answered} answered</p>` +
    (queueRows ? `<ul class="retention-list">${queueRows}</ul>` : `<p class="form-hint">Nothing waiting on a first response.</p>`) +
    (answeredRows ? `<h4>Answered</h4><ul class="retention-list">${answeredRows}</ul>` : "") +
    `</div>` +
    `<div class="retention-section"><h4>Zero-reply watch</h4>` +
    `<p class="form-hint">${m.unanswered} of ${m.contributions} contributions unanswered (${ratePct}) · ${m.unacked} unacked · ${m.zeroReplyWindowHours}h window</p>` +
    (watchRows ? `<ul class="retention-list">${watchRows}</ul>` : `<p class="form-hint">No claims past the reply window.</p>`) +
    `</div>` +
    `<div class="retention-section"><h4>Response latency</h4>` +
    `<p class="form-hint">Median first response ${escapeHtml(m.latencyMedian)} across ${m.latencyMeasured} measured claims.</p></div>` +
    `</div>`;
}

export function installRetentionPanel({ client, getState, getSession }) {
  const panel = $("#retention-panel");
  const alertChip = $("#retention-alert");
  const status = $("#retention-status");
  if (!panel) return { sync() {}, reset() {} };

  let loaded = false, busy = false, generation = 0;

  const setStatus = text => { if (status) status.textContent = text ?? ""; };

  function render(data) {
    const model = retentionModel(data);
    const host = $("#retention-panel-host");
    if (host) host.innerHTML = retentionHtml(model);
    if (alertChip) {
      const bits = [];
      if (model.breached > 0) bits.push(`${model.breached} breached`);
      if (model.unacked > 0) bits.push(`${model.unacked} unacked`);
      alertChip.textContent = bits.join(" · ");
      alertChip.hidden = bits.length === 0;
    }
    setStatus("");
  }

  async function load() {
    const session = getSession(), epoch = generation;
    if (!session || loaded || busy) return;
    const current = () => epoch === generation && getSession() === session;
    busy = true;
    try {
      const data = await client.request(client.path("/work-claims/retention"), { method: "GET" });
      if (current()) { render(data); loaded = true; }
    } catch {
      if (current()) setStatus("Could not load the retention dashboard. Close and reopen to retry.");
    } finally { if (current()) busy = false; }
  }

  panel.addEventListener("toggle", () => { if (panel.open) void load(); });

  return {
    sync() { if (panel.open) return load(); },
    reset() {
      generation++;
      loaded = false;
      busy = false;
      panel.open = false;
      if (alertChip) { alertChip.textContent = ""; alertChip.hidden = true; }
      setStatus("");
    },
  };
}
