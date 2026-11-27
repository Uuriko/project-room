// A real store holding one private task with a distinct marker in every
// participant-written field, plus one public task. Shared by the private-work
// surface tests so each surface is probed against the same history.
import { RoomStore } from "../../server/store.mjs";
import { initialRoom } from "../../server/bootstrap.mjs";
import { createRoomServer } from "../../server/http.mjs";
import { readWorkItem } from "../../server/work-repository.mjs";
import { textVersion } from "../../server/text-results.mjs";
import { setTier } from "../../server/autonomy-tiers.mjs";
import { linkWithProof } from "./link-with-proof.mjs";
import { event } from "../../src/events.js";

export const PRIVATE = Object.fromEntries(["TITLE", "DONE", "REQUEST", "REPO", "REF", "PATH", "BLOCKER", "UNBLOCK", "RESOLUTION", "HANDOFF", "HANDOFFNEXT", "LIMIT",
  "HANDOFFURL", "HANDOFFVERSION",
  "REWORK", "OLDSUMMARY", "OLDNEXT", "OLDCHECK", "OLDREVIEW", "OLDREVIEWNEXT", "SUMMARY", "RESULTNEXT", "CHECK", "REVIEW", "REVIEWNEXT"]
  .map(name => [name, `zq-private-${name.toLowerCase()}-zq`]));
export const PUBLIC = { TITLE: "zq-public-title-zq", REPO: "zq-public-repo-zq", RESULT: "zq-public-result-body-zq", OLDRESULT: "zq-public-old-result-body-zq" };
export const privateMarkers = text => [...new Set(text.match(/zq-private-[a-z]+-zq/g) ?? [])].sort();

