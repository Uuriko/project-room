// WAVE-2000 guild-02 worker-13: mint local account sessions for fuzz fixtures.
import { RoomStore } from "../server/store.mjs";

const store = new RoomStore(".tmp/worker13.sqlite", { instanceLockPath: ".tmp/worker13-fixture.lock" });

function mint(accountId, withEmail) {
  store.createAccount(accountId, "test");
  if (withEmail) {
    store.accountLogins.linkPasswordMethod(accountId, { email: withEmail, verifier: "dummy-verifier" });
  }
  const { token, session } = store.createAccountSessionSlot();
  // rotateSlot:false → returns the auth object; the slot token stays the session token.
  const auth = store.loginAccountSessionWithMethod(token, accountId, session.sessionRevision, {
    method: { kind: "password", ref: "lm-" + accountId },
  });
  console.log(JSON.stringify({ accountId, token, csrf: auth.csrf }));
}

mint("acct-noemail", null);
mint("acct-unverified", "unverified@example.com");
mint("acct-verified", "verified@example.com");
// mark acct-verified's email verified through the real consume path
const issued = store.accountLogins.issueEmailVerifyCode({ accountId: "acct-verified", email: "verified@example.com" });
store.accountLogins.consumeEmailVerifyCode({ accountId: "acct-verified", code: issued.code });
console.log("verified-marked");
store.close();
