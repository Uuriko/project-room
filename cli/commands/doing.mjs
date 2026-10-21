// room doing: set the live status line in presence from a tool hook.
//   Claude Code PostToolUse hook: room doing   (reads the hook JSON on stdin)
//   or: room doing "Edit math.js"
import { spawnSync } from "node:child_process";
import { doingFromToolAction } from "../../client/doing-status.mjs";
import { edgeDoorApiPath } from "../../server/agent-discovery.mjs";
import { bearerHeader } from "../auth.mjs";
import { connection } from "./code.mjs";

const git = (args, cwd) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  return run.status === 0 ? run.stdout.trim() : "";
};

// Presence shows repo as a plain owner/name. A git remote can carry
// credentials in its authority (https://oauth2:TOKEN@host/repo.git), and a
// segment capture over the raw URL reaches back into that authority when
// the path has one segment — broadcasting the token to every room member.
// So parse structurally: for a URL keep only the path (the authority, with
// any userinfo, is dropped whole); for scp-style user@host:path drop
// everything through the ":". Then keep the last two path segments.
export function repoFromRemote(remote) {
  const text = String(remote ?? "").trim();
  if (!text) return undefined;
  let path = text;
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(text);
  if (scheme) {
    const rest = text.slice(scheme[0].length);
    const slash = rest.indexOf("/");
    path = slash === -1 ? "" : rest.slice(slash + 1);
  } else {
    const colon = text.indexOf(":");
    const slash = text.indexOf("/");
    if (colon !== -1 && (slash === -1 || colon < slash)) path = text.slice(colon + 1);
  }
  const segments = path.split("/").filter(Boolean);
  if (!segments.length) return undefined;
  return segments.slice(-2).join("/").replace(/\.git$/, "");
}

export function repoContext(cwd) {
  const remote = git(["remote", "get-url", "origin"], cwd);
  const repo = repoFromRemote(remote);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return { ...(repo ? { repo } : {}), ...(branch && branch !== "HEAD" ? { branch } : {}) };
}

async function readStdin(stdin) {
  if (!stdin || stdin.isTTY) return "";
  let text = "";
  for await (const chunk of stdin) text += chunk;
  return text;
}

export async function doingCommand(argv, { env = process.env, cwd = process.cwd(), fetchImpl = globalThis.fetch, stdin = process.stdin, out = console.log } = {}) {
  let doing = argv.join(" ").trim() || null;
  if (!doing) {
    try { doing = doingFromToolAction(JSON.parse(await readStdin(stdin) || "{}")); } catch { doing = null; }
  }
  if (!doing) return 0;
  const conn = await connection({ env, cwd });
  const response = await fetchImpl(conn.origin + edgeDoorApiPath(conn.origin, "/api/agent-heartbeats"), {
    method: "POST", redirect: "error",
    headers: { Authorization: bearerHeader(conn.secret), "Content-Type": "application/json" },
    body: JSON.stringify({ hostId: env.ROOM_HOST_ID || "room-cli", mode: "pull-only",
      context: { ...repoContext(cwd), activity: "busy", doing: doing.slice(0, 80) } }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) { out(`Presence update failed (${response.status}). Run room doctor.`); return 1; }
  return 0;
}
