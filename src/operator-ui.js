// Operator console (operator.html). Token-only: the operator token is kept in
// sessionStorage for this tab and sent as `Authorization: Operator <token>`.
// It is never written to localStorage or a cookie. Every action goes through
// the typed /api/operator/* endpoints; a purge is always find -> plan ->
// review counts -> typed confirmation -> execute.
import { humanErrorMessage } from "./error-copy.js";

export const TOKEN_KEY = "roomOperatorToken";

// What the operator must type before execute is enabled: the room title for a
// single-room plan (the id when no title is known), otherwise a count phrase.
export function confirmationPhrase(targets, titles = new Map()) {
  if (targets.length === 1 && targets[0].kind === "room") return titles.get(targets[0].id) || targets[0].id;
  return `purge ${targets.length} target${targets.length === 1 ? "" : "s"}`;
}

// MGMT-PANEL Slice 1: the export URL for one room. A room that is not
// lifecycle-archived needs the typed room id and a reason in the query
// (MF-6); an archived room exports with neither. The server verifies both
// cases and writes the audit row; this helper only builds the path.
export function operatorExportPath(room, { format = "jsonl", confirmRoomId = "", reason = "" } = {}) {
  const params = new URLSearchParams({ format });
  if (!room.archived) {
    params.set("confirmRoomId", confirmRoomId);
    params.set("reason", reason);
  }
  return `/api/operator/rooms/${encodeURIComponent(room.id)}/export?${params.toString()}`;
}

export function describeFailure(status, body) {
  if (status === 404) return "The token was not accepted, or the operator surface is not configured on this deployment.";
  if (status === 429) return "Too many operator calls from this address. Wait a minute and try again.";
  if (status === 409 && body?.error?.code === "plan_changed") return "The data changed after this plan was made. Nothing was deleted. Plan again.";
  // The shared human error copy resolves specific per-code messages, a
  // status fallback, and a non-generic final fallthrough.
  return humanErrorMessage({ status, code: body?.error?.code, message: body?.error?.message });
}

function el(tag, text, attrs = {}) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = String(text);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function row(cells) {
  const tr = document.createElement("tr");
  for (const cell of cells) tr.append(el("td", cell));
  return tr;
}

function when(ms) {
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(ms);
}

