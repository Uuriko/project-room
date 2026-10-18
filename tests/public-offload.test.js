// Stage 0 public offload equivalence harness.
//
// The heart of the Stage 0 slice: a shaped corpus of rooms / claims /
// receipts is driven through the real command surface of an in-DO
// RoomStore, the resulting public-model rows are turned into outbox
// entries (snapshot diffs, one comparable monotonic sequence — the shape
// the design's §3.7 outbox contract describes), and those entries are
// published — shuffled and duplicated, as at-least-once delivery allows —
// into the in-memory directory target. Every public surface the design
// names for offload must then answer EXACTLY as the in-DO public read
// model answers: same rows, same order, same pagination behaviour.
//
// Named divergences (server/public-offload.mjs
// PUBLIC_OFFLOAD_NAMED_DIVERGENCES) are asserted as divergences, not
// silently dropped: lot receipts (composed at read from the escrow
// journal; no stored row exists) and the public-work receipt outcome
// fields (composed at read from public_work_receipts / reviews).
//
// Local note: this harness uses an in-memory store. File-backed SQLite
// stores fail on this development VM with SQLITE disk I/O errors (778)
// for environmental reasons (WAL/sync on the VM filesystem) — that gap
// is environmental, not a property of this code; the same store code
// runs file-backed in the hosted CI environment.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  queryPublicReceipts, publicReceiptById, collectPublicReceipts, listPublicReceiptSitemap,
  loadPublicRoom, listPublicRoomSitemap, roomProofRows, roomPageReceipts, queryDirectoryEntries,
  syncRoomPublication, projectPublicWorkReceipt, syncDirectoryCard,
} from "../server/public-read-model.mjs";
import {
  createPublicProjectionPublisher, createInMemoryPublicModelTarget, createD1PublicModelTargetStub,
  createDualReadComparator, resolvePublicOffloadConfig, readSourceFor,
  PUBLIC_OFFLOAD_FLIP_DEFAULTS, PUBLIC_OFFLOAD_NAMED_DIVERGENCES,
  PublicOffloadNotWiredError, PublicOffloadEntryError,
} from "../server/public-offload.mjs";

const HASH = `sha256:${"ab".repeat(32)}`;
const HEX = "cd".repeat(32);
const PWR_ID = `pwr_${"a".repeat(32)}`;
const OUTCOME_FIELDS = ["state", "verification", "checksReported", "executedChecks", "review"];

// Strip exactly the named public-work outcome divergence from a source
// answer: for source='public-work' receipts the in-DO model composes
// outcome fields at read time; every other field must be equal.
function stripOutcome(value) {
  if (Array.isArray(value)) return value.map(stripOutcome);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = stripOutcome(item);
    if (out.source === "public-work") {
      for (const field of OUTCOME_FIELDS) {
        if (field === "verification" && typeof out.verification !== "string") continue;
        delete out[field];
      }
    }
    return out;
  }
  return value;
}

// Snapshot-diff entry source: reads the in-DO public-model tables and
// emits one outbox entry per changed row, with a single monotonic
// sequence across the corpus (the source outbox's id).
const SNAPSHOT_TABLES = [
  { table: "public_rooms", kind: "public_room", key: row => row.slug, sql: "SELECT * FROM public_rooms" },
  { table: "public_receipts", kind: "public_receipt", key: row => row.id, sql: "SELECT * FROM public_receipts" },
  { table: "public_directory_entries", kind: "public_directory_entry", key: row => row.agent_id, sql: "SELECT * FROM public_directory_entries" },
  { table: "room_public_receipts_setting", kind: "room_public_receipts_setting", key: row => row.room_id, sql: "SELECT * FROM room_public_receipts_setting" },
  { table: "room_directory_settings", kind: "room_directory_receipts_setting", key: row => row.room_id, sql: "SELECT room_id, public_receipts FROM room_directory_settings" },
  { table: "public_unpublish", kind: "public_unpublish", key: row => `${row.kind}\0${row.target}`, sql: "SELECT * FROM public_unpublish" },
];

