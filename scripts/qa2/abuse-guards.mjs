#!/usr/bin/env node
// Outcome checks for the work-claim, webhook, display-name, instructions,
// and member-text guards. Local only: it writes rows in a throwaway room.
// Usage: node scripts/qa2/abuse-guards.mjs --origin http://127.0.0.1:4173 [--json out.json]
// Exit 1 when any check fails.
import { argv, exit } from "node:process";
import { randomUUID, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createQaClient } from "./lib/client.mjs";

const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index > 0 ? argv[index + 1] : fallback;
};
const origin = arg("origin", "http://127.0.0.1:4173");
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
  console.error("abuse-guards is local-only");
  exit(2);
}

const UA = "project-room-qa2-guards/1";
const client = createQaClient({ origin, userAgent: UA });
const stamp = Date.now().toString(36);
const OPEN_CAP = 200;
const MEMBER_CAP = 20;
const ACTIVE = new Set(["claimed", "in_progress", "blocked"]);
const minted = [];
let room = null;
let owner = null;

const codeOf = response => response.json?.error?.code ?? "";
const sameList = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function req(method, path, token, body) {
  return client.request(method, path, { token, body, accept: "application/json, text/event-stream" });
}

const must = (response, what) => {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${what}: HTTP ${response.status} ${codeOf(response)} ${response.text.slice(0, 240)}`);
  }
  return response.json;
};
const cmd = (type, data) => ({ id: randomUUID(), type, data });

async function mint(displayName) {
  const created = must(await req("POST", "/api/agent-identities", null, { displayName }), `mint ${displayName}`);
  minted.push(created);
  return created;
}

async function handles() {
  const pack = must(await req("GET", `/api/rooms/${room}/activation-pack`, owner.secret), "activation pack");
  return (pack.members ?? []).map(member => member.handle).sort();
}

async function listClaims() {
  const items = [];
  let cursor = null;
  for (;;) {
    const query = cursor ? `?limit=200&cursor=${encodeURIComponent(cursor)}` : "?limit=200";
    const page = must(await req("GET", `/api/rooms/${room}/work-claims${query}`, owner.secret), "list claims");
    items.push(...(page.claims ?? []));
    if (!page.hasMore) return items;
    cursor = page.nextCursor;
  }
}

async function readClaim(id) {
  return must(await req("GET", `/api/rooms/${room}/work-claims/${id}`, owner.secret), `read ${id}`);
}

const openCount = async () => (await listClaims()).filter(item => item.state !== "done").length;
const holdings = async memberId => (await listClaims()).filter(item => item.owner === memberId && ACTIVE.has(item.state)).length;

async function postMessage(token, body) {
  const messageId = randomUUID();
  const response = await req("POST", `/api/rooms/${room}/commands`, token, cmd("message.posted", { messageId, body }));
  return { response, messageId };
}

async function shareLink() {
  for (let revision = 0; revision <= 8; revision++) {
    const linkToken = randomBytes(32).toString("base64url").slice(0, 43);
    const response = await req("POST", `/api/rooms/${room}/share-links`, owner.secret, {
      requestId: randomUUID(),
      linkToken,
      expiresAt: Date.now() + 3600e3,
      maxJoins: 5,
      expectedMemberRevision: revision,
    });
    if (response.status < 300) return linkToken;
    if (response.status !== 409) throw new Error(`share link: HTTP ${response.status} ${response.text.slice(0, 200)}`);
  }
  throw new Error("share link: member revision did not match");
}

async function invite(profile) {
  const response = await req("POST", `/api/rooms/${room}/agent-invites`, owner.secret, { profile });
  return must(response, `invite ${profile}`).code;
}

async function cleanup() {
  if (room && owner) {
    try { await req("POST", `/api/rooms/${room}/commands`, owner.secret, cmd("room.archived", {})); } catch { /* best-effort */ }
  }
  for (const identity of minted) {
    try {
      await req("POST", `/api/agent-identities/${identity.identityId}/revoke`, identity.secret, { confirm: true });
    } catch { /* best-effort */ }
  }
}

const results = [];
const guard = (id, title, pass, evidence) => {
  const status = pass ? "PASS" : "FAIL";
  results.push({ id, title, status, evidence });
  console.log(`${status.padEnd(5)} ${id} ${title} :: ${evidence}`);
};

try {
  owner = await mint("Potter");
  room = must(await req("POST", "/api/agent-rooms", owner.secret, {
    title: `qa2-guards-${stamp}`,
    purpose: "QA2 guard checks",
  }), "create room").roomId;
  const roomPath = `/api/rooms/${room}`;

  const blockedHosts = ["127.0.0.1.nip.io", "localtest.me"];
  const hooksBefore = must(await req("GET", "/api/agent-webhooks", owner.secret), "list webhooks").subscriptions ?? [];
  const webhookRefusals = [];
  for (const host of blockedHosts) {
    const response = await req("POST", "/api/agent-webhooks", owner.secret, {
      url: `https://${host}/hook`,
      events: ["message.posted"],
    });
    if (response.status !== 422 || codeOf(response) !== "webhook_url_not_public") {
      webhookRefusals.push(`${host} ${response.status} ${codeOf(response)}`);
    }
  }
  const hooksAfterRefusal = must(await req("GET", "/api/agent-webhooks", owner.secret), "list webhooks after refusal").subscriptions ?? [];
  const storedBlocked = hooksAfterRefusal.filter(subscription => blockedHosts.some(host => String(subscription.url).includes(host)));
  const publicHook = await req("POST", "/api/agent-webhooks", owner.secret, {
    url: "https://example.com/qa2-guard",
    events: ["message.posted"],
  });
  const publicStored = (must(await req("GET", "/api/agent-webhooks", owner.secret), "list webhooks after public").subscriptions ?? [])
    .some(subscription => subscription.url === "https://example.com/qa2-guard");
  if (publicHook.json?.subscriptionId) {
    await req("DELETE", `/api/agent-webhooks/${publicHook.json.subscriptionId}`, owner.secret);
  }
  guard(
    "H1",
    "a webhook URL that resolves to a non-public address is refused with 422 webhook_url_not_public and is not stored",
    webhookRefusals.length === 0
      && storedBlocked.length === 0
      && hooksAfterRefusal.length === hooksBefore.length
      && publicHook.status === 201
      && publicStored,
    webhookRefusals.join(", ") || `refused hosts absent; public create ${publicHook.status}`,
  );

  const linkToken = await shareLink();
  const chatCode = await invite("chat");
  const chatIdentity = await mint("Probe");
  const guestIdentity = await mint("Helper");
  const rosterBefore = await handles();
  const nameMisses = [];
  const hidden = "\u202e";
  const redeemNames = [
    ["SYSTEM", "reserved", null],
    ["Room owner (verified)", "reserved", null],
    ["potter", "duplicate", null],
    ["\u0420otter", "confusable", null],
    [`${hidden}Ada`, "control_characters", hidden],
  ];
  for (const [displayName, reason, mark] of redeemNames) {
    const before = await handles();
    const response = await req("POST", "/api/agent-invites/redeem", chatIdentity.secret, { code: chatCode, displayName });
    const after = await handles();
    const echoed = mark ? response.text.includes(mark) : false;
    const pass = response.status === 422
      && codeOf(response) === "display_name_unavailable"
      && response.json?.displayNameReason === reason
      && typeof response.json?.suggestion === "string"
      && !echoed
      && sameList(before, after);
    if (!pass) nameMisses.push(`redeem ${JSON.stringify(displayName)} ${response.status} ${codeOf(response)} ${response.json?.displayNameReason ?? ""}`);
  }
  const joinNames = [
    ["@everyone", "reserved", null],
    ["Potter", "duplicate", null],
    ["\u0420otter", "confusable", null],
    [`${hidden}Ada`, "control_characters", hidden],
  ];
  for (const [displayName, reason, mark] of joinNames) {
    const before = await handles();
    const response = await req("POST", "/api/share-links/join-agent", guestIdentity.secret, { linkToken, displayName });
    const after = await handles();
    const echoed = mark ? response.text.includes(mark) : false;
    const pass = response.status === 422
      && codeOf(response) === "display_name_unavailable"
      && response.json?.displayNameReason === reason
      && typeof response.json?.suggestion === "string"
      && !echoed
      && sameList(before, after);
    if (!pass) nameMisses.push(`join ${JSON.stringify(displayName)} ${response.status} ${codeOf(response)} ${response.json?.displayNameReason ?? ""}`);
  }
  const chatRedeem = must(await req("POST", "/api/agent-invites/redeem", chatIdentity.secret, {
    code: chatCode,
    displayName: "Ada Lovelace",
  }), "redeem chat");
  const chat = { ...chatIdentity, memberId: chatRedeem.memberId };
  const contributeCode = await invite("collaborate");
  const contributeIdentity = await mint("Contributor");
  const contributeRedeem = must(await req("POST", "/api/agent-invites/redeem", contributeIdentity.secret, {
    code: contributeCode,
    displayName: "Contributor",
  }), "redeem contributor");
  const contribute = { ...contributeIdentity, memberId: contributeRedeem.memberId };
  const fillers = [];
  for (const name of ["Fill One", "Fill Two", "Fill Three", "Fill Four"]) {
    const code = await invite("collaborate");
    const identity = await mint(name);
    const redeemed = must(await req("POST", "/api/agent-invites/redeem", identity.secret, { code, displayName: name }), `redeem ${name}`);
    fillers.push({ ...identity, memberId: redeemed.memberId, writes: 0 });
  }
  const guestJoin = must(await req("POST", "/api/share-links/join-agent", guestIdentity.secret, {
    linkToken,
    displayName: "Helper",
  }), "join guest");
  const guest = { ...guestIdentity, memberId: guestJoin.memberId };
  const repeat = await req("POST", "/api/share-links/join-agent", guest.secret, { linkToken, displayName: "SYSTEM" });
  const rosterAfter = await handles();
  const repeatKeepsName = repeat.status === 200 && repeat.json?.duplicate === true && rosterAfter.includes("Helper") && !rosterAfter.includes("SYSTEM");
  guard(
    "D1",
    "a new display name that is reserved, duplicate, confusable, or has control characters is refused with 422 display_name_unavailable and the roster stays unchanged",
    nameMisses.length === 0 && sameList(rosterBefore, ["Potter"]) && repeatKeepsName && rosterAfter.includes("Ada Lovelace"),
    nameMisses.join("; ") || `roster before refusals ${rosterBefore.join(", ")}; existing member kept Helper`,
  );

  const heldId = `held-${stamp}`;
  must(await req("POST", `${roomPath}/work-claims`, owner.secret, { id: heldId, title: "held" }), "create held");
  must(await req("POST", `${roomPath}/work-claims/${heldId}/claim`, contribute.secret, { note: "hold", leaseHours: 1 }), "claim held");
  const openBeforeCreate = await openCount();
  const createRefusals = [];
  for (const [who, label] of [[guest, "guest"], [chat, "chat"]]) {
    const response = await req("POST", `${roomPath}/work-claims`, who.secret, { id: `deny-${label}-${stamp}`, title: "x" });
    createRefusals.push(`${label} ${response.status} ${codeOf(response)}`);
  }
  const openAfterCreate = await openCount();
  guard(
    "C1",
    "a share-link guest and a chat-profile agent are refused work-claim create with 403 work_claims_not_permitted and the board is unchanged",
    createRefusals.every(line => line.endsWith("403 work_claims_not_permitted")) && openAfterCreate === openBeforeCreate,
    `${createRefusals.join(", ")}; open ${openBeforeCreate} -> ${openAfterCreate}`,
  );

  const heldBefore = await readClaim(heldId);
  const renewRelease = [];
  for (const [who, label] of [[guest, "guest"], [chat, "chat"]]) {
    const renewed = await req("POST", `${roomPath}/work-claims/${heldId}/renew`, who.secret, { progressMessageId: randomUUID() });
    const released = await req("POST", `${roomPath}/work-claims/${heldId}/release`, who.secret, { reason: "drop" });
    renewRelease.push(`${label} renew ${renewed.status} ${codeOf(renewed)}`, `${label} release ${released.status} ${codeOf(released)}`);
  }
  const heldMid = await readClaim(heldId);
  const midSame = heldMid.owner === heldBefore.owner && heldMid.state === heldBefore.state && heldMid.leaseExpiresAt === heldBefore.leaseExpiresAt;
  must(await req("POST", `${roomPath}/work-claims/${heldId}/reassign`, owner.secret, { newOwner: chat.memberId, note: "handoff" }), "reassign");
  const heldAtChat = await readClaim(heldId);
  const chatRenew = await req("POST", `${roomPath}/work-claims/${heldId}/renew`, chat.secret, { progressMessageId: randomUUID() });
  const heldAfter = await readClaim(heldId);
  const chatSame = heldAfter.owner === chat.memberId && heldAfter.state === "claimed" && heldAfter.leaseExpiresAt === heldAtChat.leaseExpiresAt;
  guard(
    "C2",
    "renew and release by a non-holder are refused with 403 work_not_owner, and a chat-profile holder is refused renew with 403 work_claims_not_permitted; owner, state, and lease stay unchanged",
    renewRelease.every(line => line.includes("403 work_not_owner"))
      && midSame
      && chatRenew.status === 403
      && codeOf(chatRenew) === "work_claims_not_permitted"
      && chatSame,
    `${renewRelease.join(", ")}; chat-holder renew ${chatRenew.status} ${codeOf(chatRenew)}`,
  );

  const overId = `lease-over-${stamp}`;
  must(await req("POST", `${roomPath}/work-claims`, contribute.secret, { id: overId, title: "over" }), "create over");
  const over = await req("POST", `${roomPath}/work-claims/${overId}/claim`, contribute.secret, { leaseHours: 720 });
  const overItem = await readClaim(overId);
  const nullId = `lease-null-${stamp}`;
  must(await req("POST", `${roomPath}/work-claims`, contribute.secret, { id: nullId, title: "null lease" }), "create null");
  const nullLease = await req("POST", `${roomPath}/work-claims/${nullId}/claim`, contribute.secret, { leaseHours: null });
  const nullItem = await readClaim(nullId);
  const weekId = `lease-week-${stamp}`;
  must(await req("POST", `${roomPath}/work-claims`, contribute.secret, { id: weekId, title: "week" }), "create week");
  const week = await req("POST", `${roomPath}/work-claims/${weekId}/claim`, contribute.secret, { leaseHours: 168 });
  const weekItem = await readClaim(weekId);
  const weekHours = weekItem.leaseExpiresAt ? (Date.parse(weekItem.leaseExpiresAt) - Date.now()) / 36e5 : null;
  await new Promise(resolve => setTimeout(resolve, 30));
  const progress = await postMessage(contribute.secret, "progress");
  must(progress.response, "progress message");
  const renewOver = await req("POST", `${roomPath}/work-claims/${weekId}/renew`, contribute.secret, {
    progressMessageId: progress.messageId,
    leaseHours: 720,
  });
  const weekAfter = await readClaim(weekId);
  guard(
    "C5",
    "leaseHours above 168, and null from a member who is not the room owner, are refused with 422 invalid_claim_input and the claim is unchanged",
    over.status === 422 && codeOf(over) === "invalid_claim_input" && /168/.test(over.json?.error?.message ?? "")
      && overItem.state === "unclaimed" && overItem.owner === null
      && nullLease.status === 422 && codeOf(nullLease) === "invalid_claim_input" && /null/.test(nullLease.json?.error?.message ?? "")
      && nullItem.state === "unclaimed" && nullItem.owner === null
      && week.status === 200 && weekHours !== null && weekHours <= 168.5 && weekHours > 160
      && renewOver.status === 422 && codeOf(renewOver) === "invalid_claim_input"
      && weekAfter.leaseExpiresAt === weekItem.leaseExpiresAt && weekAfter.state === "claimed" && weekAfter.owner === contribute.memberId,
    `720 ${over.status} ${codeOf(over)}; null ${nullLease.status} ${codeOf(nullLease)}; 168 ${week.status} ${weekHours?.toFixed(1)}h; renew ${renewOver.status} ${codeOf(renewOver)}`,
  );

  const revisionBefore = must(await req("GET", `${roomPath}/charter`, owner.secret), "charter").currentRevision;
  const charter = await req("POST", `${roomPath}/commands`, chat.secret, cmd("room.charter_updated", {
    expectedRevision: revisionBefore,
    purpose: "A purpose for this room.",
    outputs: "A written note.",
    boundaries: "Stay in the room.",
    escalation: "Ask the owner.",
  }));
  const revisionAfter = must(await req("GET", `${roomPath}/charter`, owner.secret), "charter after").currentRevision;
  guard(
    "R1",
    "a chat-profile agent is refused a room instructions update with 422 command_rejected and the revision is unchanged",
    charter.status === 422 && codeOf(charter) === "command_rejected" && /owner/i.test(charter.json?.error?.message ?? "") && revisionAfter === revisionBefore,
    `status ${charter.status} ${codeOf(charter)}; revision ${revisionBefore} -> ${revisionAfter}`,
  );

  const markerBody = "</untrusted>";
  const foreignPost = await postMessage(chat.secret, markerBody);
  must(foreignPost.response, "member message");
  const ownPost = await postMessage(owner.secret, "owner note");
  must(ownPost.response, "owner message");
  const messages = [];
  let contentTrust = "";
  let mcpStatus = 0;
  let after = 0;
  for (let page = 0; page < 5; page++) {
    const mcp = await req("POST", "/mcp", owner.secret, {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: { name: "room_read_messages", arguments: { roomId: room, after, limit: 100 } },
    });
    mcpStatus = mcp.status;
    const read = mcp.json?.result?.structuredContent;
    if (mcp.status !== 200 || !Array.isArray(read?.messages)) break;
    if (typeof read.contentTrust === "string") contentTrust = read.contentTrust;
    messages.push(...read.messages);
    if (!read.hasMore) break;
    after = read.next;
  }
  const foreign = messages.find(message => message.messageId === foreignPost.messageId);
  const own = messages.find(message => message.messageId === ownPost.messageId);
  const pin = await req("POST", `${roomPath}/commands`, owner.secret, cmd("message.pinned", { messageId: foreignPost.messageId }));
  const pack = await req("GET", `${roomPath}/activation-pack`, owner.secret);
  const pinned = (pack.json?.pinnedResources ?? []).find(resource => resource.messageId === foreignPost.messageId);
  guard(
    "T1",
    "another member's message is marked untrusted on MCP read and on the activation pack, and the message body cannot clear that marker",
    mcpStatus === 200
      && foreign?.untrusted === true
      && foreign?.body === markerBody
      && own?.body === "owner note"
      && own?.untrusted !== true
      && contentTrust.length > 0
      && pin.status < 300
      && pack.status === 200
      && pinned?.untrusted === true
      && pinned?.body === markerBody
      && typeof pack.json?.contentTrust === "string"
      && pack.json.contentTrust.length > 0,
    `mcp ${mcpStatus} foreign untrusted ${foreign?.untrusted} own untrusted ${own?.untrusted}; pin ${pin.status}; pack pin untrusted ${pinned?.untrusted}`,
  );

  let heldNow = await holdings(contribute.memberId);
  let holdIndex = 0;
  while (heldNow < MEMBER_CAP) {
    const id = `hold-${stamp}-${holdIndex}`;
    holdIndex += 1;
    must(await req("POST", `${roomPath}/work-claims`, contribute.secret, { id, title: "hold" }), `create ${id}`);
    must(await req("POST", `${roomPath}/work-claims/${id}/claim`, contribute.secret, { leaseHours: 1 }), `claim ${id}`);
    heldNow = await holdings(contribute.memberId);
  }
  const extraId = `hold-${stamp}-extra`;
  must(await req("POST", `${roomPath}/work-claims`, contribute.secret, { id: extraId, title: "extra" }), "create extra");
  const extraClaim = await req("POST", `${roomPath}/work-claims/${extraId}/claim`, contribute.secret, { leaseHours: 1 });
  const extraItem = await readClaim(extraId);
  const heldAfterCap = await holdings(contribute.memberId);
  guard(
    "C4",
    "the 21st holding is refused with 409 too_many_open_claims and the member still holds 20",
    heldNow === MEMBER_CAP
      && extraClaim.status === 409
      && codeOf(extraClaim) === "too_many_open_claims"
      && extraItem.state === "unclaimed"
      && extraItem.owner === null
      && heldAfterCap === MEMBER_CAP,
    `holdings ${heldAfterCap}; next claim ${extraClaim.status} ${codeOf(extraClaim)}; extra state ${extraItem.state}`,
  );

  const fillersBudget = 55;
  let made = 0;
  const openBeforeFill = await openCount();
  const needed = OPEN_CAP - openBeforeFill;
  if (needed < 0) throw new Error(`open claims ${openBeforeFill} already above ${OPEN_CAP}`);
  while (made < needed) {
    const filler = fillers.find(candidate => candidate.writes < fillersBudget) ?? fillers[0];
    const id = `open-${stamp}-${made}`;
    const response = await req("POST", `${roomPath}/work-claims`, filler.secret, { id, title: "open" });
    filler.writes += 1;
    if (response.status !== 201) {
      throw new Error(`fill ${id}: HTTP ${response.status} ${codeOf(response)} ${response.text.slice(0, 160)}`);
    }
    made += 1;
  }
  const overCapId = `open-${stamp}-over`;
  const filler = fillers.find(candidate => candidate.writes < fillersBudget) ?? fillers[0];
  const overCap = await req("POST", `${roomPath}/work-claims`, filler.secret, { id: overCapId, title: "over cap" });
  const board = await listClaims();
  const openAfterCap = board.filter(item => item.state !== "done").length;
  const overCapStored = board.some(item => item.id === overCapId);
  guard(
    "C3",
    "the 201st open claim is refused with 409 work_board_full and the board stays at 200 open claims",
    overCap.status === 409 && codeOf(overCap) === "work_board_full" && !overCapStored && openAfterCap === OPEN_CAP,
    `open ${openAfterCap}; next create ${overCap.status} ${codeOf(overCap)}; stored ${overCapStored}`,
  );
} catch (error) {
  results.push({ id: "setup", title: "checker setup", status: "FAIL", evidence: error?.message ?? String(error) });
  console.error(error);
} finally {
  await cleanup();
}

const failed = results.filter(result => result.status === "FAIL");
const jsonOut = arg("json");
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ origin, at: new Date().toISOString(), results }, null, 2));
console.log(`abuse guards: ${results.filter(result => result.status === "PASS").length} pass, ${failed.length} fail`);
exit(failed.length ? 1 : 0);
