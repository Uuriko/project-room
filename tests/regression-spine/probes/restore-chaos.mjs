// Restore + chaos replays: structural mechanism probes over the exact
// files the findings cite, plus two dynamic boot probes for CHAOS-2/3.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { dynImport, readSrc, TMP, fixed, still, notfiled } from "../lib.mjs";

const id = process.argv[2];

if (id === "RESTORE-F1" || id === "RESTORE-F5") {
  const rst = readSrc("server/restore-ndjson.mjs") ?? "";
  const exp = readSrc("server/room-export.mjs") ?? "";
  if (!rst || !exp) notfiled("restore/export sources not found — source drifted");
  // The export watermark pins the event log only (kind/version/
  // sanitizePolicy/backedUpAt/rooms/events; its own trailer comment:
  // "trailer v1: only the event log is pinned"). There are no per-table
  // row counts and no per-room sequences in it, and the restore module
  // never references the watermark at all.
  const watermarkObj = /\{\s*kind: "watermark"[^}]*\}/.exec(exp)?.[0] ?? "";
  const hasTableCounts = /tables/.test(watermarkObj);
  // The restore DOES verify the event count against the watermark, but
  // its per-table check is conditional on watermark.tables existing —
  // and the exporter never writes that field, so the check is dead code
  // exactly as filed. Per-room sequences are verified nowhere.
  const conditionalTableCheck = /if \(watermark\.tables/.test(rst);
  const sequenceCheck = /watermark[^;]{0,200}sequence|sequence[^;]{0,120}watermark/i.test(rst);
  if (id === "RESTORE-F5") {
    if (!sequenceCheck) still("restore never verifies per-room sequences: the watermark carries no per-room sequence map and restore-ndjson.mjs compares only the total event count (plus per-table counts when present) — a backup whose per-room sequences were rewound restores silently (PR #4149 unbuilt)");
    else fixed("restore now verifies per-room sequences against the watermark");
  } else if (!hasTableCounts && conditionalTableCheck)
    still(`a backup short in any non-event table still grades verified: the restore's per-table watermark check only runs if watermark.tables exists, and the exporter never writes it (watermark fields: ${watermarkObj.replace(/\s+/g, " ").slice(0, 120)}) — the check is dead code on both ends, exactly as filed; only the total event count is actually enforced (PR #4149 unbuilt)`);
  else if (hasTableCounts) fixed("the exporter now writes watermark.tables and the restore's per-table check is live (PR #4149 shape in tree)");
  else notfiled(`watermark posture changed shape: exporter table counts=${hasTableCounts}, conditional check=${conditionalTableCheck} — re-derive`);
} else if (id === "RESTORE-F2") {
  const rst = readSrc("server/restore-ndjson.mjs") ?? "";
  const exp = readSrc("server/room-export.mjs") ?? "";
  if (/verifyConservation/.test(rst) || /verifyConservation/.test(exp)) fixed("a restore path now runs verifyConservation before/after the swap (PR #4149 shape in tree)");
  else still("no restore path runs verifyConservation (absent from restore-ndjson.mjs and room-export.mjs) — a restored store can violate conservation invisibly until some other surface trips over it");
} else if (id === "RESTORE-F4") {
  const rst = readSrc("server/restore-ndjson.mjs") ?? "";
  const store = readSrc("server/store.mjs") ?? "";
  const fileSkips = /_cf_/.test(rst) && /(skip|report|foreign|durable)/i.test(rst.slice(rst.search(/_cf_/), rst.search(/_cf_/) + 500));
  const fileRefuses = /_cf_/.test(rst) && /(refus|reject|foreign rows|total)/i.test(rst.slice(Math.max(0, rst.search(/_cf_/) - 300), rst.search(/_cf_/) + 300));
  const doSkips = /_cf_/.test(store);
  if (fileSkips && doSkips) fixed("file replay and DO replay agree on _cf_ rows (both skip-and-report) — ATLAS-RUNTIME's closed-on-main reading holds at this tree");
  else if (fileRefuses || (/_cf_/.test(rst) && !fileSkips)) still("file replay still refuses _cf_ rows the DO replay skips (or handles them unnamed) — the two replay paths disagree on foreign rows");
  else notfiled(`_cf_ handling did not match either filed shape (restore mentions _cf_: ${/_cf_/.test(rst)}, store mentions: ${doSkips})`);
} else if (id === "CHAOS-1") {
  // verifyConservation's caller census across the server tree.
  const { execSync } = await import("node:child_process");
  let callers = "";
  try { callers = execSync(`grep -rl "verifyConservation" server/ --include="*.mjs"`, { cwd: process.env.R1_ROOT, encoding: "utf8" }); } catch { callers = ""; }
  const files = callers.trim().split("\n").filter(Boolean);
  const nonDef = files.filter((f) => !/bounty-escrow\.mjs/.test(f));
  if (nonDef.length === 0) still(`verifyConservation still has no live caller: the only file referencing it is its definition (server/bounty-escrow.mjs) — payable-flow forgery is invisible to every running check (PR #4135 unbuilt)`);
  else fixed(`verifyConservation now has live callers outside its definition: ${nonDef.join(", ")}`);
} else if (id === "CHAOS-2" || id === "CHAOS-3") {
  const { RoomStore } = await dynImport("server/store.mjs");
  const { initialRoom } = await dynImport("server/bootstrap.mjs");
  const { createRoomServer } = await dynImport("server/http.mjs");
  const dir = mkdtempSync(join(TMP, "chaos-boot-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom("healthy-room"));
  store.initialize(initialRoom("corrupt-room"));
  if (id === "CHAOS-2") {
    store.db.prepare("UPDATE rooms SET projection=? WHERE id='corrupt-room'").run("{torn-projection");
  } else {
    store.db.prepare("UPDATE rooms SET projection=? WHERE id='corrupt-room'").run(JSON.stringify({ version: 1 }));
  }
  // Boot and serve inside a guard: a throw anywhere in the boot/serve
  // path IS the filed behaviour (the brick / the raw TypeError), so it is
  // captured as evidence instead of crashing the probe.
  let healthy = { status: -1, body: "" }, corrupt = { status: -1, body: "" }, bootError = null, server = null;
  try {
    server = createRoomServer({ store });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    healthy = await fetch(`${origin}/api/rooms/healthy-room`, { headers: { Authorization: `Bearer ${store.issueAccessKey("healthy-room", "owner")}` } }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 200) })).catch((e) => ({ status: -1, body: String(e).slice(0, 200) }));
    corrupt = await fetch(`${origin}/api/rooms/corrupt-room`, { headers: { Authorization: `Bearer ${store.issueAccessKey("corrupt-room", "owner")}` } }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 200) })).catch((e) => ({ status: -1, body: String(e).slice(0, 200) }));
  } catch (e) {
    bootError = e;
  }
  try { server?.closeAllConnections?.(); if (server) await new Promise((r) => server.close(r)); } catch {}
  try { store.close(); } catch {}
  if (id === "CHAOS-2") {
    if (bootError) still(`one torn room bricks the node at boot: constructing the server over a store with one torn projection throws (${String(bootError.message ?? bootError).slice(0, 140)}) — every room is down for one room's corruption (PR #4136 unbuilt)`);
    else if (healthy.status !== 200) still(`one torn room bricks the node for everyone: the HEALTHY room answers ${healthy.status} (${healthy.body.slice(0, 120)}) because corrupt-room's projection is torn — no per-room isolation at load (PR #4136 unbuilt)`);
    else if (corrupt.status === 200) notfiled(`both rooms answered 200 — the torn projection did not take effect as seeded (healthy=${healthy.status} corrupt=${corrupt.status})`);
    else fixed(`the healthy room serves (200) while the corrupt room alone fails (${corrupt.status}) — per-room isolation exists at this tree`);
  } else {
    const rawText = `${bootError?.name ?? ""} ${bootError?.message ?? ""} ${corrupt.body}`;
    if (/TypeError|Cannot read properties|Cannot convert undefined|is not a function|not iterable/.test(rawText)) still(`a hollow (parseable-but-wrong) projection surfaces a raw TypeError from the boot/serve path (${rawText.match(/TypeError[^"]*/)?.[0].slice(0, 110) ?? "TypeError"}) — no honest corruption error, no repair path (PR #4137 unbuilt)`);
    else if (bootError) notfiled(`boot threw a non-TypeError: ${String(bootError.message ?? bootError).slice(0, 160)}`);
    else if (corrupt.status >= 400 && /corrupt|integrity|projection/i.test(corrupt.body)) fixed(`the hollow projection now fails honestly (${corrupt.status}: ${corrupt.body.slice(0, 120)}) — a named corruption error exists`);
    else notfiled(`hollow projection outcome unrecognised: http ${corrupt.status} ${corrupt.body.slice(0, 160)}`);
  }
} else {
  notfiled(`restore-chaos.mjs has no probe for ${id}`);
}
