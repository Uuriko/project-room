// RC-2026-09-19-072: client-side renderer for typed handoff envelopes.
// Pure render tests against fixture envelopes built through the real
// server validator (server/work-handoff.mjs) so the fixtures are
// schema-true: all seven sections render, badges cover the lifecycle, and
// state transitions display in the trail.
import test from "node:test";
import assert from "node:assert/strict";
import { handoffEnvelope, handoffEnvelopeVersion, envelopeStatuses } from "../server/work-handoff.mjs";
import { envelopeStatusBadge, handoffEnvelopeHtml, handoffEnvelopeListHtml, envelopesForWork,
  statusLabel, statusTone } from "../src/handoff-envelope-ui.js";

const NOW = 1729219200000; // 2024-10-18T00:00:00Z
const iso = ms => new Date(ms).toISOString();
const HOUR = 3600 * 1000;

const fields = (overrides = {}) => ({
  to: "agent-b",
  objective: "Summarize the thread and draft a reply",
  inputs: [
    { kind: "work", ref: "work-1", label: "the draft task" },
    { kind: "message", ref: "msg-1", label: "the thread" },
    { kind: "file", ref: "server/a.mjs", sha: "a".repeat(40) },
    { kind: "url", ref: "https://example.test/spec" },
    { kind: "note", ref: "context", detail: "short inline context" },
  ],
  authority: { permissions: ["accept_work", "complete_work"], scope: { rooms: ["room-1"], workIds: ["work-1"] },
    expiresAt: iso(NOW + 24 * HOUR), note: "read-only plus the two grant bits" },
  expectedOutput: { kind: "text_result", description: "A draft reply of at most 500 words", schema: "plain text" },
  acceptanceTest: { checks: [
    { kind: "work_completed", workId: "work-1", description: "the draft task closes" },
    { kind: "result_submitted", workId: "work-1" },
    { kind: "verification_recorded", workId: "work-2", verdict: "pass" },
    { kind: "manual_review", reviewer: "agent-owner", description: "tone check" },
  ] },
  termination: { expiresAt: iso(NOW + 24 * HOUR), onExpiry: "escalate", escalateTo: "agent-owner", maxRounds: 3 },
  provenance: { createdBy: "agent-a", claimId: "RC-2026-09-19-062", taskId: "work-1", parentEnvelopeId: "he_0", chain: ["he_0"] },
  ...overrides,
});
const envelope = (overrides = {}) => handoffEnvelope({ envelopeVersion: handoffEnvelopeVersion,
  id: "he_1", from: "agent-a", createdAt: iso(NOW), ...fields(overrides) });
const receipt = (overrides = {}) => ({ envelopeId: "he_1", roomId: "room-1", status: "proposed",
  fromAgent: "agent-a", toAgent: "agent-b", createdAt: NOW, updatedAt: NOW,
  envelope: envelope(overrides.envelope ?? {}),
  history: [{ status: "proposed", at: iso(NOW), by: "agent-a" }],
  ...overrides });

test("all seven sections render with their content", () => {
  const html = handoffEnvelopeHtml(receipt());
  for (const title of ["Objective", "Inputs", "Authority", "Expected output", "Acceptance test", "Termination", "Provenance"])
    assert.match(html, new RegExp(`<h5>${title}</h5>`), `missing section: ${title}`);
  assert.match(html, /Summarize the thread and draft a reply/);
});

test("inputs render every kind as a reference", () => {
  const html = handoffEnvelopeHtml(receipt());
  assert.match(html, />Work</); assert.match(html, />Message</); assert.match(html, />File</);
  assert.match(html, />Link</); assert.match(html, />Note</);
  assert.match(html, /<a class="source-link" href="https:\/\/example\.test\/spec"/);
  assert.match(html, /sha aaaaaaaaaaaa/); // sha truncated to 12 chars
  assert.match(html, /short inline context/);
});

test("authority renders permission chips, scope, expiry and note", () => {
  const html = handoffEnvelopeHtml(receipt());
  assert.match(html, /accept_work/); assert.match(html, /complete_work/);
  assert.match(html, /room-1/); assert.match(html, /work-1/);
  assert.match(html, /read-only plus the two grant bits/);
});

test("expected output shows the kind label, description and schema", () => {
  const html = handoffEnvelopeHtml(receipt());
  assert.match(html, /Text result/); assert.match(html, /at most 500 words/);
  assert.match(html, /Schema: <code>plain text<\/code>/);
});

