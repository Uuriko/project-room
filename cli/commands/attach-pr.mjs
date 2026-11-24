import { parseArgs } from "node:util";
import { connection } from "./code.mjs";
import { bearerHeader } from "../auth.mjs";
import { edgeDoorApiPath } from "../../server/agent-discovery.mjs";

export async function attachPrCommand(argv, io = {}) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    head: { type: "string" }, "refresh-head": { type: "string" }, "work-revision": { type: "string" }, "operation-id": { type: "string" }, connection: { type: "string" }
  } });
  if (positionals.length !== 2 || !values.head || !/^\d+$/.test(values["work-revision"] ?? "") || !values["operation-id"])
    throw new Error("Usage: room attach-pr WORK_ID PR_URL --head SHA --work-revision NUMBER --operation-id ID");
  const conn = await connection({ env: io.env, cwd: io.cwd, name: values.connection });
  const [workItemId, pullRequest] = positionals;
  const path = edgeDoorApiPath(conn.origin, `/api/rooms/${encodeURIComponent(conn.roomId)}/github-work-attachment`);
  const response = await (io.fetch ?? fetch)(conn.origin + path, { method: "POST", redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: bearerHeader(conn.secret), "Content-Type": "application/json" },
    body: JSON.stringify({ workItemId, pullRequest, expectedHead: values.head,
      expectedRevision: Number(values["work-revision"]), operationId: values["operation-id"], refreshHead: values["refresh-head"] }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? `Room request failed (${response.status}).`);
  (io.stdout ?? process.stdout).write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}
