import { uiText } from "./strings.js";

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
        <iframe title="Shared project preview" sandbox="allow-scripts" referrerpolicy="no-referrer" hidden></iframe>
      </section>
    </div>`;
  document.body.append(dialog);

  const list = dialog.querySelector("[data-preview-list]");
  const heading = dialog.querySelector("[data-preview-heading]");
  const meta = dialog.querySelector("[data-preview-meta]");
  const status = dialog.querySelector("[data-preview-status]");
  const frame = dialog.querySelector("iframe");
  let selected = null, revision = null, generation = 0;
  const owns = (ticket, session) => dialog.open && generation === ticket && client.session === session;
  function clearPreview() {
    revision = null;
    frame.removeAttribute("src");
    frame.hidden = true;
    heading.textContent = "Open a shared preview";
    meta.textContent = "";
  }
  function reset() {
    generation++; selected = null; clearPreview();
    status.textContent = ""; list.replaceChildren();
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
      const current = page.items.find(item => item.id === selected);
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
      if (!current || revision === current.revision) return;
      const query = new URLSearchParams({ id: current.id, frame: String(current.revision) });
      if (session.authMode === "account") {
        query.set("auth", "account");
        query.set("binding", session.sessionBinding);
      }
      frame.src = client.path(`/workspace-previews?${query}`);
      frame.hidden = false;
      heading.textContent = current.title;
      meta.textContent = uiText("workspace.preview.source", {
        name: memberLabel(current.publisherId) || current.publisherId,
        head: current.head.slice(0, 12), revision: current.revision,
      });
      revision = current.revision;
    } catch (error) {
      if (!owns(ticket, session)) return;
      clearPreview();
      status.textContent = error.message || "Could not open previews.";
    }
  }
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
