import test from "node:test";
import assert from "node:assert/strict";
import { privateWorkFixture, privateMarkers, PRIVATE, PUBLIC } from "./helpers/private-work-fixture.mjs";

// Exercise the actual streaming transport, including replay after reconnect.
// A working filtered polling read alone does not qualify an open SSE stream.
async function openStream(f, who, after = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const response = await fetch(`${f.origin}/api/rooms/commons/stream`, {
    headers: { Authorization: `Bearer ${who.secret}`, "Last-Event-ID": String(after) },
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = "";
  return {
    async through(sequence) {
      const events = [];
      while (!events.some(row => row.sequence >= sequence)) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, "stream ended before the expected event");
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary;
        while ((boundary = pending.indexOf("\n\n")) !== -1) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          if (!frame.includes("event: room-event\n")) continue;
          const row = JSON.parse(frame.split("\n").find(line => line.startsWith("data: ")).slice(6));
          assert.equal(Number(frame.match(/^id: (\d+)/m)?.[1]), row.sequence);
          events.push(row);
        }
      }
      return events;
    },
    async close() { clearTimeout(timer); controller.abort(); await reader.cancel().catch(() => {}); }
  };
}

for (const representation of ["legacy", "normalized-current-v1"]) {
  test(`${representation}: SSE replay and live delivery preserve private boundaries and reconnect cursors`, async t => {
    const f = await privateWorkFixture(t, representation);
    const page = (await f.rest(f.observer, "/events?after=0&limit=100")).json;
    assert.equal(page.hasMore, false);
    const last = page.events.at(-1).sequence;
    for (const who of [f.observer, f.triage, f.broad, f.reviewer]) {
      const before = f.stored(), stream = await openStream(f, who);
      let rows;
      try { rows = await stream.through(last); } finally { await stream.close(); }
      assert.equal(f.stored(), before, "stream reads must not change stored work or events");
      const text = JSON.stringify(rows);
      assert.ok(text.includes(PUBLIC.TITLE), "public task remains visible");
      if (who === f.reviewer) assert.ok(text.includes(PRIVATE.REVIEW), "named reviewer retains private history");
      else {
        assert.deepEqual(privateMarkers(text), []);
        assert.ok(rows.some(row => row.event.data?.withheld), "withheld work events keep their cursor positions");
      }
    }

    const outside = await openStream(f, f.observer, last);
    const inside = await openStream(f, f.reviewer, last);
    let privateEvent, publicEvent, outsideRows;
    try {
      privateEvent = f.send(f.producer.key, "work.blocker_resolved", {
        workItemId: "secret", expectedRevision: f.rev("secret"), resolution: PRIVATE.RESOLUTION
      });
      publicEvent = f.send(f.producer.key, "work.started", { workItemId: "open", expectedRevision: f.rev("open") });
      const target = publicEvent.sequence;
      assert.ok(Number.isInteger(target));
      outsideRows = await outside.through(target);
      const insideRows = await inside.through(target);
      assert.deepEqual(privateMarkers(JSON.stringify(outsideRows)), []);
      assert.ok(JSON.stringify(insideRows).includes(PRIVATE.RESOLUTION), "authorized live delivery is not suppressed");
      assert.ok(outsideRows.some(row => row.event.id === privateEvent.event.id && row.event.data.withheld));
      assert.deepEqual(outsideRows.find(row => row.event.id === publicEvent.event.id), insideRows.find(row => row.event.id === publicEvent.event.id));
      assert.ok(outsideRows.every(row => row.sequence > last), "Last-Event-ID prevents replaying earlier events");
    } finally { await outside.close(); await inside.close(); }

    const reconnect = await openStream(f, f.observer, last);
    try { assert.deepEqual(await reconnect.through(publicEvent.sequence), outsideRows, "reconnect reproduces the same safe delta"); }
    finally { await reconnect.close(); }
  });
}
