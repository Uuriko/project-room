// tests/poll-ui.test.js — The web client exposes poll messages: question,
// options, live results, and voting.
//
// Contract: a poll message (kind "poll") renders in the room timeline as a
// poll — not as bare body text — with one vote control per option wired to
// the existing reaction path (data-message-action="react"), the viewer's own
// vote marked, and a closed state once the poll is closed. All user text is
// HTML-escaped.
import test from "node:test";
import assert from "node:assert/strict";
import { pollHtml, pollTally, POLL_OPTION_EMOJIS } from "../src/polls.js";

const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

const pollMessage = (overrides = {}) => ({
  id: "poll-1",
  kind: "poll",
  body: "poll body",
  authorId: "pv-a",
  reactions: {},
  poll: {
    question: "Which option?",
    options: [
      { label: "alpha", emoji: POLL_OPTION_EMOJIS[0] },
      { label: "beta", emoji: POLL_OPTION_EMOJIS[1] },
    ],
    allowMultiple: false,
  },
  ...overrides,
});

test("a poll message renders its question and options", () => {
  const html = pollHtml(pollMessage(), esc, "pv-b");
  assert.ok(html.includes("Which option?"), "question rendered");
  assert.ok(html.includes("alpha"), "option label rendered");
  assert.ok(html.includes("beta"), "option label rendered");
});

test("each option is a vote button on the existing reaction path", () => {
  const html = pollHtml(pollMessage(), esc, "pv-b");
  const [e1, e2] = POLL_OPTION_EMOJIS;
  assert.ok(html.includes(`data-message-action="react"`), "reuses the react action");
  assert.ok(html.includes(`data-reaction="${e1}"`), "first option votes its emoji");
  assert.ok(html.includes(`data-reaction="${e2}"`), "second option votes its emoji");
  assert.ok(html.includes(`data-message-id="poll-1"`), "buttons target the poll message");
});

test("live results show vote counts", () => {
  const message = pollMessage({ reactions: { [POLL_OPTION_EMOJIS[0]]: ["pv-a", "pv-b"] } });
  const html = pollHtml(message, esc, "pv-b");
  assert.ok(/2/.test(html), "vote count rendered");
  assert.ok(html.includes("1️⃣") || html.includes(POLL_OPTION_EMOJIS[0]), "option emoji shown");
  const tally = pollTally(message);
  assert.equal(tally.total, 2);
});

test("the viewer's own vote is marked", () => {
  const message = pollMessage({ reactions: { [POLL_OPTION_EMOJIS[1]]: ["pv-b"] } });
  const html = pollHtml(message, esc, "pv-b");
  assert.ok(html.includes('aria-pressed="true"'), "own vote marked pressed");
});

test("question and labels are HTML-escaped", () => {
  const message = pollMessage({
    poll: {
      question: '<script>alert("q")</script>',
      options: [{ label: '<img src=x onerror=alert(1)>', emoji: POLL_OPTION_EMOJIS[0] }],
      allowMultiple: false,
    },
  });
  const html = pollHtml(message, esc, "pv-b");
  assert.ok(!html.includes("<script>"), "no raw script tag");
  assert.ok(!html.includes("<img"), "no raw img tag");
  assert.ok(html.includes("&lt;script&gt;"), "question escaped");
});

test("a closed poll shows closed and offers no vote buttons", () => {
  const message = pollMessage({ poll: { ...pollMessage().poll, closedAt: "2026-10-07T04:00:00.000Z" } });
  const html = pollHtml(message, esc, "pv-b");
  assert.ok(/closed/i.test(html), "closed marker rendered");
  assert.ok(!html.includes('data-message-action="react"'), "no vote buttons when closed");
});

test("non-poll messages render nothing", () => {
  assert.equal(pollHtml({ id: "m1", body: "hi" }, esc, "pv-b"), "");
  assert.equal(pollHtml(null, esc, "pv-b"), "");
});