function init() {
  const $ = id => document.getElementById(id);
  const message = $("op-message");
  const titles = new Map();
  let targets = [];
  let plan = null;

  const token = () => sessionStorage.getItem(TOKEN_KEY);
  const say = text => { message.textContent = text; };

  async function call(path, { method = "GET", data } = {}) {
    const response = await fetch(path, {
      method,
      credentials: "omit",
      headers: { Authorization: `Operator ${token()}`, ...(data !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {})
    });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      const error = new Error(describeFailure(response.status, body));
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function showSignedIn(on) {
    $("op-console").hidden = !on;
    $("op-token-state").hidden = !on;
    $("op-token-form").hidden = on;
  }

  async function loadStatus() {
    const status = await call("/api/operator/status");
    const facts = $("op-status");
    facts.replaceChildren();
    const add = (term, value) => { facts.append(el("dt", term), el("dd", value)); };
    add("Deployed commit", status.version?.sourceRevision ?? "unknown");
    add("Build", status.version?.buildId ?? "unknown");
    add("Ready", status.ready ? "yes" : "no");
    add("Jobs", typeof status.jobs === "string" ? status.jobs : JSON.stringify(status.jobs));
    add("Last cold start", status.lastColdStart == null ? "not recorded" : String(status.lastColdStart));
    add("Table counts", status.partial ? "partial (deadline reached)" : "complete");
    if (status.skippedTables?.length) add("Tables skipped", status.skippedTables.join(", "));
    const body = $("op-tables").tBodies[0];
    body.replaceChildren(...(status.tables ?? []).map(t => row([t.table, t.rows])));
  }

  async function loadActions() {
    const { actions } = await call("/api/operator/actions?limit=20");
    const body = $("op-actions").tBodies[0];
    body.replaceChildren(...actions.map(a => row([when(a.at), a.action, a.targetKind ? `${a.targetKind} ${a.targetId ?? "(batch)"}` : "", a.result, a.reason ?? ""])));
  }

  let exportRoom = null;

  async function downloadExport(room, options) {
    const response = await fetch(operatorExportPath(room, options), {
      credentials: "omit",
      headers: { Authorization: `Operator ${token()}` }
    });
    if (!response.ok) {
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      const error = new Error(describeFailure(response.status, body));
      error.status = response.status;
      throw error;
    }
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const named = /filename="([^"]+)"/.exec(disposition)?.[1];
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = named ?? `room-${room.id}-export.${options.format === "html" ? "html" : "jsonl"}`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    say(`Exported room ${room.id}. The export is as sensitive as the room itself; keep it private and delete it when its purpose is done.`);
    await loadActions();
  }

  function openExport(room) {
    exportRoom = room;
    $("op-export-room").textContent = room.archived
      ? `Export room ${room.id}. It is archived, so no typed confirmation is needed.`
      : `Export room ${room.id}. It is not archived: type its id and a reason. Both are checked by the server and the reason is kept in the audit log.`;
    $("op-export-confirm-id").disabled = room.archived;
    $("op-export-reason").disabled = room.archived;
    $("op-export-confirm-id").value = "";
    $("op-export-reason").value = "";
    $("op-export-panel").hidden = false;
  }

  async function loadRooms() {
    const data = await call("/api/operator/rooms?limit=100");
    $("op-rooms-read-at").textContent = `Read at ${when(data.readAt)}${data.truncated ? " — list truncated at 100 rooms" : ""}.`;
    const body = $("op-rooms").tBodies[0];
    const rows = [];
    for (const room of data.rooms ?? []) {
      if (room.title) titles.set(room.id, room.title);
      const tr = document.createElement("tr");
      const name = el("td");
      name.append(el("span", room.title ?? room.id), el("br"), el("code", room.id));
      const size = el("td", `${room.projectionBytes} bytes`);
      const cap = document.createElement("td");
      const bar = el("div", null, { class: "op-bar", role: "img", "aria-label": `${Math.round((room.percentOfCap ?? 0) * 100)} percent of cap` });
      const fill = el("div", null, { class: "op-bar-fill" });
      fill.style.width = `${Math.min(100, Math.max(0, (room.percentOfCap ?? 0) * 100))}%`;
      bar.append(fill);
      cap.append(bar, el("span", `${((room.percentOfCap ?? 0) * 100).toFixed(1)}%`));
      const members = Object.entries(room.activeMembersByKind ?? {}).map(([kind, count]) => `${kind} ${count}`).join(", ") || "none";
      const state = [room.archived ? "archived" : "open", room.protected ? "protected" : null, room.messagesArchived ? "messages archived" : null].filter(Boolean).join(", ");
      const action = document.createElement("td");
      const button = el("button", "Export", { type: "button", "aria-label": `Export room ${room.id}` });
      button.addEventListener("click", () => {
        if (room.archived) guarded(() => downloadExport(room, { format: "jsonl" }));
        else openExport(room);
      });
      action.append(button);
      tr.append(name, size, cap, el("td", room.headSeq), el("td", members), el("td", state), action);
      rows.push(tr);
    }
    body.replaceChildren(...rows);
  }

  function renderTargets() {
    const list = $("op-targets");
    list.replaceChildren();
    if (!targets.length) list.append(el("li", "No targets yet. Add them from Find or by id."));
    for (const target of targets) {
      const item = el("li");
      item.append(el("span", `${target.kind} ${target.id}${titles.get(target.id) ? ` · ${titles.get(target.id)}` : ""}`));
      const remove = el("button", "Remove", { type: "button", "aria-label": `Remove ${target.kind} ${target.id}` });
      remove.addEventListener("click", () => { targets = targets.filter(t => t !== target); clearPlan(); renderTargets(); });
      item.append(remove);
      list.append(item);
    }
    $("op-plan-button").disabled = targets.length === 0;
  }

  function addTarget(kind, id, title) {
    if (title) titles.set(id, title);
    if (!targets.some(t => t.kind === kind && t.id === id)) targets.push({ kind, id });
    clearPlan();
    renderTargets();
  }

  function clearPlan() {
    plan = null;
    $("op-plan").hidden = true;
    $("op-confirm").value = "";
    $("op-execute").disabled = true;
  }

  function renderPlan() {
    $("op-plan").hidden = false;
    $("op-plan-summary").textContent = `Plan ${plan.planId} deletes ${plan.totalRows} rows across ${plan.targets.length} target${plan.targets.length === 1 ? "" : "s"}. It expires at ${when(plan.expiresAt)}.`;
    $("op-plan-warnings").replaceChildren(...(plan.warnings ?? []).map(w => el("li", typeof w === "string" ? w : w.message ?? JSON.stringify(w))));
    const counts = (plan.counts ?? []).filter(c => c.rows > 0);
    $("op-plan-counts").tBodies[0].replaceChildren(...counts.map(c => row([c.table, c.action === "retain" ? `keep (${c.reason ?? "retained"})` : "delete", c.rows])));
    $("op-confirm-phrase").textContent = confirmationPhrase(plan.targets, titles);
    $("op-confirm").value = "";
    $("op-execute").disabled = true;
  }

  async function guarded(work) {
    try { await work(); }
    catch (error) {
      say(error.message);
      if (error.status === 404) { sessionStorage.removeItem(TOKEN_KEY); showSignedIn(false); }
    }
  }

  async function start() {
    showSignedIn(true);
    renderTargets();
    await guarded(async () => { await loadStatus(); await loadRooms(); await loadActions(); say("Connected."); });
  }

  $("op-token-form").addEventListener("submit", event => {
    event.preventDefault();
    const value = $("op-token").value.trim();
    if (!value) return;
    sessionStorage.setItem(TOKEN_KEY, value);
    $("op-token").value = "";
    start();
  });
  $("op-forget").addEventListener("click", () => {
    sessionStorage.removeItem(TOKEN_KEY);
    targets = [];
    clearPlan();
    showSignedIn(false);
    say("Token forgotten.");
  });
  $("op-status-refresh").addEventListener("click", () => guarded(loadStatus));
  $("op-rooms-refresh").addEventListener("click", () => guarded(loadRooms));
  $("op-export-cancel").addEventListener("click", () => { exportRoom = null; $("op-export-panel").hidden = true; });
  $("op-export-form").addEventListener("submit", event => {
    event.preventDefault();
    if (!exportRoom) return;
    const room = exportRoom;
    guarded(async () => {
      await downloadExport(room, {
        format: $("op-export-format").value,
        confirmRoomId: $("op-export-confirm-id").value.trim(),
        reason: $("op-export-reason").value.trim()
      });
      exportRoom = null;
      $("op-export-panel").hidden = true;
    });
  });
  $("op-actions-refresh").addEventListener("click", () => guarded(loadActions));
  $("op-drift-form").addEventListener("submit", event => {
    event.preventDefault();
    guarded(async () => {
      const sha = $("op-drift-sha").value.trim();
      const drift = await call(`/api/operator/drift?main=${encodeURIComponent(sha)}`);
      $("op-drift").textContent = drift.match ? `Production matches ${drift.main}.` : `Production is on ${drift.deployed}, not ${drift.main}.`;
    });
  });
  $("op-find-form").addEventListener("submit", event => {
    event.preventDefault();
    guarded(async () => {
      const data = {};
      for (const [key, value] of new FormData(event.target)) if (String(value).trim()) data[key] = String(value).trim();
      const found = await call("/api/operator/purge/find", { method: "POST", data });
      const list = $("op-find-results");
      list.replaceChildren();
      const entries = [
        ...(found.rooms ?? []).map(r => ({ kind: "room", id: r.id, label: r.title })),
        ...(found.identities ?? []).map(r => ({ kind: "identity", id: r.id, label: r.displayName })),
        ...(found.accounts ?? []).map(r => ({ kind: "account", id: r.id, label: r.displayName }))
      ];
      if (!entries.length) list.append(el("li", "Nothing matched."));
      for (const entry of entries) {
        const item = el("li");
        item.append(el("span", `${entry.kind} ${entry.id}${entry.label ? ` · ${entry.label}` : ""}`));
        const add = el("button", "Add to plan", { type: "button", "aria-label": `Add ${entry.kind} ${entry.id} to the plan` });
        add.addEventListener("click", () => addTarget(entry.kind, entry.id, entry.kind === "room" ? entry.label : null));
        item.append(add);
        list.append(item);
      }
      say(`Found ${entries.length}${found.truncated ? " (more exist; narrow the filter)" : ""}. Nothing was deleted.`);
    });
  });
  $("op-add-form").addEventListener("submit", event => {
    event.preventDefault();
    const id = $("op-add-id").value.trim();
    if (!id) return;
    addTarget($("op-add-kind").value, id, null);
    $("op-add-id").value = "";
  });
  $("op-plan-form").addEventListener("submit", event => {
    event.preventDefault();
    guarded(async () => {
      plan = await call("/api/operator/purge/plan", {
        method: "POST",
        data: { targets, reason: $("op-reason").value.trim(), ...($("op-allow-active").checked ? { allowActiveMembers: true } : {}) }
      });
      renderPlan();
      say("Plan ready. Review the counts, then type the confirmation.");
    });
  });
  $("op-confirm").addEventListener("input", () => {
    $("op-execute").disabled = !plan || $("op-confirm").value !== confirmationPhrase(plan.targets, titles);
  });
  $("op-execute-form").addEventListener("submit", event => {
    event.preventDefault();
    if (!plan || $("op-confirm").value !== confirmationPhrase(plan.targets, titles)) return;
    guarded(async () => {
      const done = await call("/api/operator/purge/execute", { method: "POST", data: { planId: plan.planId, confirmToken: plan.confirmToken } });
      say(`Purged ${done.totalRows} rows across ${done.targets.length} target${done.targets.length === 1 ? "" : "s"}.`);
      targets = [];
      clearPlan();
      renderTargets();
      await loadActions();
    });
  });

  if (token()) start(); else showSignedIn(false);
}

if (typeof document !== "undefined" && document.getElementById("operator")) init();
