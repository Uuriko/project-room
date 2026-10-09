// Human desktop authentication. Reuses durable OAuth PKCE, not agent credentials.
import { OAuthProviderError, OAUTH_SCOPES } from "../oauth-provider.mjs";

async function handleDesktopAuth(ctx) {
  const { req, res, url, store, remoteAddress, oauthProvider, expectedOrigin,
    rate, reject, body, exact, checkOrigin, cookie, accountCookieName, setCookie, json } = ctx;
      const desktopClientId = "project-room-macos";
      const desktopRedirect = expectedOrigin() + "/api/auth/desktop/callback";
      if (url.pathname === "/api/auth/desktop/start" && req.method === "GET") {
        const state = url.searchParams.get("state"), challenge = url.searchParams.get("challenge");
        if (!/^[A-Za-z0-9_-]{43}$/.test(state || "") || !/^[A-Za-z0-9_-]{43}$/.test(challenge || "")
          || url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("challenge").length !== 1) {
          reject(422, "invalid_desktop_auth", "A current native authentication request is required");
        }
        const providers = url.searchParams.getAll("provider"), provider = providers[0];
        if (providers.length > 1 || (providers.length === 1 && !["google", "github"].includes(provider))) {
          reject(400, "invalid_desktop_provider", "Choose a supported sign-in provider");
        }
        rate(`desktop-start:${remoteAddress}`, 20);
        oauthProvider.registerClient({ clientId: desktopClientId, name: "Project Room for Mac", redirectUris: [desktopRedirect] });
        const query = new URLSearchParams({ client_id: desktopClientId, redirect_uri: desktopRedirect,
          scope: OAUTH_SCOPES.join(" "), state, code_challenge: challenge, code_challenge_method: "S256" });
        const consent = "/oauth/authorize?" + query;
        const entrance = provider ? "/?" + new URLSearchParams({ oauth: "login", return: consent, provider }) : consent;
        res.writeHead(302, { Location: entrance }); return res.end();
      }
      if (url.pathname === "/api/auth/desktop/callback" && req.method === "GET") {
        const state = url.searchParams.get("state"), code = url.searchParams.get("code"), error = url.searchParams.get("error");
        if (!/^[A-Za-z0-9_-]{43}$/.test(state || "") || url.searchParams.getAll("state").length !== 1
          || !((/^oac_[A-Za-z0-9_-]{32}$/.test(code || "") && url.searchParams.getAll("code").length === 1 && !error)
            || (error === "access_denied" && url.searchParams.getAll("error").length === 1 && !code))) {
          reject(422, "invalid_desktop_callback", "The native sign-in callback is invalid. Start sign-in again.");
        }
        res.writeHead(302, { Location: "projectroom://auth?" + new URLSearchParams({ state, ...(code ? { code } : { error }) }) });
        return res.end();
      }
      if (url.pathname === "/api/auth/desktop/session" && req.method === "POST") {
        checkOrigin(req, true); rate(`desktop-exchange:${remoteAddress}`, 10);
        // Refuse a request that could silently replace an existing browser account.
        if (cookie(req, accountCookieName)) reject(409, "desktop_session_exists", "Use a fresh native authentication session");
        const data = await body(req);
        if (!exact(data, ["code", "verifier"]) || !/^oac_[A-Za-z0-9_-]{32}$/.test(data.code || "")
          || !/^[A-Za-z0-9_-]{43,128}$/.test(data.verifier || "")) reject(422, "invalid_desktop_exchange", "A one-time code and native proof are required");
        let result;
        try {
          result = store.transaction(() => {
            const pair = oauthProvider.exchangeCode({ code: data.code, clientId: desktopClientId,
              redirectUri: desktopRedirect, codeVerifier: data.verifier });
            const grant = oauthProvider.verifyAccessToken(pair.accessToken);
            if (!grant || grant.clientId !== desktopClientId || grant.scopes.length !== OAUTH_SCOPES.length || !OAUTH_SCOPES.every(scope => grant.scopes.includes(scope))) reject(401, "desktop_auth_rejected", "Native sign-in could not be confirmed");
            const slot = store.createAccountSessionSlot();
            const logged = store.loginAccountSessionWithMethod(slot.token, grant.userId, slot.session.sessionRevision,
              { method: { kind: "desktop", ref: desktopClientId }, rotateSlot: true });
            oauthProvider.revoke(pair.refreshToken); // retires the entire temporary grant
            return logged;
          });
        } catch (error) {
          if (error instanceof OAuthProviderError) reject(401, "desktop_auth_rejected", "The sign-in expired, was already used, or does not match this app. Start again.");
          throw error;
        }
        setCookie(res, accountCookieName, result.token, Math.max(0, Math.floor((result.session.expiresAt - store.now()) / 1000)));
        return json(res, 201, { status: "signed_in" });
      }
}

const desktopRoute = row => ({ auth: "none", capability: null, events: [], scope: "worker",
  schema: { response: { type: "object" } }, ...row });

export const DESKTOP_AUTH_ROUTES = [
  desktopRoute({ id: "desktop-auth-start", method: "GET", path: "/api/auth/desktop/start", handler: handleDesktopAuth }),
  desktopRoute({ id: "desktop-auth-callback", method: "GET", path: "/api/auth/desktop/callback", handler: handleDesktopAuth }),
  desktopRoute({ id: "desktop-auth-session", method: "POST", path: "/api/auth/desktop/session", handler: handleDesktopAuth }),
];
