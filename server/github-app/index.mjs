// Shared GitHub App core.
//
// VL-2 renders a receipt comment. GH-APP-1 and later should import this
// module for webhook verification, the App JWT, and installation tokens
// instead of copying them. A later manifest that asks for issues access is
// a separate JSON file; it should still call these functions.
export { parseEvent, verifyWebhook, WEBHOOK_BODY_LIMIT, WEBHOOK_EVENTS } from "./verify.mjs";
export { GITHUB_API, GitHubAppError, appJwt, githubAppCredentials, installationToken } from "./auth.mjs";
export { COMMENT_LIMIT, MARKER_PREFIX, ROOM_ORIGIN, TURN_OFF_URL, claimMarker, renderPrComment } from "./render.mjs";
export { REPO_CONFIG_LIMIT, REPO_CONFIG_PATH, fetchRepoConfig, parseRepoConfig } from "./repo-config.mjs";
export { DAILY_POST_CAP, shouldPost } from "./policy.mjs";

export const MANIFEST_PERMISSIONS = Object.freeze({
  pull_requests: "write",
  checks: "write",
  contents: "read",
  metadata: "read",
});

export const MANIFEST_EVENTS = Object.freeze([
  "pull_request",
  "check_suite",
  "installation",
  "installation_repositories",
]);

export const MANIFEST_SETUP_URL = "https://room.trydemigod.com/github/setup";
export const MANIFEST_WEBHOOK_URL = "https://room.trydemigod.com/api/github/webhook";
