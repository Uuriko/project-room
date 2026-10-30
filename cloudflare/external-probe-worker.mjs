// Scheduled entry for the external probe. GET /status returns the last
// stored result and does not run checks or send notices. Every other
// request stays closed.
import { probeStatusResponse, runExternalProbe } from "./external-probe.mjs";

export default {
  async scheduled(_controller, env, ctx) {
    const run = runExternalProbe(env);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(run);
    return run;
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/status") return probeStatusResponse(request, env);
    return new Response("This worker runs on a schedule.\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
    });
  }
};
