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

export async function handleSigninOptions(ctx) {
  const { res, json, magicMailer, expectedOrigin, githubClient, googleClient, store } = ctx;
  const configured = probe => { try { return probe() !== null; } catch { return false; } };
  // #3548: the wall shows the GitHub door only once this deployment's
  // secrets have completed a real sign-in. A GitHub OAuth login method is
  // created and touched (last_used_at) solely by a successful callback, so
  // its presence is the durable record that verification happened — no
  // operator checklist state to drift. Configured-but-never-used stays
  // unverified, and the client gate fails closed on anything but true.
  const githubVerified = () => {
    try {
      return Boolean(store.db.prepare(`SELECT 1 FROM account_login_methods
        WHERE type='oauth' AND provider='github' AND disabled=0 AND last_used_at IS NOT NULL LIMIT 1`).get());
    } catch { return false; }
  };
  return json(res, 200, {
    providers: {
      github: { configured: configured(() => githubClient()), verified: githubVerified() },
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
