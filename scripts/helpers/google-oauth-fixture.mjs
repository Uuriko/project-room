// Bounded signed Google provider fixture shared by real HTTP and browser owners.
import { generateKeyPairSync, sign } from "node:crypto";
import { GOOGLE_ISSUER, GOOGLE_SCOPES } from "../../server/google-oauth.mjs";
export const clientId = "1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com";
export const clientSecret = "GOCSPX-fixture-secret-never-real";
export const sub = "123456789012345678901";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = keys.publicKey.export({ format: "jwk" });
jwk.kid = "google-http-kid";
jwk.alg = "RS256";
jwk.use = "sig";

function idToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: GOOGLE_ISSUER, sub, aud: clientId, iat: now, exp: now + 600 })).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
}

function googleFetch() {
  return async url => {
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ id_token: idToken(), scope: GOOGLE_SCOPES });
    }
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
    return new Response("missing", { status: 404 });
  };
}

export function googleAuth() {
  return { clientId, clientSecret, fetchImpl: googleFetch() };
}

