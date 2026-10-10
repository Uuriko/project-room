import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workPanelModel, renderWorkPanel, workPanelSummary, catchUpLines, IN_PROGRESS_LIMIT, DONE_LIMIT } from "../src/work-panel.js";

const NOW = Date.parse("2026-10-07T18:00:00Z");
const base = { mode: "read", revision: 1, independentVerificationRequired: false, ownerDecisionRequired: false, updatedAt: "2026-10-07T17:00:00Z" };

function fixture() {
  return {
    room: { id: "r", ownerId: "john" },
    members: {
      john: { id: "john", kind: "human", displayName: "John", permissions: ["verify", "decide", "accept_work", "complete_work"] },
      codex: { id: "codex", kind: "agent", displayName: "Codex", permissions: ["accept_work", "complete_work"] },
      grok: { id: "grok", kind: "agent", displayName: "Grok", permissions: ["accept_work", "complete_work"] }
    },
    messages: [],
    replyRequests: {},
    workItems: {
      // Codex finished; John is the verifier, so it needs John.
      invite: { ...base, id: "invite", title: "Ship the invite flow", state: "completed", accountableMemberId: "codex", verifierMemberId: "john",
        independentVerificationRequired: true,
        receipt: { eventId: "e1", evidenceVersion: "v1", producerAttribution: "reported", producerId: "codex", checksClaimed: ["42/42 tests", "Staging passed"] } },
      // Grok is working; nothing for John to do.
      page: { ...base, id: "page", title: "Style the 404 page", state: "working", accountableMemberId: "grok" },
      // Finished and verified an hour ago.
      copy: { ...base, id: "copy", title: "Agent sign-in copy", state: "completed", accountableMemberId: "codex", verifierMemberId: "john",
        receipt: { eventId: "e2", evidenceVersion: "v1", producerAttribution: "reported", producerId: "codex", checksClaimed: ["9/9 tests"] },
        verification: { verifierId: "john", result: "pass", completionEventId: "e2", evidenceVersion: "v1", independenceConfirmed: true } }
    }
  };
}

test("the panel sorts work into needs you, in progress and done today", () => {
  const state = fixture(), before = structuredClone(state);
  const model = workPanelModel(state, "john", NOW);
  assert.deepEqual(model.needsYou.map(e => e.id), ["invite"]);
  assert.deepEqual(model.inProgress.map(e => e.id), ["page"]);
  assert.deepEqual(model.done.map(e => e.id), ["copy"]);
  assert.deepEqual(model.counts, { needsYou: 1, inProgress: 1, done: 1 });
  assert.deepEqual(state, before, "the model never mutates room state");
});

test("cards name the producer, say what is next in a few words, and carry proof", () => {
  const model = workPanelModel(fixture(), "john", NOW);
  const invite = model.needsYou[0];
  assert.deepEqual(invite.owner, { id: "codex", name: "Codex", kind: "agent" });
  assert.equal(invite.status, "Ready for review");
  assert.deepEqual(invite.proof.map(p => p.text), ["42/42 tests", "Staging passed"]);
  assert.deepEqual(invite.action, { action: "verify", label: "Review" });
  assert.equal(model.inProgress[0].status, "Working");
  assert.equal(model.inProgress[0].tone, "working");
  assert.deepEqual(model.done[0].proof.map(p => p.text), ["9/9 tests", "Checked by John"]);
});

test("an action button appears only when the member may take that action", () => {
  const state = fixture();
  state.members.john.permissions = [];
  const model = workPanelModel(state, "john", NOW);
  assert.deepEqual(model.needsYou.map(e => e.id), ["invite"], "the work still needs John");
  assert.equal(model.needsYou[0].action, null, "but there is no form shortcut without the permission");
  assert.ok(model.inProgress.every(e => e.action === null));
  assert.ok(model.done.every(e => e.action === null));
  assert.doesNotMatch(renderWorkPanel(model), /data-wp-action/);
});

test("other members see their own view of the same room", () => {
  const model = workPanelModel(fixture(), "grok", NOW);
  assert.deepEqual(model.needsYou, []);
  assert.deepEqual(model.inProgress.map(e => e.id).sort(), ["invite", "page"]);
});

test("no panel without an active member", () => {
  const state = fixture();
  assert.equal(workPanelModel(state, null, NOW), null);
  assert.equal(workPanelModel(state, "stranger", NOW), null);
  state.members.john.active = false;
  assert.equal(workPanelModel(state, "john", NOW), null);
  assert.equal(workPanelModel(null, "john", NOW), null);
  assert.equal(renderWorkPanel(null), "");
  assert.equal(workPanelSummary(null), "");
});

test("done today drops results older than a day and replaced work never shows", () => {
  const state = fixture();
  state.workItems.copy.updatedAt = "2026-10-06T17:59:00Z";
  state.workItems.page.supersededBy = "page2";
  const model = workPanelModel(state, "john", NOW);
  assert.deepEqual(model.done, []);
  assert.deepEqual(model.inProgress, []);
  assert.equal(workPanelSummary(model), "1 needs you");
});

