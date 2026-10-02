// Notification policy decisions. The engine is pure: a fixed clock, no network,
// no store. Email stays unscheduled unless a caller opts into a NOTIFY mode.
import test from "node:test";
import assert from "node:assert/strict";
import { createNotifyPrefs, NotifyError } from "../server/notify-prefs.mjs";
import {
  decide, tierFor, levelAllows, desktopHold, quietDefer, batchPlan, capPlan, holdoutAllows, reasonFor,
  emailChannelPlan, POLICY_DEFAULT_LEVEL, POLICY_LEVELS, EMAIL_DELIVERY, BATCH_WINDOW_MS,
  DESKTOP_RECHECK_MS, PolicyError
} from "../server/notify-policy.mjs";

const at = (hour, minute = 0) => Date.UTC(2026, 8, 18, hour + 7, minute);
const QUIET = { start: "21:00", end: "08:00", tz: "America/Los_Angeles" };

const item = (over = {}) => ({
  kind: "approval_requested", roomId: "muse", fromMemberId: "codex", fromKind: "agent",
  addressedTo: ["ada"], blocking: true, title: "deploy staging", url: "/?room=muse", seq: 4, ...over
});

const ctx = (over = {}) => ({
  me: "ada", now: at(12), senderLabel: "Codex",
  prefs: { level: "needs_me", quietHours: null, wakeFor: [] },
  presence: {}, recentPushes: [], channelsEnabled: { push: true }, ...over
});

const channels = decision => decision.deliver.map(entry => entry.channel);
const pushAt = decision => decision.deliver.filter(entry => entry.channel === "push");

test("every kind lands in one tier", () => {
  const base = ctx();
  const cases = [
    ["approval_requested", {}, "needs_me"],
    ["input_required", {}, "needs_me"],
    ["blocked_on_me", {}, "needs_me"],
    ["review_requested", {}, "needs_me"],
    ["dm", {}, "needs_me"],
    ["question_mention", {}, "needs_me"],
    ["access_request", { owner: true }, "needs_me"],
    ["access_request", {}, "room"],
    ["approval_requested", {}, "room", { blocking: false }],
    ["approval_requested", {}, "room", { addressedTo: ["other"] }],
    ["claim_done", { ownsRoom: true }, "following", { blocking: false, addressedTo: [] }],
    ["claim_done", {}, "room", { blocking: false, addressedTo: [] }],
    ["pr_merged", { ownsRoom: true }, "following", { blocking: false, addressedTo: [] }],
    ["reply", { myThreadIds: ["thread-1"] }, "following", { blocking: false, threadId: "thread-1", addressedTo: ["ada"] }],
    ["reply", { myThreadIds: ["thread-1"] }, "room", { blocking: false, threadId: "other", addressedTo: ["ada"] }],
    ["member_added", {}, "following", { blocking: false, addressedTo: [] }],
    ["mention", {}, "room", { blocking: true }],
    ["work_update", {}, "room", { blocking: false, addressedTo: [] }]
  ];
  for (const [kind, ctxOver, tier, itemOver] of cases) {
    const decision = decide(item({ kind, ...itemOver }), ctx({ ...base, ...ctxOver }));
    assert.equal(decision.tier, tier, kind);
    assert.equal(tierFor(item({ kind, ...itemOver }), ctx({ ...base, ...ctxOver })), tier, kind);
  }
});

test("the needs_me default pushes only a blocking item addressed to me", () => {
  assert.equal(POLICY_DEFAULT_LEVEL, "needs_me");
  const approval = decide(item(), ctx());
  assert.equal(pushAt(approval).length, 1);
  assert.equal(pushAt(approval)[0].at, at(12));
  assert.equal(approval.batchKey, "ada|muse|needs_me");

  const mention = decide(item({ kind: "mention", blocking: false }), ctx());
  assert.deepEqual(channels(mention), ["in_app"]);

  const watching = decide(item({ kind: "claim_done", blocking: false, addressedTo: [] }), ctx({ ownsRoom: true }));
  assert.equal(watching.tier, "following");
  assert.equal(channels(watching).includes("push"), false);
  assert.equal(channels(watching).includes("brief"), true);
  assert.equal(channels(watching).includes("in_app"), true);
});

