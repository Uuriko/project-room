// SEED-ADVERSARIAL — pre-staged hostile state for QA-J4/H1/H2, frozen as
// data: a wash-ring settlement circle, a dispute at every rung the machine
// still has, the keeper-blind bounty rows from the #4138 census, the
// #3608 offer-cap boundary, dangling evidence, a delivered claim whose
// lease died before review, and a room whose projection sits just under
// the app's 4 MiB projection guard. Everything is driven through the real doors
// first; the three keeper-blind rows are then produced by the same column
// surgery the #4138 census tests use, because the doors (correctly)
// refuse to create them.
import { join } from "node:path";
import {
  DAY_MS, SeedClock, openSeedWorld, postBulkMessage, fillerText, sha256,
  postBounty, fundClaimSubmit, acceptBounty, disputeBounty, decideDispute, keeperSettle,
  driveWorkClaim, measureRoom, writePackFiles, baseManifest, seedLog,
} from "./common.mjs";
import { createWork, claimWork, updateWork } from "../../../server/work-claims.mjs";

const ROLES = [
  { role: "owner", displayName: "Seed Adversarial Owner", profile: null },
  { role: "poster", displayName: "Seed Adversarial Poster", profile: "collaborate" },
  { role: "wash-a", displayName: "Seed Wash A", profile: "collaborate" },
  { role: "wash-b", displayName: "Seed Wash B", profile: "collaborate" },
  { role: "wash-c", displayName: "Seed Wash C", profile: "collaborate" },
  { role: "worker", displayName: "Seed Adversarial Worker", profile: "contribute" },
  { role: "verifier", displayName: "Seed Adversarial Verifier", profile: "review" },
  { role: "decider", displayName: "Seed Adversarial Decider", profile: "collaborate" },
];

const CENSUS_SQL = `SELECT bounty_id FROM bounty_records WHERE room_id=?
  AND ((state='accepted' AND challenge_ends_ms IS NULL)
    OR (state='disputed' AND (dispute_id IS NULL OR resolution_json IS NOT NULL)))
  ORDER BY bounty_id`;

