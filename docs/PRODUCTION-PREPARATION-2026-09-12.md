# Production preparation — not a launch receipt

John explicitly requested publication and a complete usable production experience.
No application deployment, live migration or paid-plan change occurred. Production
authentication DNS was configured and verified in the subsequent launch pass below.

## Verified

- Live readiness returns ready; live source remains
  a5f2dca32be0f3ba725608d3c89ce16c635b2c30, schema26.
- Cloudflare deployment history shows a failed deployment followed by rollback
  on September12 at04:07UTC to9f29e562-ce35-4ea9-b702-fc01d7ff73ca.
- Isolated c79dfa5850923c14a00a735d6f9056971e23b548 builds with Wrangler4.116.0:
  28 application assets,640.96KiB bundle,139.03KiB gzip. Dry-run only.
- Fixed obsolete HTTP landing-copy expectation; full Workers HTTP scenario passes.
- Fixed hardcoded schema30 expectations in Workers upgrade tests to use current
  schema33. All22 real-runtime v8–v29 upgrade, rollback, old-writer refusal and
  restart scenarios pass, including v26 used by the live source.
- Replaced the fabricated v7 schema (current tables minus a denylist) with actual
  frozen884d086d37283ba6937eb6e5f6624e38f8768e87 source. The v7→v33 migration,
  rollback, cached-writer refusal and restart scenario passes.
- Compatibility2, bootstrap1, store1 and maintenance1 also pass. Total29 current
  Cloudflare non-browser scenarios pass across these runs. Historical recovery
  app-switch tests2 also pass, but only for frozen schema8/12 packages, NOT33.
- Earlier application checkpoint8289581:1290 Node tests and mobile guide test pass.

## Still required before calling this production-ready

1. Browser provider login and refresh wired to the verified exchange. Existing
   endpoint is optional and not configured in Worker or server entrypoints.
2. Production Clerk environment and authentication DNS are now verified; real
   email delivery and custom Google OAuth configuration remain to be tested.
   Proposed canonical app host: room.trydemigod.com, isolated from marketing pages;
   both requested domain entry pages should lead there. Neither room subdomain
   returned application DNS records in the earlier read-only check.
3. Production instance ins_3JFb4xTLkAurvyARPwtxOd004Us is now confirmed in the
   existing Clerk application. The five one-time Domain Connect CNAMEs for clerk,
   accounts, clkmail, clk._domainkey and clk2._domainkey were authorized and checked
   against authoritative DNS. Clerk reports all verified; certificates still
   showed Issuing in the dashboard; subsequent HTTPS public JWKS fetch succeeds
   with status200 and normal certificate verification. Public key ID matches the
   production instance. Issuer: https://clerk.trydemigod.com.
   This does not publish room.trydemigod.com. No secret keys were revealed or
   copied, and no paid upgrade was selected.
4. Verified operator identity and moderation recovery; no first-signup or email-only
   superadmin bypass. Never publish an owner key or disable authorization to launch.
5. Self-service private room creation now passes 1293 full Node tests and two
   desktop/mobile browser checks, including a lost-response retry creating only
   one room. New rooms bind ownership to the authenticated durable account,
   have no other members, and enforce quotas and exact retry semantics.
   Per-human scoped agent sponsorship remains required. Current
   agent connection issuance remains owner-only. Contribute work is the UI default.
6. Request-bound emoji action controls as approved by John. Proposal now explicitly
   permits emoji-only approval within existing authority; it is not implemented.
7. Actual provider recovery/PITR drill and compatible schema33 recovery plan.
   Local migration rollback tests do not prove hosted disaster recovery. Do not
   roll schema33 back to the schema26 code against the same migrated database.
8. Hosted two-user sign-in, chat/reconnect, revocation, agent operation, admin and
   first-room checks, then verify both domain entrypoints and exact served assets.

## Verified provider renewal implementation

The optional refresh endpoint now verifies a fresh signed provider assertion,
requires current account session, CSRF and binding, and preserves that browser's
identity generation. It replaces only that slot's credential parent; another
browser's expiry is not extended. Expired unreferenced credentials for that
account are reclaimed to prevent renewal exhausting the retention cap. Changed
identity, logout, revocation, expired sessions and stale bindings fail closed.
Out-of-order valid assertions cannot shorten current expiry. Focused provider
and verifier tests:13 pass. Browser refresh integration remains outstanding.
Full regression after renewal:1296 tests pass, zero failures/skips (202860ms).
Grok independently reports ad18f33 private-room/runtime checks5/5; browser checks
were not repeated by Grok. The live version endpoint still serves a5f2dca.

