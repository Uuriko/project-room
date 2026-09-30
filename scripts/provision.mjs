import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, openSync, fchmodSync, closeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const { values } = parseArgs({ allowPositionals: true, options: { help: { type: "boolean" }, init: { type: "boolean" }, "account-key": { type: "boolean" }, room: { type: "string", default: "commons" }, member: { type: "string", default: "owner" }, account: { type: "string" }, name: { type: "string" }, kind: { type: "string", default: "human" }, permissions: { type: "string", default: "accept_work,complete_work,verify" }, "print-key": { type: "boolean" }, "key-file": { type: "string" } } });
if (values.help) {
  process.stdout.write(`Usage: node scripts/provision.mjs [--init] [--account-key] [--room <id>] [--member <id>] [--account <id>] [--name <n>] [--kind <human|agent>] [--permissions <csv>] [--print-key] [--key-file <path>]\n`);
  process.exit(0);
}

// Keys never go to non-terminal stdout by default: CI logs must not capture
// them. Interactive terminals print the key; anything else needs --print-key
// (explicit, auditable) or --key-file <path> (written with mode 0600).
function emitKey(meta, accessKey) {
  if (values["key-file"]) {
    // H-17: writeFileSync's `mode` option applies only when the file is
    // created. A pre-existing world-readable key file would keep its mode and
    // leak the bearer key. Force owner-only mode on the fd before writing;
    // fail closed (the exception propagates, no key is written) when the
    // chmod cannot be applied.
    const fd = openSync(values["key-file"], "w", 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, accessKey + "\n");
    } finally {
      closeSync(fd);
    }
    process.stdout.write(`${meta} Key written to ${values["key-file"]} (mode 0600).\n`);
    return;
  }
  if (values["print-key"] || process.stdout.isTTY) {
    process.stdout.write(`${meta}\n${accessKey}\n`);
    return;
  }
  process.stderr.write("provision: key withheld — stdout is not a terminal. Re-run interactively or pass --print-key / --key-file <path>.\n");
  process.stdout.write(`${meta} Key withheld from non-terminal stdout; see stderr.\n`);
  process.exitCode = 2;
}
const filename = resolve(process.env.ROOM_DB || ".data/room.sqlite");
// Match server.mjs: the database file must never be created group/world-readable.
process.umask(0o077);
mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
const store = new RoomStore(filename);
try {
  if (values.init) store.initialize(initialRoom(values.room, values.member));
  // M-27: deliver-then-commit. The new key is minted WITHOUT revoking its
  // predecessors, delivered, and only then do the old keys get revoked. A
  // delivery failure (unwritable --key-file, no deliverable channel) leaves
  // the old keys working instead of stranding the operator — and a minted
  // but undelivered key is revoked again so it cannot linger.
  const deliverable = values["print-key"] || values["key-file"] || process.stdout.isTTY;
  if (!deliverable) {
    console.error("provision: key withheld — stdout is not a terminal. Minting a key the operator cannot receive would revoke the previous key and strand them, so nothing was minted or revoked. Re-run with --print-key or --key-file <path>.");
    process.exit(2);
  }
  const deliverThenRevoke = (mint, message, { revokeStale, revokeMinted }) => {
    const accessKey = mint();
    try {
      emitKey(message, accessKey);
    } catch (error) {
      revokeMinted(accessKey);
      throw error;
    }
    revokeStale(accessKey);
  };
  if (values["account-key"]) {
    if (!values.account) throw new Error("Account-key provisioning requires --account");
    let account;
    try { account = store.account(values.account); }
    catch (error) {
      if (error.code !== "account_not_found") throw error;
      account = store.createAccount(values.account);
    }
    deliverThenRevoke(
      () => store.insertAccountCredential(account.id, Date.now() + 7 * 86400000),
      `New account key for ${account.id}; previous account keys and account browser sessions are revoked now that this key is delivered. Auth epoch ${account.authEpoch}. Expires in seven days. This does not grant Room membership. Keep private; never put it in a URL, chat, logs, or GitHub.`,
      {
        revokeStale: key => store.revokeStaleAccountKeys(account.id, key),
        revokeMinted: key => store.revokeAccountCredential(account.id, key),
      },
    );
  } else {
    const { state } = store.room(values.room);
    if (!Object.hasOwn(state.members, values.member)) {
      if (!values.name) throw new Error("New members require --name");
      // Local database administration is intentionally separate from the public HTTP API.
      const admin = store.insertCredential(values.room, state.room.ownerId, "access", null, Date.now() + 60000);
      try { store.command(admin, values.room, { id: crypto.randomUUID(), type: T.MEMBER_ADDED, data: { memberId: values.member, displayName: values.name, kind: values.kind, permissions: values.permissions ? values.permissions.split(",") : [] } }); }
      finally { store.revoke(admin); }
    }
    const accessKey = store.issueAccessKey(values.room, values.member, 7 * 86400000, values.account ?? null);
    const account = store.accountForMember(values.room, values.member);
    const ownership = account ? ` Canonical account: ${account.id}; auth epoch ${account.authEpoch}.` : " Agent credential; no human account is attached.";
    deliverThenRevoke(
      () => store.mintAccessKey(values.room, values.member, 7 * 86400000, values.account ?? null),
      `New key for ${values.member} in ${values.room}; previous keys and sessions are revoked now that this key is delivered.${ownership} Expires in seven days. Keep private; never paste into GitHub.`,
      {
        revokeStale: key => store.revokeStaleRoomKeys(values.room, values.member, key),
        revokeMinted: key => store.revokeRoomCredential(values.room, values.member, key),
      },
    );
  }
} finally { store.close(); }
