// SEED-CORRUPT — the parked corrupt room's failure shapes, reproduced
// synthetically (never copied from production data): journals intact,
// projections torn or lying. For QA-J6's operator/repair journeys and
// patrol/integrity verification.
//
// Shapes, each traced to its evidence:
//  - torn-marker: a torn projection prefix that still contains the
//    "messagesArchive" key, so patrol's snapshot read dies on SQLite
//    json_extract with a plain Error ("malformed JSON") — the production
//    room's signature (hunt-2026-10-18/patrol-diagnosis.md §1.2).
//  - torn-plain: a torn projection without the marker; the parse leg
//    throws SyntaxError instead (the #3988 test shape).
//  - hollow-drop: a parseable projection with one message silently
//    dropped — reads serve 2 of 3 messages, no error (chaos.md finding 3).
//  - hollow-empty: a parseable "{}" projection — hollow state served.
// The corruption writes below go through the store's own connection (the
// writer fence's authorised path), exactly as the diagnosis repro applied
// them; everything else in the pack is built through the real doors.
import { join } from "node:path";
import { SeedClock, openSeedWorld, postMessage, driveWorkClaim, writePackFiles, baseManifest } from "./common.mjs";

function messageList(parsed) {
  if (Array.isArray(parsed?.messages)) return parsed.messages;
  if (Array.isArray(parsed?.state?.messages)) return parsed.state.messages;
  return null;
}

export async function buildCorrupt(outDir, { appSha }) {
  const clock = new SeedClock();
  const world = await openSeedWorld(join(outDir, "room.sqlite"), clock);
  const { store } = world;
  const { initialRoom } = await import("../../../server/bootstrap.mjs");
  let manifest;
  let credentials;
  try {
    const rooms = [];
    const addRoom = (key, title) => {
      store.initialize(initialRoom(key, "owner"));
      rooms.push({ key, roomId: key, title });
      return key;
    };
    const storedProjection = roomId => store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId).projection;
    const setProjection = (roomId, text) => store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(text, roomId);
    const journalEvents = roomId => store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE room_id=?").get(roomId).n;

    // Control room: healthy, patrols clean.
    const healthy = addRoom("qa-seed-corrupt-healthy", "Seed Corrupt — healthy control");
    postMessage(store, healthy, "owner", "h1", "Healthy control message one.");
    postMessage(store, healthy, "owner", "h2", "Healthy control message two.");
    driveWorkClaim(store, clock, healthy, {
      id: "healthy-done", title: "Healthy control task", creator: "owner", worker: "owner", path: "done-self",
    });

    // Torn projection containing the archive marker (production shape).
    const tornMarker = addRoom("qa-seed-corrupt-torn-marker", "Seed Corrupt — torn projection, archive marker");
    postMessage(store, tornMarker, "owner", "a1", "First message before the tear.");
    postMessage(store, tornMarker, "owner", "a2", "Second message before the tear.");
    const realA = storedProjection(tornMarker);
    setProjection(tornMarker, realA.slice(0, 40) + ",\"messagesArchive\":{\"throughSeq\":2,\"count\":1,\"retainedIds\":[\"a1\"");

    // Torn projection without the marker.
    const tornPlain = addRoom("qa-seed-corrupt-torn-plain", "Seed Corrupt — torn projection, no marker");
    postMessage(store, tornPlain, "owner", "b1", "Only message before the tear.");
    setProjection(tornPlain, "{corrupt-projection");

    // Parseable but wrong: one of three messages silently dropped.
    const hollowDrop = addRoom("qa-seed-corrupt-hollow-drop", "Seed Corrupt — projection drops a message");
    postMessage(store, hollowDrop, "owner", "c1", "Kept message one.");
    postMessage(store, hollowDrop, "owner", "c2", "The message the projection drops.");
    postMessage(store, hollowDrop, "owner", "c3", "Kept message three.");
    const parsed = JSON.parse(storedProjection(hollowDrop));
    const list = messageList(parsed);
    if (!list || list.length !== 3) throw new Error("hollow-drop: projection message list not found in the expected shape");
    list.splice(1, 1);
    setProjection(hollowDrop, JSON.stringify(parsed));

    // Parseable but empty.
    const hollowEmpty = addRoom("qa-seed-corrupt-hollow-empty", "Seed Corrupt — empty projection");
    postMessage(store, hollowEmpty, "owner", "d1", "A message the empty projection forgets.");
    setProjection(hollowEmpty, "{}");

    const shape = (roomId, kind, source, expectedPatrolErrorClass) => ({
      roomId, shape: kind, source, expectedPatrolErrorClass,
      journalEvents: journalEvents(roomId),
      storedProjectionBytes: storedProjection(roomId).length,
    });
    manifest = baseManifest("corrupt", clock, {
      appSha,
      consumers: ["QA-J6", "patrol/integrity verification"],
      invariants: [
        "the store opens with integrity deferred; patrol parks torn-marker with errorClass \"Error\" and torn-plain with \"SyntaxError\"",
        "hollow-drop serves 2 of its 3 journaled messages with no error; hollow-empty serves hollow state",
        "the healthy control room patrols clean and its journal is intact in every room",
        "an eager (default) open of this store at the build head throws on the torn rooms — chaos.md finding 2; the manifest records this, lanes boot deferred",
      ],
      notes: [
        "Boot mode matters: open with { integrity: \"deferred\" } (the operator/repair posture). Eager boot behaviour is version-coupled to the #4126 quarantine fix and is recorded, not assumed.",
        "All corruption is synthetic: journals were written through the real command path, then only the stored projection bytes were altered.",
      ],
    });
    manifest.identities = [{ role: "owner", displayName: "room owner (store-level member)", identityId: "owner" }];
    manifest.rooms = rooms;
    manifest.contents = {
      healthy: shape(healthy, "healthy", "control room", null),
      tornMarker: shape(tornMarker, "torn-projection-with-archive-marker", "patrol-diagnosis.md §1.2 (production signature)", "Error"),
      tornPlain: shape(tornPlain, "torn-projection-no-marker", "#3988 test shape", "SyntaxError"),
      hollowDrop: shape(hollowDrop, "parseable-projection-message-dropped", "chaos.md finding 3", null),
      hollowEmpty: shape(hollowEmpty, "parseable-empty-projection", "chaos.md finding 3", null),
    };
    credentials = { pack: "corrupt", identities: [], note: "Store-level rooms; the owner member id is \"owner\" — issue access keys with store.issueAccessKey(roomId, \"owner\")." };
  } finally {
    await world.close();
  }
  writePackFiles(outDir, manifest, credentials);
  return manifest;
}
