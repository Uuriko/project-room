// Sign-in options group (H3, #3341). One public GET: the capability feed
// for the logged-out wall — the same configuration probes the
// session-scoped /api/auth/methods reports, minus anything account-shaped.
// Configuration booleans are not secret (the magic request route already
// answers mail_not_configured to anyone), and the wall needs them BEFORE a
// session exists so it never offers a method this deployment cannot serve
// (e.g. email-code sign-in with no mail provider configured). Born in the
// route table: new routes join the table; the legacy allowlist only
// shrinks. The auth group stays POST-only, so this GET lives in its own
// group, like the desktop-auth GETs.

import { resolvePasskeyParams } from "../account-passkeys.mjs";

async function handleSigninOptions(ctx) {
  const { res, json, magicMailer, expectedOrigin, githubClient, googleClient } = ctx;
  const configured = probe => { try { return probe() !== null; } catch { return false; } };
  return json(res, 200, {
    providers: {
      github: { configured: configured(() => githubClient()) },
      google: { configured: configured(() => googleClient()) },
      passkey: { configured: resolvePasskeyParams(expectedOrigin()) !== null },
      mail: { configured: magicMailer.isConfigured() },
    },
  });
}

export const SIGNIN_OPTIONS_ROUTES = Object.freeze([
  {
    id: "auth.signin.options", method: "GET", path: "/api/auth/signin-options", auth: "none",
    capability: null, events: [], scope: "worker", handler: handleSigninOptions,
    parity: "exempt:human sign-in capability feed; agents read provider status via the session-scoped methods route",
    schema: { response: { type: "object" } },
  },
]);
