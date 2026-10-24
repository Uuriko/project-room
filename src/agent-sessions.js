// Sessions panel. Hidden until ROOM_AGENT_SESSIONS is on for this room.
import { uiText } from "./strings.js";

function line(className, text) {
  if (!text) return null;
  const node = document.createElement("p");
  node.className = className;
  node.textContent = text;
  return node;
}

function rowView(row) {
  const item = document.createElement("div");
  item.className = "presence-member";
  const body = document.createElement("div");
  const name = document.createElement("strong");
  name.className = "member-handle member-handle-agent";
  name.textContent = row.displayName || "Agent";
  body.append(name);
  const bits = [row.activity === "active" ? "Active" : "Idle"];
  if (row.harness) bits.push(row.harness);
  const status = line("member-status", bits.join(" · "));
  if (status) body.append(status);
  const owner = line("member-owned-by", row.owner?.displayName ?? "");
  if (owner) body.append(owner);
  const claim = line("member-working-on", row.claim?.title ?? "");
  if (claim) body.append(claim);
  const task = line("member-working-on", row.task?.title ?? "");
  if (task) body.append(task);
  item.append(body);
  return item;
}

export function bindAgentSessions({ client, $ }) {
  let enabled = null;
  let timer = 0;
  let seq = 0;
  const panel = () => $("#agent-sessions");

  function paint(body, q) {
    const node = panel();
    if (!node) return;
    if (!body?.enabled) { node.hidden = true; return; }
    if (node.hidden) node.open = true;
    node.hidden = false;
    const sessions = Array.isArray(body.sessions) ? body.sessions : [];
    const count = $("#agent-sessions-count");
    if (count) count.textContent = String(sessions.length);
    const list = $("#agent-sessions-list");
    if (list) {
      list.replaceChildren();
      for (const row of sessions) list.append(rowView(row));
    }
    const status = $("#agent-sessions-status");
    if (!status) return;
    if (!sessions.length) status.textContent = q ? uiText("agentSessions.none") : uiText("agentSessions.empty");
    else status.textContent = body.truncated ? uiText("agentSessions.truncated") : "";
  }

  async function refresh() {
    if (!client?.session?.roomId || !panel()) return;
    const mine = ++seq;
    const q = $("#agent-sessions-query")?.value.trim() ?? "";
    const suffix = q ? `/agent-sessions?q=${encodeURIComponent(q)}` : "/agent-sessions";
    try {
      const body = await client.request(client.path(suffix));
      if (mine !== seq) return;
      enabled = body?.enabled === true;
      paint(body, q);
    } catch {
      if (mine !== seq || enabled !== true) return;
      const status = $("#agent-sessions-status");
      if (status) status.textContent = uiText("agentSessions.error");
    }
  }

  function shouldPoll() {
    if (enabled === false || !client?.session?.roomId) return false;
    const node = panel();
    return Boolean($("#people-panel")?.open) || Boolean(node && !node.hidden && node.open);
  }

  const search = $("#agent-sessions-search");
  if (search) search.addEventListener("submit", event => {
    event.preventDefault();
    if (timer) clearTimeout(timer);
    timer = 0;
    void refresh();
  });
  const query = $("#agent-sessions-query");
  if (query) query.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; void refresh(); }, 200);
  });
  const node = panel();
  if (node) node.addEventListener("toggle", () => { if (node.open && !node.hidden) void refresh(); });

  return { refresh, shouldPoll };
}