test("stored levels keep their meaning and needs_me is not stored yet", () => {
  const prefs = createNotifyPrefs();
  assert.deepEqual([...prefs.LEVELS], ["all", "mentions", "muted"]);
  assert.equal(POLICY_LEVELS.includes("needs_me"), true);
  assert.throws(() => prefs.setGlobal("ada", { level: "needs_me" }), error => error instanceof NotifyError);
  prefs.setGlobal("ada", { level: "mentions" });
  const level = prefs.resolve("ada", { roomId: "muse" });
  assert.equal(level, "mentions");
  const approval = decide(item(), ctx({ prefs: level }));
  assert.equal(channels(approval).includes("push"), false, "mentions does not page an approval");
  const dm = decide(item({ kind: "dm" }), ctx({ prefs: level }));
  assert.equal(pushAt(dm).length, 1);
  assert.equal(levelAllows("mentions", "needs_me", "approval_requested"), false);
  assert.equal(levelAllows("needs_me", "needs_me", "approval_requested"), true);
  assert.equal(levelAllows("all", "needs_me", "approval_requested"), true);
  const muted = decide(item(), ctx({ prefs: "muted" }));
  assert.deepEqual(muted.deliver, []);
});

test("a focused desktop holds the push for a 120s re-check", () => {
  const now = at(12);
  const held = decide(item(), ctx({
    now,
    presence: { focusedAt: now - 30_000, heartbeatAt: now - 10_000 }
  }));
  assert.deepEqual(pushAt(held), [{ channel: "push", at: now + DESKTOP_RECHECK_MS, recheck: true }]);
  assert.equal(channels(held).includes("in_app"), true);
  assert.deepEqual(desktopHold({ focusedAt: now - 30_000, heartbeatAt: now - 10_000 }, now), {
    channel: "push", at: now + 120_000, recheck: true
  });

  const idle = decide(item(), ctx({
    now,
    presence: { focusedAt: now - 90_000, heartbeatAt: now - 90_000 }
  }));
  assert.equal(pushAt(idle)[0].at, now);
  assert.equal(pushAt(idle)[0].recheck, undefined);
  assert.equal(desktopHold({ focusedAt: now - 90_000 }, now), null);
});

test("quiet hours defer to the brief unless the sender can wake me", () => {
  const now = at(23);
  const deferred = decide(item(), ctx({ now, prefs: { level: "needs_me", quietHours: QUIET, wakeFor: [] } }));
  assert.equal(channels(deferred).includes("push"), false);
  const brief = deferred.deliver.find(entry => entry.channel === "brief");
  assert.ok(brief.at > now);
  assert.deepEqual(quietDefer({ quietHours: QUIET, wakeFor: [] }, "codex", now).quiet, true);

  const woken = decide(item(), ctx({ now, prefs: { level: "needs_me", quietHours: QUIET, wakeFor: ["codex"] } }));
  assert.equal(pushAt(woken)[0].at, now);
  assert.equal(quietDefer({ quietHours: QUIET, wakeFor: ["codex"] }, "codex", now).wake, true);
});

test("the first item in a 15-minute window delivers, and the next collapses to the end", () => {
  const now = at(12);
  const first = decide(item(), ctx({ now }));
  assert.equal(pushAt(first)[0].at, now);
  assert.equal(batchPlan([], first.batchKey, now).collapsed, false);

  const openedAt = now - 10 * 60 * 1000;
  const second = decide(item({ seq: 5 }), ctx({
    now, batches: [{ batchKey: "ada|muse|needs_me", openedAt }]
  }));
  assert.equal(pushAt(second)[0].at, openedAt + BATCH_WINDOW_MS);
  assert.equal(batchPlan([{ batchKey: "ada|muse|needs_me", openedAt }], second.batchKey, now).collapsed, true);
});

