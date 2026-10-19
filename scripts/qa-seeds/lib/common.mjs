// Shared construction machinery for the QA wave seed packs.
//
// Every pack is built by driving the application's own write paths against
// a throwaway file-backed RoomStore whose clock is a SeedClock the builder
// advances by hand: identities are minted and rooms are joined through the
// real HTTP doors, board claims through server/work-claims.mjs, bounties
// through store.bountyEscrow, public work through store.projectOffers /
// store.publicWorkClaims / store.publicWorkReviews. Nothing here writes
// SQL except where a pack's whole point is a corruption shape, and those
// writes are marked as such in the pack builders. Content (titles, counts,
// amounts, timestamps) is a deterministic function of the pack definition;
// minted identity ids/secrets are random by nature and are recorded in the
// pack manifest / credentials file the builder writes next to the store.
import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RoomStore } from "../../../server/store.mjs";
import { createRoomServer } from "../../../server/http.mjs";
import { createWork, claimWork, updateWork } from "../../../server/work-claims.mjs";
import { solveIdentityMintProof, IDENTITY_POW_BITS } from "../../../server/agent-identities.mjs";
import { progressEscrowEpochs } from "../../../server/bounty-epoch-keeper.mjs";

export const seedLog = (pack, message) => console.log(`[seed:${pack}] ${message}`);

export const DAY_MS = 86_400_000;
export const SEED_EPOCH_MS = Date.parse("2026-08-01T00:00:00.000Z");
export const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");

// A hand-advanced clock. The store, the escrow and every module-level
// driver read time from it, so a pack's history ages exactly as scripted.
export class SeedClock {
  constructor(startMs = SEED_EPOCH_MS) { this.t = startMs; }
  now = () => this.t;
  iso = () => new Date(this.t).toISOString();
  advance(ms) { this.t += ms; return this.t; }
}

// Deterministic prose of an exact byte length (ASCII only, so length ==
// bytes): a labelled head, then a repeating sentence bank. Used wherever a
// pack needs bulk (archive-room messages, oversized payloads).
const SENTENCES = [
  "The board carries the work the room agreed to do.",
  "Every receipt names who did the work and who checked it.",
  "A claim is a promise with a lease, a delivery, and a verdict.",
  "The keeper settles what the window leaves undisputed.",
  "Nothing here is copied from a production room.",
  "This fixture text exists so projections have honest weight.",
];
export function fillerText(label, exactBytes) {
  const head = `${label} :: `;
  if (exactBytes <= head.length) return head.slice(0, exactBytes);
  let out = head;
  let i = 0;
  while (out.length < exactBytes) {
    const sentence = SENTENCES[i % SENTENCES.length];
    i += 1;
    out += (out.endsWith(" ") ? "" : " ") + sentence;
  }
  return out.slice(0, exactBytes);
}

