import { uiText } from "./strings.js";
import { clipboard } from "./clipboard.js";

import { artifactDigest, workspaceArtifactLink, workspaceArtifactSelection } from "./workspace-artifact-link.js";

const changesIdentity = item => item && JSON.stringify([
  item.id, item.revision, item.publisherId, item.recipientId, item.base, item.head, item.patchDigest,
]);

// Preview code runs in an opaque frame with a separate response policy.
export function installWorkspacePreviews({ client, toolbar, memberLabel, captureThreadDraft, workThread }) {
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
        <aside data-workspace-discussion hidden>
          <h3>Discussion</h3>
          <div data-discussion-messages></div>
          <a data-discussion-link target="_blank" rel="noopener">Open full discussion</a>
        </aside>
      </section>
      <section class="workspace-preview-detail" aria-label="Selected preview">
        <h3 data-preview-heading>Open a shared preview</h3>
        <p data-preview-meta class="form-hint"></p>
        <label data-workspace-note hidden>Instruction for this version
          <textarea rows="2" maxlength="2000"></textarea>
        </label>
        <div class="workspace-link-actions">
          <button type="button" data-workspace-live class="button secondary" hidden></button>
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
          <label hidden>Compare with <select data-workspace-compare><option value="">Choose another attempt</option></select></label>
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
  let selectedStart;
  function selectStart(thread) {
    selectedStart = thread;
    start.hidden = !thread;
    startStatus.textContent = "";
    startFallback.hidden = true;
    startFallback.value = "";
  }
  startButton.addEventListener("click", async () => {
    const thread = selectedStart;
    if (!thread || thread.link !== workThread?.()?.link) return;
    const text = uiText("workspace.start.agentText", { workId: thread.id, link: thread.link });
    const result = await clipboard.copy(text);
    if (!dialog.open || selectedStart !== thread || workThread?.()?.link !== thread.link) return;
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
  const openLive = dialog.querySelector("[data-workspace-live]");
  const copyForAgent = dialog.querySelector("[data-workspace-agent-copy]");
  const addToThread = dialog.querySelector("[data-workspace-thread-draft]");
  const linkStatus = dialog.querySelector("[data-workspace-link-status]");
  const linkFallback = dialog.querySelector("[data-workspace-link-fallback]");
  const latest = dialog.querySelector("[data-workspace-latest]");
  copyLink.textContent = uiText("workspace.share.copy");
  openLive.textContent = uiText("workspace.live.open");
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
  let items = [], renderedChanges = null, renderedOutput = null, activePanel = "preview", linked = null, pendingFile = null, reviewLocation = null, threadDraft = null;

  const discussionAside = dialog.querySelector("[data-workspace-discussion]");
  const discussionMessages = discussionAside.querySelector("[data-discussion-messages]");
  const noteLabel = dialog.querySelector("[data-workspace-note]");
  const noteInput = noteLabel.querySelector("textarea");
  const notes = new Map();
  let noteKey = null;
  noteInput.addEventListener("input", () => {
    if (noteKey) notes.set(noteKey, noteInput.value);
    linkStatus.textContent = ""; linkFallback.hidden = true; linkFallback.value = "";
  });
  function refreshDiscussion() {
    if (!dialog.open) return;
    // A conversation can remain authorized after its artifact expires or changes.
    const canUseArtifact = !copyLink.hidden;
    const discussion = (canUseArtifact || linked) && threadDraft?.discussion();
    discussionAside.hidden = !discussion;
    addToThread.hidden = !canUseArtifact || !discussion || Boolean(items.find(item => item.id === selected)?.recipientId);
    discussionMessages.replaceChildren();
    const source = discussionAside.querySelector("[data-discussion-link]");
    if (discussion) source.href = discussion.link;
    else source.removeAttribute("href");
    for (const message of canUseArtifact ? discussion?.messages ?? [] : []) {
      const line = document.createElement("p");
      line.textContent = [message.author, message.excerpt].join(" · ");
      discussionMessages.append(line);
    }
  }

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
      return async (view, path) => {
        if (!ownsRead()) return null;
        const artifact = new URL(workspaceArtifactLink(location.href, session.roomId, item, "changes", path)).hash;
        const query = new URLSearchParams({ id: item.id, changes: "1", revision: String(item.revision),
          artifact });
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
      const note = reviewLocation?.publisherId === current.publisherId ? reviewLocation : null;
      const readCurrent = readChanges(current), readPeer = comparison && readChanges(comparison);
      const [{ renderWorkspaceChange }, a, b] = await Promise.all([
        import("./workspace-change-view.js"),
        file ? readCurrent("file", file).catch(error => {
          if (!note || error.status !== 404) throw error;
          return readCurrent("summary");
        }) : readCurrent("summary"),
        readPeer ? readPeer("summary") : null,
      ]);
      if (!a || !stillOpen() || (comparison && !b)) return;
      const exact = note?.revision === current.revision && note.head === current.head && note.digest === current.patchDigest;
      const selectedFile = a.file ? (a.file.newPath === "/dev/null" ? a.file.oldPath : a.file.newPath || a.file.oldPath) : undefined;
      renderWorkspaceChange(primary, current, a, readCurrent, {
        file: !note || a.file ? file : undefined,
        review: note && selectedFile ? { file: selectedFile, anchor: note.anchor, exact } : null,
      });
      pendingFile = null;
      peer.hidden = !comparison;
      if (comparison) renderWorkspaceChange(peer, comparison, b, readPeer, { shareHunks: false });
      else peer.replaceChildren();
      if (comparison) {
        for (const [column, item] of [[primary, current], [peer, comparison]]) {
          const pick = document.createElement("button");
          pick.type = "button";
          pick.className = "button secondary";
          pick.textContent = uiText("workspace.chooseVersion");
          pick.setAttribute("aria-label", uiText("workspace.chooseVersionNamed", { title: item.title }));
          pick.addEventListener("click", async () => {
            if (!stillOpen()) return;
            const url = workspaceArtifactLink(location.href, session.roomId, item, "changes");
            clearPreview();
            linked = workspaceArtifactSelection(new URL(url).hash);
            selected = item.id; pendingFile = null; reviewLocation = null;
            activePanel = "preview";
            await load();
            if (dialog.open && selected === item.id && !noteLabel.hidden) noteInput.focus();
          });
          column.querySelector("h4").after(pick);
        }
      }
      columns.hidden = false;
      changeStatus.textContent = note && file && !a.file ? "The original review file is absent from the current patch." : "";
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
    compare.closest("label").hidden = eligible.length === 0;
    if (eligible.some(item => item.id === previous)) compare.value = previous;
    void loadChanges();
  }
  const owns = (ticket, session) => dialog.open && generation === ticket && client.session === session;
  function clearPreview() {
    noteLabel.hidden = true; noteKey = null; noteInput.value = "";
    discussionAside.hidden = true; discussionMessages.replaceChildren();
    frameDigest = null; changeGeneration++; outputGeneration++;
    renderedChanges = null; renderedOutput = null;
    tabs.hidden = true;
    choosePanel("preview");
    output.textContent = ""; outputStatus.textContent = "";
    latest.hidden = true; openLive.hidden = true; copyLink.hidden = true; copyForAgent.hidden = true; addToThread.hidden = true; linkFallback.hidden = true; linkStatus.textContent = "";
    primary.replaceChildren(); peer.replaceChildren(); peer.hidden = true;
    compare.value = ""; changeStatus.textContent = "";
    frame?.remove(); frame = null;
    heading.textContent = "Open a shared preview";
    meta.textContent = "";
  }
  function reset() {
    notes.clear(); selectStart(null);
    generation++; selected = null; linked = null; pendingFile = null; reviewLocation = null; threadDraft = null; clearPreview();
    status.textContent = ""; list.replaceChildren(); items = []; changeCache.clear();
    if (dialog.open) dialog.close();
  }
  function select(id) {
    selected = id; linked = null; pendingFile = null; reviewLocation = null;
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
        latest.textContent = linked.anchor && current?.publisherId === linked.publisherId && current?.patchDigest
          ? "Locate note in current patch" : uiText("workspace.share.openCurrent");
        refreshDiscussion();
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
      openLive.hidden = !current.liveAvailable;
      copyForAgent.hidden = false;
      noteKey = changesIdentity(current);
      noteInput.value = notes.get(noteKey) ?? "";
      noteLabel.hidden = false;
      refreshDiscussion();
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
      refreshDiscussion();
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
  latest.addEventListener("click", () => {
    const current = items.find(item => item.id === selected);
    if (!linked?.anchor || !current?.patchDigest || current.publisherId !== linked.publisherId) {
      void select(selected);
      return;
    }
    reviewLocation = linked;
    linked = null;
    pendingFile = reviewLocation.file;
    latest.hidden = true;
    activePanel = "changes";
    void load();
  });
  function shareSelection() {
    const current = items.find(item => item.id === selected), session = client.session;
    if (!current || !session || copyLink.hidden) return null;
    const panel = activePanel;
    const file = panel === "changes" && !columns.hidden ? primary.querySelector("[aria-current=true]")?.dataset.file : undefined;
    const marked = file && primary.querySelector("[data-review-side][aria-pressed=true]");
    const anchor = marked ? { side: marked.dataset.reviewSide, line: Number(marked.dataset.reviewLine) } : undefined;
    const link = workspaceArtifactLink(location.href, session.roomId, current, panel, file, anchor);
    return link ? { current, session, panel, link } : null;
  }

  async function copySelection(forAgent) {
    const snapshot = shareSelection();
    if (!snapshot) return;
    const { current, session, link } = snapshot;
    const returnLink = threadDraft?.discussion()?.link;
    const note = noteInput.value.trim();
    const copiedText = forAgent ? [
      uiText("workspace.share.agentText", { link, head: current.head }),
      note && uiText("workspace.versionInstruction", { note }),
      returnLink && uiText("workspace.returnDiscussion", { link: returnLink }),
      returnLink && (current.recipientId
        ? "This publication is directed. Keep the returned artifact within the same audience."
        : "Return your revised publication to that discussion for review."),
    ].filter(Boolean).join("\n\n") : link;
    const result = await clipboard.copy(copiedText);
    if (!dialog.open || client.session !== session || shareSelection()?.link !== link
      || (forAgent && (noteInput.value.trim() !== note || threadDraft?.discussion()?.link !== returnLink))) return;
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
  openLive.addEventListener("click", async () => {
    const current = items.find(item => item.id === selected), session = client.session;
    if (!current?.liveAvailable || openLive.disabled) return;
    const tab = window.open("about:blank", "_blank");
    if (!tab) {
      linkStatus.textContent = uiText("workspace.live.popupBlocked");
      return;
    }
    tab.opener = null;
    openLive.disabled = true;
    try {
      const opened = await client.roomWrite("/workspace-previews/open-live", { id: current.id, revision: current.revision });
      if (!opened || !dialog.open || client.session !== session || selected !== current.id
        || items.find(item => item.id === current.id)?.revision !== current.revision) return tab.close();
      const url = new URL(opened.openUrl);
      if (url.origin === location.origin || url.username || url.password || url.search
        || url.pathname !== "/.room-preview" || !/^#[a-f0-9]{64}$/.test(url.hash)
        || (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname.endsWith(".localhost"))))
        throw new Error("Invalid live preview address");
      tab.location.replace(url.href);
    } catch {
      tab.close();
      if (dialog.open && client.session === session && selected === current.id) linkStatus.textContent = uiText("workspace.live.unavailable");
    } finally {
      openLive.disabled = false;
    }
  });
  copyForAgent.addEventListener("click", () => void copySelection(true));
  addToThread.addEventListener("click", async () => {
    const snapshot = shareSelection(), destination = threadDraft;
    if (!snapshot || addToThread.hidden || addToThread.disabled || !destination) return;
    const note = noteInput.value.trim();
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
      if (note !== noteInput.value.trim()) return;
      if (!destination.append(link, note)) {
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
    selectStart(workThread?.());
    dialog.showModal();
    void load();
  });
  dialog.querySelector("[data-preview-close]").addEventListener("click", reset);
  dialog.querySelector("[data-preview-refresh]").addEventListener("click", () => void load());
  dialog.addEventListener("close", () => { if (!dialog.open) reset(); });
  return {
    reset, refreshDiscussion,
    refresh() { if (dialog.open) void load(); },
    openLink(hash, destination = null) {
      const target = workspaceArtifactSelection(hash);
      if (!target || !client.session) return;
      notes.clear(); clearPreview();
      selectStart(null);
      threadDraft = destination; linked = target; reviewLocation = target.anchor ? target : null; pendingFile = target.file ?? null; selected = target.id; activePanel = target.panel;
      if (!dialog.open) dialog.showModal();
      void load();
      return true;
    },
    closeLinked() { if (linked) reset(); },
  };
}
