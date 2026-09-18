// LANE B: extractive thread summary / digest tests (rule-based, no LLM).
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeThread, threadBlurb, buildDigest, SummaryError } from "../server/inbox-summaries.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof SummaryError && error.code === code);

const M = body => ({ body });

test("summarizeThread picks representative sentences in original order", () => {
  const summary = summarizeThread([
    M("Project Phoenix launch plan. We need to finalize the Phoenix pricing tiers before Friday."),
    M("The Phoenix pricing tiers look good. Can you confirm the Phoenix discount for early adopters?"),
  ], { maxSentences: 2 });
  assert.equal(summary.messageCount, 2);
  assert.ok(summary.summary.length <= 2);
  // Original order preserved.
  const joined = summary.summary.join(" ");
  assert.ok(joined.indexOf("Project Phoenix launch plan") < joined.indexOf("Can you confirm") || summary.summary.length === 1);
  assert.ok(Object.isFrozen(summary));
  assert.ok(Object.isFrozen(summary.summary));
});

test("summarizeThread extracts questions and action items", () => {
  const summary = summarizeThread([
    M("Hi team. Please review the attached contract by Thursday. Can you confirm the renewal date? We should follow up with legal next week."),
  ]);
  assert.ok(summary.questions.some(q => q.includes("renewal date")));
  assert.ok(summary.actionItems.some(a => /review the attached contract/i.test(a)));
  assert.ok(summary.actionItems.some(a => /follow up with legal/i.test(a)));
});

test("question and action cues boost ranking", () => {
  const summary = summarizeThread([
    M("The sky is blue and the grass is green and the weather is quite pleasant today overall."),
    M("Could you approve the budget increase before Friday?"),
  ], { maxSentences: 1 });
  assert.equal(summary.summary.length, 1);
  assert.ok(summary.summary[0].includes("approve the budget increase"));
});

test("summarizeThread validation", () => {
  throwsCode(() => summarizeThread([], {}), "SUMMARY_INVALID_INPUT");
  throwsCode(() => summarizeThread("nope", {}), "SUMMARY_INVALID_INPUT");
  throwsCode(() => summarizeThread([M("")], {}), "SUMMARY_INVALID_INPUT");
  throwsCode(() => summarizeThread([M("ok")], { maxSentences: 0 }), "SUMMARY_INVALID_INPUT");
  throwsCode(() => summarizeThread([M("ok")], { maxSentences: 21 }), "SUMMARY_INVALID_INPUT");
  throwsCode(() => summarizeThread([{ body: "   " }], {}), "SUMMARY_INVALID_INPUT");
});

test("threadBlurb returns the single best sentence", () => {
  const blurb = threadBlurb([M("Short note. Can you send the Q3 numbers by Monday?")]);
  assert.equal(typeof blurb, "string");
  assert.ok(blurb.length > 0);
});

test("buildDigest aggregates threads, questions, and action items", () => {
  const digest = buildDigest([
    { id: "t1", subject: "Pricing", messages: [M("Please approve the new pricing. When does it go live?")] },
    { id: "t2", subject: "Launch", messages: [M("Please approve the new pricing. The launch is Friday.")] },
  ]);
  assert.equal(digest.threadCount, 2);
  assert.equal(digest.totalMessages, 2);
  assert.equal(digest.totalQuestions, 1);
  assert.ok(digest.totalActionItems >= 2);
  assert.equal(digest.threads.length, 2);
  assert.ok(digest.threads[0].blurb.length > 0);
  // The repeated action item ranks first with count 2.
  assert.equal(digest.topActionItems[0].count, 2);
  assert.ok(digest.topActionItems[0].text.includes("approve the new pricing"));
  assert.ok(digest.topQuestions.some(q => q.text.includes("go live")));
  assert.ok(Object.isFrozen(digest));
  assert.ok(Object.isFrozen(digest.threads));
});

test("buildDigest validation", () => {
  throwsCode(() => buildDigest("nope"), "SUMMARY_INVALID_INPUT");
  throwsCode(() => buildDigest([{ id: "t" }]), "SUMMARY_INVALID_INPUT");
  throwsCode(() => buildDigest([{ id: "", messages: [M("x")] }]), "SUMMARY_INVALID_INPUT");
  assert.deepEqual(buildDigest([]).threads, []);
});
