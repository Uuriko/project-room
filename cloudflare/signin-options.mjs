// Worker-side answer for GET /api/auth/signin-options (P0-5).
//
// The route is declared scope "worker" in server/routes/signin-options.mjs,
// but until now that only described the Node route table inside the Durable
// Object: the Worker forwarded the request, so the logged-out sign-in wall
// paid a full DO wake just to learn four configuration booleans. This module
// computes the same answer from the Worker's env, the way /api/health's
// emailVerification is computed in cloudflare/room.mjs, so the request never
// touches the Durable Object.
//
// Parity rule: reuse the object's own derivations, never hand-copy them.
// The Durable Object constructor (cloudflare/room.mjs) builds its config
// with githubConfig(env, env.ROOM_ORIGIN) / googleConfig(env,
// env.ROOM_ORIGIN) under a try/catch that disables the provider on a throw,
// and builds its mailer from magicLinkMailerFromEnv(env); the DO handler
// (server/routes/signin-options.mjs) then probes the factories those configs
// feed. Each probe below mirrors one of those steps exactly, including the
// throw-to-false semantics:
//   github/google — config factory throws (partial or invalid pair) reads
//     as not configured, exactly as the DO constructor's catch and the
//     handler's probe wrapper both produce.
//   mail — createMagicLinkMailer({ send }).isConfigured() is true exactly
//     when magicLinkMailerFromEnv(env) returns a send function.
//   passkey — resolvePasskeyParams(origin) !== null. The object handler
//     does NOT wrap this probe: for an http non-loopback origin it throws
//     422 instead of answering. That combination is unreachable here —
//     room.mjs refuses any request whose origin is not the exact https
//     ROOM_ORIGIN before this code runs — so a throw is folded to false.
//
// One combination is also deliberately not reproduced: the object handler
// re-runs the http.mjs github() factory on its stored config, which throws
// "Invalid GitHub authentication configuration" when the stored redirect URI
// was overridden to a disallowed shape. The DO constructor only ever stores
// the redirect URI githubConfig itself minted, so that throw cannot fire
// for a config this function just validated; a hand-overridden redirectUri
// is not an env combination and is named in the P0-5 PR body.

import { githubConfig } from "../server/github-oauth.mjs";
import { googleConfig } from "../server/google-oauth.mjs";
import { magicLinkMailerFromEnv } from "../server/resend-mailer.mjs";
import { resolvePasskeyParams } from "../server/account-passkeys.mjs";

const configured = probe => { try { return probe() !== null; } catch { return false; } };

export function signinOptionsFromEnv(env, origin) {
  return {
    providers: {
      github: { configured: configured(() => githubConfig(env, origin)) },
      google: { configured: configured(() => googleConfig(env, origin)) },
      passkey: { configured: configured(() => resolvePasskeyParams(origin, env?.ROOM_PASSKEY_RP_ID)) },
      mail: { configured: magicLinkMailerFromEnv(env) !== null },
    },
  };
}

export function signinOptionsResponse(request, env, origin) {
  return new Response(JSON.stringify(signinOptionsFromEnv(env, origin)), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
