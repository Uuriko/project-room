// Mint a test account + account session against the local fuzz DB, print cookie token.
import { RoomStore } from "../server/store.mjs";
const store = new RoomStore("/tmp/w2000-worker46/room.sqlite");
const id = "w46acct-" + Math.random().toString(36).slice(2, 8);
try { store.createAccount(id, "w46-fuzz"); } catch (e) { console.log("createAccount:", e.message); }
const { token, session: slot } = store.createAccountSessionSlot();
const session = store.loginAccountSessionWithMethod(token, id, slot.sessionRevision, { method: { kind: "password", ref: "lm-w46" } });
import { writeFileSync } from "node:fs";
// Store only in worker-46 scratch; read by fuzz-auth.js via file path.
writeFileSync(new URL(".creds-session.txt", import.meta.url), token);
console.log("accountId=" + id);
console.log("session minted; cookie token written to worker-46/.creds-session.txt");
