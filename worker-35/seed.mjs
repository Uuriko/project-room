// Seed an authenticated account session into the worker-35 sqlite DB (server stopped).
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { RoomStore } from "../server/store.mjs";

const store = new RoomStore("worker-35/.tmp/w35-room.sqlite");
const email = "w35fuzz@example.invalid";
const accountId = `email:${createHash("sha256").update(email).digest("hex")}`;
try { store.createAccount(accountId, "fuzz-seed"); } catch (e) { if (e?.code !== "account_exists") throw e; }
const slot = store.createAccountSessionSlot();
const { token: fresh } = store.loginAccountSessionWithMethod(
  slot.token, accountId, slot.session.sessionRevision,
  { method: { kind: "password", ref: "fuzz-seed" }, rotateSlot: true });
const anon = store.createAccountSessionSlot();
store.close();
writeFileSync("worker-35/.tmp/cookies.txt",
  `AUTHD=account_session=${fresh}\nANON=account_session=${anon.token}\n`);
console.log("seeded", accountId.slice(0, 20), "fresh cookie len", fresh.length);
