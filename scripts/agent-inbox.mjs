import { RoomAgentClient, validWorkSearchQuery, createAgentIdentity, createAgentRoom, redeemAgentInvite, previewAgentInvite, requestAccess } from "../client/room-agent.mjs";
import { packetMarkdown } from "../src/work-packet.js";
import { validId } from "../src/events.js";
import { createInterface } from "node:readline";
import { agentConnectionFromEnvironment, readConnectionInput, saveAgentConnection, connectionDiagnostic, ConnectionError } from "../client/agent-connection.mjs";

const readStdin = () => new Promise((resolve, reject) => {  let text = ""; process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => text += chunk);
  process.stdin.on("end", () => resolve(text));
  process.stdin.on("error", reject);
});

const isJSONObject = text => {
  try { const value = JSON.parse(text); return !!value && typeof value === "object" && !Array.isArray(value); }
  catch { return false; }
};

// Pre-redemption consent screen for redeem-invite: show the invite's room,
// granted permissions and expiry BEFORE anything is created, and get an
// explicit yes. The grant summary prints to stderr so stdout stays machine
// readable; --yes skips only the prompt, --no reviews then aborts —
// neither skips the summary.
function printInviteConsent(code, preview) {
  const minutesLeft = Math.max(0, Math.round((preview.expiresAt - Date.now()) / 60000));
  const grants = preview.permissions.length ? preview.permissions.join(", ") : "(chat only — no work permissions)";
  console.error([
    `Invite ${code} → room "${preview.roomTitle}" (${preview.roomId})`,
    `This code grants: ${grants}  (profile: ${preview.profile})`,
    `Expires in about ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}. Nothing else is granted.`,
    "The identity acts as itself, never as you — your account and credentials are not shared.",
  ].join("\n"));
}

// room-create: ROOM_ID TITLE PURPOSE [KIND] [DISPLAY_NAME...]
// Kind defaults to personal; displayName defaults to the title. Needs
// ROOM_AGENT_ORIGIN + a pri_ identity secret (ROOM_AGENT_TOKEN) — no room
// exists yet, so a saved connection is not required.
function parseRoomCreate(roomId, extra) {
  if (typeof roomId !== "string" || roomId.startsWith("--") || !validId(roomId) || roomId.length > 64
    || !Array.isArray(extra) || extra.length < 2) return null;
  const title = extra[0], purpose = extra[1];
  if (typeof title !== "string" || !title.trim() || title.length > 120) return null;
  if (typeof purpose !== "string" || !purpose.trim() || purpose.length > 1000) return null;
  const kindGiven = extra[2] !== undefined && ["personal", "organization"].includes(extra[2]);
  const displayName = (kindGiven ? extra.slice(3) : extra.slice(2)).join(" ").trim() || title.trim();
  if (!displayName || displayName.length > 80) return null;
  return { roomId, title: title.trim(), purpose: purpose.trim(), kind: kindGiven ? extra[2] : "personal", displayName };
}

// work-claim / work-complete / work-release flags (RC-2026-09-18-041).
// --note consumes the remainder of the command line and must come last.
// Returns the parsed flags, or null when the flags are invalid.
function parseWorkActionFlags(action, extra) {
  const flags = {};
  for (let index = 0; index < extra.length; index++) {
    const token = extra[index];
    if (action === "work-claim" && token === "--lease-hours") {
      const hours = Number(extra[index + 1]);
      if (extra[index + 1] === undefined || !Number.isFinite(hours) || hours <= 0 || hours > 720 || flags.leaseHours !== undefined) return null;
      flags.leaseHours = hours; index++;
    } else if (action === "work-complete" && token === "--delivery-mode") {
      const mode = extra[index + 1];
      if (!["result", "merged", "production"].includes(mode) || flags.deliveryMode !== undefined) return null;
      flags.deliveryMode = mode; index++;
    } else if (token === "--note") {
      const note = extra.slice(index + 1).join(" ").trim();
      if (!note || note.length > 2000 || flags.note !== undefined) return null;
      flags.note = note;
      break;
    } else return null;
  }
  return flags;
}

