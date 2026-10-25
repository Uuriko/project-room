// Coordinator planning: queue rank, capacity, collision, stall, and split.
import test from "node:test";
import assert from "node:assert/strict";
import { agentCapacity, buildWorkQueue, metricsOf, planAssignments } from "../server/agent-dispatch.mjs";

const agent = (partial) => ({
  memberId: "ada", displayName: "Ada", identityId: null, status: "idle", stalled: false,
  offered: false, failureRate: 0, mergedPerDay: 0, strengths: [], openClaims: [], ...partial
});

const task = (partial) => ({
  key: "board:t", source: "board", title: "Task", value: 40, blocked: false, assignable: true,
  onlyMemberId: null, holders: [], claimIds: [], touches: [{ path: "src/a.js", symbols: [] }],
  reason: "Ready.", ...partial
});

const pull = (outcome, ci) => ({ url: "https://github.com/acme/repo/pull/1", outcome: outcome ?? null, ...(ci ? { ciStatus: { state: ci } } : {}) });

test("the queue ranks unblocked work first, then value", () => {
  const queue = buildWorkQueue({
    claims: [
      { id: "low", state: "unclaimed", title: "Low", tags: ["low"], files: ["src/low.js"] },
      { id: "wait", state: "unclaimed", title: "Wait", tags: ["urgent"], files: ["src/wait.js"], dependsOn: ["missing"] },
      { id: "go", state: "unclaimed", title: "Go", tags: ["urgent"], files: ["src/go.js"] }
    ],
    fixPlans: [{ id: "later", title: "Later", files: ["src/fix.js"], blockedBy: ["missing"] }]
  });
  assert.deepEqual(queue.tasks.map(item => item.key), ["board:go", "board:low", "board:wait", "fix:later"]);
  assert.equal(queue.tasks[0].blocked, false);
  assert.equal(queue.tasks[2].blocked, true);
  assert.equal(queue.tasks[2].value > queue.tasks[3].value, true);
});

test("a failing check is only for its owner, and a collision is not handed to a third agent", () => {
  const queue = buildWorkQueue({
    claims: [
      { id: "held", state: "claimed", owner: "ada", title: "Held", files: ["src/shared.js"], pullRequest: pull(null, "failure") },
      { id: "other", state: "in_progress", owner: "bee", title: "Other", files: ["src/shared.js"] },
      { id: "free", state: "unclaimed", title: "Free", files: ["docs/guide.md"] }
    ]
  });
  const check = queue.tasks.find(item => item.source === "failing_check");
  const collision = queue.tasks.find(item => item.source === "collision");
  assert.equal(check.onlyMemberId, "ada");
  assert.equal(check.value > collision.value, true);
  assert.equal(collision.assignable, false);
  const plan = planAssignments({
    agents: [agent({ memberId: "cy", displayName: "Cy" })],
    tasks: queue.tasks,
    active: []
  });
  assert.deepEqual(plan.assignments.map(row => row.task.key), ["board:free"]);
});

test("two unclaimed copies become one assignment", () => {
  const files = ["src/a.js", "src/b.js"];
  const queue = buildWorkQueue({
    claims: [
      { id: "one", state: "unclaimed", title: "One", files },
      { id: "two", state: "unclaimed", title: "Two", files: [...files].reverse() }
    ]
  });
  assert.equal(queue.tasks.filter(item => item.source === "board").length, 0);
  const duplicate = queue.tasks.find(item => item.source === "duplicate");
  assert.equal(duplicate.assignable, true);
  const plan = planAssignments({
    agents: [agent(), agent({ memberId: "bee", displayName: "Bee" })],
    tasks: queue.tasks
  });
  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.assignments[0].task.source, "duplicate");
});

test("capacity counts throughput, failure, and map areas", () => {
  const now = Date.parse("2026-10-25T00:00:00Z");
  const rows = agentCapacity({
    now,
    projectMap: { files: { "server/parser.mjs": { area: "parse", symbols: ["parseModule"] } } },
    agents: [{ memberId: "ada", displayName: "Ada" }, { memberId: "bee", displayName: "Bee" }],
    claims: [
      { id: "shipped", owner: "ada", state: "done", files: ["server/parser.mjs"], updatedAt: now - 1000, pullRequest: pull("merged") },
      { id: "open", owner: "bee", state: "claimed", title: "Open", files: ["src/app.js"], pullRequest: pull(null, "failure") },
      { id: "dropped", owner: "bee", state: "closed", files: ["src/old.js"], updatedAt: now - 1000, pullRequest: pull("closed") }
    ]
  });
  const ada = rows.find(row => row.memberId === "ada");
  const bee = rows.find(row => row.memberId === "bee");
  assert.equal(ada.status, "idle");
  assert.deepEqual(ada.strengths, [{ area: "parse", merged: 1 }]);
  assert.equal(ada.mergedPerDay > 0, true);
  assert.equal(bee.status, "busy");
  assert.equal(bee.stalled, true);
  assert.equal(bee.openPrs.length, 1);
  assert.equal(bee.failureRate > 0, true);
});

