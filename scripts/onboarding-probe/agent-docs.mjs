// Follow GET /llms.txt. Hosts in the packet are rewritten to the target.
// The documented display name is replaced with a qa-prefixed name.
// Board curls run only when the packet itself shows a work-claim done call.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  boardCloseCurls, elapsed, emptyCreated, executeCurl, probeFetch, qaStamp, rewriteHosts, sectionCurls, writeJson,
} from "./lib.mjs";

function stepName(curl) {
  const url = curl.url || "";
  if (url.includes("/agent-identities")) return "mint-identity";
  if (url.includes("/agent-rooms")) return "create-room";
  if (url.includes("/mcp") && (curl.data || "").includes("tools/list")) return "tools-list";
  if ((curl.data || "").includes("room_post_message")) return "post";
  return "documented-call";
}

function remember(created, secret, body) {
  if (typeof body.secret === "string" && typeof body.identityId === "string") {
    secret.current = body.secret;
    created.identities.push({ id: body.identityId, secret: body.secret });
  }
  if (typeof body.roomId === "string" && secret.current) {
    secret.roomId = body.roomId;
    created.rooms.push({ id: body.roomId, auth: "bearer", secret: secret.current });
  }
}

export async function runAgentDocs({ target, outDir = null, created = emptyCreated(), round } = {}) {
  const origin = String(target).replace(/\/$/, "");
  const started = performance.now();
  const steps = [];
  const confusions = [];
  const name = qaStamp(round);
  let calls = 0;
  const secret = { current: null, roomId: null };
  const read = await probeFetch(`${origin}/llms.txt`);
  calls += 1;
  steps.push({ step: "read-llms", t: elapsed(started), calls, bytes: read.bytes, status: read.status });
  if (read.status !== 200) {
    confusions.push("llms.txt did not answer, so the documented calls were not run.");
    return finish(outDir, { steps, firstPost: null, firstClose: null, closeReachable: false, confusions });
  }
  const packet = rewriteHosts(read.text, origin);
  const curls = sectionCurls(packet).filter(curl => !/\/llms\.txt$/.test(curl.url));
  let firstPost = null;
  for (const curl of curls) {
    const data = curl.data ? curl.data.replaceAll('"displayName":"Ada"', `"displayName":"${name}"`) : curl.data;
    const done = await executeCurl({ ...curl, data }, { secret: secret.current, roomId: secret.roomId, target: origin });
    calls += done.calls;
    const step = { step: stepName(curl), t: elapsed(started), calls, bytes: done.bytes, status: done.response.status };
    steps.push(step);
    remember(created, secret, done.response.json ?? {});
    if (step.step === "post" && done.response.status < 300) firstPost = { t: step.t, calls };
  }
  if (!firstPost) confusions.push("The documented post did not succeed.");
  const board = boardCloseCurls(packet);
  const closeReachable = board.length > 0;
  let firstClose = null;
  if (!closeReachable) {
    confusions.push("The packet has no work-claim close, so this path does not invent board calls.");
  } else {
    for (const curl of board) {
      const done = await executeCurl(curl, { secret: secret.current, roomId: secret.roomId, target: origin });
      calls += done.calls;
      const step = { step: "board-close", t: elapsed(started), calls, bytes: done.bytes, status: done.response.status };
      steps.push(step);
      if (done.response.status < 300) firstClose = { t: step.t, calls };
    }
    if (!firstClose) confusions.push("The packet documents a work-claim close, and that call did not succeed.");
  }
  return finish(outDir, { steps, firstPost, firstClose, closeReachable, confusions });
}

function finish(outDir, result) {
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeJson(join(outDir, "agent-docs.json"), result);
  }
  return result;
}
