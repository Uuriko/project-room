import { uiText } from "./strings.js";

export const STATUS_LINE_POLL_MS = 20000;

// The header shows the person's name and the line. A member id is not a name.
export function statusLineText(line) {
  const name = typeof line?.displayName === "string" ? line.displayName.trim() : "";
  const text = typeof line?.text === "string" ? line.text.trim() : "";
  if (!name || !text || name.includes("\n") || name.includes("\r") || text.includes("\n") || text.includes("\r")) return "";
  return uiText("status.line", { name, text });
}

export function renderStatusLines(root, lines) {
  const items = Array.isArray(lines) ? lines.map(statusLineText).filter(Boolean) : [];
  root.replaceChildren();
  root.hidden = items.length === 0;
  if (!items.length) return;
  root.setAttribute("aria-label", uiText("status.lines"));
  for (const item of items) {
    const row = document.createElement("span");
    row.className = "status-line";
    row.textContent = item;
    root.append(row);
  }
}
