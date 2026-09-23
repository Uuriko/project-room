// Room hygiene (RC-2026-09-23): zombie-member cleanup + friction digest.
// Trusted local-operator script: opens the room SQLite file read-only and
// reports; it never writes. Verbs:
//
//   member-sweep --db PATH --room ROOM_ID [--days N] [--json]
//     Lists active members with no observed heartbeat (last command,
//     work-session heartbeat, or member.added) in the last N days
//     (default 30). Read-only: review the list, then deactivate via the
//     owner path (DELETE /api/rooms/{roomId}/members/{self} for self-leave,
//     or the owner's member administration).
//
//   friction-digest --db PATH --room ROOM_ID [--json]
//     Lists untriaged friction-labeled work items (see docs/ROOM-PROTOCOL.md
//     "friction work items"). Read-only: the digest feeds the claims board.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const usage = `usage:
  node scripts/room-hygiene.mjs member-sweep --db PATH --room ROOM_ID [--days N] [--json]
  node scripts/room-hygiene.mjs friction-digest --db PATH --room ROOM_ID [--json]

Both verbs are read-only: they open the room database without writing.
member-sweep lists active members with no heartbeat in the last N days
(default 30). friction-digest lists untriaged friction-labeled work items.`;

function parseArgs(argv) {
  const verb = argv[0];
  const values = { days: 30, json: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") values.db = argv[++i];
    else if (arg === "--room") values.room = argv[++i];
    else if (arg === "--days") values.days = Number(argv[++i]);
    else if (arg === "--json") values.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!["member-sweep", "friction-digest"].includes(verb)) throw new Error(usage);
  if (!values.db) throw new Error("--db PATH is required\n" + usage);
  if (!values.room) throw new Error("--room ROOM_ID is required\n" + usage);
  if (!Number.isSafeInteger(values.days) || values.days < 1 || values.days > 3650)
    throw new Error("--days must be an integer from 1 to 3650");
  return { verb, values };
}

async function memberSweep(store, roomId, days) {
  return store.staleMembers(roomId, { days });
}

function renderMemberSweep(report) {
  const lines = [`stale members in ${report.roomId} (no heartbeat in ${report.days}d): ${report.stale.length} of ${report.activeCount} active`];
  for (const m of report.stale) {
    const seen = m.lastSeenAt === null ? "never seen" : `${m.daysSinceSeen}d ago`;
    lines.push(`- ${m.memberId} (${m.displayName}, ${m.kind}): ${seen}`);
  }
  if (!report.stale.length) lines.push("(none — every active member has a heartbeat inside the window)");
  lines.push("read-only: deactivate via the owner path after review.");
  return lines.join("\n") + "\n";
}

async function frictionDigest(store, roomId) {
  const state = store.room(roomId).state;
  const items = Object.values(state.workItems ?? {})
    .filter(item => item && Array.isArray(item.labels) && item.labels.includes("friction")
      && ["proposed", "accepted", "blocked"].includes(item.state));
  items.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return { roomId, count: items.length, items: items.map(item => ({
    workItemId: item.id, title: item.title, state: item.state,
    reporterId: item.proposedById ?? null, createdAt: item.createdAt ?? null,
  })) };
}

function renderFrictionDigest(report) {
  const lines = [`untriaged friction items in ${report.roomId}: ${report.count}`];
  for (const item of report.items) {
    lines.push(`- ${item.workItemId} [${item.state}] ${item.title} (reporter: ${item.reporterId ?? "unknown"})`);
  }
  if (!report.count) lines.push("(none)");
  return lines.join("\n") + "\n";
}

async function main(argv, env) {
  const { verb, values } = parseArgs(argv);
  const { RoomStore } = await import("../server/store.mjs");
  const store = new RoomStore(resolve(values.db), { readOnly: true });
  try {
    const report = verb === "member-sweep"
      ? await memberSweep(store, values.room, values.days)
      : await frictionDigest(store, values.room);
    if (values.json) return JSON.stringify(report, null, 2) + "\n";
    return verb === "member-sweep" ? renderMemberSweep(report) : renderFrictionDigest(report);
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then(
    out => process.stdout.write(out),
    error => { process.stderr.write(`room-hygiene: ${error.message}\n`); process.exit(1); },
  );
}

export { parseArgs, memberSweep, frictionDigest };
