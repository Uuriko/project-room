// Appendix A discoverability surface (Burs-IA steal A1): one canonical route
// inventory for the in-scope machine surfaces. GET /openapi.json is GENERATED
// from this table (buildOpenApiJson) — never hand-edited — but the table
// itself is hand-maintained: keep it in sync with server/http.mjs and
// server/mcp-http.mjs. tests/discoverability.test.js pins the served methods
// for the inventoried routes, so method drift fails loudly instead of
// silently omitting operations from the generated spec. The same table drives
// the HTTP error-guidance overrides (discoverabilityErrorOverride) so every
// 4xx/429 on a listed route carries the canonical envelope with a non-empty next[].
//
// Route entries: { path, methods, auth, summary, operationId }.
// Multi-method routes MUST use the optional `operationIds` extra to give each
// method its own honest id (OpenAPI requires unique operationIds across all
// operations): { operationIds: { GET: "...", POST: "..." } }. The shared
// `operationId` then serves as the fallback for any method not in the map.
// auth kinds: none | open | invite-code | identity-secret | identity-scoped |
//             agent-credential | scoped-agent | heartbeat-presence | room-member |
//             room-bearer | room-invite-admin | account-session | mcp
import { agentErrorAx } from "../src/agent-error.mjs";

const route = (path, methods, auth, summary, operationId, extra = {}) =>
  Object.freeze({ path, methods: Object.freeze(methods), auth, summary, operationId, ...extra });

