// RC-2026-09-19-065: join-flow consolidation — the one-vocabulary claim.
//
// Falsifiable claim: "a new user can join a room knowing only one word for
// it." This test proves it two ways:
//   1. Walkthrough: a new agent joins through all four mechanisms (invite
//      code, invite link, guest invite, request to join) and every success
//      and failure message met on the way speaks only the invite vocabulary.
//   2. Scanner: every user-facing surface (UI, room door, API docs,
//      onboarding docs, CLI help) is free of the internal mechanism names.
//
// The internal names — RM- code prefixes, ga1. tokens, access-request
// objects, self-mint flows — stay in code comments and route paths (compat),
// never in what a user reads.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// A new user knows one word: "invite". These internal mechanism names must
// never reach them in copy, errors, or docs. RM- is matched with a lookbehind
// so ordinary words like SWARM-PLUG-IN.md do not trip the scanner.
const BANNED = [/(?<![A-Za-z])RM-/, "ga1.", "self-mint", "self minted", "access-request"];
// Route paths and CLI command names stay stable for compatibility; they are
// not user-facing copy, so the scanner ignores them.
const PATH_LINE = /^[ \t]*(\/api\/[^\s:]*|access-requests|access-decide|request-access)[ \t]*:?[ \t]*$/gm;
const INLINE_ROUTE = /`[^`\n]*\/api\/[^`\n]*`/g;
const COMMAND_NAME = /\b(access-requests|access-decide|request-access)\b/g;
const STRIP_GLOSSARY = /<!-- internal-glossary-start -->[\s\S]*?<!-- internal-glossary-end -->/g;

const cleanCopy = text =>
  text.replace(STRIP_GLOSSARY, "").replace(PATH_LINE, "").replace(INLINE_ROUTE, "").replace(COMMAND_NAME, "");

const assertInviteVocabulary = (text, where) => {
  const clean = cleanCopy(String(text));
  for (const token of BANNED) {
    const hit = token instanceof RegExp ? token.test(clean) : clean.includes(token);
    assert.ok(!hit,
      `${where}: user-facing copy leaks internal name ${JSON.stringify(String(token))}`);
  }
};

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-join-vocab-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  const seen = [];
  const watch = async (label, promise) => {
    const res = await promise;
    let bodyText = "";
    try { bodyText = await res.clone().text(); } catch { /* ignore */ }
    seen.push(`${label}: ${bodyText}`);
    return res;
  };
  return { store, origin, request, ownerKey, seen, watch };
}

// Secrets minted during the walkthrough are data, not copy: the invite code
// itself must reach its recipient. Mask the exact secret values before the
// vocabulary check so only the prose around them is asserted.
const maskSecrets = (texts, secrets) =>
  texts.map(t => secrets.reduce((acc, secret) => secret ? acc.split(secret).join("<secret>") : acc, t));

const joinSeenVocabulary = (seen, secrets) => {
  for (const text of maskSecrets(seen, secrets)) assertInviteVocabulary(text, "walkthrough");
};

