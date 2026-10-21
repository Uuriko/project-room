// Call one hosted Room MCP tool with the saved connection. Returns the tool's
// structuredContent, or throws with the server's message. Prints no secret.
import { randomUUID } from "node:crypto";
import { bearerHeader, mcpUrl } from "./auth.mjs";

export async function callTool(conn, name, args, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(mcpUrl(conn.origin), {
    method: "POST", redirect: "error",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: bearerHeader(conn.secret) },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json().catch(() => null);
  const result = body?.result;
  if (!response.ok || body?.error || !result || result.isError) {
    throw new Error(`${name} failed (${response.status}): ${body?.error?.message ?? result?.content?.[0]?.text ?? "request failed"}`);
  }
  return result.structuredContent ?? {};
}
