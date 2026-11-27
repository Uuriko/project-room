import { bearerHeader, loadSecret, mcpUrl } from "../auth.mjs";
import { loadConnection } from "../paths.mjs";
import { boundedJson } from "../room-response.mjs";
import { validId } from "../../src/events.js";

const HELP = "room next [--source work|requests] [--cursor TOKEN] [--considered-discovery TOKEN]\nRead addressed work and incoming formal requests for the saved Room. Outputs JSON. Follow nextRead even when a pickup page is empty.";

function selectionOf(argv) {
  const args = {};
  const options = new Map([["--source", "source"], ["--cursor", "cursor"], ["--considered-discovery", "consideredDiscovery"]]);
  for (let i = 0; i < argv.length; i += 2) {
    const key = options.get(argv[i]);
    if (!key || Object.hasOwn(args, key) || argv[i + 1] === undefined) throw new Error(HELP);
    args[key] = argv[i + 1];
  }
  if (args.source !== undefined && !["work", "requests"].includes(args.source)
    || args.consideredDiscovery !== undefined && (args.source || !/^[A-Za-z0-9_-]{1,4096}$/.test(args.consideredDiscovery))
    || args.cursor !== undefined && (!args.source || !/^[A-Za-z0-9_-]{1,4096}$/.test(args.cursor)))
    throw new Error(HELP);
  return args;
}

function annotatePickupRead(read, roomId) {
  if (read?.tool !== "room_next" || read.arguments?.roomId !== roomId) return;
  const args = read.arguments;
  if (Object.keys(args).some(key => !["roomId", "source", "cursor", "view", "consideredDiscovery"].includes(key))
      || (args.view !== undefined && args.view !== "pickup")) return;
  const flags = [
    ...(args.source === undefined ? [] : ["--source", args.source]),
    ...(args.cursor === undefined ? [] : ["--cursor", args.cursor]),
    ...(args.consideredDiscovery === undefined ? [] : ["--considered-discovery", args.consideredDiscovery])
  ];
  // Only echo commands accepted by this CLI's argument parser.
  if (flags.some(flag => typeof flag !== "string")) return;
  try { selectionOf(flags); } catch { return; }
  read.command = ["room", "next", ...flags];
}

export async function nextCommand(argv, { cwd = process.cwd(), env = process.env,
  fetchImpl = fetch, out = console.log, err = console.error } = {}) {
  if (argv.length === 1 && argv[0] === "--help") { out(HELP); return 0; }
  const selection = selectionOf(argv);
  const { config, name } = loadConnection({ project: cwd, env });
  try {
    const secret = await loadSecret(name, config.token, env);
    const call = async (name, args) => {
      const response = await fetchImpl(mcpUrl(config.origin), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: bearerHeader(secret) },
        body: JSON.stringify({
          jsonrpc: "2.0", id: "room-next", method: "tools/call",
          params: { name, arguments: { roomId: config.roomId, ...args } }
        })
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Room read failed (HTTP ${response.status}).`);
      }
      const rpc = await boundedJson(response);
      const value = rpc.result?.structuredContent;
      if (args.view === "pickup" && rpc.id === "room-next" && rpc.error?.code === -32602
        && rpc.error.data?.unexpected?.length === 1 && rpc.error.data.unexpected[0] === "view")
        return call(name, selection);
      const matches = value?.contractVersion === 1 && value.roomId === config.roomId && value.viewerId === config.memberId;
      if (rpc.id !== "room-next" || rpc.error || rpc.result?.isError || !matches)
        throw new Error("Room did not return a matching next view. Check connection access and server support.");
      return value;
    };
    const value = await call("room_next", { ...selection, view: "pickup" });
    if (["work", "requests"].some(source => {
      const page = value[source];
      if (selection.source && selection.source !== source) return page !== undefined;
      return !page || !Array.isArray(page.items) || !["complete", "partial", "unavailable"].includes(page.coverage)
        || (page.coverage === "complete" ? page.nextRead !== null : typeof page.nextRead?.tool !== "string");
    })) {
      err("Room returned an invalid next view.");
      return 1;
    }
    annotatePickupRead(value.nextRead, config.roomId);
    for (const source of ["work", "requests"]) {
      const read = value[source]?.nextRead;
      if (read?.arguments?.source === source) annotatePickupRead(read, config.roomId);
    }
    for (const row of value.work?.items ?? []) {
      const args = row.nextRead?.arguments;
      if (row.nextRead?.tool === "room_read_result" && args?.roomId === config.roomId
          && args.workItemId === row.id && validId(args.workItemId) && validId(args.completionEventId)
          && Object.keys(args).every(key => ["roomId", "workItemId", "completionEventId"].includes(key))) {
        row.nextRead.command = ["room", "result", args.workItemId, "--completion", args.completionEventId];
      }
      if (row.nextRead?.tool === "room_read_work" && validId(args?.workItemId)
          && (args.roomId === undefined || args.roomId === config.roomId)
          && args.brief === true && args.includeDiscussion !== true
          && Object.keys(args).every(key => ["roomId", "workItemId", "brief", "includeDiscussion", "includeResult"].includes(key))) {
        row.nextRead.command = ["room", "work", args.workItemId, ...(args.includeResult === true ? ["--result"] : [])];
      }
    }
    for (const row of value.requests?.items ?? []) {
      const args = row.nextRead?.arguments;
      if (row.nextRead?.tool === "room_read_request" && validId(args?.requestMessageId)
          && (args.roomId === undefined || args.roomId === config.roomId)
          && (args.view === undefined || args.view === "compact")
          && Object.keys(args).every(key => ["roomId", "requestMessageId", "view"].includes(key))) {
        row.nextRead.command = ["room", "read", args.requestMessageId];
      }
    }
    // The wire schema keeps newer exact reads in the open ifIdle extension.
    // Shell consumers have always followed the preferred action at nextRead.
    if (value.nextRead === null)
      value.nextRead = value.ifIdle?.discoveryReview?.nextRead ?? value.ifIdle?.investigation?.nextRead ?? null;
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
