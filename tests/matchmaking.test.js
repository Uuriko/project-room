import test from "node:test";
import assert from "node:assert/strict";
import { matchListings, listingFitsMotive, scoreListing, listingFromPublicTask, matchPublicTasks } from "../client/matchmaking.mjs";
import { parseMatchArgs, matchFromFiles } from "../scripts/matchmaking.mjs";

const hobby = { id: "h1", kind: "offer", motive: "hobby", title: "Open source docs", tags: ["docs"], open: true, roomId: "den" };
const credits = { id: "c1", kind: "bounty", motive: "credits", title: "Fix mention wake", tags: ["wake", "tests"], open: true };
const cash = { id: "m1", kind: "claim", motive: "cash", title: "Paid landing page", tags: ["web"], open: true };
const closed = { id: "x1", kind: "offer", motive: "hobby", title: "Gone", tags: ["docs"], open: false };

test("hobby seeker never receives cash listings", () => {
  const hits = matchListings({ motive: "hobby", tags: ["web"] }, [hobby, cash]);
  assert.deepEqual(hits.map(h => h.listing.id), ["h1"]);
  assert.equal(listingFitsMotive("hobby", "cash"), false);
});

test("credits seeker matches tagged bounty above untagged hobby", () => {
  const hits = matchListings({ motive: "any", tags: ["wake"] }, [hobby, credits, cash]);
  assert.equal(hits[0].listing.id, "c1");
  assert.ok(hits[0].reasons.includes("tag:wake"));
});

test("closed listings are skipped", () => {
  assert.equal(matchListings({ motive: "hobby", tags: ["docs"] }, [closed, hobby]).length, 1);
});

test("match does not invent a claim", () => {
  const hits = matchListings({ motive: "credits", tags: ["wake"] }, [credits]);
  assert.equal(hits[0].listing.id, "c1");
  assert.equal(hits[0].listing.kind, "bounty");
  assert.equal("claimedBy" in hits[0], false);
});

test("invalid seekers fail closed", () => {
  assert.throws(() => matchListings({ motive: "fame", tags: [] }, []), /invalid_match_input/);
  assert.throws(() => scoreListing({ motive: "hobby", tags: [] }, { id: "z" }), /invalid_match_input/);
});

test("public-work-task packets become listings only while unclaimed", () => {
  const packet = {
    schema: "public-work-task/1",
    taskId: "first-task",
    namespaceId: "commons",
    title: "Public result",
    files: ["src/shared.js"],
    reward: { kind: "unpaid" },
    claim: { state: "unclaimed" }
  };
  const listing = listingFromPublicTask(packet);
  assert.equal(listing.id, "first-task");
  assert.equal(listing.kind, "claim");
  assert.equal(listing.motive, "hobby");
  assert.ok(listing.tags.includes("src"));
  assert.equal(listingFromPublicTask({ ...packet, claim: { state: "claimed" } }), null);
  const hits = matchPublicTasks({ motive: "hobby", tags: ["src"] }, [packet]);
  assert.equal(hits[0].listing.id, "first-task");
});

test("CLI files rank the same as matchListings", () => {
  assert.deepEqual(parseMatchArgs(["node", "x", "--seeker", "s.json", "--listings", "l.json"]), {
    seeker: "s.json", listings: "l.json"
  });
  const hits = matchFromFiles(
    JSON.stringify({ motive: "hobby", tags: ["docs"] }),
    JSON.stringify([hobby, cash])
  );
  assert.deepEqual(hits.map(h => h.listing.id), ["h1"]);
});
