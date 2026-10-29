import { projectBoard } from "../src/board.js";
import { stampBoard } from "./content-trust.mjs";
import { buildWorkClaimPage } from "./work-claim-routes.mjs";
import { withProjectMapOverlap } from "./project-map-store.mjs";

// Both transports use the same selected projection, including stop records.
// Claim pages remain live reads; neither read performs lifecycle housekeeping.
export function readBoard(store, token, roomId, fence = null, query = new URLSearchParams()) {
  const snapshot = store.snapshot(token, roomId, fence, "work");
  const now = typeof store.now === "function" ? store.now() : Date.now();
  const { claims, ...claimsPage } = withProjectMapOverlap(store, roomId,
    buildWorkClaimPage(store.workClaims.list(roomId), roomId, snapshot.viewerId, query, now));
  return stampBoard({ ...projectBoard(snapshot.state, now), roomId: snapshot.roomId,
    ...Object.fromEntries(["viewerId", "viewerAccountId", "viewerAuthEpoch", "viewerSessionBinding", "viewerSessionRevision"]
      .map(key => [key, snapshot[key]])),
    evaluatedThrough: snapshot.sequence, evaluatedAt: new Date(now).toISOString(), claims, claimsPage });
}
