import { bearerHeader, loadSecret, mcpUrl } from "../auth.mjs";
import { loadConnection } from "../paths.mjs";
import { boundedJson } from "../room-response.mjs";

const HELP = "room next [--source work|requests] [--cursor TOKEN]\nRead addressed work and incoming formal requests for the saved Room. Outputs JSON. Follow each partial source's nextRead.";

function selectionOf(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i] === "--source" ? "source" : argv[i] === "--cursor" ? "cursor" : null;
    if (!key || Object.hasOwn(args, key) || argv[i + 1] === undefined) throw new Error(HELP);
    args[key] = argv[i + 1];
  }
  if (args.source !== undefined && !["work", "requests"].includes(args.source)
    || args.cursor !== undefined && (!args.source || !/^[A-Za-z0-9_-]{1,4096}$/.test(args.cursor)))
    throw new Error(HELP);
  return args;
}

export async function nextCommand(argv, { cwd = process.cwd(), env = process.env,
  fetchImpl = fetch, out = console.log, err = console.error } = {}) {
  if (argv.length === 1 && argv[0] === "--help") { out(HELP); return 0; }
  const selection = selectionOf(argv);
  const { config, name } = loadConnection({ project: cwd, env });
  try {
    const secret = await loadSecret(name, config.token, env);
    const response = await fetchImpl(mcpUrl(config.origin), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: bearerHeader(secret) },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "room-next", method: "tools/call",
        params: { name: "room_next", arguments: { roomId: config.roomId, ...selection } }
      })
    });
    if (!response.ok) {
      err(`Room read failed (HTTP ${response.status}).`);
      return 1;
    }
    const rpc = await boundedJson(response);
    const value = rpc.result?.structuredContent;
    if (rpc.id !== "room-next" || rpc.error || rpc.result?.isError
      || value?.contractVersion !== 1 || value.roomId !== config.roomId || value.viewerId !== config.memberId) {
      err("Room did not return a matching next view. Check connection access and server support.");
      return 1;
    }
    if (["work", "requests"].some(source => {
      const page = value[source];
      if (selection.source && selection.source !== source) return page !== undefined;
      return !page || !Array.isArray(page.items) || !["complete", "partial", "unavailable"].includes(page.coverage)
        || (page.coverage === "complete" ? page.nextRead !== null : typeof page.nextRead?.tool !== "string");
    })) {
      err("Room returned an invalid next view.");
      return 1;
    }
    const output = JSON.stringify(value);
    if (output.includes(secret) || output.includes(config.token)) {
      err("Room returned invalid credential content.");
      return 1;
    }
    out(output);
    return 0;
  } catch {
    err("Could not read Room next. Check the connection and retry.");
    return 1;
  }
}