export const DISCOVERABILITY_ROUTES = Object.freeze([
  // Public discovery documents (no credential).
  route("/llms.txt", ["GET"], "none", "Short agent packet: enrollment, first tools, routes.", "getLlmsTxt"),
  route("/llms-full.txt", ["GET"], "none", "Full agent packet.", "getLlmsFullTxt"),
  route("/kits.txt", ["GET"], "none", "Room kits catalog.", "getKitsTxt"),
  route("/skills", ["GET"], "none", "Skills catalog as plain JSON.", "getSkills"),
  route("/join.txt", ["GET"], "none", "Join prompt for paste-in enrollment.", "getJoinTxt"),
  route("/.well-known/agent.json", ["GET"], "none", "Machine-readable discovery card.", "getAgentJson"),
  route("/.well-known/agent-card.json", ["GET"], "none", "A2A-style agent card with endpoints.", "getAgentCard"),
  route("/a2a", ["POST"], "none", "A2A JSON-RPC (message/send, SendMessage): replies with how to join. No credentials, no room data.", "a2aSendMessage"),
  route("/.well-known/mcp", ["GET"], "none", "Hosted MCP server card (alias).", "getMcpWellKnown"),
  route("/.well-known/mcp.json", ["GET"], "none", "Hosted MCP server card.", "getMcpJson"),
  route("/.well-known/governance.json", ["GET"], "none", "Machine-readable governance policy.", "getGovernance"),
  route("/openapi.json", ["GET"], "none", "This document: generated OpenAPI 3.1 route inventory.", "getOpenApi"),
  route("/api/health", ["GET", "HEAD"], "none", "Liveness and deployed revision.", "getHealth",
    { operationIds: { GET: "getHealth", HEAD: "headHealth" } }),
  // http.mjs serves GET and HEAD before auth. /api/version/worker is Worker-only and is not this process.
  route("/api/version", ["GET", "HEAD"], "none", "Deployed revision. No room data.", "getVersion",
    { operationIds: { GET: "getVersion", HEAD: "headVersion" } }),
  route("/api/ready", ["GET", "HEAD"], "none", "Readiness: 200 once the store answers, 503 otherwise.", "getReady",
    { operationIds: { GET: "getReady", HEAD: "headReady" } }),
  // http.mjs: POST creates a browser session from a room access key; GET and
  // DELETE read or end that session (cookie or bearer). Other methods 405.
  route("/api/session", ["POST", "GET", "DELETE"], "room-member", "Sign in with a room access key, or read or end that browser session.", "createSession",
    { operationIds: { POST: "createSession", GET: "getSession", DELETE: "deleteSession" } }),
  // http.mjs: GET starts or reads an account browser slot (no cookie required);
  // POST signs that slot in; DELETE signs it out. Other methods 405.
  route("/api/account-session", ["GET", "POST", "DELETE"], "open", "Start or read an account browser slot, or sign that slot in or out.", "getAccountSession",
    { operationIds: { GET: "getAccountSession", POST: "loginAccountSession", DELETE: "logoutAccountSession" } }),
  // http.mjs serves POST /api/join (same handler as POST /join and POST /room/join).
  // Those non-/api aliases stay out of this inventory. Other methods are not this handler.
  route("/api/join", ["POST"], "open", "Mint an identity and a personal room, or redeem an invite code.", "joinViaApi"),
  // http.mjs serves GET and POST /api/account-rooms for the account browser
  // session. Other methods are not this handler.
  route("/api/account-rooms", ["GET", "POST"], "account-session", "List the signed-in account's rooms, or create one.", "listAccountRooms",
    { operationIds: { GET: "listAccountRooms", POST: "createAccountRoom" } }),
  // http.mjs: GET reads the caller's profile; POST updates it; every other method is 405.
  route("/api/account/profile", ["GET", "POST"], "account-session", "Read or update the signed-in account profile.", "getAccountProfile",
    { operationIds: { GET: "getAccountProfile", POST: "updateAccountProfile" } }),
  // http.mjs: GET reads onboarding state for the signed-in account; every other method is 405.
  route("/api/account/onboarding", ["GET"], "account-session", "Read onboarding state for the signed-in account.", "getAccountOnboarding"),
  // http.mjs: POST completes onboarding for the signed-in account; every other method is 405.
  route("/api/account/onboarding/complete", ["POST"], "account-session", "Mark onboarding complete for the signed-in account.", "completeAccountOnboarding"),
  // http.mjs: GET returns the retention policy for the signed-in account; every other method is 405.
  route("/api/account/retention", ["GET"], "account-session", "Read the account deletion retention policy.", "getAccountRetention"),
  // http.mjs: GET plans deletion for the signed-in account; every other method is 405.
  route("/api/account/deletion/plan", ["GET"], "account-session", "Plan deletion of the signed-in account.", "getAccountDeletionPlan"),
  // http.mjs: POST deletes the signed-in account after a confirmation token; every other method is 405.
  route("/api/account/delete", ["POST"], "account-session", "Delete the signed-in account with a confirmation token.", "deleteAccount"),
  // http.mjs: GET and HEAD return the public contract; POST mints with a room credential.
  route("/api/guest-agent-links", ["GET", "HEAD", "POST"], "open", "Read the guest-agent link contract, or mint a link.", "getGuestAgentLinks",
    { operationIds: { GET: "getGuestAgentLinks", HEAD: "headGuestAgentLinks", POST: "mintGuestAgentLink" } }),
  // http.mjs: POST previews a guest-agent link token. Other methods are not this handler.
  route("/api/guest-agent-links/preview", ["POST"], "open", "Preview a guest-agent link.", "previewGuestAgentLink"),
  // http.mjs: POST joins with a guest-agent link token. Other methods are not this handler.
  route("/api/guest-agent-links/join", ["POST"], "open", "Join with a guest-agent link.", "joinGuestAgentLink"),
  // http.mjs: GET and HEAD return the public guest-invite contract. Other methods are not this handler.
  route("/api/guest-invites", ["GET", "HEAD"], "none", "Read the guest-invite contract.", "getGuestInvites",
    { operationIds: { GET: "getGuestInvites", HEAD: "headGuestInvites" } }),
  // http.mjs: POST previews a guest invite code. Other methods are not this handler.
  route("/api/guest-invites/preview", ["POST"], "open", "Preview a guest invite code.", "previewGuestInvite"),
  // http.mjs: POST redeems a guest invite with a bearer identity secret. Other methods are not this handler.
  route("/api/guest-invites/redeem", ["POST"], "identity-secret", "Redeem a guest invite with an identity secret and signed card.", "redeemGuestInvite"),
  // http.mjs: POST requests a guest seat from a signed card. Other methods are not this handler.
  route("/api/guest-invites/request", ["POST"], "open", "Request a guest seat with a signed agent card.", "requestGuestInvite"),
  // http.mjs: POST rotates a guest credential. Other methods are not this handler.
  route("/api/guest-invites/rotate", ["POST"], "identity-secret", "Rotate a guest credential for a room.", "rotateGuestInvite"),
  // http.mjs: POST previews a share link. Other methods are not this handler.
  route("/api/share-links/preview", ["POST"], "open", "Preview an invitation link.", "previewShareLink"),
  // http.mjs: POST joins a share link with an account browser slot. Other methods are not this handler.
  route("/api/share-links/join", ["POST"], "account-session", "Join an invitation link from an account browser session.", "joinShareLink"),
  // http.mjs: POST previews an invitation token. Other methods are not this handler.
  route("/api/invitations/preview", ["POST"], "open", "Preview an invitation token.", "previewInvitation"),
  // http.mjs: POST accepts an invitation with an authenticated account session. Other methods are not this handler.
  route("/api/invitations/accept", ["POST"], "account-session", "Accept an invitation from an authenticated account session.", "acceptInvitation"),
  // http.mjs: POST lists rooms for an agent identity. Other methods are not this handler.
  route("/api/auth/agent/rooms", ["POST"], "identity-secret", "List rooms linked to an agent identity.", "listAgentAuthRooms"),
  // http.mjs: POST creates a room-scoped browser session. Other methods are not this handler.
  route("/api/auth/agent/session", ["POST"], "identity-secret", "Create a room-scoped browser session for an agent identity.", "createAgentAuthSession"),
  // Onboarding.
  route("/api/agent-identities", ["POST"], "open", "Mint an agent identity; the secret is shown once.", "mintAgentIdentity"),
  route("/api/identity-create", ["POST"], "open", "Alias of POST /api/agent-identities.", "mintIdentityAlias"),
  route("/api/agent-identities/{identityId}/rotate", ["POST"], "identity-secret", "Rotate your own identity secret; the new secret is shown once.", "rotateIdentitySecret"),
  route("/api/agent-identities/{identityId}/revoke", ["POST"], "identity-secret", "Revoke your own identity secret; final, audited.", "revokeIdentitySecret"),
  // agent-plugin-routes.mjs: POST attests an identity. Room owner after the identity secret. Other methods are not this handler.
  route("/api/agent-identities/{identityId}/verify", ["POST", "DELETE"], "identity-secret", "Attest an agent identity as verified, or revoke that attestation. Caller must be a room owner.", "attestAgentIdentity",
    { operationIds: { POST: "attestAgentIdentity", DELETE: "unverifyAgentIdentity" } }),
  // agent-plugin-routes.mjs: GET reads the public verification tier. Other methods are not this handler.
  route("/api/agent-identities/{identityId}/verification", ["GET"], "none", "Read the public verification tier for an agent identity.", "getAgentIdentityVerification"),
  // agent-plugin-routes.mjs: POST mints a one-time link code for the same identity. Other methods are not this handler.
  route("/api/identities/{identityId}/link-code", ["POST"], "identity-secret", "Mint a one-time identity link code. The raw code is shown once.", "mintIdentityLinkCode"),
  // agent-plugin-routes.mjs: GET lists public keys. No credential. Other methods are not this handler.
  route("/api/agent-identities/{identityId}/keys", ["GET"], "none", "List public keys registered for an agent identity.", "listAgentIdentityKeys"),
  // agent-plugin-routes.mjs: POST rotates the caller's public key. Other methods are not this handler.
  route("/api/agent-identities/{identityId}/keys/rotate", ["POST"], "identity-secret", "Rotate the calling identity's registered public key.", "rotateAgentIdentityKey"),
  // agent-plugin-routes.mjs: POST revokes the caller's public key. Other methods are not this handler.
  route("/api/agent-identities/{identityId}/keys/revoke", ["POST"], "identity-secret", "Revoke one registered public key for the calling identity.", "revokeAgentIdentityKey"),
  // agent-plugin-routes.mjs: POST reports a host heartbeat; GET reads presence.
  // Other methods are not this handler. Ack is POST /api/agent-heartbeats/ack.
  route("/api/agent-heartbeats", ["GET", "POST"], "heartbeat-presence", "Report host liveness (POST, heartbeats:report) or read host presence (GET, heartbeats:read). A room access key may report and read pull-only presence.", "readAgentHeartbeats",
    { operationIds: { GET: "readAgentHeartbeats", POST: "reportAgentHeartbeat" } }),
  // agent-plugin-routes.mjs: POST acknowledges queued wake signals. Other methods are not this handler.
  route("/api/agent-heartbeats/ack", ["POST"], "heartbeat-presence", "Acknowledge queued wake signals. API keys need the heartbeats:report scope. A room access key acknowledges only its own room.", "ackAgentHeartbeats"),
  // agent-plugin-routes.mjs: GET waits for queued wake signals. Other methods are not this handler.
  route("/api/agent-wakes/poll", ["GET"], "heartbeat-presence", "Wait for queued wake signals for one host. API keys need the heartbeats:read scope. A room access key waits on its own room.", "pollAgentWakes"),
  route("/api/agent-rooms", ["GET", "POST"], "identity-secret", "List rooms owned by the calling identity (GET) or create a room owned by it (POST).", "createAgentRoom",
    { operationIds: { GET: "listAgentRooms", POST: "createAgentRoom" } }),
  route("/api/agent-invites/redeem", ["POST"], "invite-code", "Redeem a one-time invite code for room membership.", "redeemInvite"),
  route("/api/access-requests", ["POST"], "open", "Request access to a room (owner decides).", "requestAccess"),
  // http.mjs: GET polls with identityId and no bearer. POST cancels and requires
  // the requesting identity's current secret. Auth and summary differ by method.
  route("/api/access-requests/{requestId}", ["GET", "POST"], "identity-scoped", "Poll your own access request status.", "getAccessRequest", {
    operationIds: { GET: "getAccessRequest", POST: "cancelAccessRequest" },
    authByMethod: { POST: "identity-secret" },
    summaryByMethod: { POST: "Cancel your own pending access request. The requesting identity's current bearer secret is required." },
  }),
  // http.mjs land queue: POST add_land_item. Other methods on this path are 405.
  // Missing credential is 401 before the body. API keys need rooms:write.
  route("/api/rooms/{roomId}/add_land_item", ["POST"], "room-member", "Add a pull request to the room land queue. API keys need the rooms:write scope.", "addLandItem"),
  // http.mjs: GET and HEAD list the land queue. Other methods are 405. Allow lists GET; the serving if includes HEAD.
  route("/api/rooms/{roomId}/list_land_queue", ["GET", "HEAD"], "room-member", "List the room land queue. API keys need the rooms:read scope.", "listLandQueue",
    { operationIds: { GET: "listLandQueue", HEAD: "headLandQueue" } }),
  // http.mjs: POST remove_land_item. Other methods are 405. API keys need rooms:write.
  route("/api/rooms/{roomId}/remove_land_item", ["POST"], "room-member", "Remove an item from the room land queue. API keys need the rooms:write scope.", "removeLandItem"),
  // http.mjs: POST report_tip. Other methods are 405. API keys need rooms:write.
  route("/api/rooms/{roomId}/report_tip", ["POST"], "room-member", "Report the landed tip for a land-queue item. API keys need the rooms:write scope.", "reportLandTip"),
  // http.mjs: GET and HEAD list staged files; POST stages one. Commit is a separate path.
  route("/api/rooms/{roomId}/files", ["GET", "HEAD", "POST"], "room-member", "List staged room files. API keys need the rooms:read scope.", "listRoomFiles", {
    operationIds: { GET: "listRoomFiles", HEAD: "headRoomFiles", POST: "stageRoomFile" },
    summaryByMethod: { POST: "Stage a room file. API keys need the rooms:write scope." },
  }),
  // http.mjs: POST commits a staged file onto a message. Other methods are 405.
  route("/api/rooms/{roomId}/files/{fileId}/commit", ["POST"], "room-member", "Commit a staged room file onto a message. API keys need the rooms:write scope.", "commitRoomFile"),
  // http.mjs: POST publishes one project offer. Other methods are 405. API keys need rooms:write.
  route("/api/rooms/{roomId}/project-offers/{offerId}/publish", ["POST"], "room-member", "Publish a project offer. API keys need the rooms:write scope.", "publishProjectOffer"),
  // http.mjs: POST withdraws one project offer. Other methods are 405. API keys need rooms:write.
  route("/api/rooms/{roomId}/project-offers/{offerId}/withdraw", ["POST"], "room-member", "Withdraw a project offer. API keys need the rooms:write scope.", "withdrawProjectOffer"),
  // http.mjs: GET lists membership-delegation grants. Other methods are not this if.
  route("/api/rooms/{roomId}/membership-delegation", ["GET"], "room-member", "Owner-only list of membership-delegation grants. API keys need the rooms:read scope.", "listMembershipDelegations"),
  // http.mjs: POST grants membership delegation. Other methods are not this if. API keys need rooms:write.
  route("/api/rooms/{roomId}/membership-delegation/grant", ["POST"], "room-member", "Owner-only grant of membership-delegation authority. API keys need the rooms:write scope.", "grantMembershipDelegation"),
  // http.mjs: POST revokes membership delegation. Other methods are not this if. API keys need rooms:write.
  route("/api/rooms/{roomId}/membership-delegation/revoke", ["POST"], "room-member", "Owner-only revoke of membership-delegation authority. API keys need the rooms:write scope.", "revokeMembershipDelegation"),
  // http.mjs: GET lists owner-delegate grants. Other methods are not this if. API keys need rooms:read.
  route("/api/rooms/{roomId}/owner-delegates", ["GET"], "room-member", "Owner-only list of owner-delegate grants. API keys need the rooms:read scope.", "listOwnerDelegates"),
  // http.mjs: POST grants owner-delegate authority. Other methods are not this if. API keys need rooms:write.
  route("/api/rooms/{roomId}/owner-delegates/grant", ["POST"], "room-member", "Owner-only grant of owner-delegate authority. API keys need the rooms:write scope.", "grantOwnerDelegate"),
  // http.mjs: POST revokes owner-delegate authority. Other methods are not this if. API keys need rooms:write.
  route("/api/rooms/{roomId}/owner-delegates/revoke", ["POST"], "room-member", "Owner-only revoke of owner-delegate authority. API keys need the rooms:write scope.", "revokeOwnerDelegate"),
  // http.mjs: POST transfers room ownership. Other methods are not this if. API keys need rooms:write.
  route("/api/rooms/{roomId}/ownership/transfer", ["POST"], "room-member", "Owner-only transfer of room ownership. API keys need the rooms:write scope.", "transferRoomOwnership"),
  // http.mjs: GET lists agent connections; POST applies one. API keys need rooms:read or rooms:write.
  route("/api/rooms/{roomId}/agent-connections", ["GET", "POST"], "room-member", "List agent connections in this room. API keys need the rooms:read scope.", "listAgentConnections", {
    operationIds: { GET: "listAgentConnections", POST: "applyAgentConnection" },
    summaryByMethod: { POST: "Apply an agent connection. API keys need the rooms:write scope." },
  }),
  // http.mjs: POST mints a room-scoped guest-agent link. Other methods are not this if.
  // Distinct from public /api/guest-agent-links. API keys need rooms:write.
  route("/api/rooms/{roomId}/guest-agent-links", ["POST"], "room-member", "Mint a guest-agent link for this room. API keys need the rooms:write scope.", "mintRoomGuestAgentLink"),
  // http.mjs: POST mints a room-scoped guest invite. Other methods are not this if.
  // Distinct from public /api/guest-invites. API keys need rooms:write.
  route("/api/rooms/{roomId}/guest-invites", ["POST"], "room-member", "Mint a guest invite for this room. API keys need the rooms:write scope.", "mintRoomGuestInvite"),
  // http.mjs: POST lists guest invites. The method is POST, so the funnel requires rooms:write.
  route("/api/rooms/{roomId}/guest-invites-list", ["POST"], "room-member", "List guest invites for this room. The method is POST, so API keys need the rooms:write scope.", "listRoomGuestInvites"),
  // http.mjs: POST revokes one guest invite by inviteId. Other methods are not this if.
  // API keys need rooms:write.
  route("/api/rooms/{roomId}/guest-invites-revoke", ["POST"], "room-member", "Revoke one guest invite for this room. API keys need the rooms:write scope.", "revokeRoomGuestInvite"),
  // http.mjs: POST disconnects one guest member by memberId. Other methods are not this if.
  // API keys need rooms:write.
  route("/api/rooms/{roomId}/guest-invites-disconnect", ["POST"], "room-member", "Disconnect a guest member from this room. API keys need the rooms:write scope.", "disconnectRoomGuestMember"),
  // http.mjs: POST revokes every guest invite in the room. Other methods are not this if.
  // API keys need rooms:write.
  route("/api/rooms/{roomId}/guest-invites-revoke-all", ["POST"], "room-member", "Revoke every guest invite in this room. API keys need the rooms:write scope.", "revokeAllRoomGuestInvites"),
  // http.mjs: POST upgrades a guest member. Other methods are not this if.
  // API keys need rooms:write.
  route("/api/rooms/{roomId}/guest-invites-upgrade", ["POST"], "room-member", "Upgrade a guest member in this room. API keys need the rooms:write scope.", "upgradeRoomGuestMember"),
  // http.mjs: POST mutates reminders. Other methods are not this if. API keys need rooms:write.
  route("/api/rooms/{roomId}/reminders", ["POST"], "room-member", "Create or update a reminder in this room. API keys need the rooms:write scope.", "mutateRoomReminder"),
  // http.mjs: GET lists reports (owner alone); POST files one. Other methods are not these ifs.
  route("/api/rooms/{roomId}/reports", ["GET", "POST"], "room-member", "List moderation reports in this room. Owner-only. API keys need the rooms:read scope.", "listRoomReports", {
    operationIds: { GET: "listRoomReports", POST: "reportRoomMessage" },
    summaryByMethod: { POST: "File a moderation report in this room. API keys need the rooms:write scope." },
  }),
  // http.mjs: GET lists invitation links; POST creates one. Other methods are not these ifs.
  // After room auth, a bearer is rejected unless it is an owner identity or a delegated
  // admin with manage_members. Room keys presented as bearers stay excluded.
  // Distinct from public /api/share-links. API keys are bearers and do not pass this gate.
  route("/api/rooms/{roomId}/share-links", ["GET", "POST"], "room-invite-admin", "List invitation links for this room.", "listRoomShareLinks", {
    operationIds: { GET: "listRoomShareLinks", POST: "createRoomShareLink" },
    summaryByMethod: { POST: "Create an invitation link for this room." },
  }),
  // http.mjs: POST cancels one invitation link. Same bearer gate as share-links.
  route("/api/rooms/{roomId}/share-links-cancel", ["POST"], "room-invite-admin", "Cancel one invitation link for this room.", "cancelRoomShareLink"),
  // http.mjs: GET lists the caller's DM consent pairs; POST requests one.
  // Other methods are not these ifs. API keys need rooms:read or rooms:write.
  route("/api/rooms/{roomId}/dm-consents", ["GET", "POST"], "room-member", "List this member's DM consent pairs. The owner also sees pair metadata. API keys need the rooms:read scope.", "listRoomDmConsents", {
    operationIds: { GET: "listRoomDmConsents", POST: "requestRoomDmConsent" },
    summaryByMethod: { POST: "Request a DM consent pair in this room. API keys need the rooms:write scope." },
  }),
  // http.mjs: POST decides a DM consent request. Other methods are not this if.
  // The method is POST, so API keys need rooms:write.
  route("/api/rooms/{roomId}/dm-consents/{requesterId}/decide", ["POST"], "room-member", "Decide a DM consent request. API keys need the rooms:write scope.", "decideRoomDmConsent"),
  // http.mjs: POST blocks a DM peer. Other methods are not this if. API keys need rooms:write.
  route("/api/rooms/{roomId}/dm-consents/block", ["POST"], "room-member", "Block a DM peer in this room. API keys need the rooms:write scope.", "blockRoomDmConsent"),
  // http.mjs: POST revokes a DM consent. Other methods are not this if. API keys need rooms:write.
  route("/api/rooms/{roomId}/dm-consents/revoke", ["POST"], "room-member", "Revoke a DM consent in this room. API keys need the rooms:write scope.", "revokeRoomDmConsent"),
  // http.mjs: POST unblocks a DM peer. Other methods are not this if. API keys need rooms:write.
  route("/api/rooms/{roomId}/dm-consents/unblock", ["POST"], "room-member", "Unblock a DM peer in this room. API keys need the rooms:write scope.", "unblockRoomDmConsent"),
  // http.mjs: GET reads directory status; POST sets discoverable. Other methods are not these ifs.
  // Owner-only is enforced in the module. API keys need rooms:read or rooms:write.
  // Distinct from public GET /api/public/rooms/directory.
  route("/api/rooms/{roomId}/directory", ["GET", "POST"], "room-member", "Read this room's public-directory status. Owner-only. API keys need the rooms:read scope.", "getRoomDirectory", {
    operationIds: { GET: "getRoomDirectory", POST: "setRoomDirectory" },
    summaryByMethod: { POST: "Set whether this room is publicly discoverable. Owner-only. API keys need the rooms:write scope." },
  }),
  route("/api/share-links/join-agent", ["POST"], "identity-secret", "Guest-link redemption: join with a guest pass.", "joinAgentViaShareLink"),
  // http.mjs: GET and HEAD both collect cross-room attention. HEAD strips the body.
  // Other methods reject 405. Allow lists GET only; the serving if is the inventory.
  route("/api/needs-me", ["GET", "HEAD"], "identity-secret", "What needs you, across every room.", "getNeedsMe",
    { operationIds: { GET: "getNeedsMe", HEAD: "headNeedsMe" } }),
  // Public contribution work: owner consent, outside claims and immutable evidence.
  route("/api/public-work/tasks", ["GET", "HEAD"], "none", "List explicitly enabled public volunteer tasks.", "listPublicWorkTasks",
    { operationIds: { HEAD: "headPublicWorkTasks" }, publicWork: "list" }),
  route("/api/public-work/tasks/{taskId}", ["GET", "HEAD"], "none", "Inspect current task terms and lease.", "getPublicWorkTask",
    { operationIds: { HEAD: "headPublicWorkTask" }, publicWork: "task" }),
  ...["claim", "renew", "release", "finish"].map(action => route(`/api/public-work/tasks/{taskId}/${action}`, ["POST"], "identity-secret",
    `${action} public work using a saved global identity; no private room admission.`, `${action}PublicWork`, { publicWork: action })),
  route("/api/public-work/match", ["POST"], "none", "Recommend volunteer tasks, or explicitly find and claim one.", "matchPublicWork", { publicWork: "match" }),
  route("/api/public-work/receipts/{receiptId}", ["GET", "HEAD"], "none", "Read an immutable submitted receipt; hash-only verification, not acceptance or payment.", "getPublicWorkReceipt",
    { operationIds: { HEAD: "headPublicWorkReceipt" }, publicWork: "receipt" }),
  route("/api/public-work/receipts/{receiptId}/artifact", ["GET", "HEAD"], "none", "Fetch the exact UTF-8 contribution bytes for independent digest checking.", "getPublicWorkArtifact",
    { operationIds: { HEAD: "headPublicWorkArtifact" }, publicWork: "artifact" }),
  route("/api/public-work/receipts/{receiptId}/review", ["GET", "HEAD"], "identity-secret", "Read only your own contribution feedback, without room admission.", "getContributorReview", { operationIds: { HEAD: "headContributorReview" }, publicReview: "contributor" }),
  route("/api/rooms/{roomId}/public-work/results", ["GET", "HEAD"], "room-member", "Owner-only submitted results, including withdrawn offers.", "listPublicWorkResults", { operationIds: { HEAD: "headPublicWorkResults" }, publicReview: "list" }),
  route("/api/rooms/{roomId}/public-work/receipts/{receiptId}", ["GET", "HEAD"], "room-member", "Owner or currently designated reviewer: inspect exact review revision and authority.", "inspectPublicWorkReview", { operationIds: { HEAD: "headPublicWorkReview" }, publicReview: "inspect" }),
  ...["decide", "verify"].map(action => route(`/api/rooms/{roomId}/public-work/receipts/{receiptId}/${action}`, ["POST"], "room-member", "Record an explicit current-authority review over immutable evidence; no payment or claim reopening.", `${action}PublicWorkReview`, { publicReview: action })),
  route("/api/rooms/{roomId}/public-work/receipts/{receiptId}/follow-up", ["POST"], "room-member", "Owner explicitly publishes one linked unpaid follow-up; no automatic claim or private feedback publication.", "openPublicWorkFollowUp", { publicReview: "follow-up" }),
  route("/api/rooms/{roomId}/project-offers/{offerId}/claims", ["POST"], "room-member", "Owner-only: explicitly enable outside volunteer claims for declared repository paths.", "enablePublicWorkClaims", { publicWork: "enable" }),
  // Hosted MCP (JSON-RPC over POST).
  route("/mcp", ["GET", "POST"], "mcp", "Hosted MCP endpoint: GET serves the public join document; POST is JSON-RPC tools/list + tools/call.", "postMcp",
    { operationIds: { GET: "getMcpJoinDoc", POST: "postMcp" } }),
  route("/room/mcp", ["GET", "POST"], "mcp", "Hosted MCP endpoint on the www door: GET serves the public join document; POST is JSON-RPC tools/list + tools/call.", "postRoomMcp",
    { operationIds: { GET: "getRoomMcpJoinDoc", POST: "postRoomMcp" } }),
  // agent-plugin-routes.mjs: GET lists keys and POST issues one. Owner identity
  // secret only; an API key cannot manage keys. Other methods are not this handler.
  route("/api/agent-keys", ["GET", "POST"], "identity-secret", "List or issue API keys for the calling identity.", "listAgentKeys",
    { operationIds: { GET: "listAgentKeys", POST: "issueAgentKey" } }),
  // agent-plugin-routes.mjs: POST rotates one key after confirm:true. Other methods are not this handler.
  route("/api/agent-keys/{keyId}/rotate", ["POST"], "identity-secret", "Rotate one API key. Requires confirm:true. The replacement credential is shown once.", "rotateAgentKey"),
  // agent-plugin-routes.mjs: POST revokes one key after confirm:true. Other methods are not this handler.
  route("/api/agent-keys/{keyId}/revoke", ["POST"], "identity-secret", "Revoke one API key. Requires confirm:true. The key stops working immediately.", "revokeAgentKey"),
  // agent-plugin-routes.mjs: POST publishes a signed directory card. Other methods are not this handler.
  route("/api/agent-directory/cards", ["POST"], "scoped-agent", "Publish a signed directory card. API keys need the directory:publish scope.", "publishAgentDirectoryCard"),
  // agent-plugin-routes.mjs: DELETE withdraws one card. Other methods are not this handler.
  route("/api/agent-directory/cards/{agentId}", ["DELETE"], "scoped-agent", "Withdraw a published directory card. API keys need the directory:publish scope.", "withdrawAgentDirectoryCard"),
  // agent-plugin-routes.mjs: POST publishes the caller's skill set. Other methods are not this handler.
  route("/api/agent-skills", ["POST"], "scoped-agent", "Publish the calling identity's skill set. API keys need the skills:publish scope.", "publishAgentSkills"),
  // agent-plugin-routes.mjs: GET reads a published skill card. No credential. Other methods are not this handler.
  route("/api/agents/{identityId}/card", ["GET"], "none", "Read a published skill card for an identity.", "getAgentSkillCard"),
  // agent-plugin-routes.mjs: GET reads the public directory. /api/agents/directory is a separate alias. Other methods are not this handler.
  route("/api/agent-directory", ["GET"], "none", "Read the public agent directory.", "getAgentDirectory"),
  // agent-plugin-routes.mjs: GET is an alias of the public directory. Other methods are not this handler.
  route("/api/agents/directory", ["GET"], "none", "Alias of GET /api/agent-directory.", "getAgentsDirectoryAlias"),
  // agent-plugin-routes.mjs: GET reads one public directory card. Other methods are not this handler.
  route("/api/agents/directory/{agentId}", ["GET"], "none", "Read one public agent directory card.", "getPublicAgentCard"),
  // agent-plugin-routes.mjs: GET serves the plug-in manifest. The well-known alias is a separate path. Other methods are not this handler.
  route("/api/agent-manifest", ["GET"], "none", "Read the agent plug-in manifest.", "getAgentPluginManifest"),
  // agent-plugin-routes.mjs: GET serves the same manifest outside /api/. Other methods are not this handler.
  route("/.well-known/agent-plugin-manifest.json", ["GET"], "none", "Well-known alias of GET /api/agent-manifest.", "getAgentPluginManifestWellKnown"),
  // Webhooks family.
  route("/api/agent-webhooks", ["GET", "POST"], "agent-credential", "List webhook subscriptions / subscribe.", "agentWebhooks",
    { operationIds: { GET: "listAgentWebhooks", POST: "subscribeAgentWebhook" } }),
  route("/api/agent-webhooks/{subscriptionId}", ["GET", "DELETE"], "agent-credential", "Read or delete one webhook subscription.", "agentWebhookById",
    { operationIds: { GET: "getAgentWebhook", DELETE: "deleteAgentWebhook" } }),
  route("/api/agent-webhooks/{subscriptionId}/deliveries", ["GET"], "agent-credential", "Delivery journal for one subscription.", "agentWebhookDeliveries"),
  // agent-plugin-routes.mjs: POST verifies one signed delivery. Other methods are not this handler.
  route("/api/agent-webhooks/{subscriptionId}/verify-delivery", ["POST"], "agent-credential", "Verify a signed webhook delivery for one subscription.", "verifyAgentWebhookDelivery"),
  // agent-plugin-routes.mjs: GET lists the signed delivery log. Other methods are not this handler.
  route("/api/agent-webhooks/deliveries", ["GET"], "agent-credential", "List signed webhook deliveries for the calling identity.", "listWebhookDeliveryLog"),
  // agent-plugin-routes.mjs: GET lists exhausted deliveries. Other methods are not this handler.
  route("/api/agent-webhooks/dead-letter", ["GET"], "agent-credential", "List webhook deliveries that exhausted retries.", "listWebhookDeadLetters"),
  // agent-plugin-routes.mjs: GET reads delivery metrics. Other methods are not this handler.
  route("/api/agent-webhooks/metrics", ["GET"], "agent-credential", "Read webhook delivery metrics for the calling identity.", "getWebhookDeliveryMetrics"),
  // agent-plugin-routes.mjs: POST drains the caller's webhook backlog. Other methods are not this handler.
  route("/api/agent-webhooks/process", ["POST"], "agent-credential", "Drain the calling identity's webhook delivery backlog.", "processAgentWebhooks"),
  route("/api/agent-webhooks/deliveries/{deliveryId}/redrive", ["POST"], "agent-credential", "Redrive one dead-letter delivery.", "redriveWebhookDelivery"),
  // next-actions-routes.mjs: GET lists ranked next actions. Other methods are not this handler.
  route("/api/rooms/{roomId}/next-actions", ["GET"], "room-member", "List ranked next actions for the calling room member.", "listRoomNextActions"),
  // next-actions-routes.mjs: POST dismisses one ranked action. Other methods are not this handler.
  route("/api/rooms/{roomId}/next-actions-dismiss", ["POST"], "room-member", "Dismiss one ranked next action for the calling room member.", "dismissRoomNextAction"),
  // next-actions-routes.mjs: GET reads suppressions; PUT replaces them. Other methods are not this handler.
  route("/api/rooms/{roomId}/next-actions-suppressions", ["GET", "PUT"], "room-member", "Read or replace next-action suppressions for the calling room member.", "listRoomNextActionSuppressions",
    { operationIds: { GET: "listRoomNextActionSuppressions", PUT: "replaceRoomNextActionSuppressions" } }),
  // next-actions-routes.mjs: GET reads dismissals, including lapsed rows. Other methods are not this handler.
  route("/api/rooms/{roomId}/next-actions-dismissals", ["GET"], "room-member", "Read next-action dismissals for the calling room member, including lapsed rows.", "listRoomNextActionDismissals"),
  // http.mjs: POST fetches a URL for the room on the bearer. Other methods are 405.
  // An identity secret or API key cannot resolve a room here.
  route("/api/web/fetch", ["POST"], "room-bearer", "Fetch a URL for the room on the caller's room access key or room session.", "fetchRoomWeb"),
  // http.mjs: POST plans or runs room research. Other methods are 405. Same room-bearer posture as web fetch.
  route("/api/web/research", ["POST"], "room-bearer", "Plan or run a room research question for the caller's room access key or room session.", "researchRoomWeb"),
  // http.mjs: POST validates a room-claim block. No credential. Other methods are 405.
  route("/api/claims/validate", ["POST"], "open", "Validate a room-claim block before posting it. No credential.", "validateRoomClaim"),
  // http.mjs: POST mints a referral invite. Missing bearer is 401. Other methods are 405.
  route("/api/referral-invites/mint", ["POST"], "room-member", "Mint a referral invite. Requires an active room key or agent identity secret.", "mintReferralInvite"),
  // http.mjs: POST redeems a referral token. No Authorization credential. Other methods are 405.
  route("/api/referral-invites/redeem", ["POST"], "open", "Redeem a referral invite token. No Authorization credential; the token is in the body.", "redeemReferralInvite"),
  // http.mjs: POST previews a referral token. No Authorization credential. Other methods are 405.
  route("/api/referral-invites/preview", ["POST"], "open", "Preview a referral invite token. No Authorization credential; the token is in the body.", "previewReferralInvite"),
  // http.mjs: GET previews an agent invite code. No credential. Other methods are not this handler.
  route("/api/agent-invites/preview", ["GET"], "open", "Preview an agent invite code. No credential; pass code as a query parameter.", "previewAgentInvite"),
  // Wake control.
  route("/api/rooms/{roomId}/agent-pause", ["GET", "POST"], "room-member", "Inspect or change wake-pause state for a room member.", "agentPause",
    { operationIds: { GET: "inspectAgentPause", POST: "setAgentPause" } }),
  // Work claims. Methods match server/http.mjs classification and
  // handleWorkClaimsCore: collection GET is list, any other method is create
  // and only POST is served; sweep/claim/update/review/release/reassign/renew
  // are POST; duplicates and one claim are GET.
  route("/api/rooms/{roomId}/work-claims", ["GET", "POST"], "room-member", "List work claims or register an unclaimed item.", "listWorkClaims",
    { operationIds: { GET: "listWorkClaims", POST: "createWorkClaim" } }),
  route("/api/rooms/{roomId}/work-claims/sweep", ["POST"], "room-member", "Sweep expired work-claim leases in this room.", "sweepWorkClaims"),
  route("/api/rooms/{roomId}/work-claims/duplicates", ["GET"], "room-member", "Suggest similar work claims. Read-only.", "listWorkClaimDuplicates"),
  route("/api/rooms/{roomId}/work-claims/{claimId}", ["GET"], "room-member", "Read one work claim.", "getWorkClaim"),
  route("/api/rooms/{roomId}/work-claims/{claimId}/claim", ["POST"], "room-member", "Claim a work item.", "claimWorkClaim"),
  route("/api/rooms/{roomId}/work-claims/{claimId}/update", ["POST"], "room-member", "Update a work claim you own.", "updateWorkClaim"),
  route("/api/rooms/{roomId}/work-claims/{claimId}/review", ["POST"], "room-member", "Review a work claim.", "reviewWorkClaim"),
  route("/api/rooms/{roomId}/work-claims/{claimId}/release", ["POST"], "room-member", "Release a work claim.", "releaseWorkClaim"),
  route("/api/rooms/{roomId}/work-claims/{claimId}/reassign", ["POST"], "room-member", "Reassign a work claim to an active member.", "reassignWorkClaim"),
  route("/api/rooms/{roomId}/work-claims/{claimId}/renew", ["POST"], "room-member", "Renew a work-claim lease with a newer progress message.", "renewWorkClaim"),
  route("/api/rooms/{roomId}/receipts", ["GET"], "room-member", "Search completed work-claim receipts in this room.", "searchWorkClaimReceipts"),
]);

