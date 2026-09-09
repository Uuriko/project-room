// Disposable synthetic data only. Never import this from a production entrypoint.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { textVersion } from "../server/text-results.mjs";

export function createRecoveryFixture(filename) {
  let store = new RoomStore(filename), now = Date.now();
  store.initialize(initialRoom());
  // Established v1 fixture route: migrate a pre-invitation/reminder database,
  // retaining its original event envelopes and generating a real checkpoint.
  store.db.exec("DROP TABLE private_inbox_drafts; DROP TABLE private_inbox_versions; DROP TABLE private_inbox_sources; DROP TABLE private_inbox_commands; DROP TABLE agent_connection_operations; DROP TABLE agent_connections; DROP TABLE private_reminder_commands; DROP TABLE private_reminders; DROP TABLE membership_invitation_journal; DROP TABLE projection_checkpoints; PRAGMA user_version=1");
  store.close(); store = new RoomStore(filename, { now: () => now });
  store.initialize(initialRoom("second", "second-owner"));
  const keys = { owner: store.issueAccessKey("commons", "owner"), second: store.issueAccessKey("second", "second-owner") };
  const send = (room, token, type, data) => store.command(token, room, { id: randomUUID(), type, data });
  const session = accountId => {
    const accessKey = store.issueAccountAccessKey(accountId), slot = store.createAccountSessionSlot();
    return { accessKey, token: slot.token, session: store.loginAccountSession(slot.token, accessKey, 0) };
  };
  const owner = session(store.accountForMember("commons", "owner").id);
  const enrollmentToken = randomBytes(32).toString("base64url");
  const enrollmentRequest = { action: "create", requestId: "recovery-enrollment", memberId: "managed-agent", displayName: "Managed recovery agent", access: "chat",
    keyHash: createHash("sha256").update(enrollmentToken).digest("hex"), expiresAt: now + 3600000, expectedOwnerRevision: 0 };
  const enrollment = store.agentConnections.apply(owner.token, "commons", enrollmentRequest, owner.session.sessionBinding);
  store.createAccount("recovery-target"); const target = session("recovery-target");
  store.createAccount("recovery-shared");
  for (const [room, key] of [["commons", keys.owner], ["second", keys.second]]) {
    send(room, key, T.MEMBER_ADDED, { memberId: "shared", displayName: "Shared human", kind: "human", permissions: [] });
    store.bindHumanAccount(room, "shared", "recovery-shared");
    keys[room + "Shared"] = store.issueAccessKey(room, "shared");
  }
  send("commons", keys.owner, T.MEMBER_ADDED, { memberId: "agent", displayName: "Synthetic agent", kind: "agent", permissions: [] });
  keys.oldAgent = store.issueAccessKey("commons", "agent");
  keys.agent = store.issueAccessKey("commons", "agent");
  const validSession = store.createSession(keys.owner), revokedSession = store.createSession(keys.owner);
  store.revoke(revokedSession.token);
  const loggedOut = store.createAccountSessionSlot(), loggedIn = store.loginAccountSession(loggedOut.token, owner.accessKey, 0);
  store.logoutAccountSession(loggedOut.token, loggedIn.sessionRevision);
  const pending = { requestId: "recovery-pending", token: randomBytes(32).toString("base64url"), intendedAccountId: "recovery-target",
    intendedMemberId: "pending-human", displayName: "Pending human", role: "member", expiresAt: now + 3600000,
    expectedIssuerMemberRevision: store.room("commons").state.members.owner.revision, expectedSessionBinding: owner.session.sessionBinding };
  const invitation = store.issueInvitation(owner.token, "commons", pending);
  const linkToken = randomBytes(32).toString("base64url"), shareRequest = { requestId: "recovery-share", linkToken, expiresAt: now + 3600000,
    maxJoins: 2, expectedMemberRevision: store.room("commons").state.members.owner.revision };
  const link = store.shareLinks.create(keys.owner, "commons", shareRequest, null);
  const guestSlot = store.createAccountSessionSlot(), joinRequest = { displayName: "Recovery guest", redemptionId: randomUUID(),
    expectedSessionRevision: 0, expectedSessionBinding: guestSlot.session.sessionBinding };
  const guest = store.shareLinks.join(guestSlot.token, linkToken, joinRequest);
  store.shareLinks.cancel(keys.owner, "commons", link.link.id, null);
  const propose = (room, key, member, id) => send(room, key, T.WORK_PROPOSED, { workItemId: id, title: `Recovery ${id}`,
    definitionOfDone: "Preserve the exact synthetic result", accountableMemberId: member,
    independentVerificationRequired: false, ownerDecisionRequired: true, humanDecisionMakerId: member });
  for (const id of ["active", "cancelled", "resolved", "evidence"]) propose("commons", keys.owner, "owner", id);
  propose("second", keys.second, "second-owner", "active");
  const reminders = [];
  const schedule = (room, token, workItemId, requestId = "same-local-request") => {
    const request = { requestId, workItemId, expectedRevision: 0, action: "schedule", dueAt: now + 60000 };
    const result = store.reminders.mutate(token, room, request); reminders.push({ room, token, request, receipt: result.receipt });
  };
  schedule("commons", keys.owner, "active"); schedule("commons", guestSlot.token, "active"); schedule("commons", keys.agent, "active");
  schedule("commons", keys.commonsShared, "active"); schedule("second", keys.secondShared, "active"); schedule("second", keys.second, "active");
  schedule("commons", keys.owner, "cancelled", "schedule-cancelled");
  store.reminders.mutate(keys.owner, "commons", { requestId: "cancel-reminder", workItemId: "cancelled", expectedRevision: 1, action: "cancel" });
  schedule("commons", keys.owner, "resolved", "schedule-resolved");
  send("commons", keys.owner, T.WORK_SUPERSEDED, { workItemId: "resolved", expectedRevision: 0, supersededByWorkItemId: "active", reason: "Synthetic replacement" });
  send("commons", keys.owner, T.WORK_ACCEPTED, { workItemId: "evidence", expectedRevision: 0 });
  send("commons", keys.owner, T.WORK_COMPLETED, { workItemId: "evidence", expectedRevision: 1, producerId: "owner", summary: "Synthetic exact result",
    evidenceUrl: "https://example.invalid/recovery", evidenceVersion: "fixture-v1", nextAction: "Owner review" });
  propose("commons", keys.owner, "owner", "native-evidence");
  send("commons", keys.owner, T.WORK_ACCEPTED, { workItemId: "native-evidence", expectedRevision: 0 });
  const nativeBody = "Exact native recovery text 🪷\n", nativePost = send("commons", keys.owner, T.MESSAGE_POSTED, {
    messageId: "recovery-native-text", workItemId: "native-evidence", packetId: "recovery-packet", basisRevision: 1, body: nativeBody });
  const nativeCommand = { id: "recovery-native-command", type: T.WORK_COMPLETED, data: { workItemId: "native-evidence", expectedRevision: 1,
    evidenceKind: "room_text", evidenceMessageId: "recovery-native-text", evidenceMessageEventId: nativePost.event.id, evidenceVersion: textVersion(nativeBody),
    previousCompletionEventId: null, producerId: "owner", summary: "Native recovery result", nextAction: "Review exact text" } };
  const nativeCompletion = store.command(keys.owner, "commons", nativeCommand);
  const charterCommand = { id: "recovery-charter", type: T.ROOM_CHARTER_UPDATED, data: { expectedRevision: 0, purpose: "Preserve exact room context 🪷\n", outputs: "A reviewed result", boundaries: "Synthetic only", escalation: "Ask the owner" } };
  const charterSaved = store.command(keys.owner, "commons", charterCommand);
  const sharedSession = session("recovery-shared");
  store.changeAccountAccess("recovery-shared", { expectedRevision: 0, active: false, reason: "Synthetic suspension before capture" });
  const command = { id: "recovery-command", type: T.MESSAGE_POSTED, data: { body: "Synthetic message before recovery capture" } };
  const commandResult = store.command(keys.owner, "commons", command);
  const inboxRequests = [
    { action: "source.save", requestId: "recovery-inbox-source", sourceId: "recovery-source", expectedRevision: 0,
      data: { adapter: "synthetic", sender: "sender@example.test", recipient: "owner@example.test", subject: "Private recovery source",
        paragraphs: ["Shareable recovery excerpt", "Private recovery paragraph"] } },
    { action: "draft.save", requestId: "recovery-inbox-draft", sourceId: "recovery-source", expectedRevision: 0,
      sourceRevision: 1, body: "Private recovery reply" }
  ];
  const inboxReceipts = inboxRequests.map(request => store.inbox.apply(owner.token, request, owner.session.sessionBinding).receipt);
  inboxRequests.push({ action: "source.share", requestId: "recovery-inbox-share", sourceId: "recovery-source", sourceRevision: 1,
    roomId: "commons", audienceVersion: store.inbox.shareContext(owner.token, "recovery-source", "commons", owner.session.sessionBinding).audienceVersion,
    paragraphs: [0] });
  inboxReceipts.push(store.inbox.apply(owner.token, inboxRequests.at(-1), owner.session.sessionBinding).receipt);
  const cursor = store.room("commons").sequence; store.markCaughtUp(keys.owner, "commons", cursor);
  return { store, filename, keys, owner, target, validSession, revokedSession, loggedOut, sharedSession, pending, invitation,
    shareRequest, link, linkToken, guestSlot, guest, joinRequest, reminders, command, commandResult, cursor, inboxRequests, inboxReceipts,
    enrollmentToken, enrollmentRequest, enrollment, nativeBody, nativeCommand, nativeCompletion, charterCommand, charterSaved, now: () => now, advance: ms => { now += ms; } };
}
