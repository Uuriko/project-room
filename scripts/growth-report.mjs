#!/usr/bin/env node
// Print the growth and retention report for a Room.
//
//   node scripts/growth-report.mjs                             # the bundled seed Room
//   node scripts/growth-report.mjs events.json                 # a JSON array of events
//   node scripts/growth-report.mjs events.json --json          # machine-readable
//   node scripts/growth-report.mjs --who potter                # what is waiting on one member
//   node scripts/growth-report.mjs events.json --invitations journal.json
//
// Read-only. Replays events in memory, touches no database and writes nothing.
// With --invitations it also reports the send side of the invite loop, which the
// Room event log cannot see on its own. Journal records are private authority
// history: the funnel emits aggregates only, never a token hash or an account id.

import { readFile } from "node:fs/promises";
import { replay } from "../src/events.js";
import { seedEvents } from "../src/seed.js";
import { loopHealth, formatReport, openObligations } from "../src/growth-metrics.js";
import { trueInviteCoefficient, formatInvitationReport } from "../server/invitation-funnel.mjs";
import { exportRoom } from "../server/room-export.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1] ?? true; };
const valued = new Set(["--who", "--invitations", "--store", "--room"]);
const positional = argv.filter((arg, index) => !arg.startsWith("--") && !valued.has(argv[index - 1]));
const source = positional[0] ?? null;

if (flag("--help") || flag("-h")) {
  console.log(`Usage: node scripts/growth-report.mjs [events.json] [--invitations journal.json] [--json] [--who MEMBER_ID]

Without a file it reports on the bundled seed Room, which is a fixture: the
numbers demonstrate the shape of the report, they are not evidence about the
live Room. Point it at an exported event log for that.

--invitations takes a JSON array of invitation journal snapshot records. Without
it the invite coefficient is a floor, because the event log records accepted
joins and says nothing about invitations that were sent and never taken up.

--store reads a real Room SQLite database instead, read-only, and picks up both
the event log and the invitation records at once. Use --room to choose a room
when the store holds more than one.

  node scripts/growth-report.mjs --store /path/to/room.sqlite
  node scripts/growth-report.mjs --store /path/to/room.sqlite --room commons`);
  process.exit(0);
}

const loadJson = async (path, what) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    console.error(`Could not read ${what} from ${path}: ${error.message}`);
    process.exit(1);
  }
};

let events = seedEvents;
let origin = "bundled seed fixture (not live data)";
let storedInvitations = null;

const storePath = flag("--store");
if (typeof storePath === "string") {
  let exported;
  try {
    exported = exportRoom(storePath, { roomId: typeof flag("--room") === "string" ? flag("--room") : null });
  } catch (error) {
    console.error(`Could not read the Room store at ${storePath}: ${error.message}`);
    process.exit(1);
  }
  if (!exported.roomId) {
    console.error(`${storePath}: no rooms in this store.`);
    process.exit(1);
  }
  events = exported.events;
  storedInvitations = exported.invitations;
  const others = exported.rooms.filter((room) => room.id !== exported.roomId);
  origin = `${storePath} room "${exported.roomId}" (${events.length} events` +
    `${storedInvitations.length ? `, ${storedInvitations.length} invitations` : ""})` +
    `${others.length ? `; other rooms here: ${others.map((room) => room.id).join(", ")}` : ""}`;
} else if (source) {
  const parsed = await loadJson(source, "events");
  events = Array.isArray(parsed) ? parsed : parsed.events;
  if (!Array.isArray(events)) {
    console.error(`${source}: expected a JSON array of events, or an object with an "events" array.`);
    process.exit(1);
  }
  origin = source;
}

let state;
try {
  state = replay(events);
} catch (error) {
  console.error(`Could not replay ${origin}: ${error.message}`);
  process.exit(1);
}

const who = flag("--who");
if (typeof who === "string") {
  if (!state.members?.[who]) { console.error(`No member "${who}" in this Room.`); process.exit(1); }
  const open = openObligations(state, who);
  if (flag("--json")) { console.log(JSON.stringify(open, null, 2)); process.exit(0); }
  console.log(`Waiting on ${who}: ${open.length} item(s)\n`);
  for (const entry of open) {
    const days = entry.ageMs === null ? "?" : (entry.ageMs / 86_400_000).toFixed(1);
    console.log(`  ${entry.kind.padEnd(20)} ${days.padStart(5)}d  ${entry.title ?? entry.requestId ?? ""}`);
    console.log(`  ${" ".repeat(20)}        ${entry.whyYou}`);
  }
  process.exit(0);
}

const journalPath = flag("--invitations");
let invitations = storedInvitations ? trueInviteCoefficient(storedInvitations, state) : null;
if (typeof journalPath === "string") {
  const parsed = await loadJson(journalPath, "invitation journal records");
  const rows = Array.isArray(parsed) ? parsed : parsed.records;
  if (!Array.isArray(rows)) {
    console.error(`${journalPath}: expected a JSON array of journal records, or an object with a "records" array.`);
    process.exit(1);
  }
  invitations = trueInviteCoefficient(rows, state);
}

const health = loopHealth(state);
if (flag("--json")) {
  console.log(JSON.stringify(invitations ? { ...health, invitations } : health, null, 2));
  process.exit(0);
}
console.log(formatReport(health));
if (invitations) {
  console.log("");
  console.log(formatInvitationReport(invitations));
} else {
  console.log("\nInvite coefficient above is a floor. Pass --store or --invitations to measure send-to-accept.");
}
console.log(`\nSource: ${origin}`);