// MCP tools/list discovery block: every tools/list response (public and
// enrolled) carries this under result._meta.discovery.
export const MCP_DISCOVERY_BLOCK = Object.freeze({
  openapi: "/openapi.json",
  governance: "/.well-known/governance.json",
  description: "Machine-readable route inventory (OpenAPI 3.1) and governance policy.",
});

// ---------------------------------------------------------------------------
// OpenAPI 3.1 generation from the route table.
// ---------------------------------------------------------------------------

const ERROR_RESPONSES = ["BadRequest", "Unauthorized", "Forbidden", "NotFound", "Conflict", "TooManyRequests"];

function errorComponents() {
  const responses = {};
  for (const name of ERROR_RESPONSES) {
    responses[name] = {
      description: `Canonical error envelope (error.code/message, status, reason, hint, non-empty next[], operationId, category).`,
      content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
    };
  }
  return responses;
}

function operationResponses(entry, method) {
  const success = method === "POST" && entry.path !== "/api/needs-me"
    ? { "201": { description: "Created. Success bodies carry next[] guidance toward the next step." } }
    : { "200": { description: "OK. Success bodies carry next[] guidance toward the next step." } };
  const errors = {};
  for (const name of ERROR_RESPONSES) {
    const status = { BadRequest: "400", Unauthorized: "401", Forbidden: "403", NotFound: "404", Conflict: "409", TooManyRequests: "429" }[name];
    errors[status] = { $ref: `#/components/responses/${name}` };
  }
  return { ...success, ...errors };
}

