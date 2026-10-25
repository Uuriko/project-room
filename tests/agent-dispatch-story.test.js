// An idle agent is offered the task they are best at, can decline it, and
// does not get a second task that overlaps someone else's files. The fallback
// stops when an agent claims the seat. The human page has no controls.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createWork } from "../server/work-claims.mjs";
import { ServiceError } from "../server/service-error.mjs";
import { readDispatch } from "../server/routes/agent-dispatch.mjs";
import { DISPATCH_PAGE_CSP } from "../server/agent-dispatch-view.mjs";

const ROOM = "commons";

function room(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom(ROOM));
  store.projectMap = {
    snapshot() {
      return { files: { "server/parser.mjs": { area: "parse", symbols: ["parseModule"] } } };
    }
  };
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  const link = (name) => {
    const identity = store.identities.create(name);
    return store.identities.link(ownerKey, ROOM, {
      identityId: identity.identityId, displayName: name, permissions: ["accept_work"]
    });
  };
  return { store, ada: link("Ada"), bee: link("Bee") };
}

function put(store, item) {
  store.workClaims.set(ROOM, item);
}

test("the fallback offers the stronger idle agent, a decline moves the task, and the seat stops the fallback", t => {
  const { store, ada, bee } = room(t);
  const now = Date.now();
  const shipped = createWork({ id: "shipped", title: "Parser", files: ["server/parser.mjs"] }, { now, agentId: "owner" });
  put(store, {
    ...shipped, state: "done", owner: ada.memberId, updatedAt: now - 1000,
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/1", outcome: "merged" },
    pullRequests: [{ url: "https://github.com/Uuriko/project-room/pull/1", outcome: "merged" }]
  });
  put(store, createWork({ id: "next", title: "Parser follow-up", files: ["server/parser.mjs"] }, { now, agentId: "owner" }));

  const offered = store.agentDispatch.view(ROOM);
  const adaRow = offered.capacity.find(row => row.memberId === ada.memberId);
  assert.equal(adaRow.status, "idle");
  assert.equal(adaRow.strengths[0].area, "parse");
  const offer = offered.assignments.find(row => row.taskKey === "board:next");
  assert.equal(offer.memberId, ada.memberId);
  assert.equal(offer.status, "offered");
  assert.match(offer.reason, /fallback assigned/i);
  assert.match(offer.reason, /parse/);
  const wakes = store.db.prepare("SELECT agent_id AS agentId, kind, message_id AS messageId FROM agent_wake_signals WHERE room_id=?").all(ROOM);
  assert.ok(wakes.some(row => row.agentId === ada.identityId && row.kind === "assignment" && row.messageId === offer.id));

  assert.throws(
    () => store.agentDispatch.respond(ROOM, { memberId: bee.memberId, kind: "agent" }, { assignmentId: offer.id, decision: "decline" }),
    error => error instanceof ServiceError && error.status === 403
  );
  const declined = store.agentDispatch.respond(ROOM, { memberId: ada.memberId, kind: "agent", displayName: "Ada" }, { assignmentId: offer.id, decision: "decline" });
  assert.equal(declined.assignment.status, "declined");
  assert.equal(declined.reassigned[0].memberId, bee.memberId);
  const accepted = store.agentDispatch.respond(ROOM, { memberId: bee.memberId, kind: "agent" }, { assignmentId: declined.reassigned[0].id, decision: "accept" });
  assert.equal(accepted.assignment.status, "accepted");
  assert.equal(store.agentDispatch.view(ROOM).capacity.find(row => row.memberId === bee.memberId).status, "busy");

  store.agentDispatch.claimSeat(ROOM, { memberId: ada.memberId, kind: "agent", displayName: "Ada" }, "claim");
  put(store, createWork({ id: "other", title: "Guide", files: ["docs/guide.md"] }, { now, agentId: "owner" }));
  assert.equal(store.agentDispatch.view(ROOM).assignments.some(row => row.taskKey === "board:other"), false);
  assert.equal(store.agentDispatch.tick(ROOM, { role: "hook" }).skipped, "seat_held");

  assert.throws(
    () => store.agentDispatch.override(ROOM, { memberId: ada.memberId }, { action: "pause" }),
    error => error instanceof ServiceError && error.status === 403
  );
  const forced = store.agentDispatch.override(ROOM, { memberId: "owner" }, { action: "assign", memberId: bee.memberId, taskKey: "board:other", note: "Take the guide." });
  assert.equal(forced.assignment.memberId, bee.memberId);
  assert.match(forced.assignment.reason, /owner overrode assignment/);
  assert.equal(forced.assignment.by, "owner");
  assert.ok(store.agentDispatch.view(ROOM).log.some(entry => /owner overrode assignment/.test(entry.reason)));

  const recorded = [];
  const res = {
    writeHead(status, headers) { recorded.push({ status, headers }); },
    end(body) { recorded.push({ body }); }
  };
  readDispatch({
    params: { roomId: ROOM },
    req: { method: "GET", headers: { accept: "text/html" } },
    res,
    url: new URL(`https://room.example/api/rooms/${ROOM}/dispatch`),
    store,
    roomCredentials: () => ({ mode: "room", bearer: true }),
    expectedBinding: () => null,
    accountBinding: () => null,
    roomAuth: () => ({ kind: "session", credentialScope: "room", credentialHash: "h", member: { id: "owner", displayName: "Room owner", kind: "human" } }),
    rate() {},
    protectWrite() {},
    reject(status, code, message) { const error = new Error(message); error.status = status; error.code = code; throw error; },
    json() { throw new Error("the human request was answered as JSON"); }
  });
  const html = recorded.at(-1).body;
  assert.equal(recorded[0].status, 200);
  assert.equal(recorded[0].headers["Content-Type"], "text/html; charset=utf-8");
  assert.equal(recorded[0].headers["Content-Security-Policy"], DISPATCH_PAGE_CSP);
  assert.equal(html.includes("<button"), false);
  assert.equal(html.includes("<form"), false);
  assert.equal(html.includes("<input"), false);
  assert.equal(html.includes(ada.memberId), false);
  assert.equal(html.includes(bee.memberId), false);
  assert.match(html, /Ada/);
  assert.match(html, /Bee is busy/);
  assert.match(html, /Duplicate rate/);
  assert.match(html, /holds the coordinator seat/);
});
