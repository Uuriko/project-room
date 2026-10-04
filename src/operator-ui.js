// Operator console (operator.html). Token-only: the operator token is kept in
// sessionStorage for this tab and sent as `Authorization: Operator <token>`.
// It is never written to localStorage or a cookie. Every action goes through
// the typed /api/operator/* endpoints; a purge is always find -> plan ->
// review counts -> typed confirmation -> execute.

export const TOKEN_KEY = "roomOperatorToken";

// What the operator must type before execute is enabled: the room title for a
// single-room plan (the id when no title is known), otherwise a count phrase.
export function confirmationPhrase(targets, titles = new Map()) {
  if (targets.length === 1 && targets[0].kind === "room") return titles.get(targets[0].id) || targets[0].id;
  return `purge ${targets.length} target${targets.length === 1 ? "" : "s"}`;
}

export function describeFailure(status, body) {
  if (status === 404) return "The token was not accepted, or the operator surface is not configured on this deployment.";
  if (status === 429) return "Too many operator calls from this address. Wait a minute and try again.";
  if (status === 409 && body?.error?.code === "plan_changed") return "The data changed after this plan was made. Nothing was deleted. Plan again.";
  const message = body?.error?.message;
  return message ? `Refused (${status}): ${message}` : `Request failed with status ${status}.`;
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
    await guarded(async () => { await loadStatus(); await loadActions(); say("Connected."); });
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
