// Open-questions radar panel (audit wave-2 item 8): read-only view of
// GET /api/rooms/{roomId}/open-questions — unanswered "?" messages room-wide,
// DM-scoped to the viewer. Read model; nothing here writes, mutes, or marks
// anything read. Follows the referral-board lazy-disclosure install pattern.
const $ = selector => document.querySelector(selector);

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

// TZ-safe short date ("Oct 6"); absolute UTC so every viewer reads the same day.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatQuestionWhen(askedAt) {
  if (!askedAt) return "";
  const date = new Date(askedAt);
  return Number.isNaN(date.getTime()) ? "" : `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

// Pure view model over the endpoint payload
// { roomId, viewerId, evaluatedAt, openQuestions: [{ messageId, authorId,
// excerpt, askedAt, threadRootId }] }. Tested without DOM.
export function openQuestionsModel(data) {
  const rows = Array.isArray(data?.openQuestions) ? data.openQuestions : [];
  return {
    count: rows.length,
    items: rows.map(row => ({
      messageId: typeof row?.messageId === "string" ? row.messageId : "",
      authorId: typeof row?.authorId === "string" ? row.authorId : "",
      excerpt: typeof row?.excerpt === "string" ? row.excerpt : "",
      askedAt: typeof row?.askedAt === "string" ? row.askedAt : "",
      threadRootId: typeof row?.threadRootId === "string" ? row.threadRootId : "",
      when: formatQuestionWhen(row?.askedAt),
    })),
  };
}

// Pure HTML render of the model. Tested without DOM.
export function openQuestionsHtml(model) {
  const items = model?.items ?? [];
  if (items.length === 0) {
    return `<div id="open-questions-list" class="open-questions-list"><p class="form-hint">No open questions right now.</p></div>`;
  }
  const rows = items.map(item =>
    `<li class="open-question-row"><span class="open-question-excerpt">${escapeHtml(item.excerpt)}</span>` +
    `<span class="form-hint"> ${escapeHtml(item.authorId)}${item.when ? ` · ${escapeHtml(item.when)}` : ""}</span></li>`
  ).join("");
  return `<div id="open-questions-list" class="open-questions-list"><ul>${rows}</ul></div>`;
}

export function installOpenQuestionsPanel({ client, getState, getSession }) {
  const panel = $("#open-questions-panel");
  const chip = $("#open-questions-count");
  const status = $("#open-questions-status");
  if (!panel) return { sync() {}, reset() {} };

  let loaded = false, busy = false, generation = 0;

  const setStatus = text => { if (status) status.textContent = text ?? ""; };

  function render(data) {
    const model = openQuestionsModel(data);
    if (chip) chip.textContent = String(model.count);
    const host = $("#open-questions-list-host");
    if (host) host.innerHTML = openQuestionsHtml(model);
    setStatus("");
  }

  async function load() {
    const session = getSession(), epoch = generation;
    if (!session || loaded || busy) return;
    const current = () => epoch === generation && getSession() === session;
    busy = true;
    try {
      const data = await client.request(client.path("/open-questions"), { method: "GET" });
      if (current()) { render(data); loaded = true; }
    } catch {
      if (current()) setStatus("Could not load open questions. Close and reopen to retry.");
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
      if (chip) chip.textContent = "";
      setStatus("");
    },
  };
}