test("a stalled agent is offered their open pulls first, and a decline is not a stop", () => {
  const ada = agent({
    status: "busy", stalled: true, failureRate: 0.8,
    openClaims: [{ id: "pr", owner: "ada", state: "claimed", files: ["src/held.js"], pullRequest: pull(null) }]
  });
  const fresh = task({ key: "board:new", title: "New", value: 100, touches: [{ path: "src/new.js", symbols: [] }] });
  const active = [{ memberId: "ada", keys: new Set(["file:src/held.js"]), own: true }];
  const first = planAssignments({ agents: [ada], tasks: [fresh], active });
  assert.equal(first.assignments.length, 1);
  assert.equal(first.assignments[0].task.source, "finish_prs");
  assert.match(first.assignments[0].reason, /Finish those before starting new work/);
  const after = planAssignments({
    agents: [ada], tasks: [fresh], active,
    declines: new Set(["ada|finish:ada"])
  });
  assert.equal(after.assignments[0].task.key, "board:new");
});

test("assignment avoids another agent's files and prefers the agent who has merged there", () => {
  const shared = task({ key: "board:shared", touches: [{ path: "src/shared.js", symbols: ["run"] }] });
  const own = task({ key: "board:own", title: "Own", touches: [{ path: "server/parser.mjs", symbols: [] }] });
  const ada = agent({ strengths: [{ area: "server", merged: 4 }] });
  const bee = agent({ memberId: "bee", displayName: "Bee" });
  const plan = planAssignments({
    agents: [bee, ada],
    tasks: [shared, own],
    active: [{ memberId: "cy", keys: new Set(["file:src/shared.js", "sym:src/shared.js:run"]), own: true }]
  });
  assert.deepEqual(plan.assignments.map(row => [row.memberId, row.task.key]), [["ada", "board:own"]]);
  assert.match(plan.assignments[0].reason, /4 merged in server/);
});

test("an open offer reserves its task even when the task names no files", () => {
  const bare = task({ key: "board:bare", touches: [] });
  const plan = planAssignments({
    agents: [agent({ memberId: "bee", displayName: "Bee" })],
    tasks: [bare],
    active: [{ memberId: "ada", keys: new Set(["task:board:bare"]), own: false }]
  });
  assert.deepEqual(plan.assignments, []);
});

test("a big task splits across idle agents on area, without shared files", () => {
  const big = task({
    key: "board:big", title: "Big", value: 80,
    touches: [
      { path: "server/a.mjs", symbols: [] },
      { path: "server/b.mjs", symbols: [] },
      { path: "src/a.js", symbols: [] },
      { path: "src/b.js", symbols: [] }
    ]
  });
  const plan = planAssignments({
    agents: [
      agent({ memberId: "a", displayName: "A" }),
      agent({ memberId: "b", displayName: "B", strengths: [{ area: "src", merged: 3 }] })
    ],
    tasks: [big]
  });
  assert.equal(plan.assignments.length, 2);
  const byArea = Object.fromEntries(plan.assignments.map(row => [row.task.key.split("#")[1], row.memberId]));
  assert.deepEqual(byArea, { server: "a", src: "b" });
  const files = plan.assignments.map(row => row.task.touches.map(touch => touch.path));
  assert.equal(files[0].some(path => files[1].includes(path)), false);
});

test("metrics are the busy share, merged per day, and overlap rates", () => {
  const now = Date.parse("2026-10-25T00:00:00Z");
  const metrics = metricsOf({
    now,
    capacity: [
      { displayName: "Ada", status: "busy", mergedPerDay: 1 },
      { displayName: "Bee", status: "idle", mergedPerDay: 0.5 }
    ],
    queue: { duplicateRate: 0.5, collisionRate: 0.25 },
    samples: [
      { at: now - 1000, busy: 0, agents: 2 },
      { at: now - 500, busy: 2, agents: 2 }
    ]
  });
  assert.equal(metrics.busyShare, 0.5);
  assert.equal(metrics.busyShareBasis, "window");
  assert.equal(metrics.mergedPerDay, 1.5);
  assert.equal(metrics.duplicateRate, 0.5);
  assert.equal(metrics.collisionRate, 0.25);
  assert.equal("memberId" in metrics.perAgent[0], false);
});

test("a paused room and a held seat do not let the fallback assign", () => {
  const agents = [agent()];
  const tasks = [task()];
  assert.equal(planAssignments({ agents, tasks, paused: true }).skipped, "paused");
  assert.equal(planAssignments({ agents, tasks, seatMode: "agent", actor: { role: "hook" } }).skipped, "seat_held");
  assert.equal(planAssignments({ agents, tasks, seatMode: "agent", actor: { role: "holder" } }).assignments.length, 1);
});
