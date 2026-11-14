// GitHub App JWT and installation tokens (VL-2a).
//
// GH-APP-1 and VL-2b call this instead of minting their own tokens. Secrets
// are read from the environment only: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY,
// GITHUB_APP_WEBHOOK_SECRET. Each name also answers to its ROOM_-prefixed
// variant (the production Worker inventory carries ROOM_GITHUB_APP_*); the
// canonical name wins when both are set. When any of them is missing the
// helpers stay inert (credentials() is null; token calls throw
// not_configured). Key material is never put in an error message.
//
// The JWT is RS256 via WebCrypto. iat is 60 seconds behind the clock and exp
// is 9 minutes ahead, which stays inside GitHub's 10 minute maximum. An
// installation token is cached until 5 minutes before it expires.

export const GITHUB_API = "https://api.github.com";
const TOKEN_SKEW_MS = 5 * 60 * 1000;
const processCache = new Map();

export class GitHubAppError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GitHubAppError";
    this.code = code;
  }
}

function readEnv(env, key) {
  const value = env?.[key];
  return typeof value === "string" ? value.trim() : "";
}

// The Worker's secret inventory names the App credentials ROOM_GITHUB_APP_*
// while this module's canonical names drop the prefix. Either spelling
// configures the App; the canonical name wins when both are set.
function readEnvAny(env, key) {
  return readEnv(env, key) || readEnv(env, `ROOM_${key}`);
}

function normalizePem(value) {
  return (value.includes("\\n") ? value.replace(/\\n/g, "\n") : value).trim();
}

export function githubAppCredentials(env = process.env) {
  const appId = readEnvAny(env, "GITHUB_APP_ID");
  const privateKey = readEnvAny(env, "GITHUB_APP_PRIVATE_KEY");
  const webhookSecret = readEnvAny(env, "GITHUB_APP_WEBHOOK_SECRET");
  if (!appId || !privateKey || !webhookSecret) return null;
  if (!/^\d{1,20}$/.test(appId)) return null;
  return { appId, privateKeyPem: normalizePem(privateKey), webhookSecret };
}

// The installation id is a public numeric identifier, not a secret: it
// names the installation installationToken() mints for. It is read from
// the environment under the same canonical/ROOM_ pair as the credentials
// and is valid only as a bare numeric string.
export function githubAppInstallationId(env = process.env) {
  const id = readEnvAny(env, "GITHUB_APP_INSTALLATION_ID");
  return /^\d{1,20}$/.test(id) ? id : null;
}

function derLength(length) {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function derSequence(contents) {
  return concatBytes([Uint8Array.of(0x30), derLength(contents.length), contents]);
}

function concatBytes(parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// GitHub's downloaded key is PKCS#1 ("BEGIN RSA PRIVATE KEY"). WebCrypto
// imports PKCS#8, so a PKCS#1 key is wrapped here. The bytes are not logged.
function pemToPkcs8(pem) {
  const match = String(pem).match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]+?)-----END \1-----/);
  if (!match) throw new GitHubAppError("invalid_key", "GitHub App private key is not a PEM");
  const der = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (match[1] === "PRIVATE KEY") return der;
  if (match[1] !== "RSA PRIVATE KEY") throw new GitHubAppError("invalid_key", "GitHub App private key must be PKCS#8 or PKCS#1 RSA");
  const algorithm = Buffer.from("300d06092a864886f70d0101010500", "hex");
  const octet = concatBytes([Uint8Array.of(0x04), derLength(der.length), der]);
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  return derSequence(concatBytes([version, algorithm, octet]));
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

