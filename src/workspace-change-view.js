import { uiText } from "./strings.js";
import { fileLabel, workspaceChangePath } from "./workspace-diff-parser.js";

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function renderFile(body, file) {
  body.replaceChildren();
  if (!file.hunks.length) body.append(node("p", "No text hunks in this file.", "form-hint"));
  for (const hunk of file.hunks) {
    const chunk = node("div", undefined, "workspace-hunk");
    const rangeEnd = hunk.content.indexOf("@@", 2);
    const range = node("h5", rangeEnd >= 0 ? hunk.content.slice(0, rangeEnd + 2) : hunk.content);
    range.title = hunk.content;
    const lines = node("pre", undefined, "workspace-change-lines");
    lines.tabIndex = 0;
    for (const line of hunk.changes) {
      const kind = line.type === "insert" ? "add" : line.type === "delete" ? "remove" : "context";
      const prefix = kind === "add" ? "+" : kind === "remove" ? "-" : " ";
      lines.append(node("span", [prefix, line.content, "\n"].join(""), `workspace-line-${kind}`));
    }
    chunk.append(range, lines);
    body.append(chunk);
  }
}

export function renderWorkspaceChange(parent, item, changes, read, requestedFile) {
  const selected = parent.querySelector("[aria-current=true]")?.dataset.file;
  const focused = parent.contains(document.activeElement) ? document.activeElement?.dataset.file : null;
  parent.replaceChildren(node("h4", item.title));
  const choices = node("div", undefined, "workspace-change-files");
  const body = node("div");
  const status = node("p", "", "form-hint");
  status.setAttribute("role", "status");
  parent.append(choices, status, body);
  let choice = 0;
  function fileButtons(files) {
    choices.replaceChildren();
    for (const { path, filePath = path } of files) {
      const button = node("button", path, "button ghost");
      button.type = "button";
      button.dataset.file = filePath;
      button.addEventListener("click", () => void show(button));
      choices.append(button);
    }
  }
  async function show(button, available) {
    const ticket = ++choice;
    for (const candidate of choices.children)
      candidate.setAttribute("aria-current", String(candidate === button));
    body.replaceChildren();
    status.textContent = available ? "" : uiText("workspace.changes.fileLoading");
    try {
      const value = available ? { file: available } : await read("file", button.dataset.file);
      if (!value || ticket !== choice || !parent.contains(body)) return;
      status.textContent = value.file ? "" : uiText("workspace.share.fileMissing");
      if (value.file) renderFile(body, value.file);
    } catch (error) {
      if (ticket === choice && parent.contains(body)) status.textContent = error.message || uiText("workspace.changes.fileError");
    }
  }
  if (changes.file && requestedFile) {
    const path = workspaceChangePath(changes.file) || requestedFile;
    fileButtons([{ path: fileLabel(changes.file), filePath: path }]);
    void show(choices.firstElementChild, changes.file);
    const browse = node("button", uiText("workspace.changes.browseFiles"), "button ghost");
    browse.type = "button";
    choices.append(browse);
    browse.addEventListener("click", async () => {
      browse.disabled = true;
      try {
        const value = await read("summary");
        if (!value || !parent.contains(body)) return;
        fileButtons(value.files ?? []);
        const current = [...choices.children].find(button => button.dataset.file === path);
        if (current) {
          current.setAttribute("aria-current", "true");
          current.focus();
        }
      } catch (error) {
        if (parent.contains(body)) status.textContent = error.message || "Could not read changes.";
      } finally { browse.disabled = false; }
    });
  } else if (requestedFile) {
    status.textContent = uiText("workspace.share.fileMissing");
  } else if (changes.status === "raw_available") {
    const raw = node("button", uiText("workspace.changes.openRaw"), "button ghost");
    raw.type = "button";
    choices.append(raw);
    raw.addEventListener("click", async () => {
      raw.disabled = true;
      try {
        const value = await read();
        if (value && parent.contains(body)) body.replaceChildren(node("pre", value.patch, "workspace-change-lines"));
      } catch (error) {
        if (parent.contains(body)) status.textContent = error.message || "Could not read changes.";
      } finally { raw.disabled = false; }
    });
  } else if (!changes.files?.length) {
    status.textContent = changes.status === "not_published" ? "No patch shared." : "No committed changes.";
  } else {
    fileButtons(changes.files);
    const restored = [...choices.children].find(button => button.dataset.file === selected);
    if (restored) {
      void show(restored);
      if (focused === selected) restored.focus();
    }
  }
}