test("walkthrough: one word (invite) joins through all four mechanisms", async t => {
  const { store, request, ownerKey, seen, watch } = await serve(t);
  const post = (path, data, token) => watch(`POST ${path}`, request(path, { method: "POST", data, token }));
  const get = (path, token) => watch(`GET ${path}`, request(path, { token }));

  // --- 1. Invite code: a member mints; the agent previews and redeems. ---
  const secrets = [];
  const minted = await post("/api/rooms/commons/agent-invites", { profile: "contribute" }, ownerKey);
  assert.ok([200, 201].includes(minted.status));
  const { code } = await minted.json();
  secrets.push(code);
  const preview = await get(`/api/agent-invites/preview?code=${encodeURIComponent(code)}`);
  assert.equal(preview.status, 200);
  const previewJson = await preview.json();
  assert.equal(previewJson.roomId, "commons");
  const redeemed = await post("/api/agent-invites/redeem", { code, displayName: "Invite Walker" });
  assert.ok([200, 201].includes(redeemed.status));
  const redeemedJson = await redeemed.json();
  assert.equal(redeemedJson.roomId, "commons");
  // A bad code fails in invite vocabulary, never naming the mechanism.
  const badRedeem = await post("/api/agent-invites/redeem", { code: "WRONGCODE", displayName: "X" });
  assert.equal(badRedeem.status, 404);
  const badRedeemJson = await badRedeem.json();
  assert.match(badRedeemJson.error.message, /[Ii]nvite/);

  // --- 2. Invite link: the owner mints a human invite link; a guest previews. ---
  // (Minting is an owner UI action backed by a browser session; the store
  // path below is the same call the UI makes.)
  const linkToken = randomBytes(32).toString("base64url");
  store.shareLinks.create(ownerKey, "commons", {
    requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000,
    maxJoins: 2, expectedMemberRevision: 0,
  }, null);
  const linkPreview = await post("/api/share-links/preview", { linkToken });
  assert.equal(linkPreview.status, 200);
  // A used-up/unknown link fails in invite vocabulary.
  const badLink = await post("/api/share-links/preview", { linkToken: randomBytes(32).toString("base64url") });
  assert.equal(badLink.status, 410);
  const badLinkJson = await badLink.json();
  assert.match(badLinkJson.error.message, /[Ii]nvite link/);

  // --- 3. Guest invite: the owner mints; the agent joins short-lived. ---
  // (GA-1, issue #941: tokens are server-issued — omit linkToken, use the
  // bearer the mint response returns once.)
  const guestMint = await post("/api/guest-agent-links", {
    roomId: "commons", requestId: randomUUID(),
    expectedOwnerRevision: 0, displayName: "Walker Guest",
  }, ownerKey);
  assert.ok([200, 201].includes(guestMint.status));
  const guestMintJson = await guestMint.json();
  const guestToken = guestMintJson.token;
  assert.ok(typeof guestToken === "string" && guestToken.length > 0);
  secrets.push(guestToken, linkToken);
  const guestJoin = await post("/api/guest-agent-links/join", { linkToken: guestToken });
  assert.equal(guestJoin.status, 200);
  const guestJoinJson = await guestJoin.json();
  assert.ok(guestJoinJson.memberId);
  // A bad guest token fails in invite vocabulary.
  const badGuest = await post("/api/guest-agent-links/join", { linkToken: "bogus" });
  assert.equal(badGuest.status, 410);
  const badGuestJson = await badGuest.json();
  assert.match(badGuestJson.error.message, /[Ii]nvite/);

  // --- 4. Request to join: no invite at all; the owner decides. ---
  const identityRes = await post("/api/agent-identities", { displayName: "Requester" });
  assert.ok([200, 201].includes(identityRes.status));
  const { identityId } = await identityRes.json();
  const requested = await post("/api/access-requests", {
    roomId: "commons", identityId, displayName: "Requester",
    requestedPermissions: ["accept_work"], note: null, requestId: randomUUID(),
  });
  assert.equal(requested.status, 201);
  const listed = await get("/api/rooms/commons/access-requests", ownerKey);
  assert.equal(listed.status, 200);
  const listedJson = await listed.json();
  assert.equal(listedJson.requests.length, 1);
  const decided = await post(`/api/rooms/commons/access-requests/${listedJson.requests[0].requestId}/decide`,
    { decision: "approve", permissions: ["accept_work"], note: null }, ownerKey);
  assert.equal(decided.status, 200);
  const decidedJson = await decided.json();
  assert.ok(decidedJson.memberId);
  // A request that does not exist fails in join-request vocabulary.
  const badStatus = await get(`/api/access-requests/nope?identityId=${identityId}`);
  assert.equal(badStatus.status, 404);
  const badStatusJson = await badStatus.json();
  assert.match(badStatusJson.error.message, /[Jj]oin request/);

  // Every message seen on the whole walkthrough speaks invite vocabulary.
  joinSeenVocabulary(seen, secrets);
});

test("scanner: user-facing surfaces carry no internal mechanism names", t => {
  const files = [
    "index.html",
    "deploy/room-entry.mjs",
    "deploy/agent-discovery.mjs",
    "docs/openapi.yaml",
    "docs/SWARM-PLUG-IN.md",
    "docs/AGENT-QUICKSTART.md",
    "docs/GUEST-AGENT-LINKS.md",
    "docs/JOINING.md",
    "docs/ROUTE-AUTH-TABLE.md",
    "docs/AGENT-ACCOUNT-LINK.md",
    "scripts/agent-inbox.mjs",
    "scripts/bootstrap-agent-room.mjs",
  ];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    assertInviteVocabulary(text, file);
  }
});

// docs/JOINING.md walks a human through UI controls ("Make room admin",
// "Remove admin role", ...). Bold phrases in its admin instructions name
// client controls, so each must appear verbatim in the served client bundle;
// a renamed or removed control that the doc still names strands the reader.
// "People → X" sequences split on the arrow; possessive prefixes ("their")
// are stripped before matching.
test("JOINING.md admin instructions name only controls in the client", () => {
  const doc = readFileSync(join(ROOT, "docs/JOINING.md"), "utf8");
  const adminPara = doc.split("**Making someone an additional room admin:**")[1]?.split("\n\n")[0] ?? "";
  assert.ok(adminPara.length > 0, "JOINING.md should keep the admin paragraph");
  const client = readFileSync(join(ROOT, "index.html"), "utf8")
    + readFileSync(join(ROOT, "src/app.js"), "utf8");
  const labels = [...adminPara.matchAll(/\*\*([^*]+)\*\*/g)]
    .flatMap(m => m[1].split("→"))
    .map(s => s.trim().replace(/^(their|your|the)\s+/i, ""))
    .filter(s => s.length > 1 && /[a-z]/i.test(s));
  assert.ok(labels.length > 0, "expected bold UI labels in the admin paragraph");
  const missing = labels.filter(label => !client.includes(label));
  assert.deepEqual(missing, [],
    `JOINING.md names UI controls missing from the client:\n${missing.join("\n")}`);
});
