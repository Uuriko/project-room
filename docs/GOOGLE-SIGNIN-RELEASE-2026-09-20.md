# Google sign-in activation, 20 September 2026

The production origin is `https://project-room-staging.getdasha.workers.dev` (despite the historical staging name). Google project `project-room-508502` is external and in production. Its existing locally available web client now permits `/api/auth/google/callback` on that origin; the existing localhost Gmail callback is preserved. Sign-in requests only `openid email profile`, with PKCE S256 and no incremental Gmail grants.

Credentials are Cloudflare secret bindings `ROOM_GOOGLE_CLIENT_ID` and `ROOM_GOOGLE_CLIENT_SECRET`; values are never committed. The other client configured for room.trydemigod.com was left unchanged.

Activation revealed an existing database-upgrade defect: `oauth_pending_states` was nested in the invitation schema, so fresh databases had it but established v35 databases could lack it. Extract the unchanged table definition and converge it on every store open, as an additive unfenced table. No existing rows or schema version are changed.

The Workers regression boots both a fresh database and a synthetic existing v35 database without the table. The existing-database case reproduced HTTP500 before the fix. Both must return Google redirects with the expected callback, basic identity scopes, PKCE, and an HttpOnly account session cookie. The check is included in local and CI Workers gates.

Release this narrow repair from the deployed 5ca5196 source; do not pull unrelated main changes into production. Confirm live start302, real Google callback/account home, health/version, and unchanged public assets. Keep the qualified emergency maintenance version e3f46087-8f86-4146-bb72-de81be1e0b8e available; never use incompatible old7db as rollback.

Real provider callback testing also exposed an unsupported Workers fetch option: `redirect: error`. Use `manual` and retain the existing non-2xx refusal. The Workers JWT fixture constructs real runtime Requests before serving synthetic keys and checks provider redirects are rejected. Callback diagnostics forward only bounded error codes, never provider bodies, tokens or identities.

The full Workers HTTP callback regression also found that storing native fetch as a class method supplied an invalid receiver. Wrap the injected function so it is invoked without the class receiver. Provider fixtures now intercept outbound HTTP beneath the native Workers fetch implementation, exercising token exchange, signature validation, automatic account creation, and authenticated session recovery together.