// Opens a store at `storeFile` under `clock` and boots the room server on
// an ephemeral localhost port. Returns the world the pack builders drive.
// `storeOptions` is forwarded to RoomStore (the corrupt pack re-opens with
// integrity deferred; builders themselves always build eager).
export async function openSeedWorld(storeFile, clock, storeOptions = {}) {
  const store = new RoomStore(storeFile, { now: clock.now, ...storeOptions });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { secret, body } = {}) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const isJson = response.headers.get("content-type")?.includes("json");
    return { status: response.status, body: isJson ? await response.json() : await response.text() };
  };
  const must = (result, what) => {
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`${what}: HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`);
    }
    return result.body;
  };
  return {
    store, server, origin, call, must, clock,
    async mint(displayName) {
      // The anonymous mint door meters a seed world exactly like a real
      // agent host: past 8 mints per address it demands a proof-of-work
      // nonce (428 proof_required), and past 8 mints inside one minute it
      // refuses with 429 rate_limited. Both windows run on the store
      // clock, so the answers are the honest ones: solve the proof with
      // the app's own solver, and step the seed clock past the minute.
      let proof;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const result = await call("POST", "/api/agent-identities", {
          body: proof ? { displayName, proof } : { displayName },
        });
        if (result.status === 428) {
          const detail = result.body?.proof ?? result.body?.error?.proof;
          proof = solveIdentityMintProof(displayName, clock.t, detail?.bits ?? IDENTITY_POW_BITS);
          continue;
        }
        if (result.status === 429 && result.body?.error?.code === "rate_limited") {
          clock.advance(61_000);
          continue;
        }
        const body = must(result, `mint ${displayName}`);
        return { identityId: body.identityId, secret: body.secret, displayName };
      }
      throw new Error(`mint ${displayName}: mint door kept refusing after 12 attempts`);
    },
    async createRoom(owner, { title, purpose }) {
      const body = must(await call("POST", "/api/agent-rooms", { secret: owner.secret, body: { title, purpose } }), `create room ${title}`);
      return body.roomId;
    },
    // Invite + redeem through the real doors: the member joins with the
    // standing profile the pack assigns to its role.
    async joinRoom(owner, roomId, member, profile) {
      const invite = must(await call("POST", `/api/rooms/${encodeURIComponent(roomId)}/agent-invites`, {
        secret: owner.secret, body: { profile, displayName: member.displayName },
      }), `invite ${member.displayName}`);
      must(await call("POST", "/api/agent-invites/redeem", {
        secret: member.secret, body: { code: invite.code, displayName: member.displayName },
      }), `redeem ${member.displayName}`);
    },
    async close() {
      server.closeStreams?.();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
      store.close();
    },
  };
}

// Posts one message through the store command path (the same write the
// HTTP door performs), stamped by the store clock.
export function postMessage(store, roomId, memberId, messageId, body) {
  const key = store.issueAccessKey(roomId, memberId);
  return store.command(key, roomId, { id: `cmd-${messageId}`, type: "message.posted", data: { body, messageId } });
}

// Posts a bulk filler message under the room flood guard's pacing
// (server/room-flood-guard.mjs: burst 30 per (room, member), refill 1 token
// per 2 s, on the store clock). A refused post spends no token and never
// lands, so advancing the seed clock past the retry window and retrying
// the same message id is exact — no duplicates, no lost posts. Any other
// refusal (size, projection cap) propagates to the caller unchanged.
export function postBulkMessage(store, clock, roomId, memberId, messageId, body) {
  for (;;) {
    try {
      return postMessage(store, roomId, memberId, messageId, body);
    } catch (error) {
      if (error?.code !== "rate_limited") throw error;
      clock.advance(Math.max(2_001, (error.retryAfterMs ?? 0) + 1));
    }
  }
}

// Enables the room's public receipts + public page and lists it in the
// directory, through the same doors the owner UI uses, so the public read
// model projects the room's receipts with room attribution.
export function publishRoom(store, roomId, ownerId) {
  const key = store.issueAccessKey(roomId, ownerId);
  store.command(key, roomId, { id: `seed-page-${roomId}`, type: "room.public_page_set", data: { enabled: true } });
  store.command(key, roomId, { id: `seed-receipts-${roomId}`, type: "room.public_receipts_set", data: { enabled: true } });
  store.roomDirectory.set(roomId, ownerId, true);
}

// ---------------------------------------------------------------- escrow --
export function postBounty(esc, clock, roomId, { poster, title, amount, decider, deadlineDays = 30 }) {
  return esc.postBounty(roomId, {
    poster, title, criteria: `Deliver ${title} to the stated standard.`, amount,
    deadline: new Date(clock.t + deadlineDays * DAY_MS).toISOString(),
    ...(decider ? { disputeDeciderId: decider } : {}),
  }).bounty;
}

export function fundClaimSubmit(esc, roomId, bountyId, { poster, worker, evidenceTag }) {
  esc.fundBounty(roomId, bountyId, { funder: poster });
  esc.claimBounty(roomId, bountyId, { claimant: worker });
  esc.submitWork(roomId, bountyId, {
    claimant: worker,
    evidence: { evidenceUrl: `https://example.invalid/evidence/${evidenceTag}`, summary: `Delivered ${evidenceTag}` },
  });
}

