// `.github/project-room.yml` for the GitHub App (VL-2a).
//
// A tiny top-level reader, not a general YAML parser. Unknown keys are
// ignored. The file is capped at 64 KB. The fetch uses the installation
// token and does not follow redirects, so the token stays on api.github.com.
import { GitHubAppError, GITHUB_API } from "./auth.mjs";

export const REPO_CONFIG_LIMIT = 64 * 1024;
export const REPO_CONFIG_PATH = ".github/project-room.yml";
const RECEIPTS = new Set(["full", "minimal", "check", "off"]);
const NAME = /^[A-Za-z0-9_.-]+$/;

function unquote(value) {
  const text = value.trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

export function parseRepoConfig(text) {
  if (typeof text !== "string") return { ok: false, reason: "invalid", receipts: null, reviewLink: null };
  if (Buffer.byteLength(text, "utf8") > REPO_CONFIG_LIMIT) return { ok: false, reason: "too_large", receipts: null, reviewLink: null };
  let receipts = null;
  let reviewLink = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = unquote(match[2]);
    if (match[1] === "receipts" && RECEIPTS.has(value)) receipts = value;
    else if (match[1] === "review_link" && (value === "true" || value === "false")) reviewLink = value === "true";
  }
  return { ok: true, receipts, reviewLink };
}

function safeName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 100 && NAME.test(value);
}

async function readCapped(response) {
  const declared = response.headers?.get?.("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > REPO_CONFIG_LIMIT) return null;
  if (typeof response.text !== "function") return null;
  const text = await response.text();
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > REPO_CONFIG_LIMIT) return null;
  return text;
}

export async function fetchRepoConfig({ owner, repo, token, fetchFn = globalThis.fetch }) {
  if (typeof token !== "string" || token.length === 0) throw new GitHubAppError("not_configured", "GitHub App installation token is not set");
  if (!safeName(owner) || !safeName(repo)) throw new GitHubAppError("invalid_repo", "repository name is not valid");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${REPO_CONFIG_PATH}`;
  let response;
  try {
    response = await fetchFn(url, {
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.raw+json",
        "User-Agent": "project-room",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    throw new GitHubAppError("config_failed", "GitHub repository config request failed");
  }
  if (response?.status === 404) return { ok: true, receipts: null, reviewLink: null, source: "missing" };
  if (!response || response.ok !== true) throw new GitHubAppError("config_failed", "GitHub refused the repository config read");
  const text = await readCapped(response);
  if (text == null) return { ok: false, reason: "too_large", receipts: null, reviewLink: null, source: "file" };
  return { ...parseRepoConfig(text), source: "file" };
}
