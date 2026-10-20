import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { connectRoom } from "../../client/agent-setup.mjs";
import { readAgentConnection } from "../../client/agent-connection.mjs";
import { rememberSecret } from "../auth.mjs";
import { connectionHome, safeName, tightenConnection, writePointer } from "../paths.mjs";

function parse(argv) {
  const flags = { accept: false, device: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--accept") { flags.accept = true; continue; }
    if (arg === "--device") { flags.device = true; continue; }
    if (arg === "--room" || arg === "--name") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      flags[arg.slice(2)] = value;
      continue;
    }
    rest.push(arg);
  }
  if (rest.length) throw new Error("Unknown login argument. Use room login --room <invite-or-room-url>.");
  return flags;
}

function publicResult(result) {
  if (result.status === "connected") {
    return {
      status: "connected",
      origin: result.origin,
      roomId: result.roomId,
      memberId: result.memberId,
      connection: result.connection,
      next: "Run room setup <tool> in the repo. The tool config does not contain the identity secret.",
    };
  }
  const preview = result.preview ? {
    roomId: result.preview.roomId,
    permissions: result.preview.permissions,
    expiresAt: result.preview.expiresAt,
  } : undefined;
  return {
    status: result.status,
    roomId: result.roomId,
    identityId: result.identityId,
    ...(preview ? { preview } : {}),
    next: result.next,
  };
}

// --device: no browser on this machine. Print a link to open on any signed-in
// device, wait for the approval, then finish login with the one-time invite.
export function deviceRoomTarget(value) {
  const url = new URL(value);
  const match = /^\/(?:room\/)?rooms\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?$/.exec(url.pathname);
  if (!match) throw new Error("Use room login --device --room <origin>/rooms/<room id>.");
  return { origin: url.origin, roomId: match[1] };
}

async function postJson(fetchImpl, url, data) {
  const response = await fetchImpl(url, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), signal: AbortSignal.timeout(30000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  return body;
}

export async function deviceInvite({ room, name, fetchImpl = globalThis.fetch, out, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const { origin, roomId } = deviceRoomTarget(room);
  const started = await postJson(fetchImpl, `${origin}/api/rooms/${encodeURIComponent(roomId)}/device-signin`, { name });
  out(`Open ${started.verificationUri} on any device signed in to the room and approve code ${started.userCode}. Waiting...`);
  const deadline = Date.now() + started.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(started.interval * 1000);
    const polled = await postJson(fetchImpl, `${origin}/api/device-signin/poll`, { deviceCode: started.deviceCode });
    if (polled.status === "approved") return { origin, code: polled.inviteCode };
    if (polled.status === "expired") break;
  }
  throw new Error("The sign-in link expired. Run room login --device again.");
}

export async function loginCommand(argv, { env = process.env, fetchImpl, out = console.log, progress = line => process.stderr.write(line + "\n"), sleep } = {}) {
  const flags = parse(argv);
  if (!flags.room) throw new Error("Use room login --room <invite-or-room-url>.");
  const name = flags.name ?? "Room agent";
  const slug = safeName(name);
  const directory = connectionHome(slug, env);
  mkdirSync(join(directory, ".."), { recursive: true, mode: 0o700 });
  const invited = flags.device ? await deviceInvite({ room: flags.room, name, fetchImpl, out: progress, sleep }) : null;
  const result = await connectRoom({
    target: invited ? invited.code : flags.room,
    ...(invited ? { origin: invited.origin } : {}),
    directory,
    name,
    accept: invited ? true : flags.accept,
    fetchImpl,
  });
  if (result.status === "connected") {
    tightenConnection(result.configDirectory);
    const saved = readAgentConnection(result.configDirectory);
    await rememberSecret(slug, saved.token, env);
    writePointer(slug, result.configDirectory, env);
  }
  const printed = publicResult({ ...result, connection: slug });
  out(JSON.stringify(printed));
  return result.status === "connected" ? 0 : 1;
}
