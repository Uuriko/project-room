import { c1HappyEvents, c2ReplaySameIds, c3ForgedActorEvents, c4UnknownProducerEvents } from "../fixtures/index.js";
import { contributorsForReturnBrief } from "../src/brief.js";
import { renderContributorGaps, renderContributorsLines } from "../src/contributors-section.js";

const CASES = [
  {
    id: "c1",
    title: "C1 happy",
    note: "PASS unlocks complete + artifact for Codex. Instinct verified. Potter decided. Messages omitted.",
    events: c1HappyEvents
  },
  {
    id: "c2",
    title: "C2 double-count",
    note: "Same Event ids replayed. One derived row per kind. Weight does not increase.",
    events: c2ReplaySameIds
  },
  {
    id: "c3",
    title: "C3 forged actor",
    note: "Client-supplied actor / label / prefix mint no share. Forged PASS does not unlock completion.",
    events: c3ForgedActorEvents
  },
  {
    id: "c4",
    title: "C4 unknown producer",
    note: "No complete / artifact share. Gap stays visible. Reporter is not inferred as producer.",
    events: c4UnknownProducerEvents
  }
];

function fillCase(spec) {
  const brief = contributorsForReturnBrief(spec.events);
  const root = document.getElementById(spec.id);
  root.querySelector(".rb-contributors-list").innerHTML = renderContributorsLines(brief);
  const gapList = root.querySelector(".rb-gaps-list");
  const gapHtml = renderContributorGaps(brief);
  gapList.innerHTML = gapHtml;
  gapList.hidden = !gapHtml;
  root.querySelector(".rb-gaps-heading").hidden = !gapHtml;
  root.querySelector(".rb-line-count").textContent =
    `${brief.lines.length} line${brief.lines.length === 1 ? "" : "s"} · ${brief.gaps.length} gap${brief.gaps.length === 1 ? "" : "s"}`;
}

for (const spec of CASES) fillCase(spec);

document.querySelectorAll("[data-open-event], [data-open-artifact]").forEach((node) => {
  node.addEventListener("click", (event) => {
    event.preventDefault();
    const target = node.getAttribute("data-open-event") || node.getAttribute("data-open-artifact");
    const status = document.getElementById("open-status");
    status.textContent = `Opened source ${target}`;
    status.hidden = false;
  });
});