test("per-agent and per-day caps collapse extra pushes, and wakeFor is outside the cap", () => {
  const now = at(12);
  const fromAgent = [1, 2, 3].map(n => ({ at: now - n * 1000, fromMemberId: "codex" }));
  const capped = decide(item(), ctx({ now, recentPushes: fromAgent }));
  assert.equal(pushAt(capped)[0].at, now + BATCH_WINDOW_MS);
  assert.equal(capPlan(fromAgent, "codex", now).allowed, false);

  const day = Array.from({ length: 12 }, (_, n) => ({ at: now - (n + 1) * 60_000, fromMemberId: `agent-${n}` }));
  const daily = decide(item(), ctx({ now, recentPushes: day }));
  assert.notEqual(pushAt(daily)[0].at, now);

  const woken = decide(item(), ctx({
    now, recentPushes: day, prefs: { level: "needs_me", wakeFor: ["codex"] }
  }));
  assert.equal(pushAt(woken)[0].at, now);
  assert.equal(capPlan(day, "codex", now, { wake: true }).allowed, true);
});

test("every decision says why, and a holdout still delivers a direct request", () => {
  const approval = decide(item(), ctx());
  assert.equal(approval.reason, "because Codex asked you to approve 'deploy staging'");
  assert.equal(reasonFor(item(), ctx()), approval.reason);
  const kinds = ["input_required", "blocked_on_me", "review_requested", "dm", "question_mention", "access_request", "claim_done", "mention"];
  for (const kind of kinds) {
    const decision = decide(item({ kind, blocking: kind !== "claim_done" && kind !== "mention" }), ctx({ owner: true, ownsRoom: true }));
    assert.match(decision.reason, /^because /);
  }

  const direct = decide(item(), ctx({ holdout: true }));
  assert.equal(pushAt(direct).length, 1);
  assert.equal(holdoutAllows(true, "needs_me"), true);
  const following = decide(item({ kind: "claim_done", blocking: false, addressedTo: [] }), ctx({ holdout: true, ownsRoom: true }));
  assert.deepEqual(channels(following), ["in_app"]);
  assert.equal(holdoutAllows(true, "following"), false);
});

test("email delivery stays inert unless NOTIFY opts in on a verified address", () => {
  assert.equal(EMAIL_DELIVERY, "inert");
  const enabled = decide(item(), ctx({ channelsEnabled: { push: true, email: true } }));
  assert.equal(channels(enabled).includes("email"), false);
  assert.deepEqual(emailChannelPlan(item(), ctx({ channelsEnabled: { email: true } }), "needs_me", at(12)), []);

  const now = at(12);
  const scheduled = decide(item(), ctx({
    now, emailDelivery: "needs_me", emailVerified: true, channelsEnabled: { push: true, email: true }
  }));
  const email = scheduled.deliver.find(entry => entry.channel === "email");
  assert.equal(email.at, now + 15 * 60 * 1000);

  const again = decide(item({ seq: 5 }), ctx({
    now, emailDelivery: "needs_me", emailVerified: true,
    recentEmails: [{ kind: "approval_requested", roomId: "muse", at: now - 60_000 }]
  }));
  assert.equal(again.deliver.find(entry => entry.channel === "email").collapsed, true);

  const unverified = decide(item(), ctx({ emailDelivery: "needs_me", emailVerified: false }));
  assert.equal(channels(unverified).includes("email"), false);

  const quietEmail = decide(item(), ctx({
    now: at(23), emailDelivery: "needs_me", emailVerified: true,
    prefs: { level: "needs_me", quietHours: QUIET, wakeFor: [] }
  }));
  assert.equal(quietEmail.deliver.find(entry => entry.channel === "email").brief, true);
  assert.equal(channels(quietEmail).includes("push"), false);
});

test("a slack or discord relay is scheduled only when that channel is enabled", () => {
  const both = decide(item(), ctx({ channelsEnabled: { push: true, slack: true, discord: true, telegram: true } }));
  for (const channel of ["push", "slack", "discord", "telegram"]) assert.equal(channels(both).includes(channel), true);
  const pushOnly = decide(item(), ctx());
  assert.equal(channels(pushOnly).includes("slack"), false);
});

test("malformed items and contexts are refused", () => {
  assert.throws(() => decide(null, ctx()), error => error instanceof PolicyError && error.code === "invalid_notify_policy");
  assert.throws(() => decide(item(), { me: "ada" }), error => error instanceof PolicyError);
});
