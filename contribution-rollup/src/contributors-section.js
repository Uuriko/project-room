const KIND_LABEL = Object.freeze({
  complete: "completed",
  verify: "verified",
  decide: "decided",
  artifact: "recorded artifact"
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shortRef(ref) {
  const text = String(ref ?? "");
  return /^[0-9a-f]{40}$/i.test(text) ? `${text.slice(0, 12)}…` : text;
}

function eventHref(eventId, hrefForEvent) {
  if (typeof hrefForEvent === "function") return hrefForEvent(eventId);
  return `#event:${eventId}`;
}

function artifactHref(ref, hrefForArtifact) {
  if (typeof hrefForArtifact === "function") return hrefForArtifact(ref);
  return `#artifact:${ref}`;
}

function kindLabel(kind) {
  return KIND_LABEL[kind] ?? kind;
}

/**
 * Thin Contributors list HTML for Quiet Focus / return-brief.
 * Lines open the source Event (and Artifact when that is the evidence).
 * Attribution gaps stay visible. No scoreboard. No message counts.
 */
export function renderContributorsLines(brief = {}, options = {}) {
  const { hrefForEvent, hrefForArtifact, memberLabel = (id) => id } = options;
  const lines = Array.isArray(brief.lines) ? brief.lines : [];
  if (lines.length === 0) {
    return '<li class="rb-empty">No credited contributions since your marker.</li>';
  }
  return lines
    .map((line) => {
      const eventId = line.source_event_id;
      const actor = escapeHtml(memberLabel(line.member_id));
      const kind = escapeHtml(kindLabel(line.kind));
      const weight = escapeHtml(line.weight);
      const key = escapeHtml(`${eventId}:${line.kind}:${line.evidence_ref}`);
      const openEvent = escapeHtml(eventId);
      const evidence =
        line.kind === "artifact"
          ? `<a class="rb-evidence" href="${escapeHtml(artifactHref(line.evidence_ref, hrefForArtifact))}" data-open-artifact="${escapeHtml(line.evidence_ref)}">${escapeHtml(shortRef(line.evidence_ref))}</a>`
          : `<a class="rb-evidence" href="${escapeHtml(eventHref(eventId, hrefForEvent))}" data-open-event="${openEvent}">${escapeHtml(shortRef(line.evidence_ref))}</a>`;
      return `<li class="rb-event"><a class="rb-event-link" href="${escapeHtml(eventHref(eventId, hrefForEvent))}" data-open-event="${openEvent}" data-brief-key="contributor:${key}"><span class="rb-actor">${actor}</span> <span class="rb-type">${kind}</span> <span class="rb-detail">weight ${weight}</span></a> ${evidence}</li>`;
    })
    .join("");
}

export function renderContributorGaps(brief = {}, options = {}) {
  const { hrefForEvent, memberLabel = (id) => id } = options;
  const gaps = Array.isArray(brief.gaps) ? brief.gaps : [];
  if (gaps.length === 0) return "";
  return gaps
    .map((gap) => {
      const eventId = gap.completion_event_id ?? gap.eventId ?? gap.source_event_id;
      const reporter = escapeHtml(memberLabel(gap.reported_by ?? gap.reportedBy));
      const openEvent = escapeHtml(eventId);
      const key = escapeHtml(eventId ?? gap.work_item_id ?? "gap");
      return `<li class="rb-event rb-gap"><a class="rb-event-link" href="${escapeHtml(eventHref(eventId, hrefForEvent))}" data-open-event="${openEvent}" data-brief-key="gap:${key}">Producer unknown on this completion. Reporter ${reporter} is not credited.</a></li>`;
    })
    .join("");
}

export function renderContributorsSection(brief = {}, options = {}) {
  const lines = renderContributorsLines(brief, options);
  const gaps = renderContributorGaps(brief, options);
  const gapBlock = gaps
    ? `<h3 id="rb-gaps-heading">Attribution gaps</h3><ul id="rb-gaps-list" class="rb-list">${gaps}</ul>`
    : "";
  return `<section class="rb-contributors" aria-labelledby="rb-contributors-heading"><h3 id="rb-contributors-heading">Contributors <span id="rb-contributors-boundary" class="rb-boundary">${options.boundary ?? ""}</span></h3><ul id="rb-contributors-list" class="rb-list">${lines}</ul>${gapBlock}</section>`;
}
