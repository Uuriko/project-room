// Scheduled entry for the external probe. Fetch stays closed: a request does
// not run checks or send notices. See docs/ROOM-DEPLOYMENT.md.
import { runExternalProbe } from "./external-probe.mjs";

export default {
  async scheduled(_controller, env, ctx) {
    const run = runExternalProbe(env);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(run);
    return run;
  },
  async fetch() {
    return new Response("This worker runs on a schedule.\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
    });
  }
};
