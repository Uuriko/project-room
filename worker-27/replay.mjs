// WORKER 27: verify the documented idempotent replay on /api/share-links/join
// with the ROTATED session (post-login csrf), per openapi: "A retry with the
// same redemptionId returns the earlier join (200)".
import { randomBytes, randomUUID } from "node:crypto";
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

let server = null, fixture = null, port = null, origin = null;
const f = await createAcceptanceFixture();
server = createRoomServer({ store: f.store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
port = server.address().port; origin = `http://127.0.0.1:${port}`;
const store = f.store;

// owner joins, mints a share link
let jr = await fetch(origin + "/join", { method: "POST", headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({ displayName: "w27r" }) }).then(r => r.json());
const owner = store.authenticate(jr.identitySecret, jr.roomId, null);
const linkToken = randomBytes(33).toString("base64url").slice(0, 43);
store.shareLinks.create(jr.identitySecret, jr.roomId,
  { requestId: randomUUID(), linkToken, expiresAt: store.now() + 3600000, maxJoins: 5, expectedMemberRevision: owner.member.revision }, null);

// fresh browser slot
const s = store.createAccountSessionSlot();
const H = () => ({ origin, "content-type": "application/json", cookie: `account_session=${s.token}`,
  "x-csrf-token": store.accountSessionSlot(s.token).csrf,
  "x-session-binding": store.accountSessionSlot(s.token).sessionBinding });
const rid = randomUUID();
const joinBody = () => JSON.stringify({ linkToken, displayName: "replay guest", redemptionId: rid, expectedSessionRevision: store.accountSessionSlot(s.token).sessionRevision });

const r1 = await fetch(origin + "/api/share-links/join", { method: "POST", headers: H(), body: joinBody() });
const j1 = await r1.json();
console.log("first join:", r1.status, "duplicate:", j1.duplicate, "account:", j1.session?.account?.id?.slice(0, 20));

// exact retry with the ROTATED session (new revision/csrf/binding)
const r2 = await fetch(origin + "/api/share-links/join", { method: "POST", headers: H(), body: joinBody() });
const j2 = await r2.json();
console.log("retry same redemptionId:", r2.status, "duplicate:", j2.duplicate, JSON.stringify(j2).slice(0, 120));

// retry with a DIFFERENT redemptionId but same session -> new guest or duplicate membership
const rid2 = randomUUID();
const r3 = await fetch(origin + "/api/share-links/join", { method: "POST", headers: H(),
  body: JSON.stringify({ linkToken, displayName: "replay guest", redemptionId: rid2, expectedSessionRevision: store.accountSessionSlot(s.token).sessionRevision }) });
console.log("second redemptionId:", r3.status, JSON.stringify(await r3.text()).slice(0, 120));

server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.store.close();
console.log("done"); process.exit(0);
