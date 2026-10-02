// Whether a GitHub App receipt may be posted or edited (VL-2a).
//
// Post only when the pull request is linked to a claim in a room connected
// to this installation, the repo config is not off, the pull request is not
// from a fork whose author is outside the room, and the installation is
// under the daily cap. An existing Project Room marker is edited in place.
// Edits do not spend the daily cap: the cap limits new comments.
import { MARKER_PREFIX, claimMarker } from "./render.mjs";

export const DAILY_POST_CAP = 200;

function skip(reason) {
  return { post: false, action: "skip", mode: null, reason, marker: null };
}

function linkedUrl(claim) {
  const url = claim?.pullRequest?.url ?? claim?.pullRequestUrl ?? "";
  return typeof url === "string" ? url.trim() : "";
}

function authorIsMember(claim, login) {
  if (typeof login !== "string" || login.length === 0) return false;
  const names = Array.isArray(claim?.memberLogins) ? claim.memberLogins : [];
  const folded = login.toLowerCase();
  return names.some(name => typeof name === "string" && name.toLowerCase() === folded);
}

export function shouldPost({ installation, repo, pr, claim, config, postsToday = 0 } = {}) {
  if (!claim || typeof claim.id !== "string" || !claim.id || typeof claim.roomId !== "string" || !claim.roomId) return skip("not_linked");
  const rooms = Array.isArray(installation?.roomIds) ? installation.roomIds : [];
  if (!rooms.includes(claim.roomId)) return skip("installation_mismatch");
  const want = linkedUrl(claim);
  const got = typeof pr?.url === "string" ? pr.url.trim() : "";
  if (!want || want !== got) return skip("not_linked");
  if (config?.ok === false && config?.reason === "too_large") return skip("config_too_large");
  if (config?.receipts === "off") return skip("receipts_off");
  if (pr?.fromFork === true && !authorIsMember(claim, pr.authorLogin)) return skip("fork_non_member");
  if (!Number.isInteger(postsToday) || postsToday < 0) return skip("invalid_budget");
  const chosen = config?.receipts ?? (repo?.visibility === "private" ? "full" : "minimal");
  if (!["full", "minimal", "check"].includes(chosen)) return skip("receipts_off");
  const marker = claimMarker(claim.id);
  const body = typeof pr?.commentBody === "string" ? pr.commentBody : "";
  const editing = body.includes(marker) || body.includes(MARKER_PREFIX);
  if (!editing && postsToday >= DAILY_POST_CAP) return skip("daily_cap");
  return { post: true, action: editing ? "edit" : "create", mode: chosen, reason: null, marker };
}
