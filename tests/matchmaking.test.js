import test from "node:test";
import assert from "node:assert/strict";
import { matchListings, listingFitsMotive, scoreListing, listingFromPublicTask, matchPublicTasks } from "../client/matchmaking.mjs";
import { parseMatchArgs, matchFromFiles, matchPacketsFromFiles, main } from "../scripts/matchmaking.mjs";

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
    seeker: "s.json", listings: "l.json", tasks: null
  });
  const hits = matchFromFiles(
    JSON.stringify({ motive: "hobby", tags: ["docs"] }),
    JSON.stringify([hobby, cash])
  );
  assert.deepEqual(hits.map(h => h.listing.id), ["h1"]);
});

test("packet reward kinds map to motives", () => {
  const base = { schema: "public-work-task/1", taskId: "t", title: "Task", claim: { state: "unclaimed" } };
  assert.equal(listingFromPublicTask({ ...base, reward: { kind: "cash" } }).motive, "cash");
  assert.equal(listingFromPublicTask({ ...base, reward: { kind: "work_trade" } }).motive, "credits");
  assert.equal(listingFromPublicTask({ ...base, reward: { kind: "unpaid" } }).motive, "hobby");
  assert.equal(listingFromPublicTask({ ...base }).motive, "hobby");
});

test("packet mapping carries namespace as room and first file segments as tags", () => {
  const listing = listingFromPublicTask({
    schema: "public-work-task/1",
    taskId: "t2",
    namespaceId: "commons",
    title: "Tagged",
    files: ["Src/App.js", "src/util.js", "docs/guide.md", "", 42],
    reward: { kind: "unpaid" },
    claim: { state: "unclaimed" }
  });
  assert.equal(listing.roomId, "commons");
  assert.deepEqual(listing.tags, ["src", "docs"]);
  const noRoom = listingFromPublicTask({
    schema: "public-work-task/1", taskId: "t3", title: "No room", claim: { state: "unclaimed" }
  });
  assert.equal(noRoom.roomId, null);
  assert.deepEqual(noRoom.tags, []);
});

test("packet titles truncate to the listing cap and fall back to the task id", () => {
  const long = listingFromPublicTask({
    schema: "public-work-task/1", taskId: "t4", title: "x".repeat(250), claim: { state: "unclaimed" }
  });
  assert.equal(long.title.length, 200);
  const blank = listingFromPublicTask({
    schema: "public-work-task/1", taskId: "t5", title: "", claim: { state: "unclaimed" }
  });
  assert.equal(blank.title, "t5");
});

test("packets without an unclaimed state drop out", () => {
  const base = { schema: "public-work-task/1", taskId: "t", title: "Task" };
  assert.equal(listingFromPublicTask({ ...base, claim: { state: "claimed" } }), null);
  assert.equal(listingFromPublicTask({ ...base, claim: { state: "released" } }), null);
  assert.equal(listingFromPublicTask({ ...base }), null);
  assert.equal(listingFromPublicTask({ ...base, claim: null }), null);
});

test("malformed packets fail closed", () => {
  assert.throws(() => listingFromPublicTask(null), /invalid_match_input/);
  assert.throws(() => listingFromPublicTask({ schema: "other/1", taskId: "t", title: "T" }), /invalid_match_input/);
  assert.throws(() => listingFromPublicTask({ schema: "public-work-task/1", title: "T" }), /invalid_match_input/);
  assert.throws(() => listingFromPublicTask({ schema: "public-work-task/1", taskId: "t", title: 7 }), /invalid_match_input/);
  assert.throws(() => matchPublicTasks({ motive: "hobby", tags: [] }, "nope"), /invalid_match_input/);
});

test("matchPublicTasks gates on motive and never invents a claim", () => {
  const paid = {
    schema: "public-work-task/1", taskId: "paid-1", title: "Paid fix",
    files: ["server/fix.js"], reward: { kind: "cash" }, claim: { state: "unclaimed" }
  };
  const free = {
    schema: "public-work-task/1", taskId: "free-1", title: "Free fix",
    files: ["server/free.js"], reward: { kind: "unpaid" }, claim: { state: "unclaimed" }
  };
  assert.deepEqual(matchPublicTasks({ motive: "hobby", tags: ["server"] }, [paid, free]).map(h => h.listing.id), ["free-1"]);
  const cashHits = matchPublicTasks({ motive: "cash", tags: ["server"] }, [paid, free]);
  assert.deepEqual(cashHits.map(h => h.listing.id), ["paid-1"]);
  assert.equal("claimedBy" in cashHits[0], false);
  assert.equal(cashHits[0].listing.kind, "claim");
});

test("CLI tasks mode ranks packets from files", async () => {
  assert.deepEqual(parseMatchArgs(["node", "x", "--seeker", "s.json", "--tasks", "t.json"]), {
    seeker: "s.json", listings: null, tasks: "t.json"
  });
  assert.equal(parseMatchArgs(["node", "x", "--seeker", "s.json"]), null);
  assert.equal(parseMatchArgs(["node", "x", "--seeker", "s.json", "--listings", "l.json", "--tasks", "t.json"]), null);
  const packet = {
    schema: "public-work-task/1", taskId: "first-task", namespaceId: "commons",
    title: "Public result", files: ["src/shared.js"],
    reward: { kind: "unpaid" }, claim: { state: "unclaimed" }
  };
  const hits = matchPacketsFromFiles(
    JSON.stringify({ motive: "hobby", tags: ["src"] }),
    JSON.stringify([packet])
  );
  assert.deepEqual(hits.map(h => h.listing.id), ["first-task"]);
  assert.throws(() => matchPacketsFromFiles("{}", "{}"), /tasks must be a JSON array/);
  const logged = [];
  await main(["node", "x", "--seeker", "s.json", "--tasks", "t.json"], {
    read: (path) => path === "s.json"
      ? JSON.stringify({ motive: "hobby", tags: ["src"] })
      : JSON.stringify([packet]),
    log: (line) => logged.push(line),
    error: (line) => { throw new Error(`unexpected CLI error: ${line}`); }
  });
  assert.deepEqual(JSON.parse(logged[0]).map(h => h.listing.id), ["first-task"]);
});
