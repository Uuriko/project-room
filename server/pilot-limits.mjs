// Bounded pilot capacity limits for a room, as a leaf module.
//
// server/store.mjs used to own PILOT_LIMITS, which created import cycles:
// modules that store.mjs's write paths interact with (invites, share links,
// referrals, work-claim integrity, ...) imported the constants FROM
// store.mjs, tying them into the store's strongly connected component.
// PILOT_LIMITS now lives here, following the server/service-error.mjs
// pattern (the ServiceError half of F-16); store.mjs imports it and
// re-exports it, so every existing
// `import { PILOT_LIMITS } from "./store.mjs"` keeps resolving to this
// exact frozen object. This module imports nothing.
//
// F5: the bounded pilot caps in one place. The room write paths enforce
// them; server/usage-summary.mjs reports them with the remaining headroom.
// G11 (2026-10-06): muse-room reached 82% of the 4 MB projection and was
// ~0.7 days from refusing writes, with the event cap ~10 days out. Raised per
// the owner's word relayed at room seq 3425. Every event cap check reads
// eventsPerRoom from here (tests/pilot-limits-single-source.test.js).
// Keep the application guard at 4 MiB. Bodies-at-rest supplies projection
// headroom; a larger guard does not establish the deployed storage ceiling.
export const PILOT_LIMITS = Object.freeze({ eventsPerRoom: 1_000_000, membersPerRoom: 100, workItemsPerRoom: 500, projectionBytes: 4 * 1024 * 1024 });
