import { uiText } from "./strings.js";
import { fileLabel, workspaceChangePath } from "./workspace-diff-parser.js";

// Hunk anchor geometry and placement, from modem-dev/hunk f5de5300a3a9447dde77d75075be02b428a7bc93.
// MIT license in third_party/hunk-review/LICENSE.
function reviewHunkRange(hunk, side) {
    const start = side === "new" ? hunk.additionStart : hunk.deletionStart;
    const count = side === "new" ? hunk.additionCount : hunk.deletionCount;
    return [
        start,
        start + Math.max(count, 1) - 1
    ];
}

function reviewRangesOverlap(left, right) {
    return left[0] <= right[1] && right[0] <= left[1];
}

function reviewGapOwnerHunkIndex(hunks, side, line) {
    if (hunks.length === 0) {
        return undefined;
    }
    const following = hunks.findIndex((hunk)=>reviewHunkRange(hunk, side)[0] > line);
    return following >= 0 ? following : hunks.length - 1;
}

function resolveReviewNoteAnchor(hunks, { oldRange, newRange, preferred, fallbackOwnerHunkIndex }) {
    const intersectingHunkIndices = hunks.flatMap((hunk, index)=>{
        const intersects = oldRange !== undefined && reviewRangesOverlap(oldRange, reviewHunkRange(hunk, "old")) || newRange !== undefined && reviewRangesOverlap(newRange, reviewHunkRange(hunk, "new"));
        return intersects ? [
            index
        ] : [];
    });
    const preferredOwner = preferred === undefined ? -1 : hunks.findIndex((hunk)=>{
        const [start, end] = reviewHunkRange(hunk, preferred.side);
        return preferred.line >= start && preferred.line <= end;
    });
    const validatedFallback = fallbackOwnerHunkIndex !== undefined && hunks[fallbackOwnerHunkIndex] !== undefined ? fallbackOwnerHunkIndex : undefined;
    const ownerHunkIndex = preferredOwner >= 0 ? preferredOwner : intersectingHunkIndices[0] ?? validatedFallback ?? (hunks.length > 0 ? 0 : undefined);
    return {
        ...oldRange ? {
            oldRange: [
                ...oldRange
            ]
        } : {},
        ...newRange ? {
            newRange: [
                ...newRange
            ]
        } : {},
        ...preferred ? {
            preferred: {
                ...preferred
            }
        } : {},
        intersectingHunkIndices,
        ...ownerHunkIndex !== undefined ? {
            ownerHunkIndex
        } : {}
    };
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function rowNumber(row, side) {
  if (row.type === "normal") return side === "old" ? row.oldLineNumber : row.newLineNumber;
  return row.type === (side === "old" ? "delete" : "insert") ? row.lineNumber : undefined;
}

function hunkLocation(hunk) {
  const change = hunk.changes.find(row => row.type === "insert" || row.type === "delete") ?? hunk.changes[0];
  if (!change) return null;
  const side = change.type === "delete" ? "old" : "new";
  const line = rowNumber(change, side);
  return Number.isSafeInteger(line) && line > 0 ? { side, line } : null;
}

function renderFile(body, file, review) {
  body.replaceChildren();
  if (!file.hunks.length) body.append(node("p", "No text hunks in this file.", "form-hint"));
  let target;
  if (review) {
    const { side, line } = review.anchor;
    const spans = file.hunks.map(hunk => ({
      additionStart: hunk.newStart, additionCount: hunk.newLines,
      deletionStart: hunk.oldStart, deletionCount: hunk.oldLines,
    }));
    const range = side === "old" ? "oldRange" : "newRange";
    const placement = resolveReviewNoteAnchor(spans, {
      [range]: [line, line], preferred: { side, line },
      fallbackOwnerHunkIndex: reviewGapOwnerHunkIndex(spans, side, line),
    });
    target = placement.ownerHunkIndex;
    const exact = review.exact && file.hunks[target]?.changes.some(row => rowNumber(row, side) === line);
    const message = target === undefined
      ? "The original review location has no text hunk in this patch."
      : exact ? "Original review location." : "Original review location shown near the current hunk. Verify it before reviewing.";
    const location = node("p", message, "form-hint");
    location.dataset.reviewPlacement = exact ? "exact" : "needs-reanchor";
    location.setAttribute("role", "status");
    body.append(location);
  }
  for (const [index, hunk] of file.hunks.entries()) {
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
    chunk.append(range);
    const location = hunkLocation(hunk);
    if (location) {
      const button = node("button", "Select hunk for review link", "button ghost");
      button.type = "button";
      button.dataset.reviewSide = location.side;
      button.dataset.reviewLine = String(location.line);
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => {
        const pressed = button.getAttribute("aria-pressed") === "true";
        body.querySelector("[data-review-side][aria-pressed=true]")?.setAttribute("aria-pressed", "false");
        button.setAttribute("aria-pressed", String(!pressed));
      });
      chunk.append(button);
    }
    chunk.append(lines);
    body.append(chunk);
    if (index === target) {
      chunk.dataset.reviewTarget = "";
      requestAnimationFrame(() => { if (chunk.isConnected) chunk.scrollIntoView({ block: "nearest" }); });
    }
  }
}

export function renderWorkspaceChange(parent, item, changes, read, requestedFile, review) {
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
      if (value.file) renderFile(body, value.file, button.dataset.file === review?.file ? review : null);
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