// Token management (RC-2026-09-18-050): agent-keys create|list|rotate|revoke
// over /api/agent-keys. create takes a comma-separated scope list plus
// --label, --expires-in <N m|h|d> or --expires-at <ms epoch>. Returns the
// parsed options, or null when the arguments are invalid.
function parseAgentKeysDuration(text) {
  const match = /^(\d+)(m|h|d)$/.exec(text ?? "");
  if (!match) return null;
  const ms = Number(match[1]) * { m: 60000, h: 3600000, d: 86400000 }[match[2]];
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}
function parseAgentKeysArgs(subaction, args) {
  if (!["create", "list", "rotate", "revoke"].includes(subaction)) return null;
  if (subaction === "list") return args.length === 0 ? { subaction } : null;
  if (subaction === "rotate" || subaction === "revoke") {
    return args.length === 1 && /^rak_[A-Za-z0-9_-]{1,64}$/.test(args[0])
      ? { subaction, keyId: args[0] } : null;
  }
  const [scopesCsv, ...flags] = args;
  if (typeof scopesCsv !== "string" || scopesCsv.startsWith("--")) return null;
  const scopes = scopesCsv.split(",").map(scope => scope.trim()).filter(Boolean);
  if (scopes.length === 0 || !scopes.every(scope => /^[a-z0-9:_*-]+$/.test(scope))) return null;
  const options = { subaction, scopes };
  for (let index = 0; index < flags.length; index += 2) {
    const name = flags[index], value = flags[index + 1];
    if (name === "--label") {
      if (value === undefined || value.length === 0 || value.length > 80 || options.label !== undefined) return null;
      options.label = value;
    } else if (name === "--expires-in") {
      const ms = parseAgentKeysDuration(value);
      if (ms === null || options.expiresAt !== undefined) return null;
      options.expiresAt = Date.now() + ms;
    } else if (name === "--expires-at") {
      if (!/^\d+$/.test(value ?? "") || !Number.isSafeInteger(Number(value))
        || Number(value) <= Date.now() || options.expiresAt !== undefined) return null;
      options.expiresAt = Number(value);
    } else return null;
  }
  return options;
}

// Runs the agent-keys verb. create/rotate print the one-time secret warning
// to stderr (stdout stays machine-readable JSON); the secret is shown here
// exactly once and never again.
async function agentKeysMain(client, subaction, args) {
  const parsed = parseAgentKeysArgs(subaction, args);
  if (parsed === null) throw new ConnectionError("usage_error");
  if (parsed.subaction === "list") return client.listAgentKeys();
  if (parsed.subaction === "revoke") return client.revokeAgentKey(parsed.keyId);
  const issued = parsed.subaction === "create"
    ? await client.createAgentKey({ scopes: parsed.scopes,
      ...(parsed.label === undefined ? {} : { label: parsed.label }),
      ...(parsed.expiresAt === undefined ? {} : { expiresAt: parsed.expiresAt }) })
    : await client.rotateAgentKey(parsed.keyId);
  console.error([
    "ONE-TIME SECRET — copy it now: the `secret` (and `credential`) below is shown exactly once and never again.",
    "Store it in your secret manager. Never paste it into a prompt, a commit, or a URL.",
  ].join("\n"));
  return issued;
}

async function promptYesNo(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise(resolve => rl.question(question, resolve));
    return /^(y|yes)$/i.test(answer.trim());
  } finally { rl.close(); }
}

