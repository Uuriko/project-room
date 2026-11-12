#!/usr/bin/env node
// Native work lifecycle, referral, receipts opt-in, sweep, status, and
// wake-pause matrix for a current-format (native) room.
// Roles: owner, contribute, chat, review, manage_claims, write_external,
// link guest, public. The policy is the one SEC-1 and SEC-2 implement for
// the surfaces that are live in a native room: work travels the command
// bus (propose / accept / start / complete / verify), and the retired
// Board is pinned as refused or denied — Board writers get 409
// legacy_work_retired, non-writers the Board gate, anonymous 401.
// The legacy held-claim rows (claim / update / renew / release /
// reassign / attestation / verdict on Board claims) were removed when
// the Board retired in current rooms: their native equivalents are the
// lifecycle rows below. Do not relax the production retirement guard to
// revive them — seed native fixtures instead. (This harness originally
// failed exactly there: qa3-gates run 43056303231, exit 2 at the old
// Board claim seeding.)
// A cell whose fix has not merged is expectedFail with its finding id:
// the run stays green, and turns red once the fix matches while the flag
// is still set.
// Usage: node scripts/qa3/authz-board.mjs --origin http://127.0.0.1:4173 [--db room.sqlite]
// Referral redeem rows need outstanding tokens; since the mint door was
// parked (#3218) the harness seeds them at the store level (see
// seedReferralTokens below), so --db or ROOM_DB must name the server's
// database file, as with content-trust.
import { argv, exit } from "node:process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createQaClient } from "../qa2/lib/client.mjs";
import { assertLocalOrigin, createReport } from "./lib/summary.mjs";
import { ReferralInvites } from "../../server/referral-invites.mjs";

const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index > 0 ? argv[index + 1] : fallback;
};
const origin = arg("origin", "http://127.0.0.1:4173");
assertLocalOrigin(origin);

const ROLES = ["owner", "contribute", "chat", "review", "manage_claims", "write_external", "linkguest", "public"];
const MEMBERS = ROLES.filter(role => role !== "public");
const WRITERS = ["owner", "contribute", "review"];

// Intended policy. expectedFail names the finding whose fix has not merged.
// refused: writers must be refused with 422 invalid_claim_input (SEC-2 §3)
// or, on the retired Board, 409 legacy_work_retired.
// Native lifecycle rows classify command_rejected (400/409/422) as deny
// (denyAs422): a member who may not take a lifecycle step is refused by
// the command bus, which is the native room's deny. propose needs the
// steer permission (owner); accept / start / complete need accept_work /
// complete_work and accountability for the item (owner, contribute);
// verify needs the verify permission and designation as the item's
// verifier (owner, review).
const POLICY = {
  "propose work": { allow: ["owner"], denyAs422: true },
  "accept work": { allow: ["owner", "contribute"], denyAs422: true },
  "start work": { allow: ["owner", "contribute"], denyAs422: true },
  "complete work": { allow: ["owner", "contribute"], denyAs422: true },
  "verify work": { allow: ["owner", "review"], denyAs422: true },
  "legacy board create": { allow: [], refused: WRITERS },
  "sweep": { allow: ["owner", "contribute", "review", "manage_claims"] },
  "board status": { allow: MEMBERS },
  // Referral minting is parked (#3218): nobody may mint. Authenticated
  // callers get 410 referral_invites_parked, anonymous 401 — both classify
  // as deny (parkedAsDeny maps the 410).
  "referral mint": { allow: [], parkedAsDeny: true },
  // expectedFail: redeem is refused 409 current_room_context_required
  // for every role in a current-format room — ReferralInvites.redeem
  // reads the room through the legacy projection (store.room), which
  // current rooms refuse. The cure is a production fix to the redeem
  // path's room read, not a harness change, and it has not merged;
  // until it does, these cells are expectedFail and the run turns red
  // once redeem matches, so the flag is removed then.
  "referral redeem": {
    allow: ROLES,
    expectedFail: Object.fromEntries(ROLES.map(role => [role, "referral-redeem-current-room"])),
  },
  "receipts opt-in": { allow: ["owner"], denyAs422: true },
  "pause own wakes": { allow: MEMBERS },
  "pause another member": { allow: ["owner"] },
  "forged merged pull request": { allow: [], refused: WRITERS },
};

