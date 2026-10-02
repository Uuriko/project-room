// A live member.added stamps the display-name policy and refuses a folded
// duplicate. These checks need a stored collision so the rail can disambiguate
// names. An older event omits the stamp and still replays.
import { applyEvent, event } from "../src/events.js";

export function admitHistoricalMember(store, roomId, actorId, data) {
  const room = store.room(roomId);
  const incoming = event({ type: "member.added", actorId, roomId, data });
  const state = applyEvent(room.state, incoming);
  const sequence = room.sequence + 1;
  const stored = { ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
  store.transaction(() => {
    store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
    store.db.prepare("UPDATE rooms SET sequence=?, projection=? WHERE id=?").run(sequence, JSON.stringify(stored), roomId);
  });
  return incoming;
}