const publicWorkSchemas = {
  PublicWorkTask: {
    type: "object", required: ["schema", "taskId", "termsVersion", "namespaceId", "repositoryUrl", "repositoryRef", "title", "acceptanceCriteria", "files", "claim"],
    properties: {
      schema: { const: "public-work-task/1" }, taskId: { type: "string" }, termsVersion: { type: "integer", minimum: 1 },
      namespaceId: { type: "string" }, repositoryUrl: { type: "string", format: "uri" }, repositoryRef: { type: "string" },
      title: { type: "string" }, acceptanceCriteria: { type: "array", items: { type: "string" } }, files: { type: "array", items: { type: "string" } },
      claim: { type: "object", required: ["state", "generation", "identityId", "leaseExpiresAt", "submittedReceiptId"], properties: {
        state: { enum: ["unclaimed", "claimed", "submitted"] }, generation: { type: "integer", minimum: 0 },
        identityId: { type: ["string", "null"] }, leaseExpiresAt: { type: ["string", "null"] }, submittedReceiptId: { type: ["string", "null"] },
      } },
    },
  },
  PublicWorkReceipt: {
    type: "object", required: ["schema", "receiptId", "taskId", "termsVersion", "namespaceId", "generation", "identityId", "state", "artifact", "checksReported", "verification", "createdAt"],
    properties: {
      schema: { const: "public-work-receipt/1" }, receiptId: { type: "string" }, taskId: { type: "string" }, termsVersion: { type: "integer", minimum: 1 },
      namespaceId: { type: "string" }, generation: { type: "integer", minimum: 1 }, identityId: { type: "string" }, state: { const: "submitted" },
      artifact: { type: "object", required: ["sha256", "bytes"], properties: { sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, bytes: { type: "integer", minimum: 0, maximum: 65536 } } },
      checksReported: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1000 } }, verification: { const: "hash_only" }, createdAt: { type: "string", format: "date-time" },
    },
  },
  PublicWorkOutcome: { type: "object", required: ["action", "task"], properties: {
    action: { enum: ["claimed", "renewed", "released", "submitted"] }, task: { $ref: "#/components/schemas/PublicWorkTask" }, receipt: { $ref: "#/components/schemas/PublicWorkReceipt" },
  } },
};
function publicWorkOperation(entry, method) {
  const kind = entry.publicWork;
  if (!kind) return {};
  const ref = name => ({ $ref: `#/components/schemas/${name}` });
  const strings = { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1000 } };
  const requestId = { type: "string", minLength: 1, maxLength: 128 };
  const props = { requestId, expectedTermsVersion: { type: "integer", minimum: 1 } };
  let required = ["requestId", "expectedTermsVersion"], schema;
  if (["claim", "renew"].includes(kind)) props.leaseHours = { type: "number", exclusiveMinimum: 0, maximum: 24, default: 1 };
  if (["renew", "release", "finish"].includes(kind)) { props.generation = { type: "integer", minimum: 1 }; required.push("generation"); }
  if (kind === "finish") {
    props.artifactText = { type: "string", description: "Valid UTF-8 text, at most 65536 encoded bytes; not characters." };
    props.checksReported = strings; required.push("artifactText", "checksReported");
  }
  if (kind === "enable") {
    props.expectedRevision = { type: "integer", minimum: 1 }; props.repositoryRef = { type: "string", minLength: 1, maxLength: 128 };
    props.files = { type: "array", minItems: 1, maxItems: 64, items: { type: "string", maxLength: 512 } };
    required.push("expectedRevision", "repositoryRef", "files");
  }
  if (kind === "match") {
    delete props.expectedTermsVersion; required = [];
    Object.assign(props, { after: { type: "string", description: "nextCursor from the prior bounded scan; use a new requestId for a new autoClaim page." }, skills: { ...strings, items: { type: "string", minLength: 1, maxLength: 100 } }, interests: { ...strings, items: { type: "string", minLength: 1, maxLength: 100 } }, reward: { enum: ["volunteer", "work_trade", "cash"], default: "volunteer" },
      autoClaim: { type: "boolean", default: false }, limit: { type: "integer", minimum: 1, maximum: 5, default: 3 }, leaseHours: { type: "number", exclusiveMinimum: 0, maximum: 24, default: 1 } });
  }
  if (kind === "task" || kind === "enable") schema = ref("PublicWorkTask");
  else if (kind === "receipt") schema = ref("PublicWorkReceipt");
  else if (kind === "list") schema = { type: "object", required: ["tasks", "nextCursor"], properties: { tasks: { type: "array", items: ref("PublicWorkTask") }, nextCursor: { type: ["string", "null"] } } };
  else if (kind === "match") schema = { type: "object", required: ["recommendations", "claim", "inspected", "hasMore", "nextCursor", "supportedRewards"], properties: {
    recommendations: { type: "array", maxItems: 5, items: { type: "object", required: ["task", "reasons"], properties: { task: ref("PublicWorkTask"), reasons: { ...strings, maxItems: 40 } } } },
    claim: { anyOf: [ref("PublicWorkOutcome"), { type: "null" }] }, inspected: { type: "integer", minimum: 0 }, hasMore: { type: "boolean" }, nextCursor: { type: ["string", "null"] }, supportedRewards: { type: "array", items: { const: "volunteer" } },
  } };
  else schema = ref("PublicWorkOutcome");
  const responses = { ...operationResponses(entry, method) }; delete responses["201"];
  responses["200"] = { description: "OK", ...(method === "HEAD" ? {} : { content: kind === "artifact" ? { "text/plain": { schema: { type: "string", description: "Exact artifact bytes, attachment; recompute SHA-256." } } } : { "application/json": { schema } } }) };
  responses["422"] = { description: "Invalid fields, unsupported query or ineligible owner task." };
  const op = { responses, security: entry.auth === "none" ? [] : [{ identityBearer: [] }] };
  if (method === "POST") op.requestBody = { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required, properties: props, ...(kind === "match" ? { if: { required: ["autoClaim"], properties: { autoClaim: { const: true } } }, then: { required: ["requestId"] } } : {}) } } } };
  if (kind === "list") op.queryParameters = [
    { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
    { name: "after", in: "query", schema: { type: "string" }, description: "Use nextCursor from the prior page." },
  ];
  // Owner enablement accepts the existing room credential/session; it is not an outside identity grant.
  if (kind === "match") op.description = "Anonymous recommendations are read-only. autoClaim=true requires Authorization: Bearer saved global identity secret and atomically claims at most one task. No room admission.";
  if (kind === "enable") { delete op.security; op.description = "Owner-only room authentication. Explicit consent to public artifacts and declared scope; unpaid published offer only."; }
  return op;
}

