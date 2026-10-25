// Needs you, task status, acknowledgement, and result. Loaded only after the
// room flag is on. The server is the source of the status and ack words.
import { uiText } from "./strings.js";

const KIND_KEYS = Object.freeze({
  ask: "designUpgrade.kind.ask",
  approval: "designUpgrade.kind.approval",
  mention: "designUpgrade.kind.mention",
  task: "designUpgrade.kind.task",
});

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function rejectedHref(href) {
  return /\s/u.test(href) || href.includes("<") || href.includes(">") || href.includes("\"") || href.includes("'") || href.includes("`");
}

function safeHref(href) {
  if (typeof href !== "string" || rejectedHref(href)) return null;
  if (href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/\\")) return href;
  try {
    const url = new URL(href);
    return url.protocol === "https:" ? href : null;
  } catch {
    return null;
  }
}

async function read(client, suffix) {
  return client.request(client.path(suffix));
}

function paintAck(host, ack, kind, id, client, onAck) {
  host.replaceChildren();
  if (!ack?.label) return;
  const line = el("p", "design-upgrade-ack");
  line.textContent = ack.label;
  host.append(line);
  if (!ack.canAck) return;
  const button = el("button", "button secondary");
  button.type = "button";
  button.textContent = uiText("designUpgrade.acknowledge");
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const next = await client.request(client.path("/acks"), { method: "POST", data: { kind, id } });
      paintAck(host, next, kind, id, client, onAck);
      onAck?.();
    } catch {
      button.disabled = false;
    }
  });
  host.append(button);
}

function paintResult(panel, body) {
  panel.replaceChildren();
  if (!body?.result) {
    const empty = el("p", "design-upgrade-note");
    empty.textContent = uiText("designUpgrade.resultEmpty");
    panel.append(empty);
    return;
  }
  const summary = el("p");
  summary.textContent = body.result.summary;
  panel.append(summary);
  for (const link of body.result.links ?? []) {
    const href = safeHref(link?.href);
    if (!href) continue;
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.textContent = typeof link.label === "string" ? link.label : href;
    anchor.rel = "noopener noreferrer";
    if (href.startsWith("https:")) anchor.target = "_blank";
    panel.append(anchor);
  }
}

function bindCard(card, record, client, onAck) {
  const status = record?.status ? record : null;
  if (!status?.label) return;
  const state = card.querySelector(".state");
  let chip = card.querySelector("[data-design-chip]");
  if (state) {
    state.textContent = status.label;
    state.dataset.designChip = "";
    chip = state;
  } else if (!chip) {
    chip = el("p", "design-upgrade-status");
    chip.dataset.designChip = "";
    const title = card.querySelector("h3, h4");
    title?.after(chip);
  }
  if (!state) chip.textContent = status.label;
  let ackHost = card.querySelector("[data-design-ack]");
  if (!ackHost) {
    ackHost = el("div");
    ackHost.dataset.designAck = "";
    chip.after(ackHost);
  }
  paintAck(ackHost, status.ack, record.kind, record.id, client, onAck);
  if (card.querySelector("[data-design-result]")) return;
  const resultButton = el("button", "button secondary");
  resultButton.classList.add("design-upgrade-result");
  resultButton.type = "button";
  resultButton.dataset.designResult = "";
  resultButton.textContent = uiText("designUpgrade.result");
  const panel = el("div", "design-upgrade-panel");
  panel.hidden = true;
  resultButton.addEventListener("click", async () => {
    panel.hidden = false;
    panel.replaceChildren();
    const loading = el("p", "design-upgrade-note");
    loading.textContent = uiText("designUpgrade.loading");
    panel.append(loading);
    try {
      const query = new URLSearchParams({ kind: record.kind, id: record.id });
      const body = await read(client, `/task-result?${query}`);
      paintResult(panel, body);
    } catch {
      panel.replaceChildren();
      const error = el("p", "design-upgrade-note");
      error.textContent = uiText("designUpgrade.resultError");
      const retry = el("button", "button secondary");
      retry.type = "button";
      retry.textContent = uiText("designUpgrade.retry");
      retry.addEventListener("click", () => resultButton.click());
      panel.append(error, retry);
    }
  });
  ackHost.after(resultButton, panel);
}

async function loadKind(client, kind, ids) {
  const params = new URLSearchParams({ kind, ids: ids.join(",") });
  return read(client, `/task-status?${params}`);
}

