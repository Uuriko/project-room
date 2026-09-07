# Quiet Focus / return-brief Contributors hook

Phase 0 return-brief lives on [PR #8](https://github.com/Uuriko/project-room/pull/8) (`instinct/integration-2026-09-06`, audited tip `30eaa93`). This module does **not** merge #8 or #9. Wire later by importing here.

Reports on [#11](https://github.com/Uuriko/project-room/issues/11). Do not touch identity D235, Arcade, Multichain, or the getdasha Worker.

## Import

```js
import {
  attachContributorsToReturnBrief,
  eventsFromHistoryItems,
  sinceFromCursor
} from "../contribution-rollup/src/return-brief.js";
import { renderContributorsSection } from "../contribution-rollup/src/contributors-section.js";
```

`contributorsForReturnBrief` is the read-model. The attach helper only adds `brief.contributors`. The section helper is the thin list: each line opens the source Event / Artifact; gaps stay honest. No scoreboard. Message / ack volume is not a weight.

## Exact Phase 0 insertion points

### 1. `server/return-brief.mjs` — `buildReturnBrief`

Today the payload is `{ history, current }`. Add `contributors` as a sibling, not a replacement:

```js
// eventsThroughH = [{ sequence, event }, ...] for every Event with sequence <= H
export function buildReturnBrief({ sequence, workItems, rows, H, startAfter, C, memberId, eventsThroughH }) {
  const brief = { history: { /* existing */ }, current: { /* existing */ } };
  return attachContributorsToReturnBrief(brief, { items: eventsThroughH, workItems }, { cursor: C });
}
```

`contributorsForReturnBrief` must see **Events through frozen horizon H**, not the current history page. Paged `rows` drop `work.proposed` and earlier PASS/FAIL that verification-first needs. Pass `workItems` from the current projection so designated verifier / decision-maker still resolve when the proposal is before cursor C.

`since` is the `at` of the Event at frozen cursor C, or `null` when C is 0. Fetching still never acknowledges.

### 2. `server/store.mjs` — `returnBrief`

Inside the existing read transaction, load Events with `sequence <= H` for the rollup. Keep the paged query for `history.items`. Do not POST a cursor from this read.

### 3. `index.html` — `#return-brief-panel .return-brief-body`

Insert after **What changed** (history stays first; Contributors is the same derived rows, not a second home):

```html
<section aria-labelledby="rb-contributors-heading">
  <h3 id="rb-contributors-heading">Contributors <span id="rb-contributors-boundary" class="rb-boundary"></span></h3>
  <ul id="rb-contributors-list" class="rb-list"></ul>
  <ul id="rb-gaps-list" class="rb-list"></ul>
</section>
```

Reuse `.rb-list` / `.rb-event` / `.rb-event-link`. Do not add a totals chart or activity ranking.

### 4. `src/app.js` — `renderReturnBrief`

After the history list:

```js
import { renderContributorsLines, renderContributorGaps } from "../contribution-rollup/src/contributors-section.js";

renderBriefList("#rb-contributors-list", renderContributorsLines(returnBrief.contributors, { memberLabel }));
renderBriefList("#rb-gaps-list", renderContributorGaps(returnBrief.contributors, { memberLabel }) || "");
```

Clear `#rb-contributors-list` and `#rb-gaps-list` in `invalidateReturnBrief` / sign-out the same way as the other brief lists. `data-open-event` / `data-open-artifact` should use the existing Quiet Focus record-open path.

## What this stub already proves

`preview/index.html` renders C1–C4 through `contributorsForReturnBrief` + the section helper. Unit tests cover attach, since-cursor, empty/gap copy, and “messages mint no line.”

## Ask

**@Codex / @Instinct:** land the four insertion points on a Phase 0-capable tip **without merging #8/#9 as-is**. If the unpublished rebuild already has a camelCase `contributorsForReturnBrief` in `src/contribution.js`, keep one derivation — import or fold this module; do not dual-count. Reply on #11.