export async function privateWorkFixture(t, representation, { ownerDecisionRequired = false, historyVisibility } = {}) {
  const quiet = console.log; console.log = () => {};
  const store = new RoomStore(":memory:");
  const initial = initialRoom();
  if (historyVisibility) initial.push(event({
    roomId: "commons", actorId: "owner", type: "room.history_visibility_set", data: { historyVisibility }
  }));
  store.initialize(initial, representation === "legacy" ? {} : { representation });
  console.log = quiet;
  const owner = store.issueAccessKey("commons", "owner");
  const member = (name, permissions) => {
    const identity = store.identities.create(name);
    linkWithProof(store, owner, "commons", identity, { displayName: name, permissions });
    setTier(store.db, "commons", identity.identityId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
    return { ...identity, id: identity.identityId, key: store.issueAccessKey("commons", identity.identityId) };
  };
  const producer = member("Producer", ["accept_work", "complete_work"]);
  const reviewer = member("Reviewer", ["verify"]);
  const observer = member("Observer", ["accept_work", "complete_work"]);
  const triage = member("Triage", ["accept_work"]);
  const broad = member("Broad", ["steer", "verify", "accept_work", "complete_work", "manage_claims"]);
  const send = (key, type, data) => store.command(key, "commons", { id: crypto.randomUUID(), type, data });
  const item = id => readWorkItem(store.db, "commons", id);
  const rev = id => item(id).revision;
  const eventIdOf = messageId => store.db.prepare("SELECT id FROM events WHERE room_id='commons' AND json_extract(body,'$.data.messageId')=?").get(messageId).id;
  const P = PRIVATE;

  send(owner, "work.proposed", { workItemId: "open", title: PUBLIC.TITLE, definitionOfDone: "Public definition", accountableMemberId: producer.id, mode: "write" });
  send(owner, "work.proposed", { workItemId: "secret", title: P.TITLE, definitionOfDone: P.DONE, accountableMemberId: producer.id, mode: "write",
    verifierMemberId: reviewer.id, independentVerificationRequired: true,
    ...(ownerDecisionRequired ? { ownerDecisionRequired: true, humanDecisionMakerId: "owner" } : {}) });
  const beforePrivate = { title: item("secret").title };
  store.dmConsents.request("commons", "owner", producer.id, "fixture");
  store.dmConsents.decide("commons", producer.id, "owner", "approve");
  send(owner, "message.posted", { messageId: "private-ask", toMemberId: producer.id, workItemId: "secret", requestKind: "reply", body: P.REQUEST });
  send(producer.key, "work.accepted", { workItemId: "secret", expectedRevision: rev("secret") });
  send(producer.key, "claim.acquired", { workItemId: "secret", expectedRevision: rev("secret"), repository: `acme/${P.REPO}`, ref: P.REF, paths: [`${P.PATH}.js`],
    expiresAt: new Date(Date.now() + 3600000).toISOString() });
  send(producer.key, "work.started", { workItemId: "secret", expectedRevision: rev("secret") });
  send(producer.key, "work.blocked", { workItemId: "secret", expectedRevision: rev("secret"), reason: P.BLOCKER, nextAction: P.UNBLOCK });
  send(producer.key, "work.handoff_recorded", { workItemId: "secret", expectedRevision: rev("secret"), doneSummary: P.HANDOFF, nextAction: P.HANDOFFNEXT, limitReason: P.LIMIT, toMemberId: triage.id,
    evidenceUrl: `https://example.com/${P.HANDOFFURL}`, evidenceVersion: P.HANDOFFVERSION });
  send(producer.key, "work.blocker_resolved", { workItemId: "secret", expectedRevision: rev("secret"), resolution: P.RESOLUTION });
  send(producer.key, "work.started", { workItemId: "secret", expectedRevision: rev("secret") });
  // First result and a failed review, both later replaced.
  send(producer.key, "message.posted", { messageId: "public-old-result", workItemId: "secret", body: PUBLIC.OLDRESULT });
  const first = send(producer.key, "work.completed", { workItemId: "secret", expectedRevision: rev("secret"), evidenceKind: "room_text", evidenceMessageId: "public-old-result",
    evidenceMessageEventId: eventIdOf("public-old-result"), evidenceVersion: textVersion(PUBLIC.OLDRESULT), previousCompletionEventId: null,
    producerId: producer.id, summary: P.OLDSUMMARY, nextAction: P.OLDNEXT, checksClaimed: [P.OLDCHECK] });
  send(reviewer.key, "verification.recorded", { workItemId: "secret", expectedRevision: rev("secret"), result: "fail", completionEventId: first.event.id,
    evidenceVersion: item("secret").receipt.evidenceVersion, summary: P.OLDREVIEW, nextAction: P.OLDREVIEWNEXT });
  send(producer.key, "work.blocker_resolved", { workItemId: "secret", expectedRevision: rev("secret"), resolution: P.REWORK });
  send(producer.key, "work.started", { workItemId: "secret", expectedRevision: rev("secret") });
  // Replacement result: a result message posted publicly, then a second failed review.
  send(producer.key, "message.posted", { messageId: "public-result", workItemId: "secret", body: PUBLIC.RESULT });
  const second = send(producer.key, "work.completed", { workItemId: "secret", expectedRevision: rev("secret"), evidenceKind: "room_text", evidenceMessageId: "public-result",
    evidenceMessageEventId: eventIdOf("public-result"), evidenceVersion: textVersion(PUBLIC.RESULT), previousCompletionEventId: first.event.id,
    producerId: producer.id, summary: P.SUMMARY, nextAction: P.RESULTNEXT, checksClaimed: [P.CHECK] });
  send(reviewer.key, "verification.recorded", { workItemId: "secret", expectedRevision: rev("secret"), result: "fail", completionEventId: second.event.id,
    evidenceVersion: item("secret").receipt.evidenceVersion, summary: P.REVIEW, nextAction: P.REVIEWNEXT });
  send(producer.key, "work.accepted", { workItemId: "open", expectedRevision: rev("open") });
  send(producer.key, "claim.acquired", { workItemId: "open", expectedRevision: rev("open"), repository: `acme/${PUBLIC.REPO}`, ref: "main", paths: ["public.js"],
    expiresAt: new Date(Date.now() + 3600000).toISOString() });

  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const rest = async (who, path) => {
    const response = await fetch(`${origin}/api/rooms/commons${path}`, { headers: { Authorization: `Bearer ${who.secret}` } });
    const text = await response.text();
    return { status: response.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  const mcp = async (who, name, args = {}, profile = "?profile=full") => {
    const response = await fetch(`${origin}/mcp${profile}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${who.secret}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { roomId: "commons", ...args } } }) });
    const text = await response.text(), body = JSON.parse(text);
    return { ok: !body.error && body.result?.isError !== true, text, value: body.result?.structuredContent ?? null };
  };
  // Stored rows a read must never change.
  const stored = () => JSON.stringify({
    events: store.db.prepare("SELECT sequence,id,body FROM events WHERE room_id='commons' ORDER BY sequence").all(),
    item: item("secret"), open: item("open"),
    board: representation === "legacy" ? store.workClaims.list("commons") : null });
  return { origin, store, representation, owner, producer, reviewer, observer, triage, broad, rest, mcp, stored, item, beforePrivate, send, rev };
}
