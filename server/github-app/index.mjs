// Shared GitHub App core.
//
// VL-2 renders a receipt comment. GH-APP-1 and later should import this
// module for webhook verification, the App JWT, and installation tokens
// instead of copying them. A later manifest that asks for issues access is
// a separate JSON file; it should still call these functions.
export { parseEvent, verifyWebhook, WEBHOOK_BODY_LIMIT, WEBHOOK_EVENTS } from "./verify.mjs";
export { GITHUB_API, GitHubAppError, appJwt, githubAppCredentials, installationToken } from "./auth.mjs";
export { COMMENT_LIMIT, MARKER_PREFIX, ROOM_ORIGIN, TURN_OFF_URL, claimMarker, renderPrComment } from "./render.mjs";
import { ROOM_ORIGIN as HOSTED_ORIGIN } from "./render.mjs";
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

// URLs for one Room instance. `origin` must be that instance's exact HTTPS
// origin (no path, query or fragment). The default is the original hosted
// service, which `github-app/manifest.json` registers.
export function manifestUrls(origin = HOSTED_ORIGIN) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new TypeError("GitHub App manifest needs an exact HTTPS origin");
  return Object.freeze({ origin: url.origin, setupUrl: `${url.origin}/github/setup`, webhookUrl: `${url.origin}/api/github/webhook` });
}

export const MANIFEST_SETUP_URL = manifestUrls().setupUrl;
export const MANIFEST_WEBHOOK_URL = manifestUrls().webhookUrl;

// The manifest an operator registers for their own instance.
export function githubAppManifest(origin = HOSTED_ORIGIN) {
  const { origin: base, setupUrl, webhookUrl } = manifestUrls(origin);
  return {
    name: "Project Room",
    url: base,
    description: "Posts one receipt comment on a pull request linked to a Project Room claim, and updates that same comment in place.",
    hook_attributes: { url: webhookUrl },
    redirect_url: setupUrl,
    callback_urls: [setupUrl],
    setup_url: setupUrl,
    request_oauth_on_install: true,
    public: true,
    default_permissions: { ...MANIFEST_PERMISSIONS },
    default_events: [...MANIFEST_EVENTS],
  };
}