export function mountDesignUpgrade({ client, root = document }) {
  let alive = true;
  const style = el("link");
  style.rel = "stylesheet";
  style.href = new URL("./design-upgrade.css", import.meta.url).href;
  root.head?.append(style);

  const button = el("button", "topbar-button design-upgrade-needs");
  button.type = "button";
  button.id = "design-upgrade-needs";
  button.append(uiText("designUpgrade.needsYou"));
  const count = el("span", "design-upgrade-count");
  count.hidden = true;
  button.append(count);
  const catchup = root.querySelector("#topbar-catchup");
  if (catchup) catchup.before(button);
  else root.body?.prepend(button);

  const dialog = el("dialog", "design-upgrade-dialog");
  dialog.id = "design-upgrade-dialog";
  dialog.setAttribute("aria-labelledby", "design-upgrade-title");
  const head = el("div", "design-upgrade-head");
  const title = el("h2");
  title.id = "design-upgrade-title";
  title.textContent = uiText("designUpgrade.needsYou");
  const close = el("button", "button secondary");
  close.type = "button";
  close.textContent = uiText("designUpgrade.close");
  close.addEventListener("click", () => dialog.close());
  head.append(title, close);
  const note = el("p", "design-upgrade-note");
  const list = el("ul", "design-upgrade-list");
  const more = el("button", "button secondary");
  more.type = "button";
  more.hidden = true;
  more.textContent = uiText("designUpgrade.more");
  dialog.append(head, note, list, more);
  root.body?.append(dialog);
  dialog.addEventListener("close", () => button.focus());

  let nextCursor = null;

  async function refreshCount() {
    try {
      const body = await page(null);
      if (!alive) return;
      setCount(body.count);
    } catch { /* keep the last count */ }
  }

  function setCount(value) {
    count.hidden = false;
    count.textContent = String(value);
    count.setAttribute("aria-label", uiText("designUpgrade.count", { count: value }));
  }

  function addItems(items) {
    for (const item of items ?? []) {
      const row = el("li", "design-upgrade-item");
      const kind = el("p", "design-upgrade-kind");
      kind.textContent = uiText(KIND_KEYS[item.kind] ?? "designUpgrade.kind.task");
      const heading = el("p", "design-upgrade-title");
      heading.textContent = item.title ?? "";
      row.append(kind, heading);
      if (item.ack?.label) {
        const ack = el("p", "design-upgrade-note");
        ack.textContent = item.ack.label;
        row.append(ack);
      }
      if (item.ack?.canAck && item.subjectKind && item.subjectId) {
        const ackButton = el("button", "button secondary");
        ackButton.type = "button";
        ackButton.textContent = uiText("designUpgrade.acknowledge");
        ackButton.addEventListener("click", async () => {
          ackButton.disabled = true;
          try {
            await client.request(client.path("/acks"), {
              method: "POST",
              data: { kind: item.subjectKind, id: item.subjectId },
            });
            void refresh({ replace: true });
          } catch {
            ackButton.disabled = false;
          }
        });
        row.append(ackButton);
      }
      list.append(row);
    }
  }

  async function page(cursor) {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    params.set("limit", "50");
    const suffix = params.size ? `/needs-you?${params}` : "/needs-you";
    return read(client, suffix);
  }

  async function refresh({ replace }) {
    if (!alive) return;
    if (replace) {
      note.textContent = uiText("designUpgrade.loading");
      list.replaceChildren();
      more.hidden = true;
    }
    try {
      const body = await page(replace ? null : nextCursor);
      if (!alive) return;
      if (replace) list.replaceChildren();
      addItems(body.items);
      nextCursor = body.nextCursor ?? null;
      more.hidden = !nextCursor;
      setCount(body.count);
      note.textContent = body.count === 0 ? uiText("designUpgrade.empty") : "";
      if (body.incomplete?.length) {
        const extra = el("span");
        extra.textContent = body.count === 0 ? "" : " ";
        note.append(extra, document.createTextNode(uiText("designUpgrade.incomplete")));
      }
    } catch {
      if (!alive) return;
      note.textContent = uiText("designUpgrade.error");
      const retry = el("button", "button secondary");
      retry.type = "button";
      retry.textContent = uiText("designUpgrade.retry");
      retry.addEventListener("click", () => { void refresh({ replace: true }); });
      note.append(" ", retry);
    }
  }

  more.addEventListener("click", () => { void refresh({ replace: false }); });
  button.addEventListener("click", () => {
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    void refresh({ replace: true });
  });

  const seen = new Set();
  async function enhance() {
    if (!alive) return;
    const cards = [...root.querySelectorAll("article.claim-card[data-claim-id], article.work-card[data-work-record-id]")];
    const pending = cards.filter(card => !card.dataset.designStatus || (card.dataset.designStatus === "ready" && !card.querySelector("[data-design-chip]")));
    if (!pending.length) return;
    const groups = { claim: [], work: [] };
    for (const card of pending) {
      const claimId = card.dataset.claimId;
      const workId = card.dataset.workRecordId;
      const kind = claimId ? "claim" : "work";
      const id = claimId || workId;
      const key = [kind, id].join(":");
      if (seen.has(key) && card.dataset.designStatus === "pending") continue;
      card.dataset.designStatus = "pending";
      groups[kind].push({ card, id, key });
    }
    for (const kind of ["claim", "work"]) {
      const batch = groups[kind];
      for (let index = 0; index < batch.length; index += 40) {
        const slice = batch.slice(index, index + 40);
        try {
          const body = await loadKind(client, kind, slice.map(entry => entry.id));
          if (!alive) return;
          const byId = new Map((body.tasks ?? []).map(task => [task.id, task]));
          for (const entry of slice) {
            const task = byId.get(entry.id);
            if (!task || task.error || !task.label) {
              entry.card.dataset.designStatus = "failed";
              continue;
            }
            bindCard(entry.card, task, client, () => { void (dialog.open ? refresh({ replace: true }) : refreshCount()); });
            entry.card.dataset.designStatus = "ready";
            seen.add(entry.key);
          }
        } catch {
          for (const entry of slice) entry.card.dataset.designStatus = "failed";
        }
      }
    }
  }

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; void enhance(); });
  });
  if (root.body) observer.observe(root.body, { childList: true, subtree: true });
  void refresh({ replace: true });
  void enhance();

  return {
    teardown() {
      alive = false;
      observer.disconnect();
      button.remove();
      dialog.remove();
      style.remove();
    },
  };
}