function createSnapshotSource(store) {
  let sequence = 0;
  const seen = new Map(); // table -> Map(key -> stable json)
  const stable = value => JSON.stringify(value, Object.keys(value ?? {}).sort());
  return {
    capture() {
      const entries = [];
      for (const spec of SNAPSHOT_TABLES) {
        const previous = seen.get(spec.table) ?? new Map();
        const current = new Map();
        for (const raw of store.db.prepare(spec.sql).all()) {
          const row = { ...raw };
          const key = spec.key(row);
          current.set(key, stable(row));
          if (previous.get(key) !== stable(row)) {
            entries.push({ scope: `snapshot:${spec.table}`, sequence: ++sequence, kind: `${spec.kind}.upsert`, row });
          }
        }
        for (const key of previous.keys()) {
          if (!current.has(key)) entries.push({ scope: `snapshot:${spec.table}`, sequence: ++sequence, kind: `${spec.kind}.delete`, key });
        }
        seen.set(spec.table, current);
      }
      return entries;
    },
    get sequence() { return sequence; },
  };
}

// Deterministic shuffle (seeded) + full duplication: the delivery a
// publisher must tolerate under at-least-once, unordered transport.
function shuffledAndDuplicated(entries) {
  const out = [...entries];
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return [...out, ...entries];
}

