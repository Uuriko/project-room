// Anonymous MCP: initialize, then tools/list, then stop.
// OAuth PKCE runs only when staging advertises a protected-resource document
// and the server challenges. That enrollment flow is not available here.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { elapsed, probeFetch, PROBE_VERSION, writeJson } from "./lib.mjs";

export async function runAgentMcp({ target, outDir = null } = {}) {
  const origin = String(target).replace(/\/$/, "");
  const started = performance.now();
  const steps = [];
  const confusions = [];
  let calls = 0;
  const init = await probeFetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "project-room-onboarding-probe", version: PROBE_VERSION } },
    }),
  });
  calls += 1;
  steps.push({ step: "initialize", t: elapsed(started), calls, bytes: init.bytes, status: init.status });
  const list = await probeFetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  calls += 1;
  steps.push({ step: "tools-list", t: elapsed(started), calls, bytes: list.bytes, status: list.status });
  const tools = Array.isArray(list.json?.result?.tools) ? list.json.result.tools : [];
  const oauthDoc = await probeFetch(`${origin}/.well-known/oauth-protected-resource`);
  calls += 1;
  steps.push({ step: "oauth-discovery", t: elapsed(started), calls, bytes: oauthDoc.bytes, status: oauthDoc.status });
  const challenged = list.status === 401 || Boolean(list.headers.get("www-authenticate"));
  if (oauthDoc.status === 200 && challenged) {
    confusions.push("OAuth is advertised and a challenge arrived. Scripted PKCE stays limited to a configured staging origin, and this probe does not complete that enrollment.");
  }
  confusions.push("Anonymous MCP lists the public catalog. This path does not mint a secret, so it does not close work.");
  const result = {
    steps,
    firstPost: null,
    firstClose: null,
    closeReachable: false,
    confusions,
    catalog: { count: tools.length, kilobytes: Math.round((list.bytes / 1024) * 10) / 10, budget: "unknown" },
    oauth: "unavailable",
  };
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeJson(join(outDir, "agent-mcp.json"), result);
  }
  return result;
}
