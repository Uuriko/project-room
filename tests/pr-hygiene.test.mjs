import test from "node:test";
import assert from "node:assert/strict";
import { decide, STALE_DAYS, CLOSE_DAYS } from "../scripts/pr-hygiene.mjs";

const repo = "Uuriko/project-room";
const now = Date.parse("2026-11-20T00:00:00Z");
const pr = ({ idle = 0, labels = [], fork = false, mergeable = null } = {}) => ({
  updated_at: new Date(now - idle * 86_400_000).toISOString(),
  labels: labels.map(name => ({ name })),
  head: { repo: { full_name: fork ? "someone/project-room" : repo } },
  mergeable,
});
const action = options => decide(pr(options), { now, repo }).action;

test("recent pull requests are left alone", () => {
  assert.equal(action({ idle: STALE_DAYS - 1 }), "skip");
  assert.equal(action({ idle: STALE_DAYS - 1, fork: true }), "skip");
});

test("an idle maintainer PR is labelled before anything else", () => {
  assert.equal(action({ idle: STALE_DAYS, mergeable: false }), "label");
});

test("a labelled, idle, conflicting maintainer PR is closed", () => {
  assert.equal(action({ idle: CLOSE_DAYS, labels: ["stale"], mergeable: false }), "close");
});

test("a labelled PR that still merges, or whose mergeability is unknown, stays open", () => {
  assert.equal(action({ idle: 30, labels: ["stale"], mergeable: true }), "skip");
  assert.equal(action({ idle: 30, labels: ["stale"], mergeable: null }), "skip");
});

test("a fork PR is asked once and never closed automatically", () => {
  assert.equal(action({ idle: STALE_DAYS, fork: true, mergeable: false }), "ask");
  assert.equal(action({ idle: 90, labels: ["stale"], fork: true, mergeable: false }), "skip");
});

test("a PR with no head repository counts as a fork", () => {
  const deletedFork = { ...pr({ idle: 30, labels: ["stale"], mergeable: false }), head: { repo: null } };
  assert.equal(decide(deletedFork, { now, repo }).action, "skip");
});

test("keep-open exempts a pull request", () => {
  assert.equal(action({ idle: 90, labels: ["stale", "keep-open"], mergeable: false }), "skip");
});
