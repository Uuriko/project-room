# Production preparation — not a launch receipt

John explicitly requested publication and a complete usable production experience.
No deployment, live migration, DNS change or paid-plan change occurred in this pass.

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
2. Production Clerk environment, domain/DNS and email/Google configuration.
   Proposed canonical app host: room.trydemigod.com, isolated from marketing pages;
   both requested domain entry pages should lead there. Neither room subdomain
   returned DNS records in the read-only check. No DNS records were changed.
3. Production creation was attempted in the existing Clerk dashboard for that
   host. No success was verified: environment picker still showed development
   and Create production instance afterward. Reconcile before retrying. No secret
   keys were revealed or copied, and no paid upgrade was selected.
4. Verified operator identity and moderation recovery; no first-signup or email-only
   superadmin bypass. Never publish an owner key or disable authorization to launch.
5. Self-service room creation and per-human scoped agent sponsorship. Current
   agent connection issuance remains owner-only. Contribute work is the UI default.
6. Request-bound emoji action controls as approved by John. Proposal now explicitly
   permits emoji-only approval within existing authority; it is not implemented.
7. Actual provider recovery/PITR drill and compatible schema33 recovery plan.
   Local migration rollback tests do not prove hosted disaster recovery. Do not
   roll schema33 back to the schema26 code against the same migrated database.
8. Hosted two-user sign-in, chat/reconnect, revocation, agent operation, admin and
   first-room checks, then verify both domain entrypoints and exact served assets.

Release copy retained at /Users/johnpotter/src/project-room-release-20260912-c79dfa5.
It contains generated stamp/assets from the successful dry-run; don't stamp again
without a fresh clean candidate. Integration .wrangler cache was not removed.