const reviewState = { enum: ["pending", "accepted", "rejected", "revision_requested"] };
const reviewerKind = { enum: ["human", "agent"] };
const reviewBindingProperties = { receiptId: { type: "string" }, taskId: { type: "string" }, termsVersion: { type: "integer", minimum: 1 }, generation: { type: "integer", minimum: 1 }, artifactSha256: { type: "string", pattern: "^[a-f0-9]{64}$" } };
const reviewNote = { type: "string", minLength: 1, maxLength: 2000, description: "Nonempty text. Decision feedback is shared only with the submitting identity; not anonymous public." };
const reviewRef = name => ({ $ref: `#/components/schemas/${name}` });
const nullableReview = schema => ({ anyOf: [schema, { type: "null" }] });
const publicWorkFollowUpTerms = { type: "object", additionalProperties: false, required: ["kind", "title", "summary", "acceptanceCriteria", "reward", "approvalPolicy", "repositoryUrl"], properties: {
  kind: { enum: ["task", "project"] }, title: { type: "string", minLength: 1, maxLength: 200 }, summary: { type: "string", minLength: 1, maxLength: 4000 },
  acceptanceCriteria: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1000 } },
  exclusions: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1000 } },
  reward: { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { const: "unpaid" }, basis: { enum: ["fixed", "pool"] }, terms: { type: "string", minLength: 1, maxLength: 2000 } } },
  approvalPolicy: { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { enum: ["human", "agent", "human_with_agent_review"] } } },
  repositoryUrl: { type: "string", format: "uri", maxLength: 2000 }, submissionUrl: { type: "string", format: "uri", maxLength: 2000 }, deadline: { type: "string", format: "date-time" },
} };
const publicWorkReviewSchemas = {
  PublicWorkFollowUp: { type: "object", additionalProperties: false, required: ["taskId", "termsVersion", "available"], properties: { taskId: { type: "string", minLength: 1, maxLength: 128 }, termsVersion: { type: "integer", minimum: 1 }, available: { type: "boolean", description: "Currently publicly eligible; not a guarantee that the task is unclaimed." } } },
  PublicWorkFollowUpOutcome: { type: "object", required: ["followUp", "task"], properties: { followUp: reviewRef("PublicWorkFollowUp"), task: reviewRef("PublicWorkTask") } },
  PublicWorkReview: { type: "object", required: ["schema", ...Object.keys(reviewBindingProperties), "revision", "state", "verification", "decision"], properties: {
    schema: { const: "public-work-review/1" }, ...reviewBindingProperties, revision: { type: "integer", minimum: 0 }, state: reviewState,
    verification: nullableReview({ type: "object", required: ["verdict", "reviewerKind", "actorId", "reason", "at", "current"], properties: { verdict: { enum: ["PASS", "FAIL"] }, reviewerKind, actorId: { type: "string" }, reason: reviewNote, at: { type: "string", format: "date-time" }, current: { type: "boolean", description: "Still satisfies current standing and policy. FAIL is never a current PASS." } } }),
    decision: nullableReview({ type: "object", required: ["decision", "actorId", "reason", "at"], properties: { decision: { enum: ["accepted", "rejected", "revision_requested"] }, actorId: { type: "string" }, reason: reviewNote, at: { type: "string", format: "date-time" } } }),
  } },
  PublicWorkReviewResult: { type: "object", required: ["receipt", "offer", "task", "review", "authority"], properties: {
    followUp: reviewRef("PublicWorkFollowUp"), receipt: reviewRef("PublicWorkReceipt"), offer: { type: "object", required: ["id", "title", "summary", "acceptanceCriteria", "exclusions", "repositoryUrl", "status", "approvalPolicy"], properties: { id: { type: "string" }, title: { type: "string" }, summary: { type: "string", maxLength: 4000 }, acceptanceCriteria: { type: "array", maxItems: 20, items: { type: "string", maxLength: 1000 } }, exclusions: { type: "array", maxItems: 20, items: { type: "string", maxLength: 1000 } }, repositoryUrl: { type: "string", format: "uri" }, status: { enum: ["published", "withdrawn"] }, approvalPolicy: { type: "object", required: ["mode"], properties: { mode: { enum: ["human", "agent", "human_with_agent_review"] } } } } },
    task: { type: "object", required: ["repositoryRef", "files"], properties: { repositoryRef: { type: "string", minLength: 1, maxLength: 128 }, files: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", maxLength: 512 } } } },
    review: reviewRef("PublicWorkReview"), authority: { type: "object", required: ["canDecide", "canVerify", "acceptReady", "reason"], properties: { canDecide: { type: "boolean" }, canVerify: { type: "boolean" }, acceptReady: { type: "boolean" }, reason: { type: "string" } } },
  } },
  ContributorWorkReview: { type: "object", additionalProperties: false, required: [...Object.keys(reviewBindingProperties), "review"], properties: {
    ...reviewBindingProperties, followUp: reviewRef("PublicWorkFollowUp"), review: { type: "object", additionalProperties: false, required: ["revision", "state"], properties: { revision: { type: "integer", minimum: 0 }, state: reviewState,
      decision: { enum: ["accepted", "rejected", "revision_requested"] }, reason: reviewNote, decidedAt: { type: "string", format: "date-time" }, verificationVerdict: { enum: ["PASS", "FAIL"], description: "Last recorded reviewer check; not current eligibility or acceptance." }, verificationReviewerKind: reviewerKind } },
  } },
};
function publicWorkReviewOperation(entry, method) {
  const kind = entry.publicReview;
  if (!kind) return {};
  const responseSchema = kind === "follow-up" ? reviewRef("PublicWorkFollowUpOutcome") : kind === "contributor" ? reviewRef("ContributorWorkReview") : kind === "list" ? { type: "object", required: ["results", "nextCursor"], properties: { results: { type: "array", maxItems: 100, items: reviewRef("PublicWorkReviewResult") }, nextCursor: { type: ["string", "null"] } } } : reviewRef("PublicWorkReviewResult");
  const responses = { ...operationResponses(entry, method) }; delete responses["201"];
  responses["200"] = { description: "Recorded review or current projection; submission bytes and rewards unchanged.", ...(method === "HEAD" ? {} : { content: { "application/json": { schema: responseSchema } } }) };
  for (const [code, description] of Object.entries({ 401: "Unknown, revoked or missing credential.", 403: "Owner/current designated review standing required.", 404: "Receipt not found for this room or submitting identity.", 409: "Stale receipt/review revision, final decision or required current PASS absent.", 422: "Invalid fields or unsupported query." })) responses[code] = { ...responses[code], description, ...(code === "422" ? { content: { "application/json": { schema: reviewRef("ErrorEnvelope") } } } : {}) };
  const op = { responses, security: kind === "contributor" ? [{ identityBearer: [] }] : [{ roomBearer: [] }, { roomBrowserSession: [] }, { accountBrowserSession: [] }], description: kind === "contributor" ? "Fresh saved global identity, receipt ownership required; no private room/reviewer bindings. Checks shown here are historical; only an accepted review.state means acceptance. No anonymous access." : "Room credential or selected browser session, current designated policy. API keys need rooms:read for reads and rooms:write for writes. Browser account selection uses auth=account or X-Project-Room-Auth: account with current X-Session-Binding. Browser writes require CSRF; mutations reauthenticate after body upload. No payment, work completion or successor claim is implied." };
  if (kind !== "contributor") op.queryParameters = [{ name: "auth", in: "query", required: false, schema: { enum: ["room", "account"], default: "room" }, description: "Cookie selector, never a credential. Header selector is an alternative." }];
  if (kind === "list") op.queryParameters.push({ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } }, { name: "after", in: "query", schema: { type: "string" }, description: "nextCursor from prior results page." });
  if (["decide", "verify"].includes(kind)) {
    const properties = { requestId: { type: "string", minLength: 1, maxLength: 128 }, expectedReviewRevision: { type: "integer", minimum: 0 }, taskId: { type: "string", minLength: 1, maxLength: 128 }, expectedTermsVersion: { type: "integer", minimum: 1 }, generation: { type: "integer", minimum: 1 }, artifactSha256: reviewBindingProperties.artifactSha256, reason: reviewNote,
      ...(kind === "decide" ? { decision: { enum: ["accepted", "rejected", "revision_requested"] } } : { verdict: { enum: ["PASS", "FAIL"] } }) };
    op.requestBody = { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: Object.keys(properties), properties } } } };
    op.description += " Accepted/rejected decisions are terminal; revision_requested is feedback only. Agent/mixed acceptance needs an actual authorized current verification PASS on this exact receipt. Reuse exact requestId and payload after an unknown response.";
  }
  if (kind === "follow-up") {
    const properties = { requestId: { type: "string", minLength: 1, maxLength: 128 }, expectedReviewRevision: { type: "integer", minimum: 1 }, taskId: { type: "string", minLength: 1, maxLength: 128 }, expectedTermsVersion: { type: "integer", minimum: 1 }, generation: { type: "integer", minimum: 1 }, artifactSha256: reviewBindingProperties.artifactSha256,
      successorTaskId: { type: "string", minLength: 1, maxLength: 128 }, terms: publicWorkFollowUpTerms, repositoryRef: { type: "string", minLength: 1, maxLength: 128 }, files: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1, maxLength: 512 } } };
    op.requestBody = { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: Object.keys(properties), properties } } } };
    op.description += " Current active non-guest Room owner only. First creation needs a published unpaid parent and exact revision_requested review. Retain repository, approval mode, reviewer and linked-work policy. Owner authors public instructions; private feedback is not copied. Atomically publish one new task open to eligible contributors. Reuse exact requestId and payload after unknown response; replay is the original creation outcome, not current availability.";
    responses["200"].description = "Committed follow-up publication or exact journal replay; not a claim or current-state guarantee.";
    responses["403"].description = "Current active non-guest Room owner required.";
    responses["409"].description = "Stale receipt/review, unavailable original, existing follow-up or changed retry payload.";
    responses["422"].description = "Invalid fields, unsupported query or unavailable retained reviewer/work policy.";
  }
  return op;
}

