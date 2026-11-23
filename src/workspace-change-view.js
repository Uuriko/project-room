import { fileLabel, parsePatch } from "./workspace-diff-parser.js";

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

export function renderWorkspaceChange(parent, item, patch) {
  const selected = parent.querySelector("[aria-current=true]")?.dataset.file;
  const focused = parent.contains(document.activeElement) ? document.activeElement?.dataset.file : null;
  parent.replaceChildren(node("h4", item.title));
  const files = patch === null ? null : parsePatch(patch);
  if (!files || files.length === 0) {
    if (patch) {
      parent.append(node("p", "Raw patch", "form-hint"), node("pre", patch, "workspace-change-lines"));
    } else parent.append(node("p", patch === null ? "No patch shared." : "No committed changes.", "form-hint"));
    return;
  }

  const choices = node("div", undefined, "workspace-change-files");
  const body = node("div");
  function show(index, moveFocus = false) {
    const file = files[index];
    for (const [i, button] of [...choices.children].entries()) button.setAttribute("aria-current", String(i === index));
    const group = node("div");
    if (!file.hunks.length) group.append(node("p", "No text hunks in this file.", "form-hint"));
    for (const hunk of file.hunks) {
      const chunk = node("div", undefined, "workspace-hunk");
      const rangeEnd = hunk.content.indexOf("@@", 2);
      const range = node("h5", rangeEnd >= 0 ? hunk.content.slice(0, rangeEnd + 2) : hunk.content);
      range.title = hunk.content;
      chunk.append(range);
      const lines = node("pre", undefined, "workspace-change-lines");
      lines.tabIndex = 0;
      for (const line of hunk.changes) {
        const kind = line.type === "insert" ? "add" : line.type === "delete" ? "remove" : "context";
        const prefix = kind === "add" ? "+" : kind === "remove" ? "-" : " ";
        lines.append(node("span", [prefix, line.content, "\n"].join(""), `workspace-line-${kind}`));
      }
      chunk.append(lines);
      group.append(chunk);
    }
    body.replaceChildren(group);
    if (moveFocus) choices.children[index].focus();
  }
  for (const [index, file] of files.entries()) {
    const label = fileLabel(file);
    const button = node("button", label, "button ghost");
    button.type = "button"; button.dataset.file = label;
    button.addEventListener("click", () => show(index));
    choices.append(button);
  }
  parent.append(choices, body);
  const restored = files.findIndex(file => fileLabel(file) === selected);
  show(Math.max(0, restored), Boolean(focused && focused === selected && restored >= 0));
}