// Onboarding Slice 3 (RC-2026-09-17-028): `check` is a verification
// ladder. Rung 1: access probe (the existing checkConnection). Rung 2: read
// probe — the presence roster, which proves the read path. Rung 3: write
// probe, draft-only until the sandbox practice room (Slice 8) lands: it
// composes the verification message but never sends it, and says so
// explicitly. check never writes to a real room. The first failing rung
// stops the ladder and names the doctor repair.
async function checkVerificationLadder(client) {
  const rungs = [];
  let access;
  try {
    access = await client.checkConnection();
    rungs.push({ name: "access", ok: true,
      detail: `credential accepted as ${access.memberId} in room ${access.roomId}; permissions: ${(access.permissions ?? []).join(",") || "none"}` });
  } catch (error) {
    const diagnostic = connectionDiagnostic(error);
    rungs.push({ name: "access", ok: false, detail: diagnostic.hint ?? diagnostic.message });
    return ladderResult(rungs, null);
  }
  try {
    const roster = await client.presence();
    const members = Array.isArray(roster?.members) ? roster.members : [];
    rungs.push({ name: "read", ok: true,
      detail: `presence roster readable: ${members.length} member${members.length === 1 ? "" : "s"} online` });
  } catch (error) {
    const diagnostic = connectionDiagnostic(error);
    rungs.push({ name: "read", ok: false, detail: diagnostic.hint ?? diagnostic.message });
    return ladderResult(rungs, access);
  }
  rungs.push({ name: "write", ok: true, wrote: false,
    detail: "draft-only probe: no sandbox room yet, so the verification message was composed but never sent. Nothing was written to any room." });
  return ladderResult(rungs, access);
}

function ladderResult(rungs, access) {
  const total = rungs.length, passed = rungs.filter(rung => rung.ok).length;
  const failed = rungs.find(rung => !rung.ok);
  const summary = failed === undefined
    ? `${total}/${total} — you're live in #${access.roomId}`
    : `${passed}/${total} — ${failed.name} failed. Run: node scripts/agent-inbox.mjs doctor`;
  if (failed !== undefined) process.exitCode = 1;
  return { contractVersion: 1, type: "agent_connection_ladder", status: failed === undefined ? "verified" : "failed",
    roomId: access?.roomId ?? null, memberId: access?.memberId ?? null, rungs, summary };
}

async function redeemInviteWithConsent(origin, code, displayName, { autoYes, autoNo }) {
  const preview = await previewAgentInvite(origin, code);
  printInviteConsent(code, preview);
  let proceed = autoYes;
  if (autoNo) proceed = false;
  else if (!autoYes) {
    if (!process.stdin.isTTY) {
      console.error("Not attached to a terminal: review the grant above, then re-run with --yes to accept it (or --no to decline).");
      process.exitCode = 1;
      return;
    }
    proceed = await promptYesNo("Redeem this invite and create the identity? [y/N] ");
  }
  if (!proceed) {
    console.error("Declined: the invite was not redeemed and no identity was created.");
    process.exitCode = 1;
    return;
  }
  return redeemAgentInvite(origin, code, displayName);
}

