import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARTIFACT_SHA,
  c1HappyEvents,
  c4UnknownProducerEvents
} from "../fixtures/index.js";
import {
  attachContributorsToReturnBrief,
  contributorsForReturnBrief,
  eventsFromHistoryItems,
  renderContributorGaps,
  renderContributorsLines,
  renderContributorsSection,
  sinceFromCursor
} from "../src/index.js";

function asHistoryItems(events, startSequence = 1) {
  return events.map((event, index) => ({ sequence: startSequence + index, event }));
}

test("attachContributorsToReturnBrief adds a sibling read-model and leaves history/current alone", () => {
  const brief = {
    history: { cursor: 0, evaluatedThrough: 9, items: [], hasMore: false },
    current: { evaluatedThrough: 9, needsAttention: [], workInvolvingMe: [] }
  };
  const next = attachContributorsToReturnBrief(brief, c1HappyEvents);
  assert.equal(next.history, brief.history);
  assert.equal(next.current, brief.current);
  assert.equal(next.contributors.lines.length, 4);
  assert.equal(next.contributors.gaps.length, 0);
  assert.ok(next.contributors.lines.every((line) => line.source_event_id && line.evidence_ref));
});

test("sinceFromCursor uses the Event at C; cursor 0 means no bound", () => {
  const items = asHistoryItems(c1HappyEvents);
  assert.equal(sinceFromCursor(items, 0), null);
  assert.equal(sinceFromCursor(items, 1), c1HappyEvents[0].at);
  assert.equal(sinceFromCursor(items, 99), null);
});

test("attach with Phase 0 items + cursor withholds already-seen rows", () => {
  const items = asHistoryItems(c1HappyEvents);
  const completeIndex = c1HappyEvents.findIndex((event) => event.type === "work.completed");
  const next = attachContributorsToReturnBrief(
    { history: {}, current: {} },
    { items, workItems: null },
    { cursor: items[completeIndex].sequence }
  );
  assert.ok(!next.contributors.lines.some((line) => line.kind === "complete" || line.kind === "artifact"));
  assert.deepEqual(next.contributors.lines.map((line) => line.kind).sort(), ["decide", "verify"]);
});

test("eventsFromHistoryItems unwraps Phase 0 rows and passes bare Events through", () => {
  assert.deepEqual(eventsFromHistoryItems(asHistoryItems(c1HappyEvents)), c1HappyEvents);
  assert.deepEqual(eventsFromHistoryItems(c1HappyEvents), c1HappyEvents);
});

test("section lines open the source Event / Artifact; no member_share scoreboard", () => {
  const brief = contributorsForReturnBrief(c1HappyEvents);
  const html = renderContributorsSection(brief);
  assert.match(html, /id="rb-contributors-heading">Contributors/);
  assert.match(html, /data-open-event="evt-work-134-completed"/);
  assert.match(html, /data-open-artifact="70053cc6cf9d86f3a43220dcfbb0af05797380c0"/);
  assert.match(html, /data-open-event="evt-work-134-verified"/);
  assert.match(html, /data-open-event="evt-work-134-decided"/);
  assert.equal(html.includes('>codex</span> <span class="rb-type">completed</span>'), true);
  assert.equal(html.includes('>instinct</span> <span class="rb-type">verified</span>'), true);
  assert.equal(html.includes('>potter</span> <span class="rb-type">decided</span>'), true);
  assert.doesNotMatch(html, /scoreboard|leaderboard|member_share|activity/i);
  assert.doesNotMatch(html, /maya/);
  assert.equal(html.includes(ARTIFACT_SHA.slice(0, 12)), true);
});

test("C4 renders an honest gap and no complete/artifact line", () => {
  const brief = contributorsForReturnBrief(c4UnknownProducerEvents);
  const lines = renderContributorsLines(brief);
  const gaps = renderContributorGaps(brief);
  assert.doesNotMatch(lines, /completed|recorded artifact/);
  assert.match(gaps, /Producer unknown on this completion/);
  assert.match(gaps, /Reporter codex is not credited/);
  assert.match(gaps, /data-open-event="evt-work-134-completed"/);
  assert.match(lines, /instinct/);
  assert.match(lines, /potter/);
});

test("empty brief is a quiet empty state, not a zeroed scoreboard", () => {
  const html = renderContributorsLines({ lines: [], gaps: [] });
  assert.equal(html, '<li class="rb-empty">No credited contributions since your marker.</li>');
});

test("message and ack Events never appear as contributor lines", () => {
  const brief = contributorsForReturnBrief(c1HappyEvents);
  const html = renderContributorsLines(brief);
  assert.doesNotMatch(html, /evt-msg-|message|ack volume|posted/);
  assert.equal(brief.lines.some((line) => line.kind === "message"), false);
});