test("long lists are capped and say how many more there are", () => {
  const state = fixture();
  for (let i = 0; i < IN_PROGRESS_LIMIT + 3; i++) state.workItems[`w${i}`] = { ...state.workItems.page, id: `w${i}`, updatedAt: `2026-10-07T1${i % 10}:00:00Z` };
  for (let i = 0; i < DONE_LIMIT + 2; i++) state.workItems[`d${i}`] = { ...state.workItems.copy, id: `d${i}` };
  const model = workPanelModel(state, "john", NOW);
  assert.equal(model.inProgress.length, IN_PROGRESS_LIMIT);
  assert.equal(model.inProgressMore, 4);
  assert.equal(model.counts.inProgress, IN_PROGRESS_LIMIT + 4);
  assert.equal(model.done.length, DONE_LIMIT);
  assert.match(renderWorkPanel(model), /4 more in the room/);
});

test("rendered cards escape text and link back to the record", () => {
  const state = fixture();
  state.workItems.invite.title = `<img src=x onerror="alert(1)">`;
  state.members.codex.displayName = `<b>Codex</b>`;
  const html = renderWorkPanel(workPanelModel(state, "john", NOW));
  assert.doesNotMatch(html, /<img|<b>Codex/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /data-open-work="invite"/);
  assert.match(html, /data-wp-action="verify" data-wp-work="invite"/);
  assert.match(html, /Needs you <span class="wp-count">1<\/span>/);
});

test("explicit reply requests show up as a chat link, not a work action", () => {
  const state = fixture();
  state.messages.push({ id: "q1", body: "Which option do you want for the invite email?" });
  state.replyRequests.q1 = { id: "q1", recipientId: "john", status: "open", createdAt: "2026-10-07T17:30:00Z" };
  const model = workPanelModel(state, "john", NOW);
  const request = model.needsYou.find(e => e.kind === "request");
  assert.equal(request.status, "Reply requested");
  assert.equal(request.action, null);
  assert.match(renderWorkPanel(model), /data-open-message="q1"/);
});

test("the app mounts the panel inside #main so existing record links work", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const main = html.slice(html.indexOf('<main id="main"'), html.indexOf("</main>"));
  assert.match(main, /<aside id="work-panel" class="work-panel"[^>]*hidden>/);
  assert.match(html, /<button id="work-panel-toggle"[^>]*aria-controls="work-panel"/);
  assert.match(html, /<h2 id="work-panel-title" tabindex="-1">Work<\/h2>/, "a focus target when the panel opens");
  assert.match(html, /href="\.\/src\/work-panel\.css"/);
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /import \{ createWorkPanel, workPanelModel \} from "\.\/work-panel\.js";/);
  assert.match(app, /workPanel\.render\(owned \? workPanelModel\(state, session\.member\.id, now\) : null\);/);
});

test("catch-up says what waits on you, what is running and what finished, in that order", () => {
  const model = workPanelModel(fixture(), "john", NOW);
  assert.deepEqual(catchUpLines(model).map(l => l.text), [
    "Waiting on you: Ship the invite flow.",
    "In progress: Style the 404 page (Grok).",
    "Finished today: Agent sign-in copy by Codex."
  ]);
  assert.match(renderWorkPanel(model), /^<section class="wp-catchup" aria-label="Catch up">/);
});

test("catch-up counts extra items and stays empty when there is nothing to say", () => {
  const state = fixture();
  state.workItems.page2 = { ...state.workItems.page, id: "page2", title: "Second", accountableMemberId: "codex" };
  state.workItems.invite2 = { ...state.workItems.invite, id: "invite2" };
  const lines = catchUpLines(workPanelModel(state, "john", NOW)).map(l => l.text);
  assert.equal(lines[0], "Waiting on you: Ship the invite flow and 1 more.");
  assert.match(lines[1], /^In progress: 2 pieces of work \((Grok, Codex|Codex, Grok)\)\.$/);
  const empty = { ...fixture(), workItems: {} };
  assert.deepEqual(catchUpLines(workPanelModel(empty, "john", NOW)), []);
  assert.doesNotMatch(renderWorkPanel(workPanelModel(empty, "john", NOW)), /wp-catchup/);
  assert.deepEqual(catchUpLines(null), []);
});

test("catch-up counts all work in progress, not just the cards that fit", () => {
  const state = fixture();
  for (let i = 0; i < 16; i++) state.workItems[`w${i}`] = { ...state.workItems.page, id: `w${i}` };
  const model = workPanelModel(state, "john", NOW);
  assert.equal(model.inProgress.length, IN_PROGRESS_LIMIT);
  assert.equal(model.working.count, 17);
  assert.match(catchUpLines(model)[1].text, /^In progress: 17 pieces of work \(Grok\)\.$/);
});
