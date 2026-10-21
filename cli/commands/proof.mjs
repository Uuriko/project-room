// room proof: attach evidence (a screenshot, log or test output) to work.
//   room proof <file> [--work <workItemId>] [--note <text>]
// Stages the file, posts one message naming the work, and commits the file
// onto that message, so the evidence sits next to the claim it backs.
// Files are at most 1 MiB; staging a file is a paid room call (room cents).
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { connection } from "./code.mjs";
import { callTool } from "../mcp-tool.mjs";

export const PROOF_MAX_BYTES = 1024 * 1024;
const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".txt": "text/plain", ".log": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv",
  ".html": "text/html", ".pdf": "application/pdf", ".xml": "application/xml" };
export const mediaTypeFor = file => TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";

export function parseProofArgs(argv) {
  let file = null, work = null, note = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--work" && argv[i + 1]) { work = argv[++i]; continue; }
    if (argv[i] === "--note" && argv[i + 1] !== undefined) { note = argv[++i]; continue; }
    if (argv[i].startsWith("--") || file) throw new Error("Use room proof <file> [--work <workItemId>] [--note <text>]");
    file = argv[i];
  }
  if (!file) throw new Error("Use room proof <file> [--work <workItemId>] [--note <text>]");
  return { file, work, note };
}

export function proofBody({ filename, work, note }) {
  const head = work ? `Proof for ${work}` : "Proof";
  return `${head}: ${note?.trim() || filename}`;
}

export async function proofCommand(argv, { env = process.env, cwd = process.cwd(), fetchImpl = globalThis.fetch, out = console.log } = {}) {
  const { file, work, note } = parseProofArgs(argv);
  const size = (await stat(file)).size;
  if (size > PROOF_MAX_BYTES) { out(`${basename(file)} is ${size} bytes; proof files are at most 1 MiB. Trim the log or crop the screenshot.`); return 1; }
  const conn = await connection({ env, cwd });
  const filename = basename(file), id = randomUUID(), messageId = randomUUID();
  const data = (await readFile(file)).toString("base64");
  await callTool(conn, "room_put_file", { roomId: conn.roomId, id, filename, mediaType: mediaTypeFor(file), data }, fetchImpl);
  await callTool(conn, "room_post_message", { roomId: conn.roomId, id: messageId, messageId, body: proofBody({ filename, work, note }) }, fetchImpl);
  await callTool(conn, "room_commit_file", { roomId: conn.roomId, id, messageId }, fetchImpl);
  out(`Attached ${filename} as proof${work ? ` for ${work}` : ""}.`);
  return 0;
}