test("acceptance checks render kind labels, targets and descriptions", () => {
  const html = handoffEnvelopeHtml(receipt());
  assert.match(html, /Work completed/); assert.match(html, /Result submitted/);
  assert.match(html, /Verification recorded/); assert.match(html, /Manual review/);
  assert.match(html, /reviewer agent-owner/); assert.match(html, /verdict pass/);
  assert.match(html, /the draft task closes/); assert.match(html, /tone check/);
});

test("termination renders expiry, escalation target and max rounds", () => {
  const html = handoffEnvelopeHtml(receipt());
  assert.match(html, /Escalate to agent-owner/); assert.match(html, /3/);
});

test("provenance renders sender, claim, task, parent and chain", () => {
  const html = handoffEnvelopeHtml(receipt());
  assert.match(html, /agent-a/); assert.match(html, /RC-2026-09-19-062/);
  assert.match(html, /<code>he_0<\/code>/);
});

test("badges cover every lifecycle status with the right label and tone", () => {
  const expected = { proposed: ["Proposed", "warn"], accepted: ["Accepted", "info"],
    completed: ["Completed", "done"], rejected: ["Rejected", "muted"], expired: ["Expired", "muted"],
    escalated: ["Escalated", "alert"], cancelled: ["Cancelled", "muted"] };
  assert.deepEqual(Object.keys(expected).sort(), [...envelopeStatuses].sort());
  for (const [status, [label, tone]] of Object.entries(expected)) {
    assert.equal(statusLabel(status), label);
    assert.equal(statusTone(status), tone);
    const html = envelopeStatusBadge(status);
    assert.match(html, new RegExp(`handoff-badge-${tone}`));
    assert.match(html, new RegExp(`>${label}</span>`));
  }
  assert.match(envelopeStatusBadge("nope"), /handoff-badge-muted/);
});

test("the lifecycle trail shows each state transition with actor and note", () => {
  const html = handoffEnvelopeHtml(receipt({ status: "completed",
    history: [
      { status: "proposed", at: iso(NOW), by: "agent-a" },
      { status: "accepted", at: iso(NOW + HOUR), by: "agent-b", note: "looks good" },
      { status: "completed", at: iso(NOW + 2 * HOUR), by: "agent-b", checksPassed: ["work_completed", "result_submitted"] },
    ] }));
  const trail = html.slice(html.indexOf("handoff-trail"), html.indexOf("</ol>", html.indexOf("handoff-trail")));
  assert.match(trail, /Proposed/); assert.match(trail, /Accepted/); assert.match(trail, /Completed/);
  assert.ok(trail.indexOf("Proposed") < trail.indexOf("Accepted") && trail.indexOf("Accepted") < trail.indexOf("Completed"),
    "trail preserves transition order");
  assert.match(trail, /by agent-a/); assert.match(trail, /by agent-b/); assert.match(trail, /looks good/);
  // The current journal status leads the card.
  assert.match(html, /<span class="handoff-badge handoff-badge-done"[^>]*>Completed<\/span>/);
});

test("automatic handoff history explains expiry and names the escalation recipient", () => {
  for (const status of ["expired", "escalated"]) {
    const html = handoffEnvelopeHtml(receipt({ status, history: [
      { status: "proposed", at: iso(NOW), by: "agent-a" },
      { status, at: iso(NOW + 24 * HOUR), by: "system", reason: "termination.expiresAt reached",
        ...(status === "escalated" ? { escalatedTo: "review-agent" } : {}) },
    ] }));
    const trail = html.slice(html.indexOf('aria-label="Envelope lifecycle"'), html.indexOf("</ol>"));
    assert.match(trail, /Handoff deadline reached/);
    if (status === "escalated") assert.match(trail, /to review-agent/);
    else assert.doesNotMatch(trail, /to review-agent/);
  }
  const html = handoffEnvelopeHtml(receipt({ history: [
    { status: "escalated", at: iso(NOW), reason: "<reason>", escalatedTo: "<recipient>", note: "<note>" },
  ] }));
  assert.match(html, /&lt;reason&gt;/);
  assert.match(html, /&lt;recipient&gt;/);
  assert.match(html, /&lt;note&gt;/);
  assert.doesNotMatch(html, /<(reason|recipient|note)>/);
});