The browser AccountClient now exposes provider sign-in and renewal. Renewal keeps
the same account object/generation and monotonically updates expiry; late results
cannot restore a signed-out/replaced account. Transport failures preserve drafts,
while confirmed authority loss invalidates ownership.49 focused client, provider,
attachment, reconnect and cookie checks pass. Grok independently reviewed the
ecafc8a backend checkpoint:13/13. SDK loading, the visible Join control and its
renewal scheduler are not yet connected; these methods alone are not usable login.
Full regression after browser-client changes:1302 pass, zero failed/skipped (55262ms).

## Deployment configuration (not enabled live)

Node and Worker entrypoints now accept ROOM_CLERK_ISSUER,
ROOM_CLERK_PUBLISHABLE_KEY and ROOM_CLERK_PUBLIC_KEY together. All absent keeps
legacy access; any partial setting fails startup. The publishable key must encode
the exact HTTPS issuer, the pinned RSA key must validate, and test keys are limited
to loopback app origins. Authorized parties are the single configured app origin.
GET /api/auth-config exposes only provider/issuer/publishableKey, with no-store;
the signing verification key and all other server configuration are excluded.
The renewal helper also rejects malformed/non-HTTPS issuer configuration directly.
Same issuer/subject with a different valid provider session ID may renew: identity
is account-bound, not bound to the first provider session. Provider-side revocation
is bounded by assertion expiry, not promised instantaneous without a revocation
feed. Grok's session-ID observation is recorded as this explicit contract, not a
claim of a verified cross-account bypass.

The SDK integration must follow the provider's current
[JavaScript quickstart](https://clerk.com/docs/js-frontend/getting-started/quickstart)
and [CSP requirements](https://clerk.com/docs/guides/secure/best-practices/csp-headers).
Existing CSP has not yet been broadened and no SDK is loaded by these changes.
Configuration checkpoint verification:1305 full Node tests pass, zero skips
(57525ms);5 Worker compatibility/bootstrap/maintenance/HTTP scenarios pass;
both exact-commit and uncommitted-candidate cold packaging checks pass. These
checks do not substitute for a real provider browser sign-in journey.

## Visible Join candidate

Configured instances now show Join with key/invite recovery collapsed. The app
loads Clerk UI1/JS6 only for Join, returning provider authentication, or provider
sign-out. Explicit sign-in intent survives OAuth navigation without storing a
token. The exchange opens Welcome for new users, or the explicitly requested
room. Existing provider account restores retain their room selection. Renewal
uses the guarded account client on a bounded timer; confirmed expiry clears
access, while a brief network failure preserves drafts. Sign-out clears pending
Join intent and ends provider authentication before local account logout.

Provider-only CSP allows the configured issuer and documented bot-protection
hosts, inline styles for provider components, Clerk images and blob workers.
It does NOT allow inline scripts or eval. Unconfigured instances retain the
previous strict CSP and visible key controls. Marketing door CSP is unchanged.

Synthetic-provider browser checks pass at390/1280: actual RSA-verified Welcome
admission, no elevated member permissions, narrow-screen layout, renewal retaining
an unsent draft, and provider/local sign-out. Legacy New room browser checks2/2
also pass. The provider SDK is intercepted in these tests; real hosted email,
Google, OAuth redirect, CSP compatibility and session restoration remain gates.
Full candidate regression:1305 pass, zero failed/skipped (60753ms); current
Workers HTTP scenario also passes. Grok independently reports c9d957d client19/19
and b3728f0 config16/16 plus auth-config HTTP2/2; visible Join review is separate.

Join lifecycle follow-up: rejected Join clears intent so later SDK events cannot
retry it without another user click. Provider sign-out advances a lifecycle fence;
late renewals cannot restart its timer or end replacement access. The sign-out
handlers recheck their original account/room ownership after awaiting the provider
before issuing local logout. Both390/1280 browser checks now cover rejected Join,
provider re-emission without a click, explicit retry, draft-preserving renewal,
and a deliberately delayed renewal arriving after sign-out.
Regression after lifecycle follow-up:1305 pass, zero failed/skipped (87235ms).

Release copy retained at /Users/johnpotter/src/project-room-release-20260912-c79dfa5.
It contains generated stamp/assets from the successful dry-run; don't stamp again
without a fresh clean candidate. Integration .wrangler cache was not removed.
