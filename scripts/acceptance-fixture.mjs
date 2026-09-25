// Disposable, loopback-only acceptance fixture. Never accepts an existing DB path.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";

export function createAcceptanceFixture({ managedProducer = false, dmConsent = false } = {}) {
  if (typeof managedProducer !== "boolean") throw new Error("Choose a boolean managed-producer fixture mode");
  const directory = mkdtempSync(join(tmpdir(), "project-room-acceptance-"));
  // Mutable fixture clock. Live chat posts spend the room flood budget
  // (burst 30, refill 0.5/s); advance 2s before each message.posted /
  // dm.posted so history seeds and acceptance loops stay under the limit
  // without weakening the product guard. Tests may still replace store.now.
  let nowMs = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => nowMs });
  const rawCommand = store.command.bind(store);
  store.command = (accessKey, roomId, command) => {
    if (command?.type === T.MESSAGE_POSTED || command?.type === T.DM_POSTED) nowMs += 2000;
    return rawCommand(accessKey, roomId, command);
  };
  try {
    const seed = initialRoom();
    seed[0].data.title = "Project Room — Disposable Test";
    seed[0].data.purpose = "Synthetic acceptance testing only. No real people, private data, or external actions.";
    store.initialize(seed);
    const keys = { owner: store.issueAccessKey("commons", "owner") };
    const send = (actor, type, data) => store.command(keys[actor], "commons", { id: randomUUID(), type, data });
    for (const [memberId, kind, permissions] of [
      ["guest", "human", []], ["producer", "agent", ["accept_work", "complete_work"]], ["reviewer", "agent", ["verify"]]
    ]) {
      if (managedProducer && memberId === "producer") {
        const session = store.createSession(keys.owner), token = randomBytes(32).toString("base64url");
        store.agentConnections.apply(session.token, "commons", { action: "create", requestId: randomUUID(), memberId,
          displayName: "Test producer", access: "contribute", keyHash: createHash("sha256").update(token).digest("hex"),
          expiresAt: Date.now() + 3600000, expectedOwnerRevision: 0 }, session.session.sessionBinding);
        keys.producer = token;
        continue;
      }
      send("owner", T.MEMBER_ADDED, { memberId, displayName: `Test ${memberId}`, kind, permissions, ...(kind === "agent" ? { accountableHumanId: "owner" } : {}) });
      keys[memberId] = store.issueAccessKey("commons", memberId);
    }
    // Graduated autonomy tiers: new agent members enroll at t1_readonly. The
    // fixture's working agents are operator-promoted to t2_standard so
    // acceptance flows exercise the full command surface.
    for (const memberId of ["producer", "reviewer"])
      setTier(store.db, "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: store.now() });
    // Consent-bound DMs: acceptance flows address each other directly.
    // Opt-in via { dmConsent: true } so consent-flow tests keep a clean slate.
    // Approves every direction among the fixture members so UI journeys that
    // send DMs are not blocked by the consent gate.
    if (dmConsent) {
      for (const from of ["owner", "guest", "producer", "reviewer"]) {
        for (const to of ["owner", "guest", "producer", "reviewer"]) {
          if (from === to) continue;
          store.dmConsents.request("commons", from, to, "acceptance fixture");
          store.dmConsents.decide("commons", to, from, "approve");
        }
      }
    }
    send("owner", T.MESSAGE_POSTED, { messageId: "test-welcome", body: "Disposable test room. Try a reply and a reaction; no real conversation is affected." });
    send("guest", T.MESSAGE_POSTED, { messageId: "test-request", body: "Please prepare an agenda naming its owner. This is a synthetic handoff." });
    send("owner", T.WORK_PROPOSED, { workItemId: "test-handoff", title: "Test: prepare an agenda", definitionOfDone: "Agenda names its owner; reviewer checks the exact submitted version.", accountableMemberId: "producer", verifierMemberId: "reviewer", independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: "owner", sourceMessageId: "test-request", mode: "read" });
    const links = {};
    function link(label, maxJoins = 10) {
      const token = randomBytes(32).toString("base64url");
      const result = store.shareLinks.create(keys.owner, "commons", { requestId: randomUUID(), linkToken: token, expiresAt: nowMs + 3600000, maxJoins, expectedMemberRevision: 0 }, null);
      links[label] = token;
      return result.link;
    }
    nowMs = Date.now() - 7200000; link("expired"); nowMs = Date.now();
    const cancelled = link("cancelled"); store.shareLinks.cancel(keys.owner, "commons", cancelled.id, null);
    link("full", 1);
    const slot = store.createAccountSessionSlot();
    const current = store.accountSessionSlot(slot.token);
    store.shareLinks.join(slot.token, links.full, { displayName: "Test capacity guest", redemptionId: randomUUID(), expectedSessionRevision: current.sessionRevision, expectedSessionBinding: current.sessionBinding });
    link("valid");
    return { directory, store, keys, links };
  } catch (error) { store.close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "52331" } } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Choose a port from 1024 to 65535");
  const fixture = createAcceptanceFixture();
  // localhost cookies are separate from the user's existing 127.0.0.1 preview.
  const origin = `http://localhost:${port}`;
  const credentialsFile = join(fixture.directory, "test-credentials.json");
  writeFileSync(credentialsFile, JSON.stringify({ origin, keys: fixture.keys, links: fixture.links }, null, 2), { mode: 0o600, flag: "wx" });
  const server = createRoomServer({ store: fixture.store, origin });
  server.on("error", error => { fixture.store.close(); console.error(error.message); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ origin, directory: fixture.directory, credentialsFile, reset: "Stop this process and run the same command again for a fresh database. Existing data is never overwritten." })));
  let closing = false;
  const close = () => {
    if (closing) return; closing = true;
    server.closeStreams(); server.closeAllConnections(); server.close(() => { fixture.store.close(); process.exit(0); });
  };
  process.on("SIGINT", close); process.on("SIGTERM", close);
}
