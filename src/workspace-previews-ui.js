// Preview code runs in an opaque frame with a separate response policy.
export function installWorkspacePreviews({ client, toolbar, memberLabel }) {
  const button = document.createElement("button");
  button.type = "button"; button.className = "topbar-button"; button.textContent = "Workspace";
  button.setAttribute("aria-haspopup", "dialog");
  toolbar.prepend(button);
  const dialog = document.createElement("dialog");
  dialog.id = "room-project-workspace";
  dialog.setAttribute("aria-labelledby", "workspace-preview-title");
  dialog.innerHTML = `<div class="dialog-head"><h2 id="workspace-preview-title">Workspace</h2>
    <button type="button" data-preview-close class="button ghost">Close</button></div>
    <div class="workspace-previews-layout">
      <section aria-label="Shared previews">
        <button type="button" data-preview-refresh class="button secondary">Refresh previews</button>
        <p data-preview-status role="status"></p>
        <ol data-preview-list></ol>
      </section>
      <section class="workspace-preview-detail" aria-label="Selected preview">
        <h3 data-preview-heading>Open a shared preview</h3>
        <p data-preview-meta class="form-hint"></p>
        <details data-workspace-changes hidden>
          <summary>Changes</summary>
          <label>Compare with <select data-workspace-compare><option value="">Choose another attempt</option></select></label>
          <p data-workspace-change-status class="form-hint" role="status"></p>
          <div class="workspace-change-columns"><section data-workspace-primary></section><section data-workspace-peer hidden></section></div>
        </details>
        <iframe title="Shared project preview" sandbox="allow-scripts" referrerpolicy="no-referrer" hidden></iframe>
      </section>
    </div>`;
  document.body.append(dialog);

  const list = dialog.querySelector("[data-preview-list]");
  const heading = dialog.querySelector("[data-preview-heading]");
  const meta = dialog.querySelector("[data-preview-meta]");
  const status = dialog.querySelector("[data-preview-status]");
  const frame = dialog.querySelector("iframe");
  const changesView = dialog.querySelector("[data-workspace-changes]");
  const compare = dialog.querySelector("[data-workspace-compare]");
  const changeStatus = dialog.querySelector("[data-workspace-change-status]");
  const columns = dialog.querySelector(".workspace-change-columns");
  const primary = dialog.querySelector("[data-workspace-primary]");
  const peer = dialog.querySelector("[data-workspace-peer]");
  const patchCache = new Map();
  let selected = null, revision = null, generation = 0, changeGeneration = 0, items = [], renderedChanges = null;
  async function loadChanges() {
    if (!dialog.open || !changesView.open) return;
    const current = items.find(item => item.id === selected);
    if (!current?.patchDigest) return;
    const comparison = items.find(item => item.id === compare.value && item.base === current.base && item.patchDigest);
    const ticket = ++changeGeneration, session = client.session;
    const stillOpen = () => dialog.open && changesView.open && ticket === changeGeneration && client.session === session;
    const key = JSON.stringify([current.id, current.revision, comparison?.id, comparison?.revision]);
    if (renderedChanges === key) return;
    columns.hidden = true;
    changeStatus.textContent = "Loading changes…";
    try {
      const getPatch = async item => {
        const cached = patchCache.get(item.id);
        if (cached?.revision === item.revision) return cached.patch;
        const query = new URLSearchParams({ id: item.id, changes: "1", revision: String(item.revision) });
        const value = await client.roomRead(`/workspace-previews?${query}`);
        if (!value || !stillOpen()) return null;
        patchCache.set(item.id, value.changes);
        return value.changes.patch;
      };
      const [{ renderWorkspaceChange }, a, b] = await Promise.all([
        import("./workspace-change-view.js"), getPatch(current), comparison ? getPatch(comparison) : null,
      ]);
      if (!stillOpen()) return;
      renderWorkspaceChange(primary, current, a);
      peer.hidden = !comparison;
      if (comparison) renderWorkspaceChange(peer, comparison, b);
      else peer.replaceChildren();
      columns.hidden = false;
      changeStatus.textContent = "";
      renderedChanges = key;
    } catch (error) {
      if (!stillOpen()) return;
      primary.replaceChildren(); peer.replaceChildren(); peer.hidden = true;
      renderedChanges = null;
      changeStatus.textContent = error.message || "Could not read changes.";
    }
  }
  function updateComparisons(current) {
    changesView.hidden = !current.patchDigest;
    if (changesView.hidden) return;
    const previous = compare.value;
    const eligible = items.filter(item => item.id !== current.id && item.base === current.base && item.patchDigest);
    compare.replaceChildren(new Option("Choose another attempt", ""), ...eligible.map(item => new Option(item.title, item.id)));
    compare.disabled = eligible.length === 0;
    if (eligible.some(item => item.id === previous)) compare.value = previous;
    void loadChanges();
  }
  const owns = (ticket, session) => dialog.open && generation === ticket && client.session === session;
  function clearPreview() {
    revision = null; changeGeneration++;
    renderedChanges = null;
    changesView.open = false; changesView.hidden = true;
    primary.replaceChildren(); peer.replaceChildren(); peer.hidden = true;
    compare.value = ""; changeStatus.textContent = "";
    frame.removeAttribute("src");
    frame.hidden = true;
    heading.textContent = "Open a shared preview";
    meta.textContent = "";
  }
  function reset() {
    generation++; selected = null; clearPreview();
    status.textContent = ""; list.replaceChildren(); items = []; patchCache.clear();
    if (dialog.open) dialog.close();
  }
  function select(id) {
    selected = id;
    clearPreview();
    return load();
  }
  async function load() {
    const ticket = ++generation, session = client.session;
    if (!session) return;
    status.textContent = "Loading previews…";
    try {
      const page = await client.roomRead("/workspace-previews");
      if (!page || !owns(ticket, session)) return;
      items = page.items;
      const current = items.find(item => item.id === selected);
      if (selected && !current) { selected = null; clearPreview(); }
      const focused = document.activeElement?.dataset?.previewId;
      list.replaceChildren(...page.items.map(item => {
        const row = document.createElement("li");
        const choice = document.createElement("button");
        const title = document.createElement("strong");
        const author = document.createElement("span");
        title.textContent = item.title;
        author.textContent = memberLabel(item.publisherId) || item.publisherId;
        choice.type = "button"; choice.dataset.previewId = item.id;
        choice.setAttribute("aria-pressed", String(selected === item.id));
        choice.append(title, author);
        choice.addEventListener("click", () => void select(item.id));
        row.append(choice);
        return row;
      }));
      if (focused) list.querySelector(`[data-preview-id="${CSS.escape(focused)}"]`)?.focus();
      status.textContent = page.items.length ? "" : "No previews shared yet. An agent can publish one with room workspace.";
      if (!current) return;
      updateComparisons(current);
      if (revision === current.revision) return;
      const query = new URLSearchParams({ id: current.id, frame: String(current.revision) });
      if (session.authMode === "account") {
        query.set("auth", "account");
        query.set("binding", session.sessionBinding);
      }
      frame.src = client.path(`/workspace-previews?${query}`);
      frame.hidden = false;
      heading.textContent = current.title;
      meta.textContent = `${memberLabel(current.publisherId) || current.publisherId} · ${current.head.slice(0, 12)} · Preview ${current.revision}`;
      revision = current.revision;
    } catch (error) {
      if (!owns(ticket, session)) return;
      clearPreview();
      status.textContent = error.message || "Could not open previews.";
    }
  }
  changesView.addEventListener("toggle", () => {
    if (changesView.open) void loadChanges();
    else changeGeneration++;
  });
  compare.addEventListener("change", () => void loadChanges());
  button.addEventListener("click", () => {
    if (!client.session || dialog.open) return;
    dialog.showModal();
    void load();
  });
  dialog.querySelector("[data-preview-close]").addEventListener("click", reset);
  dialog.querySelector("[data-preview-refresh]").addEventListener("click", () => void load());
  dialog.addEventListener("close", () => { if (!dialog.open) reset(); });
  return { reset, refresh() { if (dialog.open) void load(); } };
}
