// SEED-CLEAN — a fresh room at genesis: the standard identity set as
// members, the escrow endowed, nothing posted, claimed, or settled. The
// from-nothing start every guided journey assumes (QA-J1/J2/J3, X1, C1).
import { join } from "node:path";
import { SeedClock, openSeedWorld, measureRoom, writePackFiles, baseManifest } from "./common.mjs";

export const CLEAN_ROLES = [
  { role: "owner", displayName: "Seed Clean Owner", profile: null },
  { role: "poster", displayName: "Seed Clean Poster", profile: "collaborate" },
  { role: "worker", displayName: "Seed Clean Worker", profile: "contribute" },
  { role: "verifier", displayName: "Seed Clean Verifier", profile: "review" },
];

export async function buildClean(outDir, { appSha }) {
  const clock = new SeedClock();
  const world = await openSeedWorld(join(outDir, "room.sqlite"), clock);
  const identities = [];
  let manifest;
  let credentials;
  try {
    const byRole = {};
    for (const spec of CLEAN_ROLES) {
      const identity = await world.mint(spec.displayName);
      byRole[spec.role] = { ...identity, ...spec };
      identities.push({ role: spec.role, displayName: spec.displayName, identityId: identity.identityId });
    }
    const roomId = await world.createRoom(byRole.owner, {
      title: "Seed Clean — fresh room",
      purpose: "QA seed pack: a fresh room at genesis for session-one journeys.",
    });
    for (const spec of CLEAN_ROLES.slice(1)) {
      await world.joinRoom(byRole.owner, roomId, byRole[spec.role], spec.profile);
    }
    world.store.bountyEscrow.ensureGenesis(roomId);
    const balances = {};
    for (const spec of CLEAN_ROLES) {
      balances[spec.role] = world.store.bountyEscrow.balances(roomId, byRole[spec.role].identityId).payable;
    }
    manifest = baseManifest("clean", clock, {
      appSha,
      consumers: ["QA-J1", "QA-J2", "QA-J3", "QA-X1", "QA-C1"],
      invariants: [
        "server boots on the pack store; the room reads back with 4 members",
        "every member lane holds exactly the 100-credit genesis endowment, nothing locked or attributed",
        "no bounties, no public offers, no public receipts; the only work claim is the room's starter claim",
      ],
      notes: ["Room creation itself records one starter claim (product behaviour); it is counted in contents."],
    });
    manifest.identities = identities;
    manifest.rooms = [{ key: "clean", roomId, title: "Seed Clean — fresh room" }];
    manifest.contents = { clean: { ...measureRoom(world.store, roomId), balances } };
    credentials = { pack: "clean", identities: CLEAN_ROLES.map(spec => ({
      role: spec.role, identityId: byRole[spec.role].identityId, secret: byRole[spec.role].secret,
    })) };
  } finally {
    await world.close();
  }
  writePackFiles(outDir, manifest, credentials);
  return manifest;
}