// Outstanding referral tokens for the redeem rows, seeded at the store
// level: the HTTP mint door is parked (#3218), so the harness writes what
// ReferralInvites.mint writes for a root mint by the room owner (no chain:
// depth 0, default cap 6, 7-day TTL — the module's TOKEN_VERSION /
// REFERRAL_TIER / DEFAULT_MAX_DEPTH / INVITE_TTL_MS constants in
// server/referral-invites.mjs), signing with the room's own key via the
// module's roomKeys/signToken so preview/redeem verify them exactly like
// door-minted tokens. The server's writer fence is an app-level lock; this
// follows content-trust's direct-DB precedent with a short busy timeout.
function seedReferralTokens(roomId, inviterMemberId, count) {
  const dbPath = arg("db", process.env.ROOM_DB ?? "");
  if (!dbPath) throw new Error("authz-board needs --db or ROOM_DB to seed referral tokens (mint is parked, #3218)");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const invites = new ReferralInvites({ db, now: () => Date.now() });
    const keys = invites.roomKeys(roomId);
    const tokens = [];
    for (let i = 0; i < count; i++) {
      const jti = randomUUID(), chainId = randomUUID(), issuedAt = Date.now(), expiresAt = issuedAt + 7 * 24 * 60 * 60 * 1000;
      db.prepare(`INSERT INTO referral_invites (jti, room_id, chain_id, inviter_member_id, depth, max_depth, created_at, expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'minted')`).run(jti, roomId, chainId, inviterMemberId, 0, 6, issuedAt, expiresAt);
      tokens.push(invites.signToken({ v: 1, jti, chainId, roomId, depth: 0, maxDepth: 6, issuedAt, expiresAt, tier: "chat" }, keys.privateSeed));
    }
    return tokens;
  } finally { db.close(); }
}

const client = createQaClient({ origin, userAgent: "project-room-qa3-authz/1" });
const report = createReport("qa3 authz-board");
const stamp = Date.now().toString(36);
const cmd = (type, data) => ({ id: randomUUID(), type, data });