export async function appJwt({ appId, privateKeyPem, now = Date.now() } = {}) {
  if (!/^\d{1,20}$/.test(String(appId ?? ""))) throw new GitHubAppError("not_configured", "GitHub App id is not set");
  if (typeof privateKeyPem !== "string" || privateKeyPem.length === 0) throw new GitHubAppError("not_configured", "GitHub App private key is not set");
  let pkcs8;
  try { pkcs8 = pemToPkcs8(privateKeyPem); }
  catch (error) {
    if (error instanceof GitHubAppError) throw error;
    throw new GitHubAppError("invalid_key", "GitHub App private key could not be read");
  }
  const seconds = Math.floor(now / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 9 * 60, iss: String(appId) })));
  const signingInput = new TextEncoder().encode(`${header}.${payload}`);
  const keyBytes = pkcs8.buffer.slice(pkcs8.byteOffset, pkcs8.byteOffset + pkcs8.byteLength);
  let key;
  try {
    key = await crypto.subtle.importKey("pkcs8", keyBytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    throw new GitHubAppError("invalid_key", "GitHub App private key could not be read");
  }
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, signingInput));
  return `${header}.${payload}.${base64url(signature)}`;
}

function clockOf(now) {
  const value = typeof now === "function" ? now() : now;
  return Number.isFinite(value) ? value : Date.now();
}

// A caller that needs less than the App's full grant can narrow the mint:
// GitHub accepts a permissions object on the access_tokens POST and issues
// a token carrying only that subset (each name at or below the level the
// App itself holds). The body is deterministic — names sorted — and the
// cache key carries the subset, so a narrowed token never answers an
// un-narrowed caller or the reverse. Omitting the option mints exactly as
// before: no body, the installation's full granted set.
function narrowedMint(permissions) {
  if (permissions === undefined) return null;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    throw new GitHubAppError("invalid_permissions", "installation token permissions must be an object of permission levels");
  }
  const names = Object.keys(permissions).sort();
  if (names.length === 0 || names.some(name => !["read", "write", "admin"].includes(permissions[name]))) {
    throw new GitHubAppError("invalid_permissions", "installation token permissions must name read, write, or admin levels");
  }
  const subset = {};
  for (const name of names) subset[name] = permissions[name];
  return { key: names.map(name => `${name}:${subset[name]}`).join(","), body: JSON.stringify({ permissions: subset }) };
}

export async function installationToken(installationId, { env = process.env, fetchFn = globalThis.fetch, now = Date.now, cache = processCache, permissions = undefined } = {}) {
  const narrowed = narrowedMint(permissions);
  const credentials = githubAppCredentials(env);
  if (!credentials) throw new GitHubAppError("not_configured", "GitHub App credentials are not set");
  const id = String(installationId ?? "");
  if (!/^\d{1,20}$/.test(id)) throw new GitHubAppError("invalid_installation", "installation id must be numeric");
  const clock = clockOf(now);
  const cacheKey = narrowed ? `${id}|${narrowed.key}` : id;
  const hit = cache.get(cacheKey);
  if (hit && clock < hit.refreshAt) return hit.token;
  const jwt = await appJwt({ appId: credentials.appId, privateKeyPem: credentials.privateKeyPem, now: clock });
  let response;
  try {
    response = await fetchFn(`${GITHUB_API}/app/installations/${id}/access_tokens`, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "project-room",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(narrowed ? { "Content-Type": "application/json" } : {}),
      },
      ...(narrowed ? { body: narrowed.body } : {}),
    });
  } catch {
    throw new GitHubAppError("token_failed", "GitHub installation token request failed");
  }
  if (!response || response.ok !== true) throw new GitHubAppError("token_failed", "GitHub refused the installation token request");
  let body;
  try { body = await response.json(); }
  catch { throw new GitHubAppError("token_failed", "GitHub installation token response could not be read"); }
  if (typeof body?.token !== "string" || body.token.length === 0) throw new GitHubAppError("token_failed", "GitHub installation token response had no token");
  const expiresAt = Date.parse(body.expires_at ?? "");
  const refreshAt = Number.isFinite(expiresAt) ? expiresAt - TOKEN_SKEW_MS : clock;
  cache.set(cacheKey, { token: body.token, refreshAt });
  return body.token;
}