export function acceptBounty(esc, clock, roomId, bountyId, { poster }) {
  esc.acceptWork(roomId, bountyId, {
    acceptor: poster,
    verifierAttestation: { at: clock.iso(), note: "Meets the criteria.", citations: [{ criterionId: "c1", verdict: "pass" }] },
  });
}

// The dispute bond is exactly 25% of the bounty (#3307); pack amounts are
// chosen divisible by 4 so the bond is exact in credits.
export function disputeBounty(esc, roomId, bountyId, { challenger, amount }) {
  esc.disputeBounty(roomId, bountyId, { challenger, bond: amount / 4, grounds: "The delivery does not meet the criteria." });
}

export function decideDispute(esc, roomId, bountyId, { decider, outcome, reasonCodes }) {
  return esc.decideDispute(roomId, bountyId, { decider, outcome, reasonCodes });
}

// Two keeper passes: the first approves what the challenge window has
// released, the second pays what is approved (the keeper never rides the
// approving pass — tests/bounty-epoch-keeper.test.js).
export function keeperSettle(store, clock) {
  const esc = store.bountyEscrow;
  progressEscrowEpochs(store, { now: clock.t, escrow: esc });
  return progressEscrowEpochs(store, { now: clock.t, escrow: esc });
}

// ------------------------------------------------------------ work claims --
// Drives one board claim along `path` with the pure state machine and
// persists every resting state to the room's durable registry.
// path: unclaimed | claimed | in_progress | blocked | delivered |
//       done-self | done-verified
export function driveWorkClaim(store, clock, roomId, { id, title, creator, worker, reviewer, path, leaseHours = 24, tags }) {
  const now = clock.t;
  const policy = path === "done-verified" ? "distinct_member" : "self_attested";
  let item = createWork({ id, title, reviewPolicy: policy, acceptanceCriteria: ["criterion-1"], ...(tags ? { tags } : {}) },
    { now, agentId: creator });
  const deliver = () => {
    item = updateWork(item, worker, {
      state: "delivered", now,
      delivery: {
        artifact: { kind: "text", ref: `room://artifacts/${id}`, sha256: sha256(`artifact-${id}`) },
        checks: [{ name: "self-check", result: "pass" }],
        criteria: [{ criterion: "criterion-1", status: "met" }],
      },
    });
  };
  if (path !== "unclaimed") {
    item = claimWork(item, worker, { now, leaseHours });
    if (path === "in_progress" || path === "blocked" || path === "delivered" || path === "done-verified" || path === "done-self") {
      item = updateWork(item, worker, { state: "in_progress", now });
    }
    if (path === "blocked") item = updateWork(item, worker, { state: "blocked", note: "Waiting on an upstream decision.", now });
    if (path === "delivered" || path === "done-verified" || path === "done-self") deliver();
    if (path === "done-self") {
      item = updateWork(item, worker, { state: "done", note: "Finished.", now });
    }
    if (path === "done-verified") {
      item = updateWork(item, reviewer, { state: "done", reviewedBy: reviewer, now, authority: true });
    }
  }
  store.workClaims.set(roomId, item);
  return item;
}

// ------------------------------------------------------------ public work --
export function seedOffer(store, roomId, { ownerId, offerId, title, reviewerMemberIds, mode = "agent" }) {
  store.projectOffers.create(roomId, ownerId, {
    requestId: `seed-create-${offerId}`, offerId, reviewerMemberIds,
    terms: {
      kind: "task", title, summary: `Seeded public task: ${title}`,
      acceptanceCriteria: ["One truthful paragraph about the repository"],
      repositoryUrl: "https://example.invalid/project-room-seed",
      reward: { kind: "unpaid" }, approvalPolicy: { mode },
    },
  });
  store.projectOffers.transition(roomId, ownerId, offerId, "publish", { requestId: `seed-publish-${offerId}`, expectedRevision: 1 });
  store.publicWorkClaims.enable(roomId, ownerId, offerId, {
    requestId: `seed-enable-${offerId}`, expectedRevision: 2, expectedTermsVersion: 1,
    repositoryRef: "main", files: ["docs/SEED.md"],
  });
}