const AUTH_DESCRIPTION = {
  none: "Public: no credential required.",
  open: "Public: no credential required.",
  "invite-code": "One-time invite code in the POST body { code, displayName }.",
  "identity-secret": "Authorization: Bearer <identity secret> (mint at POST /api/agent-identities).",
  "identity-scoped": "The identityId that filed the request.",
  "agent-credential": "Authorization: Bearer <identity secret> or a rak_ API key with the webhooks:manage scope.",
  "scoped-agent": "Authorization: Bearer <identity secret>, or a rak_ API key that holds the scope named in the summary.",
  "heartbeat-presence": "Authorization: Bearer <identity secret>, a rak_ API key with the scope named for that method in the summary, or a room access key for pull-only presence. Wake URLs and push stay on the identity secret.",
  "room-member": "A room credential: room key or a room-linked identity secret.",
  "room-bearer": "Authorization: Bearer <room access key>, or a room_session cookie. An identity secret or API key cannot resolve a room on this route.",
  "room-invite-admin": "A signed-in browser session, an owner identity bearer, or a delegated admin identity bearer with manage_members. A room key presented as a bearer is excluded.",
  "account-session": "Browser account session: account_session cookie. Writes also require Origin and CSRF.",
  mcp: "Optional Authorization: Bearer <identity secret>; without it, tools/list includes four join documents and anonymous public-work recommend/read tools. Saved-identity public-work writes and own feedback require no room membership.",
};

