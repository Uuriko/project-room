// F12: hostile NDJSON to replayNdjson — every malformed input throws clean, never hangs;
// a valid export replays verified:true.
import assert from "node:assert/strict";
import { join } from "node:path";
import { RoomStore } from "../../server/store.mjs";
import { initialRoom } from "../../server/bootstrap.mjs";
import { exportNdjsonText, replayNdjson } from "../../server/room-export.mjs";
import { fuzz, scratchDir, throwsBounded } from "./lib.mjs";

fuzz("F12-hostile-replay", async () => {
  const dir = scratchDir("g04-f12-");
  const src = new RoomStore(join(dir, "src.sqlite"));
  src.initialize(initialRoom("commons"));
  const good = exportNdjsonText(src.db);
  src.close();
  assert.ok(good.length > 100, "empty export?");

  const hostile = {
    "empty": "",
    "not-json-line": good + "\nthis is not json\n",
    "two-watermarks": good.replace("\n", "\n" + good.split("\n")[0] + "\n"),
    "two-trailers": good + good.split("\n").filter(l => l.includes('"trailer"')).join("\n") + "\n",
    "bad-trailer": good.replace(/"eventsHash":"[0-9a-f]{64}"/, '"eventsHash":"zzzz"'),
    "torn-count": good.replace(/"events":\d+,"eventsHash"/, '"events":999999,"eventsHash"'),
    "object-cell": good.replace(/"title":"[^"]*"/, '"title":{"$nope":1}'),
    "noncanonical-b64": good.replace(/"\$base64":"[A-Za-z0-9+/=]*"/, '"$base64":"!!!notbase64!!!"'),
    "unknown-table": good + JSON.stringify({ table: "nope_table", row: { a: 1 } }) + "\n",
    "missing-watermark": good.split("\n").filter(l => !l.includes('"watermark"')).join("\n"),
  };
  for (const [name, ndjson] of Object.entries(hostile)) {
    const t0 = Date.now();
    let threw = false, msg = "";
    try { replayNdjson(ndjson, join(dir, `out-${name}.sqlite`), { audit: "report" }); }
    catch (e) { threw = true; msg = String(e.message).slice(0, 70); }
    const dt = Date.now() - t0;
    assert.ok(threw, `${name}: replay accepted hostile input!`);
    assert.ok(dt < 15000, `${name}: took ${dt}ms`);
    console.log(`  ${name}: clean throw (${msg})`);
  }

  // valid export replays verified:true with trailer verified
  const res = replayNdjson(good, join(dir, "restored.sqlite"), { audit: "report" });
  assert.equal(res.verified, true);
  assert.equal(res.trailer, "verified");
  console.log(`  valid export: verified:true, trailer:${res.trailer}, events:${res.events}, audit.ok=${res.audit.ok}`);
});
