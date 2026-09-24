// Compact land-queue board card. The list is the room's land queue read
// (GET list_land_queue). Each card shows the pull request number, title,
// short head SHA, a checks dot, a behind badge, and a tip badge.

export function shortSha(sha) {
  return typeof sha === "string" && sha.length >= 7 ? sha.slice(0, 7) : "";
}

export function landCardModel(item) {
  const checks = item?.checks === "green" || item?.checks === "red" || item?.checks === "pending" ? item.checks : "pending";
  return {
    prNumber: item?.prNumber ?? "",
    title: typeof item?.title === "string" && item.title ? item.title : `PR ${item?.prNumber ?? ""}`,
    url: typeof item?.url === "string" ? item.url : "",
    head: shortSha(item?.headSha),
    checks,
    behind: item?.behind === true,
    merged: Boolean(item?.mergedSha),
    tip: Boolean(item?.tip && (item.tip.sourceRevision || item.tip.buildId))
  };
}

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[char]));
}

export function landCardHtml(item) {
  const card = landCardModel(item);
  const behind = card.behind ? `<span class="land-badge">behind</span>` : "";
  const merged = card.merged ? `<span class="land-badge">merged</span>` : "";
  const tip = card.tip ? `<span class="land-badge">tip</span>` : "";
  const sha = card.head ? `<span class="land-sha">${escapeHtml(card.head)}</span>` : "";
  const title = escapeHtml(card.title);
  const label = `#${escapeHtml(card.prNumber)}`;
  const link = card.url
    ? `<a href="${escapeHtml(card.url)}">${label}</a>`
    : `<span>${label}</span>`;
  return `<article class="land-card">${link} <span class="land-title">${title}</span> ${sha}<span class="land-checks land-checks-${card.checks}" title="checks ${card.checks}"></span>${behind}${merged}${tip}</article>`;
}

export function installLandQueueBoard({ client, getSession }) {
  const panel = document.querySelector("#land-queue-panel");
  const list = document.querySelector("#land-queue-list");
  const count = document.querySelector("#land-queue-count");
  if (!panel || !list) return { sync() {}, reset() {} };
  let loadedFor = null;
  let busy = false;

  function render(items) {
    const rows = Array.isArray(items) ? items : [];
    if (count) count.textContent = String(rows.length);
    list.innerHTML = rows.length
      ? rows.map(landCardHtml).join("")
      : `<p class="form-hint">No pull requests in the land queue.</p>`;
  }

  async function load() {
    const session = getSession();
    if (!session?.roomId || busy) return;
    if (loadedFor === session.roomId) return;
    busy = true;
    try {
      const data = await client.request(client.path("/list_land_queue"));
      if (getSession()?.roomId !== session.roomId) return;
      render(data?.items);
      loadedFor = session.roomId;
    } catch {
      if (count) count.textContent = "";
    } finally {
      busy = false;
    }
  }

  return {
    sync() { void load(); },
    reset() { loadedFor = null; render([]); }
  };
}
