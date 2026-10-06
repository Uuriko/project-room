// Hard Work lane CLI (docs/HARD-WORK.md). Read-only.
//
//   node scripts/hard-work.mjs lane            open hard items, pairing, flags
//   node scripts/hard-work.mjs mix [--days 7]  real per-member closed-work mix
//   node scripts/hard-work.mjs next --member <memberId>
//                                              next hard item + partner
//
// Data: --board <file.json> (a saved GET /api/rooms/{roomId}/work-claims body)
// and optional --roster <file.json> (activation-pack body or [{id, handle}]),
// or live GETs with ROOM_ORIGIN, ROOM_ID and ROOM_KEY (Bearer). --json prints
// the raw view. Run it when an event happens (you closed a claim, a PR merged,
// a hard item was released), not on a timer.
import { readFileSync } from "node:fs";
import { formatLane, formatMix, laneView, nextFor, workMix } from "./hard-work-lane.mjs";

export function parseArgs(argv) {
  const [command = "lane", ...rest] = argv;
  const options = { command, json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--json") options.json = true;
    else if (["--board", "--roster", "--member", "--days"].includes(flag)) options[flag.slice(2)] = rest[++index];
    else throw new Error(`unknown option ${flag}`);
  }
  if (!["lane", "mix", "next"].includes(command)) throw new Error("command must be lane, mix or next");
  if (command === "next" && !options.member) throw new Error("next needs --member <memberId>");
  return options;
}

export function rosterOf(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.members) ? body.members : [];
  return list.filter(member => member && member.id).map(member => ({ id: member.id, handle: member.handle ?? member.displayName ?? member.id, kind: member.kind ?? null }));
}

async function live(path) {
  const origin = process.env.ROOM_ORIGIN, room = process.env.ROOM_ID, key = process.env.ROOM_KEY;
  if (!origin || !room || !key) throw new Error("pass --board, or set ROOM_ORIGIN, ROOM_ID and ROOM_KEY");
  const response = await fetch(new URL(path.replace("{roomId}", encodeURIComponent(room)), origin), {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "project-room-hard-work/1" }
  });
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
  return response.json();
}

async function loadBoard(options) {
  if (options.board) {
    const body = JSON.parse(readFileSync(options.board, "utf8"));
    return Array.isArray(body) ? body : body.claims ?? [];
  }
  const claims = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const body = await live(`/api/rooms/{roomId}/work-claims?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    claims.push(...(body.claims ?? []));
    if (!body.hasMore || !body.nextCursor) break;
    cursor = body.nextCursor;
  }
  return claims;
}

async function loadRoster(options) {
  if (options.roster) return rosterOf(JSON.parse(readFileSync(options.roster, "utf8")));
  if (options.board) return [];
  return rosterOf(await live("/api/rooms/{roomId}/activation-pack"));
}

export async function main(argv, { now = Date.now() } = {}) {
  const options = parseArgs(argv);
  const [items, roster] = [await loadBoard(options), await loadRoster(options)];
  if (options.command === "lane") {
    const view = laneView(items, { now, roster });
    return options.json ? `${JSON.stringify(view, null, 2)}\n` : formatLane(view, roster);
  }
  if (options.command === "mix") {
    const days = Number(options.days ?? 7);
    if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number");
    const mix = workMix(items, { since: now - days * 24 * 3600 * 1000, until: now + 1 });
    return options.json ? `${JSON.stringify(mix, null, 2)}\n` : `Last ${days} days (Board data only)\n${formatMix(mix, roster)}`;
  }
  const reviewers = roster.filter(member => member.kind !== "human").map(member => member.id);
  const next = nextFor(items, options.member, { now, roster, reviewers });
  if (options.json) return `${JSON.stringify(next, null, 2)}\n`;
  if (!next) return "No claimable hard item for you right now.\n";
  const name = id => roster.find(member => member.id === id)?.handle ?? id ?? "nobody yet";
  return `Next: ${next.tier ?? "H?"} ${next.id}: ${next.title}\nPartner: ${name(next.partner)} (${next.partnerSource ?? "none"})\nWhy: ${next.reason}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(text => process.stdout.write(text), error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