test("completed envelopes mark the checks the recipient asserted passed", () => {
  const html = handoffEnvelopeHtml(receipt({ status: "completed",
    history: [{ status: "proposed", at: iso(NOW), by: "agent-a" },
      { status: "accepted", at: iso(NOW + HOUR), by: "agent-b" },
      { status: "completed", at: iso(NOW + 2 * HOUR), by: "agent-b", checksPassed: ["work_completed"] }] }));
  assert.match(html, /Work completed<\/span>[\s\S]*?<span class="handoff-pass">passed<\/span>/);
  assert.doesNotMatch(html, /Result submitted<\/span>[\s\S]*?<span class="handoff-pass">/);
});

test("state transitions display correctly across proposed, accepted and completed cards", () => {
  for (const status of ["proposed", "accepted", "completed"]) {
    const html = handoffEnvelopeHtml(receipt({ status,
      history: [{ status: "proposed", at: iso(NOW), by: "agent-a" },
        ...(status === "proposed" ? [] : [{ status: "accepted", at: iso(NOW + HOUR), by: "agent-b" }]),
        ...(status === "completed" ? [{ status: "completed", at: iso(NOW + 2 * HOUR), by: "agent-b", checksPassed: ["work_completed"] }] : [])] }));
    assert.match(html, new RegExp(`handoff-badge handoff-badge-${statusTone(status)}[^>]*>${statusLabel(status)}<`),
      `card badge must read ${status}`);
    assert.match(html, /handoff-trail/, "trail must render");
    const trailEntries = [...html.matchAll(/handoff-badge handoff-badge-(\w+)"/g)].length;
    assert.ok(trailEntries >= (status === "proposed" ? 2 : status === "accepted" ? 3 : 4),
      `trail + badge must cover the ${status} history`);
  }
});

test("missing optional sections are skipped, never rendered empty", () => {
  const html = handoffEnvelopeHtml(receipt({ envelope: {
    expectedOutput: { kind: "report", description: "x" },
    authority: { permissions: ["accept_work"], scope: { rooms: ["room-1"] }, expiresAt: iso(NOW + 24 * HOUR) },
    termination: { expiresAt: iso(NOW + 24 * HOUR), onExpiry: "release", escalateTo: null },
    provenance: { createdBy: "agent-a" },
  } }));
  assert.doesNotMatch(html, /<h5>Inputs<\/h5>/);
  assert.doesNotMatch(html, /<h5>Acceptance test<\/h5>/);
  assert.match(html, /<h5>Expected output<\/h5>/);
  assert.doesNotMatch(html, /Escalate/); // onExpiry is "release"
});

test("envelopes with no envelope payload render an unavailable notice", () => {
  const html = handoffEnvelopeHtml({ envelopeId: "he_9", status: "proposed" });
  assert.match(html, /unavailable/);
});

test("rendered content is HTML-escaped", () => {
  const html = handoffEnvelopeHtml(receipt({ envelope: { objective: "<script>alert(1)</script>" } }));
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const urlHtml = handoffEnvelopeHtml(receipt({ envelope: {
    inputs: [{ kind: "url", ref: "https://example.test/x", label: "\"><img src=x onerror=alert(1)>" }] } }));
  assert.doesNotMatch(urlHtml, /<img src=x/);
});

test("envelopesForWork matches input refs, check workIds and scope workIds", () => {
  const receipts = [
    receipt({ envelopeId: "he_input" }),
    receipt({ envelopeId: "he_other", envelope: { inputs: [{ kind: "note", ref: "n" }],
      acceptanceTest: { checks: [{ kind: "work_completed", workId: "work-9" }] },
      authority: { permissions: ["accept_work"], scope: { rooms: ["room-1"] }, expiresAt: iso(NOW + 24 * HOUR) } } }),
    receipt({ envelopeId: "he_scope", envelope: { inputs: [{ kind: "note", ref: "n" }],
      authority: { permissions: ["accept_work"], scope: { workIds: ["work-1"] }, expiresAt: iso(NOW + 24 * HOUR) } } }),
  ];
  const matched = envelopesForWork(receipts, "work-1").map(r => r.envelopeId);
  assert.deepEqual(matched, ["he_input", "he_scope"]);
  assert.deepEqual(envelopesForWork(receipts, "work-zzz"), []);
  assert.deepEqual(envelopesForWork(null, "work-1"), []);
});

test("the list renderer wraps cards and names the empty state", () => {
  const html = handoffEnvelopeListHtml([receipt({ envelopeId: "he_1" }), receipt({ envelopeId: "he_2", status: "accepted" })]);
  assert.equal((html.match(/data-handoff-envelope=/g) ?? []).length, 2);
  assert.match(handoffEnvelopeListHtml([]), /No handoffs reference this work yet/);
});
