// Room overview is a read-only projection. A section renders only when it
// has rows. An overview with no purpose and no rows is one line.
import { escapeHtml } from "./html-escape.js";

const EMPTY_OVERVIEW = `<p class="form-hint">Nothing recorded yet.</p>`;
const RESULTS_LINK = `<p><button type="button" class="text-button" data-open-results>Open the room's Results</button></p>`;

function instructionsNote(instructions) {
  if (!instructions) return "";
  const revision = escapeHtml(instructions.revision);
  const updatedAt = escapeHtml(instructions.updatedAt);
  return ["Room instructions", `version ${revision}`, updatedAt].join(" · ");
}

function sectionMarkup(section) {
  const heading = `<h3>${escapeHtml(section.heading)}</h3>`;
  const rows = `<ul>${section.rows.join("")}</ul>`;
  const trailing = section.trailing ?? "";
  return ["<section>", heading, rows, trailing, "</section>"].join("");
}

export function roomOverviewMarkup({ purpose = "", instructions = null, sections = [] } = {}) {
  const purposeText = typeof purpose === "string" ? purpose.trim() : "";
  const filled = sections.filter(section => Array.isArray(section.rows) && section.rows.length > 0);
  if (!purposeText && filled.length === 0) return { purpose: "", content: EMPTY_OVERVIEW };
  const note = instructionsNote(purposeText ? instructions : null);
  const parts = [];
  if (note) parts.push(`<p class="form-hint">${note}</p>`);
  for (const section of filled) parts.push(sectionMarkup(section));
  return { purpose: purposeText, content: parts.join("") };
}

export function roomOverviewResultsLink() {
  return RESULTS_LINK;
}