const [action = "orient", checkpoint, ...extra] = process.argv.slice(2);
if (action === "reply") {
  const { replyMain } = await import("./agent-replies.mjs");
  await replyMain(process.argv.slice(3));
} else if (action === "watch") {
  const { watchMain } = await import("./agent-watch.mjs");
  await watchMain(process.argv.slice(3));
} else if (action === "doctor") {
  const { doctorMain } = await import("./agent-doctor.mjs");
  await doctorMain(process.argv.slice(3));
} else if (action === "bootstrap-agent-room") {
  const { bootstrapMain } = await import("./bootstrap-agent-room.mjs");
  await bootstrapMain(process.argv.slice(3));
} else if (action === "account-link") {
  const { accountLinkMain } = await import("./bootstrap-agent-room.mjs");
  await accountLinkMain(process.argv.slice(3));
} else if (action === "--help") {
  console.log(`Agent connection (Node 24.19+):
  node scripts/agent-inbox.mjs connect NEW_PRIVATE_DIRECTORY
  pbpaste | node scripts/agent-inbox.mjs import NEW_PRIVATE_DIRECTORY
  node scripts/agent-inbox.mjs check
  node scripts/agent-inbox.mjs search "phrase" [--needs-me]
  node scripts/agent-inbox.mjs find "phrase" [messages|work|all]
  node scripts/agent-inbox.mjs work WORK_ID [--include-source] [--include-offers]
  node scripts/agent-inbox.mjs result WORK_ID [--completion ID | --draft MESSAGE_ID]
  node scripts/agent-inbox.mjs discussion WORK_ID [--since N | --cursor CURSOR] [--limit N]
  node scripts/agent-inbox.mjs [orient|next|brief|changes CHECKPOINT|packet WORK_ID]
  node scripts/agent-inbox.mjs presence
  node scripts/agent-inbox.mjs capabilities [QUERY]
  node scripts/agent-inbox.mjs advertise CAPABILITY [CAPABILITY...]
  node scripts/agent-inbox.mjs say [--to MEMBER_ID] MESSAGE...
  node scripts/agent-inbox.mjs templates [TEMPLATE_ID]
  node scripts/agent-inbox.mjs export > room.jsonl
  cat room.jsonl | node scripts/agent-inbox.mjs import-history
  node scripts/agent-inbox.mjs thread MESSAGE_ID
  node scripts/agent-inbox.mjs notify '{"mentions":"mentions_only"}'
  node scripts/agent-inbox.mjs templates
  node scripts/agent-inbox.mjs apply-template team-standup [ACCOUNTABLE_MEMBER_ID]
  node scripts/agent-inbox.mjs heartbeats
  node scripts/agent-inbox.mjs identity-create DISPLAY_NAME
  node scripts/agent-inbox.mjs bootstrap-agent-room DISPLAY_NAME [ROOM_ID] [TITLE] [PURPOSE]
  node scripts/agent-inbox.mjs room-create ROOM_ID TITLE PURPOSE [KIND] [DISPLAY_NAME]
  node scripts/agent-inbox.mjs account-link ROOM_ID IDENTITY_ID DISPLAY_NAME [PERM1,PERM2] [NOTE]
  node scripts/agent-inbox.mjs identity-link IDENTITY_ID [PERM1,PERM2] [MEMBER_ID] [DISPLAY_NAME]
  (omit permissions for a read/chat-only link)
  node scripts/agent-inbox.mjs identity-links
  node scripts/agent-inbox.mjs identity-unlink IDENTITY_ID
  node scripts/agent-inbox.mjs invite-code PERM1,PERM2 [EXPIRES_MINUTES] [DISPLAY_NAME]
  node scripts/agent-inbox.mjs invite-code profile:chat|contribute|review|collaborate [EXPIRES_MINUTES] [DISPLAY_NAME]
  node scripts/agent-inbox.mjs invite-codes
  node scripts/agent-inbox.mjs invite-code-revoke INVITE_ID
  node scripts/agent-inbox.mjs agent-keys create SCOPES_CSV [--label LABEL] [--expires-in 24h|7d] [--expires-at MS_EPOCH]
  node scripts/agent-inbox.mjs agent-keys list
  node scripts/agent-inbox.mjs agent-keys rotate KEY_ID
  node scripts/agent-inbox.mjs agent-keys revoke KEY_ID
  node scripts/agent-inbox.mjs redeem-invite CODE DISPLAY_NAME [--yes|--no]
  node scripts/agent-inbox.mjs request-access ROOM_ID IDENTITY_ID DISPLAY_NAME PERM1,PERM2 [NOTE]
  node scripts/agent-inbox.mjs access-requests [STATUS]
  node scripts/agent-inbox.mjs access-decide REQUEST_ID approve|deny [PERM1,PERM2] [NOTE]
  node scripts/agent-inbox.mjs doctor
  node scripts/agent-inbox.mjs support-export
  node scripts/agent-inbox.mjs sessions [STATUS]
  node scripts/agent-inbox.mjs claim WORK_ID ['{"maxRuntimeMs":3600000,"maxAttempts":3}']
  node scripts/agent-inbox.mjs session WORK_ID STATUS
  node scripts/agent-inbox.mjs work-claim WORK_ID [--lease-hours HOURS] [--note WORDS...]
  node scripts/agent-inbox.mjs work-complete WORK_ID [--delivery-mode result|merged|production] [--note WORDS...]
  node scripts/agent-inbox.mjs work-release WORK_ID [--note WORDS...]
Assignment watching: node scripts/agent-inbox.mjs watch --help
Reply requests: node scripts/agent-inbox.mjs reply --help

Connect checks access, then saves a new private connection; never overwrites or
issues a key. Supply ROOM_AGENT_ORIGIN, ROOM_AGENT_ROOM, ROOM_AGENT_MEMBER and
ROOM_AGENT_TOKEN through the approved process environment/secret manager first.
Live www door: set ROOM_AGENT_ORIGIN to https://www.getdasha.com (no /room
path). The client prefixes /room so identity-create, room-create, invite-code
and redeem-invite hit the Worker. One-shot: bootstrap-agent-room (identity →
own room → collaborate invite → optional --hello). To join a human-owned
room without creating another: account-link (request-access; owner
identity-link). Never put an identity secret or invite code in a prompt or commit.
After saving, clear those four variables and set ROOM_AGENT_CONFIG to that directory.
Import accepts the browser's private setup through a pipe (not a command argument),
checks its identity, then creates the same private connection. Existing credential
environment variables must be cleared first. Clear your clipboard afterward.
Check/read/watch reuse the saved connection. Never mix the two sources.
Legacy reads without a saved connection still accept the original three variables;
expected agent identity is enforced when ROOM_AGENT_MEMBER is supplied.
Never put a key in a prompt, URL or command argument. No AI or work is started.
Check reads identity metadata only; work reads one task with source excluded by
default. Search returns up to 25 compact current-work matches; --needs-me narrows
them to handoffs addressed to you. Refine the query if truncated. No messages or
external evidence files are searched. Next shows current work handoffs addressed to you; it does not start work
or include reply requests. Orient reads broader private room context. A read does not narrow the key's
permissions. See docs/SWARM-PLUG-IN.md for scope, recovery and current limits.`);
} else {
  try {
    let discussionOptions, resultOptions = {};
    if (action === "result" && extra.length) {
      if (extra.length !== 2 || !["--completion", "--draft"].includes(extra[0]) || !validId(extra[1])) throw new ConnectionError("usage_error");
      resultOptions = { [extra[0] === "--completion" ? "completionEventId" : "draftMessageId"]: extra[1] };
    }
    if (action === "discussion") {
      discussionOptions = {};
      for (let index = 0; index < extra.length; index += 2) {
        const name = extra[index]?.slice(2), value = extra[index + 1];
        if (!["--since", "--cursor", "--limit"].includes(extra[index]) || value === undefined || Object.hasOwn(discussionOptions, name)
          || (name !== "cursor" && !/^(0|[1-9]\d*)$/.test(value))) throw new ConnectionError("usage_error");
        discussionOptions[name] = name === "cursor" ? value : Number(value);
      }
      const { since, cursor, limit } = discussionOptions;
      if ((since !== undefined && !Number.isSafeInteger(since))
        || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50))
        || (cursor !== undefined && (since !== undefined || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)))) throw new ConnectionError("usage_error");
    }
    // redeem-invite accepts a trailing --yes to skip the interactive consent
    // prompt, or --no to review the grant and abort (a scripted decline /
    // dry run). The flags are never part of the display name and are
    // mutually exclusive. The grant summary prints either way.
    const redeemArgs = extra.filter(a => a !== "--yes" && a !== "--no"),
      redeemAutoYes = redeemArgs.length !== extra.length && extra.includes("--yes"),
      redeemAutoNo = extra.includes("--no");
    // work-claim / work-complete / work-release flags (RC-2026-09-18-041).
    const workActionOptions = ["work-claim", "work-complete", "work-release"].includes(action)
      ? parseWorkActionFlags(action, extra) : null;
    // say accepts an optional --to MEMBER_ID first; the remaining words are
    // the message body. With --to the message is a targeted DM.
    const sayArgs = action === "say"
      ? (checkpoint === "--to"
        ? { toMemberId: extra[0], words: extra.slice(1) }
        : { words: [checkpoint, ...extra] })
      : null;
    if (!["connect", "import", "check", "orient", "next", "search", "find", "brief", "changes", "packet", "work", "discussion", "result", "presence", "capabilities", "advertise", "say", "sessions", "claim", "session", "work-claim", "work-complete", "work-release", "status", "notify", "templates", "apply-template", "heartbeats", "identity-create", "room-create", "identity-link", "identity-links", "identity-unlink", "invite-code", "invite-codes", "invite-code-revoke", "redeem-invite", "request-access", "access-requests", "access-decide", "export", "import-history", "thread", "doctor", "support-export", "agent-keys"].includes(action)
      || (["connect", "import"].includes(action) && (!checkpoint || checkpoint.startsWith("--") || process.env.ROOM_AGENT_CONFIG !== undefined))
      || (action === "import" && ["ROOM_AGENT_ORIGIN", "ROOM_AGENT_ROOM", "ROOM_AGENT_MEMBER", "ROOM_AGENT_TOKEN"].some(name => process.env[name] !== undefined))
      || (["packet", "work", "discussion", "result", "claim", "work-claim", "work-complete", "work-release"].includes(action) && !validId(checkpoint))
      || (action === "advertise" && (checkpoint === undefined || checkpoint.startsWith("--") || !extra.every(cap => typeof cap === "string" && cap.trim() && cap.length <= 80) || [checkpoint, ...extra].length > 30))
      || (action === "say" && (sayArgs.toMemberId !== undefined && !validId(sayArgs.toMemberId)
        || sayArgs.words.length === 0 || sayArgs.words.some(word => typeof word !== "string" || !word.trim())
        || sayArgs.words.join(" ").length > 4096))
      || (action === "status" && (checkpoint === undefined || [checkpoint, ...extra].join(" ").length > 140))
      || (action === "sessions" && checkpoint !== undefined && !/^[a-z]+$/.test(checkpoint))
      || (action === "session" && (!validId(checkpoint) || extra.length !== 1 || !/^[a-z]+$/.test(extra[0])))
      || (action === "search" && !validWorkSearchQuery(checkpoint))
      || (["discussion", "result"].includes(action) ? false : action === "work" ? new Set(extra).size !== extra.length || extra.some(flag => !["--include-source", "--include-offers"].includes(flag))
        : action === "search" ? extra.length > 1 || (extra.length === 1 && extra[0] !== "--needs-me")
        : ["advertise", "say", "session", "identity-link", "invite-code", "invite-codes", "invite-code-revoke", "redeem-invite", "room-create", "agent-keys"].includes(action) ? false
        : ["work-claim", "work-complete", "work-release"].includes(action) ? workActionOptions === null
        : action === "claim" ? extra.length > 1 || (extra.length === 1 && !isJSONObject(extra[0]))
        : extra.length || (["check", "orient", "next", "brief"].includes(action) && checkpoint !== undefined))
      || (action === "changes" && (!/^\d+$/.test(checkpoint ?? "") || !Number.isSafeInteger(Number(checkpoint))))
      || (["identity-create", "identity-unlink"].includes(action) && (checkpoint === undefined || checkpoint.startsWith("--")))
      || (action === "room-create" && !parseRoomCreate(checkpoint, extra))
      || (action === "identity-link" && (checkpoint === undefined || extra.length > 3))
      || (action === "invite-code" && (checkpoint === undefined || checkpoint.startsWith("--")
        || (checkpoint.startsWith("profile:") && !["chat", "contribute", "review", "collaborate"].includes(checkpoint.slice("profile:".length)))
        || (extra[0] !== undefined && !/^\d+$/.test(extra[0])) || extra.slice(1).join(" ").length > 80))
      || (action === "invite-code-revoke" && !/^[a-f0-9]{8}$/.test(checkpoint ?? ""))
      || (action === "agent-keys" && parseAgentKeysArgs(checkpoint, extra) === null)
      || (action === "redeem-invite" && (checkpoint === undefined || checkpoint.startsWith("--") || !redeemArgs.length || redeemArgs.join(" ").length > 80 || (redeemAutoYes && redeemAutoNo)))
      || (action === "request-access" && (checkpoint === undefined || extra.length < 3 || extra.length > 4))
      || (action === "access-requests" && (checkpoint !== undefined && !/^[a-z]+$/.test(checkpoint) || extra.length))
      || (action === "access-decide" && (checkpoint === undefined || !["approve", "deny"].includes(extra[0])))
      || (action === "invite-codes" && (checkpoint !== undefined || extra.length))
      || (action === "doctor" && (checkpoint !== undefined || extra.length))
      || (action === "support-export" && (checkpoint !== undefined || extra.length))) throw new ConnectionError("usage_error");
    const config = ["identity-create", "room-create", "redeem-invite", "request-access"].includes(action) ? {} : action === "import" ? await readConnectionInput() : agentConnectionFromEnvironment(),
      client = ["identity-create", "room-create", "redeem-invite", "request-access"].includes(action) ? null : new RoomAgentClient(config);
    let result;
    if (["connect", "import", "check"].includes(action)) {
      result = action === "check" ? await checkVerificationLadder(client) : await client.checkConnection();
      if (["connect", "import"].includes(action)) {
        saveAgentConnection(checkpoint, { version: 1, ...config });
        result = { ...result, configurationSaved: true };
      }
    } else result = action === "discussion" ? await client.workDiscussion(checkpoint, discussionOptions)
      : action === "result" ? await client.workResult(checkpoint, resultOptions)
      : action === "work" ? await client.workContext(checkpoint, { includeSource: extra.includes("--include-source"), includeOffers: extra.includes("--include-offers") })
      : action === "next" ? await client.orient({ focus: "needs_me" })
      : action === "search" ? await client.orient({ query: checkpoint, focus: extra[0] === "--needs-me" ? "needs_me" : "all" })
      : action === "packet" ? packetMarkdown(await client.workPacket(checkpoint)) : action === "orient" ? await client.orient() : action === "brief" ? await client.returnBrief()
      : action === "presence" ? await client.presence()
      : action === "capabilities" ? await client.capabilities(checkpoint === undefined ? {} : { search: checkpoint })
      : action === "advertise" ? await client.advertiseCapabilities([checkpoint, ...extra])
      : action === "status" ? await client.setStatus([checkpoint, ...extra].join(" "))
      : action === "say" ? await client.say(sayArgs.words.join(" "),
        sayArgs.toMemberId === undefined ? {} : { toMemberId: sayArgs.toMemberId })
      : action === "templates" ? { templates: checkpoint === undefined ? client.workTemplates() : [client.workTemplate(checkpoint)].filter(Boolean) }
      : action === "export" ? { ndjson: await client.exportRoom() }
      : action === "import-history" ? await client.importRoom(await readStdin())
      : action === "find" ? await client.search(checkpoint, { kind: extra[0] ?? "all" })
      : action === "thread" ? await client.messageThread(checkpoint)
      : action === "notify" ? await client.setNotificationPreferences(JSON.parse(checkpoint))
      : action === "templates" ? client.roomTemplates()
      : action === "apply-template" ? await client.applyRoomTemplate(checkpoint, { accountableMemberId: extra[0] })
      : action === "heartbeats" ? await client.providerHeartbeats()
      : action === "identity-create" ? await createAgentIdentity(process.env.ROOM_AGENT_ORIGIN, checkpoint)
      : action === "room-create" ? await createAgentRoom(process.env.ROOM_AGENT_ORIGIN, process.env.ROOM_AGENT_TOKEN, parseRoomCreate(checkpoint, extra))
      : action === "identity-link" ? await client.linkIdentity({ identityId: checkpoint, permissions: (extra[0] ?? "").split(",").map(p => p.trim()).filter(Boolean), ...(extra[1] === undefined ? {} : { memberId: extra[1] }), ...(extra[2] === undefined ? {} : { displayName: extra.slice(2).join(" ") }) })
      : action === "identity-links" ? await client.identityLinks()
      : action === "identity-unlink" ? await client.unlinkIdentity(checkpoint)
      : action === "invite-code" ? await client.createAgentInvite({ ...(checkpoint.startsWith("profile:")
            ? { profile: checkpoint.slice("profile:".length) }
            : { permissions: checkpoint.split(",").map(p => p.trim()).filter(Boolean) }),
          ...(extra[0] === undefined ? {} : { expiresInMinutes: Number(extra[0]) }),
          ...(extra[1] === undefined ? {} : { displayName: extra.slice(1).join(" ") }) })
      : action === "invite-codes" ? await client.agentInvites()
      : action === "invite-code-revoke" ? await client.revokeAgentInvite(checkpoint)
      : action === "agent-keys" ? await agentKeysMain(client, checkpoint, extra)
      : action === "redeem-invite" ? await redeemInviteWithConsent(process.env.ROOM_AGENT_ORIGIN, checkpoint, redeemArgs.join(" "), { autoYes: redeemAutoYes, autoNo: redeemAutoNo })
      : action === "request-access" ? await requestAccess(process.env.ROOM_AGENT_ORIGIN, {
          roomId: checkpoint, identityId: extra[0], displayName: extra[1],
          requestedPermissions: extra[2].split(",").map(p => p.trim()).filter(Boolean),
          ...(extra[3] === undefined ? {} : { note: extra[3] })
        })
      : action === "access-requests" ? await client.accessRequests(checkpoint === undefined ? {} : { status: checkpoint })
      : action === "access-decide" ? await client.decideAccessRequest(checkpoint, {
          decision: extra[0],
          ...(extra[1] === undefined ? {} : { permissions: extra[1].split(",").map(p => p.trim()).filter(Boolean) }),
          ...(extra[2] === undefined ? {} : { note: extra[2] })
        })
      : action === "support-export" ? await client.diagnosticsExport()
      : action === "sessions" ? await client.workSessions(checkpoint === undefined ? {} : { status: checkpoint })
      : action === "claim" ? await client.claimSession(checkpoint,
          extra[0] === undefined ? {} : { budget: JSON.parse(extra[0]) })
      : action === "session" ? await (async () => {
          const sessions = await client.workSessions();
          const card = sessions?.sessions?.find?.(item => item.workItemId === checkpoint);
          if (!card) throw new ConnectionError("usage_error");
          return client.workSessionAction({ requestId: crypto.randomUUID(), workItemId: checkpoint,
            expectedRevision: card.revision, action: "set_status", status: extra[0] });
        })()
      : action === "work-claim" ? await client.workClaim(checkpoint, workActionOptions)
      : action === "work-complete" ? await client.workComplete(checkpoint, workActionOptions)
      : action === "work-release" ? await client.workRelease(checkpoint, workActionOptions)
      : await client.changes(Number(checkpoint));
    if (action === "export") process.stdout.write(result.ndjson);
    // redeem-invite returns undefined on consent abort (exit code already
    // set, explanation on stderr): nothing machine-readable to print.
    else if (result !== undefined) console.log(action === "packet" ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    // Fixed diagnostic text avoids printing transport internals or environment secrets.
    console.error(JSON.stringify(connectionDiagnostic(error)));
    process.exitCode = 1;
  }
}