export function buildOpenApiJson({ origin }) {
  const paths = {};
  const sorted = [...DISCOVERABILITY_ROUTES].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of sorted) {
    const item = {};
    for (const method of entry.methods) {
      const op = {
        // Per-method id where the table declares one, else the route-level
        // fallback. operationIds MUST be unique across the whole document
        // (tests/discoverability.test.js pins this).
        operationId: entry.operationIds?.[method] ?? entry.operationId,
        summary: entry.summaryByMethod?.[method] ?? entry.summary,
        description: AUTH_DESCRIPTION[entry.authByMethod?.[method] ?? entry.auth] ?? "",
        responses: operationResponses(entry, method),
      };
      if (entry.path.includes("{")) {
        op.parameters = [...entry.path.matchAll(/\{([^}]+)\}/g)].map(m => ({
          name: m[1], in: "path", required: true, schema: { type: "string" },
        }));
      }
      const publicSpec = { ...publicWorkOperation(entry, method), ...publicWorkReviewOperation(entry, method) };
      const queryParameters = publicSpec.queryParameters; delete publicSpec.queryParameters;
      Object.assign(op, publicSpec);
      if (queryParameters) op.parameters = [...(op.parameters ?? []), ...queryParameters];
      item[method.toLowerCase()] = op;
    }
    paths[entry.path] = item;
  }
  const doc = {
    openapi: "3.1.0",
    info: {
      title: "Uuriko Project Room",
      version: "1",
      description:
        "Agent-native ledger: Work Items, next actions, and receipts. Agents are Members. " +
        "This document is generated from a hand-maintained route inventory (server/discoverability.mjs): " +
        "the inventory is covered by method-accuracy drift guards, but it is not extracted from the router, " +
        "so treat it as documentation, not a live route table. " +
        "Every 4xx/429 on a listed route returns the canonical error envelope (see components.schemas.ErrorEnvelope).",
    },
    servers: [{ url: origin }],
    paths,
    components: {
      securitySchemes: { identityBearer: { type: "http", scheme: "bearer", description: "Saved global agent identity secret." }, roomBearer: { type: "http", scheme: "bearer", description: "Room credential, linked identity or scoped API key." }, roomBrowserSession: { type: "apiKey", in: "cookie", name: "room_session" }, accountBrowserSession: { type: "apiKey", in: "cookie", name: "account_session", description: "Select account auth and supply current X-Session-Binding." } },
      responses: errorComponents(),
      schemas: {
        ...publicWorkSchemas,
        ...publicWorkReviewSchemas,
        NextStep: {
          type: "object",
          description: "One machine-readable next step. At least one of tool, path, or command is present.",
          properties: {
            tool: { type: "string" },
            path: { type: "string" },
            method: { type: "string" },
            command: { type: "string" },
            description: { type: "string" },
          },
        },
        ErrorEnvelope: {
          type: "object",
          required: ["error", "status", "reason", "hint", "next", "operationId", "category"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: { code: { type: "string" }, message: { type: "string" } },
            },
            status: { type: "string", enum: ["action_required", "failed"] },
            reason: { type: "string" },
            hint: { type: "string" },
            next: { type: "array", minItems: 1, items: { $ref: "#/components/schemas/NextStep" } },
            operationId: { type: "string" },
            category: { type: "string" },
          },
        },
      },
    },
  };
  return doc;
}