const must = (response, what) => {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${what}: HTTP ${response.status} ${response.json?.error?.code ?? ""} ${response.text.slice(0, 240)}`);
  }
  return response.json;
};

function classify(response, { denyAs422 = false, parkedAsDeny = false } = {}) {
  const status = response.status;
  const code = response.json?.error?.code ?? "";
  if (status >= 200 && status < 300) return "allow";
  if (status === 401 || status === 403 || status === 404) return "deny";
  if (parkedAsDeny && status === 410 && code === "referral_invites_parked") return "deny";
  if (denyAs422 && code === "command_rejected" && (status === 400 || status === 409 || status === 422 || status === 405)) return "deny";
  if (status === 400 || status === 409 || status === 422 || status === 405) return "refused";
  return "error";
}

function expectedOf(policy, role) {
  if ((policy.refused ?? []).includes(role)) return "refused";
  if ((policy.allow ?? []).includes(role)) return "allow";
  return "deny";
}

async function shareLink(roomPath, token) {
  for (let revision = 0; revision <= 8; revision++) {
    const linkToken = randomBytes(32).toString("base64url").slice(0, 43);
    const response = await client.request("POST", `${roomPath}/share-links`, {
      token,
      body: {
        requestId: randomUUID(),
        linkToken,
        expiresAt: Date.now() + 3600e3,
        maxJoins: 4,
        expectedMemberRevision: revision,
      },
    });
    if (response.status < 300) return linkToken;
    if (response.status !== 409) throw new Error(`share link: HTTP ${response.status} ${response.text.slice(0, 200)}`);
  }
  throw new Error("share link: member revision did not match");
}

try {
  const tokens = { public: null };
  const memberIds = {};
  const owner = must(await client.request("POST", "/api/agent-identities", { body: { displayName: `Qa3Owner${stamp}` } }), "mint owner");
  tokens.owner = owner.secret;
  memberIds.owner = owner.identityId;
  const roomId = must(await client.request("POST", "/api/agent-rooms", {
    token: tokens.owner,
    body: { title: `qa3-authz-${stamp}`, purpose: "QA3 board authz throwaway room" },
  }), "create room").roomId;
  const roomPath = `/api/rooms/${encodeURIComponent(roomId)}`;

  const invites = [
    ["contribute", { profile: "contribute" }],
    ["chat", { profile: "chat" }],
    ["review", { profile: "review" }],
    ["manage_claims", { permissions: ["manage_claims"] }],
    ["write_external", { permissions: ["write_external"] }],
  ];
  for (const [role, scope] of invites) {
    const who = must(await client.request("POST", "/api/agent-identities", { body: { displayName: `Qa3${role}${stamp}` } }), `mint ${role}`);
    tokens[role] = who.secret;
    memberIds[role] = who.identityId;
    const invite = must(await client.request("POST", `${roomPath}/agent-invites`, {
      token: tokens.owner,
      body: { ...scope, displayName: `Qa3${role}${stamp}` },
    }), `invite ${role}`);
    must(await client.request("POST", "/api/agent-invites/redeem", {
      token: tokens[role],
      body: { code: invite.code, displayName: `Qa3${role}${stamp}` },
    }), `redeem ${role}`);
  }
  const linkToken = await shareLink(roomPath, tokens.owner);
  const guest = must(await client.request("POST", "/api/agent-identities", { body: { displayName: `Qa3link${stamp}` } }), "mint linkguest");
  tokens.linkguest = guest.secret;
  memberIds.linkguest = guest.identityId;
  must(await client.request("POST", "/api/share-links/join-agent", {
    token: tokens.linkguest,
    body: { linkToken, displayName: `Qa3link${stamp}` },
  }), "join linkguest");

  // Native lifecycle fixtures. Each matrix row seeds its own item
  // through the command bus: the owner proposes it with the tested role
  // as the accountable member. (The public role has no membership, so
  // the owner stands in as accountable and the row observes the
  // anonymous refusal instead.) This replaces the retired Board claim
  // seeding that tripped legacy_work_retired at this point in the file.
  const command = (role, type, data) => client.request("POST", `${roomPath}/commands`, {
    token: tokens[role],
    body: cmd(type, data),
  });
  const accountableFor = role => (memberIds[role] ? role : "owner");
  const proposeFor = async (id, accountableRole, extra = {}) => {
    must(await command("owner", "work.proposed", {
      workItemId: id, title: id, definitionOfDone: "qa3 result recorded",
      accountableMemberId: memberIds[accountableRole], mode: "read", ...extra,
    }), `propose ${id}`);
  };
  // Attempt accept + start as the accountable member, ignoring refusals:
  // a member without accept_work stays at revision 0, which is exactly
  // what the classified step in the row then observes.
  const acceptAndStart = async (id, role) => {
    await command(role, "work.accepted", { workItemId: id, expectedRevision: 0 });
    await command(role, "work.started", { workItemId: id, expectedRevision: 1 });
  };
  // Post the result text and complete the item as its accountable
  // member. Returns the work.completed response plus the evidence
  // version, for rows that continue to verification.
  const completeAs = async (id, role) => {
    const body = `result ${id} ${stamp}`;
    const messageId = randomUUID();
    const posted = await command(role, "message.posted", { messageId, body, workItemId: id });
    const evidenceVersion = `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
    const response = await command(role, "work.completed", {
      workItemId: id, expectedRevision: 2, evidenceKind: "room_text",
      evidenceMessageId: messageId, evidenceMessageEventId: posted.json?.event?.id ?? "missing-event",
      evidenceVersion, previousCompletionEventId: null,
      producerId: memberIds[role] ?? memberIds.owner,
      summary: `result ${id}`, nextAction: "verify",
    });
    return { response, evidenceVersion };
  };

  const referralTokens = seedReferralTokens(roomId, memberIds.owner, ROLES.length);

  const call = {
    "propose work": role => command(role, "work.proposed", {
      workItemId: `prop-${role}-${stamp}`, title: `prop ${role}`,
      definitionOfDone: "qa3 result recorded",
      accountableMemberId: memberIds[accountableFor(role)], mode: "read",
    }),
    // Accept is the native claim step: only the accountable member, and
    // only with accept_work, may take an item.
    "accept work": async role => {
      const id = `acc-${role}-${stamp}`;
      await proposeFor(id, accountableFor(role));
      return command(role, "work.accepted", { workItemId: id, expectedRevision: 0 });
    },
    "start work": async role => {
      const id = `start-${role}-${stamp}`;
      await proposeFor(id, accountableFor(role));
      await command(role, "work.accepted", { workItemId: id, expectedRevision: 0 });
      return command(role, "work.started", { workItemId: id, expectedRevision: 1 });
    },
    "complete work": async role => {
      const id = `done-${role}-${stamp}`;
      await proposeFor(id, accountableFor(role));
      await acceptAndStart(id, role);
      return (await completeAs(id, role)).response;
    },
    // Verification is by the item's designated verifier alone. The
    // producer is a different member from the tested verifier (the
    // contribute member, or the owner when contribute is the tested
    // role): independent verification requires that split, and the
    // owner row is then an independent verification, not a
    // self-verification.
    "verify work": async role => {
      const id = `ver-${role}-${stamp}`;
      const producer = role === "contribute" ? "owner" : "contribute";
      await proposeFor(id, producer, {
        independentVerificationRequired: true,
        verifierMemberId: memberIds[accountableFor(role)],
      });
      await acceptAndStart(id, producer);
      const { response: completed, evidenceVersion } = await completeAs(id, producer);
      if (completed.status < 200 || completed.status >= 300) {
        throw new Error(`verify setup for ${role}: completion HTTP ${completed.status} ${completed.text.slice(0, 160)}`);
      }
      return command(role, "verification.recorded", {
        workItemId: id, expectedRevision: 3, result: "pass",
        completionEventId: completed.json?.event?.id, evidenceVersion,
        summary: `verify ${role}`,
      });
    },
    // The retired Board stays retired: a create in a native room is
    // refused for Board writers (409 legacy_work_retired) and denied for
    // everyone else (Board gate 403, anonymous 401).
    "legacy board create": role => client.request("POST", `${roomPath}/work-claims`, {
      token: tokens[role],
      body: { id: `new-${role}-${stamp}`, title: `new ${role}` },
    }),
    "sweep": role => client.request("POST", `${roomPath}/work-claims/sweep`, { token: tokens[role], body: {} }),
    "board status": role => client.request("GET", `${roomPath}/work-claims/status`, { token: tokens[role] }),
    "referral mint": role => client.request("POST", "/api/referral-invites/mint", { token: tokens[role], body: { roomId } }),
    "referral redeem": role => client.request("POST", "/api/referral-invites/redeem", {
      body: { token: referralTokens.shift(), displayName: `Qa3ref${role}${stamp}` },
    }),
    "receipts opt-in": role => client.request("POST", `${roomPath}/commands`, {
      token: tokens[role],
      body: cmd("room.public_receipts_set", { enabled: true }),
    }),
    "pause own wakes": role => client.request("POST", `${roomPath}/agent-pause`, {
      token: tokens[role],
      body: { action: "pause", memberId: memberIds[role], requestId: `own${role}${stamp}`.slice(0, 80), reason: "qa3" },
    }),
    "pause another member": role => client.request("POST", `${roomPath}/agent-pause`, {
      token: tokens[role],
      body: {
        action: "pause",
        memberId: role === "owner" ? memberIds.contribute : memberIds.owner,
        requestId: `oth${role}${stamp}`.slice(0, 80),
        reason: "qa3",
      },
    }),
    "forged merged pull request": role => client.request("POST", `${roomPath}/work-claims`, {
      token: tokens[role],
      body: {
        id: `pr-${role}-${stamp}`,
        title: `forged ${role}`,
        pullRequest: {
          url: "https://github.com/torvalds/linux/pull/1",
          outcome: "merged",
          syncedAt: "2020-01-01T00:00:00.000Z",
        },
      },
    }),
  };

  for (const [name, policy] of Object.entries(POLICY)) {
    for (const role of ROLES) {
      let response;
      try {
        response = await call[name](role);
      } catch (error) {
        throw new Error(`${name} as ${role}: ${error.message}`);
      }
      const outcome = classify(response, { denyAs422: policy.denyAs422 === true, parkedAsDeny: policy.parkedAsDeny === true });
      const expected = expectedOf(policy, role);
      const finding = policy.expectedFail?.[role] ?? null;
      report.cell({
        name: `${name} as ${role}`,
        matched: outcome === expected,
        expectedFail: finding,
        detail: `expected ${expected}, got ${outcome} ${response.status} ${response.json?.error?.code ?? ""}`.trim(),
      });
    }
  }
  exit(report.finish());
} catch (error) {
  console.error(error.stack || error.message);
  exit(2);
}