export async function buildAdversarial(outDir, { appSha, bulkTargetBytes } = {}) {
  const clock = new SeedClock();
  const world = await openSeedWorld(join(outDir, "room.sqlite"), clock);
  const { store } = world;
  const esc = store.bountyEscrow;
  const identities = [];
  let manifest;
  let credentials;
  try {
    const byRole = {};
    for (const spec of ROLES) {
      const identity = await world.mint(spec.displayName);
      byRole[spec.role] = { ...identity, ...spec };
      identities.push({ role: spec.role, displayName: spec.displayName, identityId: identity.identityId });
    }
    const id = role => byRole[role].identityId;
    const arena = await world.createRoom(byRole.owner, {
      title: "Seed Adversarial — arena",
      purpose: "QA seed pack: pre-staged hostile state for dispute and hostile-user lanes.",
    });
    for (const spec of ROLES.slice(1)) await world.joinRoom(byRole.owner, arena, byRole[spec.role], spec.profile);
    esc.ensureGenesis(arena);
    const sql = (statement, ...params) => store.db.prepare(statement).run(arena, ...params);
    const bountyState = bountyId => esc.getBounty(arena, bountyId).state;

    seedLog("adversarial", "wash ring");
    // -- Wash ring: A posts/B claims, B posts/C claims, C posts/A claims,
    //    twice around; every leg settles through the keeper.
    const ring = [id("wash-a"), id("wash-b"), id("wash-c")];
    const ringBounties = [];
    for (let round = 0; round < 2; round += 1) {
      for (let leg = 0; leg < 3; leg += 1) {
        const posterLane = ring[leg];
        const workerLane = ring[(leg + 1) % 3];
        const bounty = postBounty(esc, clock, arena, {
          poster: posterLane, title: `wash-ring-${round + 1}-${leg + 1}`, amount: 8, decider: id("decider"),
        });
        fundClaimSubmit(esc, arena, bounty.bountyId, { poster: posterLane, worker: workerLane, evidenceTag: bounty.bountyId });
        acceptBounty(esc, clock, arena, bounty.bountyId, { poster: posterLane });
        ringBounties.push(bounty.bountyId);
      }
    }

    seedLog("adversarial", "dispute ladder");
    // -- Dispute ladder (poster posts, worker works): one left open, one
    //    upheld (poster refunded), one rejected (worker paid by keeper).
    const ladder = {};
    for (const [key, outcome] of [["open", null], ["upheld", "upheld"], ["rejected", "rejected"]]) {
      const bounty = postBounty(esc, clock, arena, {
        poster: id("poster"), title: `dispute-ladder-${key}`, amount: 8, decider: id("decider"),
      });
      fundClaimSubmit(esc, arena, bounty.bountyId, { poster: id("poster"), worker: id("worker"), evidenceTag: bounty.bountyId });
      acceptBounty(esc, clock, arena, bounty.bountyId, { poster: id("poster") });
      disputeBounty(esc, arena, bounty.bountyId, { challenger: id("poster"), amount: 8 });
      if (outcome) {
        decideDispute(esc, arena, bounty.bountyId, {
          decider: id("decider"), outcome,
          reasonCodes: outcome === "upheld" ? ["criterion-unmet"] : ["frivolous"],
        });
      }
      ladder[key] = bounty.bountyId;
    }

    seedLog("adversarial", "keeper-blind rows");
    // -- Keeper-blind rows (#4138 census shapes), doors first, then the
    //    census tests' column surgery.
    const blind = {};
    {
      const bounty = postBounty(esc, clock, arena, { poster: id("poster"), title: "blind-accepted-null-window", amount: 8, decider: id("decider") });
      fundClaimSubmit(esc, arena, bounty.bountyId, { poster: id("poster"), worker: id("worker"), evidenceTag: bounty.bountyId });
      acceptBounty(esc, clock, arena, bounty.bountyId, { poster: id("poster") });
      sql("UPDATE bounty_records SET challenge_ends_ms=NULL WHERE room_id=? AND bounty_id=?", bounty.bountyId);
      blind.acceptedNullWindow = bounty.bountyId;
    }
    {
      const bounty = postBounty(esc, clock, arena, { poster: id("poster"), title: "blind-disputed-null-id", amount: 8, decider: id("decider") });
      fundClaimSubmit(esc, arena, bounty.bountyId, { poster: id("poster"), worker: id("worker"), evidenceTag: bounty.bountyId });
      acceptBounty(esc, clock, arena, bounty.bountyId, { poster: id("poster") });
      disputeBounty(esc, arena, bounty.bountyId, { challenger: id("poster"), amount: 8 });
      sql("UPDATE bounty_records SET dispute_id=NULL WHERE room_id=? AND bounty_id=?", bounty.bountyId);
      blind.disputedNullId = bounty.bountyId;
    }
    {
      const bounty = postBounty(esc, clock, arena, { poster: id("poster"), title: "blind-disputed-with-resolution", amount: 8, decider: id("decider") });
      fundClaimSubmit(esc, arena, bounty.bountyId, { poster: id("poster"), worker: id("worker"), evidenceTag: bounty.bountyId });
      acceptBounty(esc, clock, arena, bounty.bountyId, { poster: id("poster") });
      disputeBounty(esc, arena, bounty.bountyId, { challenger: id("poster"), amount: 8 });
      decideDispute(esc, arena, bounty.bountyId, { decider: id("decider"), outcome: "upheld", reasonCodes: ["criterion-unmet"] });
      // The decide settled the money and wrote the resolution; the bounty
      // row is then forced back to `disputed` — a decided dispute the
      // keeper's disputed branch (which requires no resolution) skips.
      sql("UPDATE bounty_records SET state='disputed' WHERE room_id=? AND bounty_id=?", bounty.bountyId);
      blind.disputedWithResolution = bounty.bountyId;
    }

    seedLog("adversarial", "keeper settle");
    // -- One keeper settle: pays the ring and the rejected-dispute leg.
    clock.advance(4 * DAY_MS);
    keeperSettle(store, clock);

    // -- Delivered, lease dead, never reviewed (the CN-10 / S-3 shape).
    const deliveredStale = driveWorkClaim(store, clock, arena, {
      id: "delivered-past-lease", title: "Delivered before its lease died",
      creator: id("poster"), worker: id("worker"), path: "delivered", leaseHours: 1,
    });

    // -- Dangling evidence: an "attested" skill whose hash resolves
    //    nowhere (the EXP-T4 shape), plus a finished claim pointing at a
    //    blob that does not exist.
    const danglingHash = `sha256:${sha256("seed adversarial dangling evidence — resolves nowhere")}`;
    store.membersDirectory.setSkills(id("worker"), {
      publish: true,
      skills: [{
        id: "deploy-verification", name: "Deploy verification",
        description: "Attested by an evidence hash that resolves to nothing in this pack.",
        evidence: [danglingHash],
      }],
    });
    {
      let item = createWork({ id: "dangling-evidence-claim", title: "Finished against a dangling blob", reviewPolicy: "self_attested", acceptanceCriteria: ["criterion-1"] },
        { now: clock.t, agentId: id("poster") });
      item = claimWork(item, id("worker"), { now: clock.t, leaseHours: 24 });
      item = updateWork(item, id("worker"), { state: "in_progress", now: clock.t });
      item = updateWork(item, id("worker"), {
        state: "delivered", now: clock.t,
        delivery: {
          artifact: { kind: "text", ref: "room://artifacts/dangling-evidence-claim", sha256: sha256("artifact-dangling-evidence-claim") },
          checks: [{ name: "self-check", result: "pass" }], criteria: [{ criterion: "criterion-1", status: "met" }],
        },
      });
      item = updateWork(item, id("worker"), { state: "done", note: "Finished.", blobs: [danglingHash], now: clock.t });
      store.workClaims.set(arena, item);
    }

    // -- Bulk just under the app's 4 MiB projection guard
    //    (PILOT_LIMITS.projectionBytes): filler messages until the stored
    //    projection sits in [3.90 MB, 4 MiB), where writes start refusing.
    //    (Smoke builds may pass a smaller bulkTargetBytes; the manifest
    //    always records the measured projection, never the target.)
    const bulkTarget = bulkTargetBytes ?? 3_900_000;
    let bodyBytes = 48_000;
    let posted = 0;
    const projectionBytes = () => store.db.prepare("SELECT LENGTH(projection) AS n FROM rooms WHERE id=?").get(arena).n;
    while (projectionBytes() < bulkTarget) {
      try {
        postBulkMessage(store, clock, arena, id("owner"), `bulk-${posted}`, fillerText(`seed adversarial bulk ${posted}`, bodyBytes));
        posted += 1;
        if (posted % 5 === 0) seedLog("adversarial", `bulk ${posted} posts, projection ${projectionBytes()}`);
      } catch {
        bodyBytes = Math.floor(bodyBytes / 2);
        if (bodyBytes < 1_000) throw new Error("arena bulk: message bodies refused below 1 KB");
      }
    }

    // -- The delivered claim's lease dies; nothing reviews it.
    clock.advance(3 * DAY_MS);

    seedLog("adversarial", "offer-cap room");
    // -- Offer-cap room: exactly 100 project offers (the #3608 lifetime
    //    cap), then the 101st, whose refusal is recorded, not assumed.
    const capRoom = await world.createRoom(byRole.owner, {
      title: "Seed Adversarial — offer cap",
      purpose: "QA seed pack: a room at the 100-offer lifetime cap boundary.",
    });
    await world.joinRoom(byRole.owner, capRoom, byRole.poster, "collaborate");
    await world.joinRoom(byRole.owner, capRoom, byRole.verifier, "review");
    for (let i = 1; i <= 100; i += 1) {
      const offerId = `cap-offer-${String(i).padStart(3, "0")}`;
      store.projectOffers.create(capRoom, id("owner"), {
        requestId: `seed-cap-create-${i}`, offerId, reviewerMemberIds: [id("verifier")],
        terms: {
          kind: "task", title: `Cap offer ${i}`, summary: "Seeded to sit at the offer cap.",
          acceptanceCriteria: ["A truthful paragraph"], repositoryUrl: "https://example.invalid/project-room-seed",
          reward: { kind: "unpaid" }, approvalPolicy: { mode: "agent" },
        },
      });
    }
    let capAttempt;
    try {
      store.projectOffers.create(capRoom, id("owner"), {
        requestId: "seed-cap-create-101", offerId: "cap-offer-101", reviewerMemberIds: [id("verifier")],
        terms: {
          kind: "task", title: "Cap offer 101", summary: "The one past the cap.",
          acceptanceCriteria: ["A truthful paragraph"], repositoryUrl: "https://example.invalid/project-room-seed",
          reward: { kind: "unpaid" }, approvalPolicy: { mode: "agent" },
        },
      });
      capAttempt = { refused: false };
    } catch (error) {
      capAttempt = { refused: true, code: error.code ?? null, status: error.status ?? null, message: String(error.message).slice(0, 160) };
    }

    const censusRows = store.db.prepare(CENSUS_SQL).all(arena).map(row => row.bounty_id);
    const conservation = esc.verifyConservation(arena);
    manifest = baseManifest("adversarial", clock, {
      appSha,
      consumers: ["QA-J4", "QA-H1", "QA-H2"],
      invariants: [
        "the wash ring's six bounties are all paid; escrow conservation verifies on every bounty except the staged disputed-with-resolution blind row, whose single named violation is itself the fixture (contents.arena.conservationViolations)",
        "the dispute ladder rests at disputed (open), refunded (upheld), paid (rejected)",
        "the keeper census predicate counts exactly the three staged blind rows",
        "the cap room holds exactly 100 offers; the recorded 101st attempt matches the code's actual answer",
        "the arena projection is bulk-filled to just under the app's 4 MiB projection guard (shipped pack: [3.90 MB, 4 MiB); measured bytes in contents)",
      ],
      notes: [
        "The keeper-blind rows are corruption-shaped by construction (the doors refuse them); they are staged for the #4138 census and QA-H1's keeper-timing games.",
        "The dangling skill card reproduces the EXP-T4 shape: declaration \"attested\" is computed from the hash's presence, and the hash resolves nowhere in this pack.",
        "The disputed-with-resolution blind row is staged by deciding a real dispute through the doors and forcing the record back to disputed; its award has genuinely been disbursed, so the conservation checker's single violation against it is expected — it is the anomaly the #4138 census exists to catch.",
      ],
    });
    manifest.identities = identities;
    manifest.rooms = [
      { key: "arena", roomId: arena, title: "Seed Adversarial — arena" },
      { key: "cap", roomId: capRoom, title: "Seed Adversarial — offer cap" },
    ];
    manifest.contents = {
      arena: {
        ...measureRoom(store, arena),
        ringPaid: ringBounties.filter(bountyId => bountyState(bountyId) === "paid").length,
        ringBounties: ringBounties.length,
        disputeLadder: Object.fromEntries(Object.entries(ladder).map(([key, bountyId]) => [key, bountyState(bountyId)])),
        keeperBlindRows: censusRows,
        keeperBlindStaged: blind,
        conservationOk: conservation.ok === true,
        conservationViolations: conservation.violations ?? [],
        deliveredPastLease: { claimId: deliveredStale.id, state: deliveredStale.state, leaseExpiresAt: deliveredStale.leaseExpiresAt },
        danglingEvidenceHash: danglingHash,
        bulkMessages: posted, bulkBodyBytes: bodyBytes,
      },
      cap: { offers: store.db.prepare("SELECT COUNT(*) AS n FROM project_offers WHERE room_id=?").get(capRoom).n, attempt101: capAttempt },
    };
    credentials = { pack: "adversarial", identities: ROLES.map(spec => ({
      role: spec.role, identityId: byRole[spec.role].identityId, secret: byRole[spec.role].secret,
    })) };
  } finally {
    await world.close();
  }
  writePackFiles(outDir, manifest, credentials);
  return manifest;
}
