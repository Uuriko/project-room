// Synthetic journal fixture for digest aggregation tests, never a runtime seed.
// Projection content is intentionally small; this isolates journal window costs.
export function seedDigestJournal(store, count) {
  const since = store.headSequence("commons");
  store.transaction(() => {
    const insert = store.db.prepare("INSERT INTO events(room_id,sequence,id,body) VALUES(?,?,?,?)");
    for (let i = 1; i <= count; i++) {
      const seq = since + i, id = `digest-journal-${seq}`;
      const type = ["message.posted", "room.policy_set", "future.alpha", "future.beta"][i % 4];
      insert.run("commons", seq, id, JSON.stringify({ id, roomId: "commons", actorId: "owner", type,
        at: "2026-10-17T00:00:00.000Z", data: type === "message.posted" ? { messageId: id, body: "Synthetic journal entry" } : {} }));
    }
    store.db.prepare("UPDATE rooms SET sequence=? WHERE id=?").run(since + count, "commons");
  });
  return { since, through: since + count, count };
}