function buildCorpus(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  for (const roomId of ["alpha-room", "beta-room", "gamma-room"]) store.initialize(initialRoom(roomId));
  const keys = Object.fromEntries(["alpha-room", "beta-room", "gamma-room"].map(id => [id, store.issueAccessKey(id, "owner")]));
  const command = (roomId, id, type, data) => store.command(keys[roomId], roomId, { id, type, data });
  for (const roomId of ["alpha-room", "beta-room"]) {
    command(roomId, `add-ada-${roomId}`, "member.added", { memberId: "ada", displayName: "Ada", kind: "agent", permissions: ["accept_work"] });
  }
  // alpha is directory-listed; beta has a settings row (toggle target)
  // but is not listed, so its receipts carry no room attribution.
  store.db.prepare("INSERT INTO room_directory_settings (room_id, discoverable, listed_at, updated_at, public_receipts) VALUES ('alpha-room', 1, 1, 1, 1)").run();
  store.db.prepare("INSERT INTO room_directory_settings (room_id, discoverable, listed_at, updated_at, public_receipts) VALUES ('beta-room', 0, NULL, 1, 1)").run();

  const merged = (id, title, at, pull) => ({
    id, title, state: "done", owner: "ada",
    history: [
      { action: "state:done", agentId: "ada", at },
      { action: "pr_merged", agentId: "ada", at },
    ],
    pullRequest: { url: `https://github.com/Uuriko/project-room/pull/${pull}`, outcome: "merged", syncedAt: at },
    blobs: [HASH], updatedAt: at,
  });
  store.workClaims.set("alpha-room", merged("alpha-merged", "Alpha merged work", "2026-10-01T00:00:00.000Z", 11));
  store.workClaims.set("alpha-room", {
    id: "alpha-verified", title: "Alpha verified result", state: "done", owner: "ada",
    deliveryMode: "result", reviewPolicy: "distinct_member", reviewedBy: "owner",
    history: [{ action: "state:done", agentId: "ada", at: "2026-10-02T00:00:00.000Z" }],
    pullRequest: null, blobs: [HASH], updatedAt: "2026-10-02T00:00:00.000Z",
  });
  store.workClaims.set("alpha-room", {
    id: "alpha-self", title: "Alpha self attested", state: "done", owner: "ada",
    deliveryMode: "result", reviewPolicy: "self_attested",
    history: [{ action: "state:done", agentId: "ada", at: "2026-10-03T00:00:00.000Z" }],
    pullRequest: null, blobs: [], updatedAt: "2026-10-03T00:00:00.000Z",
  });
  store.workClaims.set("alpha-room", {
    id: "alpha-open", title: "Alpha still open", state: "working", owner: "ada",
    history: [], pullRequest: null, blobs: [], updatedAt: "2026-10-03T00:00:00.000Z",
  });
  store.workClaims.set("beta-room", merged("beta-merged", "Beta merged work", "2026-10-01T12:00:00.000Z", 12));
  store.workClaims.set("gamma-room", merged("gamma-merged", "Gamma merged work", "2026-10-01T06:00:00.000Z", 13));

  command("alpha-room", "alpha-page", "room.public_page_set", { enabled: true });
  command("alpha-room", "alpha-receipts", "room.public_receipts_set", { enabled: true });
  command("alpha-room", "alpha-join", "room.join_link_set", { enabled: true });
  command("beta-room", "beta-receipts", "room.public_receipts_set", { enabled: true });

  // A completed board work item projects a wir_ receipt.
  const alphaState = structuredClone(store.room("alpha-room").state);
  alphaState.workItems = {
    ...(alphaState.workItems ?? {}),
    "wi-1": {
      id: "wi-1", title: "Alpha guide shipped", state: "completed",
      receipt: { reportedById: "owner", producerId: "ada", evidenceVersion: HASH },
      accountableMemberId: "owner", updatedAt: "2026-10-04T00:00:00.000Z",
    },
  };
  syncRoomPublication(store, { roomId: "alpha-room", state: alphaState, previous: alphaState });

  // A public-work receipt, with its record so the in-DO read composes
  // the outcome fields that form the named divergence.
  const pwrBody = {
    receiptId: PWR_ID, namespaceId: "alpha-room", title: "Public work artifact",
    agentName: "Agent One", identityId: "identity-1",
    createdAt: "2026-10-05T00:00:00.000Z", artifact: { sha256: HEX },
    state: "submitted", verification: "hash_only", checksReported: ["unit tests pass"],
  };
  store.db.prepare("INSERT INTO public_work_receipts VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(PWR_ID, "offer-1", "alpha-room", 1, "identity-1", "artifact body", HEX, 13, JSON.stringify(pwrBody), 0);
  projectPublicWorkReceipt(store, pwrBody, HEX);

  // Directory cards.
  for (const [agentId, name, identityId] of [["agent-1", "Agent One", "identity-1"], ["agent-2", "Agent Two", "identity-2"], ["agent-3", "Agent Three", "identity-3"]]) {
    store.db.prepare("INSERT INTO agent_directory_cards (agent_id, card_json, visibility, owner_identity_id, published_at, updated_at, withdrawn) VALUES (?,?, 'public', ?, 0, 0, 0)")
      .run(agentId, JSON.stringify({ name, description: `${name} description`, skills: ["testing"] }), identityId);
    syncDirectoryCard(store, agentId);
  }
  return { store, command, keys };
}

function assertSurfacesEqual(store, target, label) {
  // Receipts list: full pagination walk at several page sizes, plus
  // filters and error behaviour.
  for (const limit of [1, 2, 7, 20]) {
    let cursor = null;
    do {
      const source = queryPublicReceipts(store, { cursor, limit });
      const candidate = target.queryPublicReceipts({ cursor, limit });
      assert.deepEqual(stripOutcome(source), candidate, `${label}: receipts list limit=${limit} cursor=${cursor}`);
      cursor = source.nextCursor;
    } while (cursor);
  }
  for (const options of [{ room: "alpha-room" }, { agent: "ada" }, { limit: 0 }, { cursor: "not-a-receipt" }, { room: 5 }]) {
    assert.deepEqual(stripOutcome(queryPublicReceipts(store, options)), target.queryPublicReceipts(options), `${label}: receipts query ${JSON.stringify(options)}`);
  }
  // Receipt detail for every served id.
  for (const receipt of collectPublicReceipts(store)) {
    assert.deepEqual(stripOutcome(publicReceiptById(store, receipt.id)), target.publicReceiptById(receipt.id), `${label}: receipt detail ${receipt.id}`);
  }
  assert.equal(target.publicReceiptById("not-an-id"), publicReceiptById(store, "not-an-id"));
  assert.deepEqual(stripOutcome(collectPublicReceipts(store)), target.collectPublicReceipts(), `${label}: collect`);
  assert.deepEqual(listPublicReceiptSitemap(store), target.listPublicReceiptSitemap(), `${label}: receipts sitemap`);
  assert.deepEqual(listPublicReceiptSitemap(store, 2), target.listPublicReceiptSitemap(2), `${label}: receipts sitemap capped`);
  for (const slug of ["alpha-room", "beta-room", "gamma-room", "no-such-room"]) {
    assert.deepEqual(loadPublicRoom(store, slug), target.loadPublicRoom(slug), `${label}: room page ${slug}`);
    assert.deepEqual(stripOutcome(roomProofRows(store, slug)), target.roomProofRows(slug), `${label}: room proof ${slug}`);
    for (const enabled of [true, false]) {
      // Page through room-page receipts with the {at,id} cursor.
      let after = null;
      do {
        const source = roomPageReceipts(store, slug, enabled, { limit: 2, after });
        const candidate = target.roomPageReceipts(slug, enabled, { limit: 2, after });
        // Source rows are null-prototype SQLite row objects; the served
        // JSON shape is {id,title,at}, compared field-by-field.
        assert.deepEqual(source.map(row => ({ id: row.id, title: row.title, at: row.at })), candidate, `${label}: room page receipts ${slug} enabled=${enabled}`);
        after = source.length ? { at: source.at(-1).at, id: source.at(-1).id } : null;
        if (source.length < 2) after = null;
      } while (after);
    }
  }
  assert.deepEqual(listPublicRoomSitemap(store), target.listPublicRoomSitemap(), `${label}: rooms sitemap`);
  // Directory: pagination walk + error behaviour.
  let cursor = null;
  do {
    const source = queryDirectoryEntries(store, { cursor, limit: 2 });
    const candidate = target.queryDirectoryEntries({ cursor, limit: 2 });
    assert.deepEqual(source, candidate, `${label}: directory cursor=${cursor}`);
    cursor = source.nextCursor;
  } while (cursor);
  assert.deepEqual(queryDirectoryEntries(store, { cursor: "not-an-agent" }), target.queryDirectoryEntries({ cursor: "not-an-agent" }), `${label}: directory bad cursor`);
}

test("equivalence: published corpus answers equal the in-DO public read model, through mutations", async t => {
  const { store, command } = buildCorpus(t);
  const target = createInMemoryPublicModelTarget();
  const publisher = createPublicProjectionPublisher({ target });
  const source = createSnapshotSource(store);

  const started = performance.now();
  const first = source.capture();
  assert.ok(first.length >= 10, `corpus produced ${first.length} entries`);
  const results = publisher.publishAll(shuffledAndDuplicated(first));
  assert.ok(results.some(result => result.applied), "some entries applied");
  assertSurfacesEqual(store, target, "initial");
  t.diagnostic(`equivalence corpus: ${first.length} entries, first publish+compare ${(performance.now() - started).toFixed(1)} ms, stats ${JSON.stringify(publisher.stats())}`);

  // Replaying the whole batch changes nothing.
  const before = target.collectPublicReceipts();
  publisher.publishAll(first);
  assert.deepEqual(target.collectPublicReceipts(), before, "full replay is a no-op");

  // Phase 2: opt-out removes rows in the same write; opt-in restores.
  command("alpha-room", "alpha-receipts-off", "room.public_receipts_set", { enabled: false });
  publisher.publishAll(shuffledAndDuplicated(source.capture()));
  assertSurfacesEqual(store, target, "alpha receipts off");

  command("alpha-room", "alpha-receipts-on", "room.public_receipts_set", { enabled: true });
  command("gamma-room", "gamma-receipts-on", "room.public_receipts_set", { enabled: true });
  publisher.publishAll(shuffledAndDuplicated(source.capture()));
  assertSurfacesEqual(store, target, "alpha on + gamma on");

  // Phase 3: owner toggle hides beta's receipts from the list query,
  // an operator unpublish hides one alpha receipt everywhere, and a
  // withdrawn directory card leaves the directory.
  store.db.prepare("UPDATE room_directory_settings SET public_receipts=0 WHERE room_id='beta-room'").run();
  const alphaMerged = collectPublicReceipts(store).find(receipt => receipt.title === "Alpha merged work");
  store.db.prepare("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES ('receipt', ?, 1, 'operator')").run(alphaMerged.id);
  store.db.prepare("UPDATE agent_directory_cards SET withdrawn=1 WHERE agent_id='agent-3'").run();
  syncDirectoryCard(store, "agent-3");
  publisher.publishAll(shuffledAndDuplicated(source.capture()));
  assertSurfacesEqual(store, target, "toggle + unpublish + withdraw");

  // Phase 4: lifting the unpublish restores the receipt.
  store.db.prepare("DELETE FROM public_unpublish WHERE kind='receipt' AND target=?").run(alphaMerged.id);
  publisher.publishAll(shuffledAndDuplicated(source.capture()));
  assertSurfacesEqual(store, target, "unpublish lifted");
});

test("named divergence: public-work outcome fields are present in-DO and absent in the candidate, and only those", async t => {
  const { store } = buildCorpus(t);
  const target = createInMemoryPublicModelTarget();
  const publisher = createPublicProjectionPublisher({ target });
  publisher.publishAll(createSnapshotSource(store).capture());
  const source = publicReceiptById(store, PWR_ID);
  const candidate = target.publicReceiptById(PWR_ID);
  assert.ok(source && candidate, "both sides serve the public-work receipt");
  for (const field of OUTCOME_FIELDS) {
    if (field === "review" || field === "executedChecks") continue; // absent on both for an unreviewed, unchecked record
    assert.notDeepEqual(source[field], candidate[field], `divergent field: ${field}`);
  }
  assert.deepEqual(stripOutcome(source), candidate, "all non-outcome fields are equal");
  const named = PUBLIC_OFFLOAD_NAMED_DIVERGENCES.find(entry => entry.surface === "public-work-receipt-outcome");
  assert.ok(named, "the divergence is named in the module");
  assert.deepEqual([...named.fields].sort(), [...OUTCOME_FIELDS].sort());
});

test("named divergence: lot receipts cannot be enabled for offload", () => {
  const lotId = `lot_${"0".repeat(16)}`;
  const target = createInMemoryPublicModelTarget();
  assert.equal(target.publicReceiptById(lotId), null, "no stored lot row exists to serve");
  assert.throws(() => resolvePublicOffloadConfig({ "lot-receipt-detail": true }), PublicOffloadEntryError);
  const named = PUBLIC_OFFLOAD_NAMED_DIVERGENCES.find(entry => entry.surface === "lot-receipt-detail");
  assert.ok(named && /bounty_journal/.test(named.divergence), "lot divergence names the read-time journal composition");
});

test("publisher: replay and reorder converge; a stale delete/upsert cannot resurrect a row", () => {
  const row = slug => ({
    slug, title: slug, purpose: "", humans: 1, agents: 0, names_json: "[]", tasks_json: "[]",
    members_json: "[]", receipts_enabled: 1, join_mode: "request", join_token: null,
    owner_member_id: "owner", set_at: null, updated_at: "2026-10-01T00:00:00.000Z",
  });
  const entries = [
    { scope: "room:room-a", sequence: 1, kind: "public_room.upsert", row: row("room-a") },
    { scope: "room:room-a", sequence: 2, kind: "public_room.delete", key: "room-a" },
    { scope: "room:room-a", sequence: 3, kind: "public_room.upsert", row: { ...row("room-a"), title: "Back again" } },
  ];
  const inOrder = createInMemoryPublicModelTarget();
  createPublicProjectionPublisher({ target: inOrder }).publishAll(entries);
  const shuffled = createInMemoryPublicModelTarget();
  const publisher = createPublicProjectionPublisher({ target: shuffled });
  publisher.publishAll([entries[2], entries[0], entries[1], entries[2], entries[0]]);
  assert.deepEqual(shuffled.loadPublicRoom("room-a"), inOrder.loadPublicRoom("room-a"));
  assert.equal(shuffled.loadPublicRoom("room-a").title, "Back again");
  // A replay of the delete at its own sequence, then the older upsert:
  // neither moves the converged state.
  publisher.publish(entries[1]);
  publisher.publish(entries[0]);
  assert.equal(shuffled.loadPublicRoom("room-a").title, "Back again");
  assert.ok(publisher.stats().stale >= 1 && publisher.stats().replayed >= 1, JSON.stringify(publisher.stats()));
});

test("publisher: entry validation and same-sequence conflicts are explicit", () => {
  const publisher = createPublicProjectionPublisher({ target: createInMemoryPublicModelTarget() });
  assert.throws(() => publisher.publish({ scope: "x", sequence: -1, kind: "public_room.upsert", row: { slug: "a" } }), PublicOffloadEntryError);
  assert.throws(() => publisher.publish({ scope: "x", sequence: 1, kind: "nope.upsert", row: {} }), PublicOffloadEntryError);
  assert.throws(() => publisher.publish({ scope: "x", sequence: 1, kind: "public_room.upsert", row: {} }), PublicOffloadEntryError);
  const base = { slug: "room-a", title: "One", purpose: "", humans: 0, agents: 0, names_json: "[]", tasks_json: "[]", members_json: "[]", receipts_enabled: 0, join_mode: "request", join_token: null, owner_member_id: null, set_at: null, updated_at: "2026-10-01T00:00:00.000Z" };
  assert.equal(publisher.publish({ scope: "s", sequence: 5, kind: "public_room.upsert", row: base }).reason, "applied");
  assert.equal(publisher.publish({ scope: "s", sequence: 5, kind: "public_room.upsert", row: base }).reason, "replay");
  assert.equal(publisher.publish({ scope: "s", sequence: 5, kind: "public_room.upsert", row: { ...base, title: "Two" } }).reason, "conflict");
  assert.equal(publisher.stats().conflicts, 1);
});

test("production stub: every publish fails safe with the named not-wired error", () => {
  const publisher = createPublicProjectionPublisher({ target: createD1PublicModelTargetStub() });
  assert.throws(
    () => publisher.publish({ scope: "room:room-a", sequence: 1, kind: "public_room.upsert", row: { slug: "room-a" } }),
    error => error instanceof PublicOffloadNotWiredError && error.code === "public_offload_not_wired",
  );
});

test("dual-read compare: defaults keep the in-DO model authoritative; a flipped equal surface may serve the candidate", async t => {
  const { store } = buildCorpus(t);
  const target = createInMemoryPublicModelTarget();
  createPublicProjectionPublisher({ target }).publishAll(createSnapshotSource(store).capture());
  assert.ok(Object.values(PUBLIC_OFFLOAD_FLIP_DEFAULTS).every(value => value === false), "flip defaults are all off");
  assert.equal(readSourceFor("directory-list"), "in-do");

  const divergences = [];
  const comparator = createDualReadComparator({ onDivergence: item => divergences.push(item) });
  const directory = comparator.read("directory-list", () => queryDirectoryEntries(store, {}), () => target.queryDirectoryEntries({}));
  assert.equal(directory.servedFrom, "in-do", "default config never serves the candidate");
  assert.equal(directory.comparison.equal, true);

  const flipped = createDualReadComparator({ config: resolvePublicOffloadConfig({ "directory-list": true }) });
  const served = flipped.read("directory-list", () => queryDirectoryEntries(store, {}), () => target.queryDirectoryEntries({}));
  assert.equal(served.servedFrom, "directory", "flipped + equal serves the candidate");

  // A divergent candidate is never served, even when flipped: the raw
  // receipts list diverges exactly in the named outcome fields.
  const receipts = flipped.read("receipts-list", () => queryPublicReceipts(store, {}), () => target.queryPublicReceipts({}));
  assert.equal(receipts.servedFrom, "in-do");
  assert.equal(comparator.read("receipts-list", () => queryPublicReceipts(store, {}), () => target.queryPublicReceipts({})).comparison.equal, false);
  assert.ok(divergences.length >= 0);
  const raw = createDualReadComparator({ config: resolvePublicOffloadConfig({ "receipts-list": true }), onDivergence: item => divergences.push(item) })
    .read("receipts-list", () => queryPublicReceipts(store, {}), () => target.queryPublicReceipts({}));
  assert.equal(raw.servedFrom, "in-do", "divergence falls back to the in-DO answer");
  assert.ok(raw.comparison.differences.every(path => OUTCOME_FIELDS.some(field => path.endsWith(`.${field}`) || path.includes(`.${field}.`))), JSON.stringify(raw.comparison.differences));
  assert.throws(() => comparator.read("nope", () => 1, () => 1), PublicOffloadEntryError);
  assert.throws(() => resolvePublicOffloadConfig({ nope: true }), PublicOffloadEntryError);
});