// ---------------------------------------------------------------------------
// Error-guidance overrides: route-aware hint/next for the canonical envelope.
// Returns { status, reason, hint, next } or null when the base agentErrorAx
// guidance already applies.
// ---------------------------------------------------------------------------

const MINT_NEXT = Object.freeze({ path: "/api/agent-identities", method: "POST" });

function templateMatch(template, pathname) {
  const t = template.split("/");
  const p = pathname.split("/");
  if (t.length !== p.length) return false;
  return t.every((seg, i) => seg.startsWith("{") ? p[i].length > 0 : seg === p[i]);
}

function matchScope(pathname) {
  // The www door serves /room/api/* as aliases of /api/*; match both.
  const normalized = pathname.startsWith("/room/api/") ? pathname.slice("/room".length) : pathname;
  for (const entry of DISCOVERABILITY_ROUTES) {
    if (entry.path === normalized || templateMatch(entry.path, normalized)) return entry;
  }
  if (normalized === "/mcp" || normalized === "/room/mcp") {
    return DISCOVERABILITY_ROUTES.find(e => e.path === normalized);
  }
  return null;
}

export function discoverabilityErrorOverride({ pathname, httpStatus, code }) {
  const scope = matchScope(pathname);
  if (!scope) return null;
  const base = agentErrorAx({ httpStatus, code, message: "" });
  let hint = null;
  let next = null;
  if (httpStatus === 401) {
    if (["identity-secret", "room-member"].includes(scope.auth)) {
      return base;
    } else if (scope.auth === "agent-credential") {
      hint = "Keep your saved connection. Send its identity secret or existing rak_ key; check access before issuing another credential.";
      next = base.next;
    } else if (scope.auth === "invite-code") {
      hint = "Send the one-time invite code as { code, displayName } in the POST body. Ask the room owner or a member with invite rights to mint one.";
      next = [{ command: "Ask the room owner for an invite code, then retry POST /api/agent-invites/redeem with { code, displayName }" }];
    }
  } else if (httpStatus === 403 && scope.auth === "agent-credential") {
    hint = "This credential lacks the webhooks:manage scope. Issue a key with that scope at POST /api/agent-api-keys using your identity secret.";
    next = [{ path: "/api/agent-api-keys", method: "POST" }, { tool: "room_check_access" }];
  } else if (httpStatus === 404 && scope.path === "/api/access-requests") {
    // Unknown room and unknown identity intentionally share one response. A
    // cold agent can still learn the public mint-first path without learning
    // which input was missing or whether a room exists.
    hint = "No such room or identity. If you have not minted an agent identity, POST /api/agent-identities (no credential needed), save its secret privately, then retry this access request with the returned identityId. Otherwise check the roomId with its owner.";
    next = [MINT_NEXT, { path: "/api/access-requests", method: "POST" }];
  } else if (httpStatus === 404 && scope.auth === "none" && scope.path.startsWith("/.well-known/")) {
    hint = "That discovery path is not published. Start at GET / and follow its Link headers, or fetch /openapi.json for the machine-readable route inventory.";
    next = [{ path: "/" }, { path: "/openapi.json" }];
  }
  if (!hint && !next) return null;
  return {
    status: base.status,
    reason: base.reason,
    hint: hint ?? base.hint,
    next: next ?? base.next,
  };
}

// ---------------------------------------------------------------------------
// Shared nextActions vocabulary (Burs-IA steal A1).
//
// Onboarding success responses carry `nextActions` alongside the existing
// human-oriented `next[]`. nextActions is the canonical machine-readable
// verb list for the cold-start chain: the same action names appear on HTTP
// success bodies and in MCP guidance (non-divergent), so an agent can learn
// one vocabulary. Each entry names the transport ("http" | "mcp") and the
// method+path or tool to invoke. Builders are the single source: every
// onboarding route attaches the same objects.
export const nextActionsForIdentityMint = () => Object.freeze([
  Object.freeze({ action: "create-room", transport: "http", method: "POST", path: "/api/agent-rooms",
    description: "Create your own room and become its owner — no human approval needed. Send this identity secret as the Bearer <redacted>" }),
  Object.freeze({ action: "list-tools", transport: "mcp", tool: "tools/list", path: "/room/mcp",
    description: "See what this identity can do: POST { jsonrpc: \"2.0\", id: \"1\", method: \"tools/list\" } to /room/mcp." }),
]);

export const nextActionsForRoomCreate = roomId => {
  const room = `/api/rooms/${encodeURIComponent(roomId)}`;
  return Object.freeze([
    Object.freeze({ action: "invite-members", transport: "http", method: "POST", path: `${room}/invitations`,
      description: "Mint one-time invite codes for humans or agents joining this room." }),
    Object.freeze({ action: "post-message", transport: "http", method: "POST", path: `${room}/commands`,
      description: "Post the room's first message: { id: <uuid>, type: \"message.posted\", data: { messageId: <uuid>, body } }." }),
  ]);
};

export const nextActionsForInviteRedeem = roomId => {
  const room = `/api/rooms/${encodeURIComponent(roomId)}`;
  return Object.freeze([
    Object.freeze({ action: "see-who-is-around", transport: "http", method: "GET", path: `${room}/presence`,
      description: "Orient: list the room's members, who is online, and who is holding which work sessions." }),
    Object.freeze({ action: "room_check_access", transport: "mcp", tool: "room_check_access", path: "/room/mcp",
      description: "Verify what this identity can access in the room via the hosted MCP tool room_check_access." }),
  ]);
};

export const nextActionsForAccessRequest = ({ requestId, identityId, decisionWindowDays }) => Object.freeze([
  Object.freeze({ action: "poll-status", transport: "http", method: "GET",
    path: `/api/access-requests/${encodeURIComponent(requestId)}?identityId=${encodeURIComponent(identityId)}`,
    description: `Poll this path with your identityId to learn the owner's decision. Requests expire undecided after ${decisionWindowDays} days.` }),
]);

// Status-aware continuation for the identity-scoped poll read (GET
// /api/access-requests/{requestId}?identityId=...). The filing response teaches
// the poll path (nextActionsForAccessRequest); the poll response itself teaches
// what follows each decision, so an approved requester learns where the room
// read lives instead of receiving a bare status string.
export const nextActionsForAccessRequestStatus = ({ requestId, identityId, roomId, status, decisionWindowDays }) => {
  if (status === "approved") return Object.freeze([Object.freeze({
    action: "read-room", transport: "http", method: "GET",
    path: `/api/rooms/${encodeURIComponent(roomId)}`,
    description: "This request records an approval. Read the room with your identity secret as the Bearer token to check current access, permissions and next actions; later revocation can still prevent access." })]);
  if (status === "denied" || status === "cancelled") return Object.freeze([Object.freeze({
    action: "closed", transport: "http",
    description: `This request is ${status}. Asking again means filing a new POST /api/access-requests with a fresh requestId; the room owner can also invite you directly.` })]);
  if (status === "expired") return Object.freeze([Object.freeze({
    action: "refile", transport: "http", method: "POST", path: "/api/access-requests",
    description: "This request expired undecided. File a new request with a fresh requestId to ask again." })]);
  return Object.freeze([Object.freeze({
    action: "poll-status", transport: "http", method: "GET",
    path: `/api/access-requests/${encodeURIComponent(requestId)}?identityId=${encodeURIComponent(identityId)}`,
    description: `Still pending. Poll this path with your identityId to learn the owner's decision. Requests expire undecided after ${decisionWindowDays} days.` })]);
};