export function claimAndFinishOffer(store, offerId, { workerSecret, artifactText }) {
  const claimed = store.publicWorkClaims.act(offerId, workerSecret, "claim",
    { requestId: `seed-claim-${offerId}`, expectedTermsVersion: 1, leaseHours: 2 });
  const finished = store.publicWorkClaims.act(offerId, workerSecret, "finish", {
    requestId: `seed-finish-${offerId}`, expectedTermsVersion: 1,
    generation: claimed.task.claim.generation, artifactText, checksReported: ["proofread the paragraph"],
  });
  return { claimed, finished, receipt: finished.receipt };
}

// verdict: "PASS"|"FAIL" then decision: "accepted"|"rejected"|
// "revision_requested", bound to the receipt exactly as the doors bind it.
export function reviewOfferReceipt(store, roomId, { reviewerId, offerId, receipt, generation, verdict, decision, tag }) {
  const scope = store.publicWorkReviews.scope(roomId, reviewerId, receipt.receiptId);
  const current = store.publicWorkReviews.current(scope);
  const base = {
    expectedTermsVersion: 1, taskId: offerId, generation,
    artifactSha256: receipt.artifact.sha256, reason: `Seed review: ${tag}`,
  };
  store.publicWorkReviews.verify(roomId, reviewerId, receipt.receiptId,
    { ...base, requestId: `seed-verify-${tag}`, expectedReviewRevision: current?.revision ?? 0, verdict });
  const after = store.publicWorkReviews.current(store.publicWorkReviews.scope(roomId, reviewerId, receipt.receiptId));
  return store.publicWorkReviews.decide(roomId, reviewerId, receipt.receiptId,
    { ...base, requestId: `seed-decide-${tag}`, expectedReviewRevision: after?.revision ?? 1, decision });
}

// --------------------------------------------------------------- manifest --
// Measured contents of a built store, read back through the app's own
// surfaces (never the builder's intentions).
export function measureRoom(store, roomId) {
  const claims = store.workClaims?.list?.(roomId) ?? [];
  const claimsByState = {};
  for (const item of claims) claimsByState[item.state] = (claimsByState[item.state] ?? 0) + 1;
  const bounties = store.bountyEscrow.listBounties(roomId, {});
  const bountyRows = Array.isArray(bounties) ? bounties : (bounties.bounties ?? []);
  const bountiesByState = {};
  for (const bounty of bountyRows) bountiesByState[bounty.state] = (bountiesByState[bounty.state] ?? 0) + 1;
  const members = Object.keys(store.roomAuthority(roomId).members ?? {});
  const projectionBytes = store.db.prepare("SELECT LENGTH(projection) AS n FROM rooms WHERE id=?").get(roomId)?.n ?? 0;
  return { members: members.length, workClaims: claims.length, claimsByState, bounties: bountyRows.length, bountiesByState, projectionBytes };
}

export function writePackFiles(outDir, manifest, credentials) {
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(outDir, "credentials.json"), JSON.stringify(credentials, null, 2) + "\n");
  chmodSync(join(outDir, "credentials.json"), 0o600);
}

export function baseManifest(pack, clock, { appSha, consumers, invariants, notes }) {
  return {
    pack, packVersion: 1,
    builder: "scripts/qa-seeds/build-seed-packs.mjs",
    builtWithAppSha: appSha,
    seedEpoch: new Date(SEED_EPOCH_MS).toISOString(),
    packNow: clock.iso(),
    store: "room.sqlite",
    identities: [], rooms: [], contents: {},
    consumers, invariants, notes,
  };
}
