#!/usr/bin/env node
// Board, referral, receipts opt-in, sweep, status, and wake-pause matrix.
// Roles: owner, contribute, chat, review, manage_claims, write_external,
// link guest, public. The policy is the one SEC-1 and SEC-2 implement.
// A cell whose fix has not merged is expectedFail with its finding id:
// the run stays green, and turns red once the fix matches while the flag
// is still set.
// Usage: node scripts/qa3/authz-board.mjs --origin http://127.0.0.1:4173 [--db room.sqlite]
// Referral redeem rows need outstanding tokens; since the mint door was
// parked (#3218) the harness seeds them at the store level (see
// seedReferralTokens below), so --db or ROOM_DB must name the server's
// database file, as with content-trust.
import { argv, exit } from "node:process";
import { randomBytes, randomUUID } from "node:crypto";
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
// refused: writers must be refused with 422 invalid_claim_input (SEC-2 §3).
const POLICY = {
  "create work claim": { allow: WRITERS },
  "claim work": { allow: WRITERS },
  "update held claim": { allow: WRITERS },
  "renew held claim": { allow: WRITERS },
  "release claim": { allow: ["owner", "contribute", "review", "manage_claims"] },
  "reassign claim": { allow: ["owner", "contribute", "review", "manage_claims"] },
  "attestation note": { allow: ["owner", "review", "manage_claims"] },
  "verdict review": { allow: ["owner", "review"] },
  "sweep": { allow: ["owner", "contribute", "review", "manage_claims"] },
  "board status": { allow: MEMBERS },
  // Referral minting is parked (#3218): nobody may mint. Authenticated
  // callers get 410 referral_invites_parked, anonymous 401 — both classify
  // as deny (parkedAsDeny maps the 410).
  "referral mint": { allow: [], parkedAsDeny: true },
  "referral redeem": { allow: ROLES },
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

  const claimBy = async (id, holder) => {
    must(await client.request("POST", `${roomPath}/work-claims`, {
      token: tokens.owner,
      body: { id, title: id },
    }), `create ${id}`);
    must(await client.request("POST", `${roomPath}/work-claims/${id}/claim`, {
      token: tokens[holder],
      body: { note: "held", leaseHours: 1 },
    }), `claim ${id} as ${holder}`);
  };

  const held = {};
  for (const role of WRITERS) {
    held[`update:${role}`] = `upd-${role}`;
    held[`renew:${role}`] = `ren-${role}`;
    await claimBy(`upd-${role}`, role);
    await claimBy(`ren-${role}`, role);
  }
  await claimBy("upd-deny", "contribute");
  await claimBy("ren-deny", "contribute");
  for (const role of ["owner", "contribute", "review", "manage_claims"]) {
    const holder = role === "owner" || role === "manage_claims" ? "review" : role;
    held[`release:${role}`] = `rel-${role}`;
    held[`reassign:${role}`] = `reas-${role}`;
    await claimBy(`rel-${role}`, holder);
    await claimBy(`reas-${role}`, holder);
  }
  await claimBy("rel-deny", "contribute");
  await claimBy("reas-deny", "contribute");
  await claimBy("attest-1", "owner");
  await claimBy("verdict-1", "contribute");
  for (const role of ROLES) {
    must(await client.request("POST", `${roomPath}/work-claims`, {
      token: tokens.owner,
      body: { id: `clm-${role}`, title: `clm-${role}` },
    }), `create clm-${role}`);
  }

  const referralTokens = seedReferralTokens(roomId, memberIds.owner, ROLES.length);

  const call = {
    "create work claim": role => client.request("POST", `${roomPath}/work-claims`, {
      token: tokens[role],
      body: { id: `new-${role}-${stamp}`, title: `new ${role}` },
    }),
    "claim work": role => client.request("POST", `${roomPath}/work-claims/clm-${role}/claim`, {
      token: tokens[role],
      body: { note: "claim", leaseHours: 1 },
    }),
    "update held claim": role => client.request("POST", `${roomPath}/work-claims/${held[`update:${role}`] ?? "upd-deny"}/update`, {
      token: tokens[role],
      body: { state: "in_progress", note: "progress" },
    }),
    "renew held claim": async role => {
      const id = held[`renew:${role}`] ?? "ren-deny";
      let progressMessageId = "missing-progress";
      if (held[`renew:${role}`]) {
        progressMessageId = randomUUID();
        const posted = await client.request("POST", `${roomPath}/commands`, {
          token: tokens[role],
          body: cmd("message.posted", { messageId: progressMessageId, body: `progress ${role} ${stamp}` }),
        });
        if (posted.status < 200 || posted.status >= 300) {
          throw new Error(`renew progress for ${role}: HTTP ${posted.status} ${posted.text.slice(0, 160)}`);
        }
      }
      return client.request("POST", `${roomPath}/work-claims/${id}/renew`, {
        token: tokens[role],
        body: { progressMessageId },
      });
    },
    "release claim": async role => {
      // E5/D4 (QA-200 2026-10-08): /release binds the claim round the client read.
      const id = held[`release:${role}`] ?? "rel-deny";
      const read = await client.request("GET", `${roomPath}/work-claims/${id}`, {
        token: tokens[role],
      });
      const item = read.json?.claim ?? read.json;
      return client.request("POST", `${roomPath}/work-claims/${id}/release`, {
        token: tokens[role],
        body: { note: "release", expectedClaimedAt: item?.claimedAt,
          expectedHistoryLength: (item?.history?.length ?? 0) + (item?.historyOmitted ?? 0) },
      });
    },
    "reassign claim": async role => {
      // /reassign binds the claim round the client read, like /release.
      const id = held[`reassign:${role}`] ?? "reas-deny";
      const read = await client.request("GET", `${roomPath}/work-claims/${id}`, { token: tokens[role] });
      const item = read.json?.claim ?? read.json;
      return client.request("POST", `${roomPath}/work-claims/${id}/reassign`, {
        token: tokens[role],
        body: { newOwner: role === "contribute" ? memberIds.owner : memberIds.contribute, note: "reassign",
          expectedClaimedAt: item?.claimedAt ?? null,
          expectedHistoryLength: (item?.history?.length ?? 0) + (item?.historyOmitted ?? 0) },
      });
    },
    "attestation note": role => client.request("POST", `${roomPath}/work-claims/attest-1/review`, {
      token: tokens[role],
      body: { note: `attest ${role}` },
    }),
    "verdict review": role => client.request("POST", `${roomPath}/work-claims/verdict-1/review`, {
      token: tokens[role],
      body: { verdict: "comment", summary: `verdict ${role}` },
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
