import { readFileSync } from "node:fs";
import { connection } from "./code.mjs";
import { bearerHeader } from "../auth.mjs";
import { edgeDoorApiPath } from "../../server/agent-discovery.mjs";

const help = `room docs list [--limit 100] [--after <doc-id>]
room docs read <doc-id> [--rev <revision>]
room docs write <doc-id> --title <title> --file <markdown-file> --base-rev <revision>
Outputs JSON. Use base-rev 0 to create. Reads are bounded; follow nextAfter.
Writes are never automatically retried. After an uncertain result, read the document
and compare before deciding whether to write again. Revisions retain shared history.`;

export async function docsCommand(argv, io = {}) {
  const out = io.out ?? console.log;
  const [action, ...args] = argv;
  if (!action || ["help", "--help", "-h"].includes(action)) { out(help); return 0; }
  if (!["list", "read", "write"].includes(action)) throw new Error("Unknown docs action. Run room docs help.");
  const flags = {};
  const positional = [];
  const allowed = new Set(action === "list" ? ["limit", "after"] : action === "read" ? ["rev"] : ["title", "file", "base-rev"]);
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) { positional.push(args[i]); continue; }
    const key = args[i].slice(2);
    if (!allowed.has(key) || Object.hasOwn(flags, key) || i + 1 === args.length) throw new Error(`Invalid or repeated option --${key}`);
    flags[key] = args[++i];
  }
  const validId = value => /^[a-z0-9][a-z0-9-]{0,63}$/.test(value ?? "");
  if (positional.length !== (action === "list" ? 0 : 1) || (action !== "list" && !validId(positional[0]))) throw new Error("Expected a valid document id (1–64 lowercase letters, digits or hyphens).");
  const integer = (key, min, max) => {
    if (!/^\d+$/.test(flags[key] ?? "")) throw new Error(`--${key} must be an integer`);
    const value = Number(flags[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`--${key} is out of range`);
    return value;
  };
  const query = new URLSearchParams();
  if (flags.limit !== undefined) query.set("limit", integer("limit", 1, 500));
  if (flags.after !== undefined) { if (!validId(flags.after)) throw new Error("Invalid --after document id"); query.set("after", flags.after); }
  if (flags.rev !== undefined) query.set("rev", integer("rev", 1, Number.MAX_SAFE_INTEGER));
  let data;
  if (action === "write") {
    const baseRev = integer("base-rev", 0, Number.MAX_SAFE_INTEGER);
    if (!flags.title?.trim() || flags.title.length > 200 || !flags.file) throw new Error("write requires --title (1–200 characters) and --file");
    const body = (io.readFile ?? readFileSync)(flags.file, "utf8");
    if (typeof body !== "string" || body.length > 50000) throw new Error("Document exceeds 50000 characters");
    data = { title: flags.title.trim(), body, baseRev };
  }
  const conn = await (io.connection ?? connection)({ env: io.env ?? process.env, cwd: io.cwd ?? process.cwd() });
  const path = `/api/rooms/${encodeURIComponent(conn.roomId)}/docs${action === "list" ? "" : `/${encodeURIComponent(positional[0])}`}${query.size ? `?${query}` : ""}`;
  const response = await (io.fetchImpl ?? fetch)(conn.origin + edgeDoorApiPath(conn.origin, path), {
    method: data ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { Authorization: bearerHeader(conn.secret), ...(data ? { "Content-Type": "application/json" } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${result.error?.code ?? "request_failed"}: ${result.error?.message ?? "Request failed"}`);
  out(JSON.stringify(result));
  return 0;
}
