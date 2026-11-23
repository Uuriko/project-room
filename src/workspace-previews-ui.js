import { uiText } from "./strings.js";
import { clipboard } from "./clipboard.js";

import { artifactDigest, workspaceArtifactLink, workspaceArtifactSelection } from "./workspace-artifact-link.js";

const changesIdentity = item => item && JSON.stringify([
  item.id, item.revision, item.publisherId, item.recipientId, item.base, item.head, item.patchDigest,
]);

// Preview code runs in an opaque frame with a separate response policy.
export function installWorkspacePreviews({ client, toolbar, memberLabel, captureThreadDraft, workThreadLink }) {
  const button = document.createElement("button");
  button.type = "button"; button.className = "topbar-button workspace-open";
  button.setAttribute("aria-label", "Workspace");
  button.title = "Workspace";
  button.setAttribute("aria-haspopup", "dialog");
  button.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18m-11 0v10"/></svg><span>Workspace</span>`;
  toolbar.prepend(button);
  const dialog = document.createElement("dialog");
  dialog.id = "room-project-workspace";
  dialog.setAttribute("aria-labelledby", "workspace-preview-title");
  dialog.innerHTML = `<div class="dialog-head"><h2 id="workspace-preview-title">Workspace</h2>
    <button type="button" data-preview-close class="button ghost">Close</button></div>
    <div class="workspace-previews-layout">
      <section aria-label="Shared previews">
        <button type="button" data-preview-refresh class="button secondary">Refresh previews</button>
        <div data-workspace-start hidden>
          <button type="button" class="button secondary" aria-describedby="workspace-start-status"></button>
          <p id="workspace-start-status" class="form-hint" role="status"></p>
          <textarea rows="4" readonly hidden></textarea>
        </div>
        <p data-preview-status role="status"></p>
        <ol data-preview-list></ol>
      </section>
      <section class="workspace-preview-detail" aria-label="Selected preview">
        <h3 data-preview-heading>Open a shared preview</h3>
        <p data-preview-meta class="form-hint"></p>
        <div class="workspace-link-actions">
          <button type="button" data-workspace-link class="button ghost" hidden></button>
          <button type="button" data-workspace-agent-copy class="button ghost" hidden></button>
          <button type="button" data-workspace-thread-draft class="button ghost" hidden></button>
          <button type="button" data-workspace-latest class="button secondary" hidden></button>
          <span data-workspace-link-status class="form-hint" role="status"></span>
        </div>
        <textarea data-workspace-link-fallback rows="3" readonly hidden></textarea>
        <div data-workspace-tabs role="tablist" aria-label="Attempt views" hidden>
          <button type="button" class="button ghost" role="tab" id="workspace-tab-preview" aria-controls="workspace-panel-preview" data-workspace-tab="preview">Preview</button>
          <button type="button" class="button ghost" role="tab" id="workspace-tab-changes" aria-controls="workspace-panel-changes" data-workspace-tab="changes">Changes</button>
          <button type="button" class="button ghost" role="tab" id="workspace-tab-output" aria-controls="workspace-panel-output" data-workspace-tab="output">Run output</button>
        </div>
        <section id="workspace-panel-changes" role="tabpanel" aria-labelledby="workspace-tab-changes" data-workspace-changes hidden>
          <label>Compare with <select data-workspace-compare><option value="">Choose another attempt</option></select></label>
          <p data-workspace-change-status class="form-hint" role="status"></p>
          <div class="workspace-change-columns"><section data-workspace-primary></section><section data-workspace-peer hidden></section></div>
        </section>
        <section id="workspace-panel-output" role="tabpanel" aria-labelledby="workspace-tab-output" hidden>
          <p data-workspace-output-status class="form-hint" role="status"></p>
          <pre data-workspace-output tabindex="0"></pre>
        </section>
        <section id="workspace-panel-preview" role="tabpanel" aria-labelledby="workspace-tab-preview" hidden>
        </section>
      </section>
    </div>`;
  document.body.append(dialog);

  const start = dialog.querySelector("[data-workspace-start]");
  const startButton = start.querySelector("button");
  const startStatus = start.querySelector("[role=status]");
  const startFallback = start.querySelector("textarea");
  startButton.textContent = uiText("workspace.start.copy");
  startFallback.setAttribute("aria-label", startButton.textContent);
  let startLink = "";
  function selectStart(link) {
    startLink = link;
    start.hidden = !link;
    startStatus.textContent = "";
    startFallback.hidden = true;
    startFallback.value = "";
  }
  startButton.addEventListener("click", async () => {
    const link = startLink;
    if (!link || link !== workThreadLink?.()) return;
    const text = uiText("workspace.start.agentText", { link });
    const result = await clipboard.copy(text);
    if (!dialog.open || startLink !== link || workThreadLink?.() !== link) return;
    startStatus.textContent = uiText(result === "copied" ? "workspace.share.agentCopied" : "workspace.share.agentManual");
    startFallback.hidden = result === "copied";
    if (result !== "copied") {
      startFallback.value = text;
      startFallback.select();
    }
  });

  const list = dialog.querySelector("[data-preview-list]");
  const heading = dialog.querySelector("[data-preview-heading]");
  const meta = dialog.querySelector("[data-preview-meta]");
  const status = dialog.querySelector("[data-preview-status]");
  const previewPanel = dialog.querySelector("#workspace-panel-preview");
  const tabs = dialog.querySelector("[data-workspace-tabs]");
  const tabButtons = [...tabs.querySelectorAll("[role=tab]")];
  const output = dialog.querySelector("[data-workspace-output]");
  const outputStatus = dialog.querySelector("[data-workspace-output-status]");
  const copyLink = dialog.querySelector("[data-workspace-link]");
  const copyForAgent = dialog.querySelector("[data-workspace-agent-copy]");
  const addToThread = dialog.querySelector("[data-workspace-thread-draft]");
  const linkStatus = dialog.querySelector("[data-workspace-link-status]");
  const linkFallback = dialog.querySelector("[data-workspace-link-fallback]");
  const latest = dialog.querySelector("[data-workspace-latest]");
  copyLink.textContent = uiText("workspace.share.copy");
  addToThread.textContent = uiText("workspace.share.threadDraft");
  copyForAgent.textContent = uiText("workspace.share.copyForAgent");
  latest.textContent = uiText("workspace.share.openCurrent");
  const changesView = dialog.querySelector("[data-workspace-changes]");
  const compare = dialog.querySelector("[data-workspace-compare]");
  const changeStatus = dialog.querySelector("[data-workspace-change-status]");
  const columns = dialog.querySelector(".workspace-change-columns");
  const primary = dialog.querySelector("[data-workspace-primary]");
  const peer = dialog.querySelector("[data-workspace-peer]");
  const changeCache = new Map();
  let selected = null, frame = null, frameDigest = null, generation = 0, changeGeneration = 0, outputGeneration = 0;
  let items = [], renderedChanges = null, renderedOutput = null, activePanel = "preview", linked = null, pendingFile = null, threadDraft = null;

  function choosePanel(name) {
    if (activePanel !== name) {
      linkFallback.hidden = true;
      linkStatus.textContent = "";
    }
    activePanel = name;
    for (const tab of tabButtons) {
      const active = tab.dataset.workspaceTab === name;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden = !active || tabs.hidden;
    }
  }
  function showPreview(current, session) {
    if (activePanel !== "preview" || !current || !session || frameDigest === current.digest) return;
    const query = new URLSearchParams({ id: current.id, frame: String(current.revision) });
    if (session.authMode === "account") {
      query.set("auth", "account");
      query.set("binding", session.sessionBinding);
    }
    if (!frame) {
      frame = document.createElement("iframe");
      frame.title = uiText("workspace.preview.frameTitle");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.referrerPolicy = "no-referrer";
    }
    frame.src = client.path(`/workspace-previews?${query}`);
    if (!frame.isConnected) previewPanel.append(frame);
    frameDigest = current.digest;
  }
  async function loadOutput() {
    const current = items.find(item => item.id === selected);
    if (!dialog.open || activePanel !== "output" || !current?.outputDigest) return;
    const key = [current.id, current.outputDigest].join(":");
    if (renderedOutput === key) return;
    const ticket = ++outputGeneration, session = client.session;
    const ownsOutput = () => dialog.open && activePanel === "output" && selected === current.id
      && client.session === session && outputGeneration === ticket;
    output.textContent = "";
    outputStatus.textContent = "Loading run output…";
    try {
      const query = new URLSearchParams({ output: "1", id: current.id, revision: String(current.revision) });
      const value = await client.roomRead(`/workspace-previews?${query}`);
      if (!value || !ownsOutput()) return;
      output.textContent = value.run.output ?? "";
      outputStatus.textContent = "";
      renderedOutput = key;
    } catch (error) {
      if (ownsOutput()) outputStatus.textContent = error.message || "Could not read run output.";
    }
  }
  async function loadChanges() {
    const session = client.session;
    if (!session || !dialog.open || changesView.hidden) return;
    const current = items.find(item => item.id === selected);
    if (!current?.patchDigest) return;
    const comparison = items.find(item => item.id === compare.value && item.base === current.base && item.patchDigest);
    const key = JSON.stringify([changesIdentity(current), changesIdentity(comparison)]);
    if (renderedChanges === key && !pendingFile && !columns.hidden) return;
    const ticket = ++changeGeneration;
    const stillOpen = () => dialog.open && ticket === changeGeneration && client.session === session;
    const readChanges = item => {
      const identity = changesIdentity(item);
      const ownsRead = () => stillOpen() && changesIdentity(items.find(entry => entry.id === item.id)) === identity;
      const artifact = new URL(workspaceArtifactLink(location.href, session.roomId, item, "changes")).hash;
      return async (view, path) => {
        if (!ownsRead()) return null;
        const pinned = view === "file" && linked?.head && item.id === current.id && linked.file === path;
        const query = new URLSearchParams({ id: item.id, changes: "1", revision: String(item.revision),
          artifact: pinned ? location.hash : artifact });
        if (view) query.set("view", view);
        if (path) query.set("path", path);
        const cacheKey = JSON.stringify([identity, query.toString()]);
        if (changeCache.has(cacheKey)) return changeCache.get(cacheKey);
        const value = await client.roomRead(`/workspace-previews?${query}`);
        if (!value || !ownsRead()) return null;
        changeCache.set(cacheKey, value.changes);
        if (changeCache.size > 32) changeCache.delete(changeCache.keys().next().value);
        return value.changes;
      };
    };
    columns.hidden = true;
    changeStatus.textContent = "Loading changes…";
    try {
      const file = pendingFile;
      const readCurrent = readChanges(current), readPeer = comparison && readChanges(comparison);
      const [{ renderWorkspaceChange }, a, b] = await Promise.all([
        import("./workspace-change-view.js"),
        file ? readCurrent("file", file) : readCurrent("summary"),
        readPeer ? readPeer("summary") : null,
      ]);
      if (!a || !stillOpen() || (comparison && !b)) return;
      renderWorkspaceChange(primary, current, a, readCurrent, file);
      pendingFile = null;
      peer.hidden = !comparison;
      if (comparison) renderWorkspaceChange(peer, comparison, b, readPeer);
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
    if (!current.patchDigest) return;
    const previous = compare.value;
    const eligible = items.filter(item => item.id !== current.id && item.base === current.base && item.patchDigest);
    compare.replaceChildren(new Option("Choose another attempt", ""), ...eligible.map(item => new Option(item.title, item.id)));
    compare.disabled = eligible.length === 0;
    if (eligible.some(item => item.id === previous)) compare.value = previous;
    void loadChanges();
  }
  const owns = (ticket, session) => dialog.open && generation === ticket && client.session === session;
  function clearPreview() {
    frameDigest = null; changeGeneration++; outputGeneration++;
    renderedChanges = null; renderedOutput = null;
    tabs.hidden = true;
    choosePanel("preview");
    output.textContent = ""; outputStatus.textContent = "";
    latest.hidden = true; copyLink.hidden = true; copyForAgent.hidden = true; addToThread.hidden = true; linkFallback.hidden = true; linkStatus.textContent = "";
    primary.replaceChildren(); peer.replaceChildren(); peer.hidden = true;
    compare.value = ""; changeStatus.textContent = "";
    frame?.remove(); frame = null;
    heading.textContent = "Open a shared preview";
    meta.textContent = "";
  }
  function reset() {
    selectStart("");
    generation++; selected = null; linked = null; pendingFile = null; threadDraft = null; clearPreview();
    status.textContent = ""; list.replaceChildren(); items = []; changeCache.clear();
    if (dialog.open) dialog.close();
  }
  function select(id) {
    selected = id; linked = null; pendingFile = null;
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
      if (selected && !current) { if (!linked) selected = null; clearPreview(); }
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
      if (linked && (!current || current.revision !== linked.revision || current.publisherId !== linked.publisherId
        || (linked.head && current.head !== linked.head)
        || artifactDigest(current, linked.panel) !== linked.digest)) {
        clearPreview();
        linkStatus.textContent = uiText(current ? "workspace.share.stale" : "workspace.share.missing");
        latest.hidden = !current;
        return;
      }
      if (!current) return;
      tabs.hidden = false;
      for (const tab of tabButtons) {
        tab.hidden = tab.dataset.workspaceTab === "changes" ? !current.patchDigest
          : tab.dataset.workspaceTab === "output" ? !current.outputDigest : false;
      }
      const activeTab = tabButtons.find(tab => tab.dataset.workspaceTab === activePanel);
      choosePanel(activeTab.hidden ? "preview" : activePanel);
      copyLink.hidden = false;
      copyForAgent.hidden = false;
      addToThread.hidden = !threadDraft || Boolean(current.recipientId);
      updateComparisons(current);
      void loadOutput();
      heading.textContent = current.title;
      meta.textContent = uiText("workspace.preview.source", {
        name: memberLabel(current.publisherId) || current.publisherId,
        head: current.head.slice(0, 12), revision: current.revision,
      });
      showPreview(current, session);
    } catch (error) {
      if (!owns(ticket, session)) return;
      clearPreview();
      status.textContent = error.message || "Could not open previews.";
    }
  }
  function activate(tab) {
    outputGeneration++;
    choosePanel(tab.dataset.workspaceTab);
    if (activePanel === "changes") void loadChanges();
    if (activePanel === "output") void loadOutput();
    showPreview(items.find(item => item.id === selected), client.session);
  }
  for (const tab of tabButtons) tab.addEventListener("click", () => activate(tab));
  tabs.addEventListener("keydown", event => {
    const enabled = tabButtons.filter(tab => !tab.hidden);
    const index = enabled.indexOf(event.target);
    if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = event.key === "Home" ? enabled[0] : event.key === "End" ? enabled.at(-1)
      : enabled[(index + step + enabled.length) % enabled.length];
    next.focus();
    activate(next);
  });
  compare.addEventListener("change", () => void loadChanges());
  latest.addEventListener("click", () => void select(selected));
  function shareSelection() {
    const current = items.find(item => item.id === selected), session = client.session;
    if (!current || !session || copyLink.hidden) return null;
    const panel = activePanel;
    const file = panel === "changes" && !columns.hidden ? primary.querySelector("[aria-current=true]")?.dataset.file : undefined;
    const link = workspaceArtifactLink(location.href, session.roomId, current, panel, file);
    return link ? { current, session, panel, link } : null;
  }

  async function copySelection(forAgent) {
    const snapshot = shareSelection();
    if (!snapshot) return;
    const { current, session, panel, link } = snapshot;
    const copiedText = forAgent ? uiText("workspace.share.agentText", { link, head: current.head }) : link;
    const result = await clipboard.copy(copiedText);
    if (!dialog.open || client.session !== session || selected !== current.id || panel !== activePanel
      || items.find(item => item.id === selected)?.revision !== current.revision) return;
    linkFallback.hidden = result === "copied";
    if (result === "copied") linkStatus.textContent = uiText(forAgent ? "workspace.share.agentCopied" : "workspace.share.copied");
    else {
      linkStatus.textContent = uiText(forAgent ? "workspace.share.agentManual" : "workspace.share.manual");
      linkFallback.setAttribute("aria-label", forAgent ? copyForAgent.textContent : copyLink.textContent);
      linkFallback.value = copiedText;
      linkFallback.hidden = false;
      linkFallback.select();
    }
  }
  copyLink.addEventListener("click", () => void copySelection(false));
  copyForAgent.addEventListener("click", () => void copySelection(true));
  addToThread.addEventListener("click", async () => {
    const snapshot = shareSelection(), destination = threadDraft;
    if (!snapshot || addToThread.hidden || addToThread.disabled || !destination) return;
    addToThread.disabled = true;
    try {
      const { current, session, panel, link } = snapshot;
      const query = new URLSearchParams({ id: current.id });
      const observed = await client.roomRead(`/workspace-previews?${query}`);
      if (!dialog.open || threadDraft !== destination || client.session !== session || shareSelection()?.link !== link) return;
      const item = observed?.item;
      if (!item || item.recipientId || item.revision !== current.revision || item.head !== current.head
        || item.publisherId !== current.publisherId || artifactDigest(item, panel) !== artifactDigest(current, panel)) {
        linkStatus.textContent = uiText("workspace.share.stale"); return;
      }
      if (!destination(link)) {
        linkStatus.textContent = uiText("workspace.share.threadUnavailable"); return;
      }
      reset();
      document.querySelector("#message-input")?.focus();
    } catch {
      if (dialog.open && threadDraft === destination) linkStatus.textContent = uiText("workspace.share.threadUnavailable");
    } finally { addToThread.disabled = false; }
  });
  button.addEventListener("click", () => {
    if (!client.session || dialog.open) return;
    threadDraft = captureThreadDraft?.() ?? null;
    selectStart(workThreadLink?.() ?? "");
    dialog.showModal();
    void load();
  });
  dialog.querySelector("[data-preview-close]").addEventListener("click", reset);
  dialog.querySelector("[data-preview-refresh]").addEventListener("click", () => void load());
  dialog.addEventListener("close", () => { if (!dialog.open) reset(); });
  return {
    reset,
    refresh() { if (dialog.open) void load(); },
    openLink(hash) {
      const target = workspaceArtifactSelection(hash);
      if (!target || !client.session) return;
      clearPreview();
      selectStart("");
      threadDraft = null; linked = target; pendingFile = target.file ?? null; selected = target.id; activePanel = target.panel;
      if (!dialog.open) dialog.showModal();
      void load();
    },
    closeLinked() { if (linked) reset(); },
  };
}
