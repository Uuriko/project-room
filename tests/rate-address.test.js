import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIP } from "node:net";
import { ipv6RatePrefix, rateAddressKey, rateAddressPart } from "../server/rate-address.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

test("IPv6 rate ids are keyed by their /64", () => {
  assert.equal(rateAddressKey("agent-connect:2001:db8:1:2::1"), "agent-connect:2001:0db8:0001:0002::/64");
  assert.equal(rateAddressKey("agent-connect:2001:db8:1:2:ffff:1:2:3"), rateAddressKey("agent-connect:2001:db8:1:2::9"));
  assert.notEqual(rateAddressKey("agent-connect:2001:db8:1:3::1"), rateAddressKey("agent-connect:2001:db8:1:2::1"));
  assert.equal(rateAddressKey("login:::1"), "login:0000:0000:0000:0000::/64");
  assert.equal(rateAddressKey("agent-connect:[2001:db8:1:2::1]"), "agent-connect:2001:0db8:0001:0002::/64");
  assert.equal(ipv6RatePrefix("fe80::1%eth0"), null);
});

test("IPv4, mapped IPv4 and non-address ids are unchanged", () => {
  for (const id of ["agent-connect:203.0.113.7", "agent-connect:::ffff:203.0.113.7", "agent-connect:[203.0.113.7]", "write:abc123", "account-login:2001:db8::1:" + "f".repeat(64), "email-verify-resend:acct_1", "nofamily"])
    assert.equal(rateAddressKey(id), id);
});

test("rateAddressPart keys a bare or bracketed IPv6 address by its /64 for composite rate ids (r176)", () => {
  const worker = new URL("http://[2001:db8:1:2::1]").hostname; // cloudflare/room.mjs resolver shape
  assert.equal(rateAddressPart(worker), "2001:0db8:0001:0002::/64");
  assert.equal(rateAddressPart("2001:db8:1:2:ffff::9"), "2001:0db8:0001:0002::/64");
  assert.notEqual(rateAddressPart("[2001:db8:1:3::1]"), rateAddressPart(worker));
  for (const address of ["203.0.113.7", "::ffff:203.0.113.7", "unknown", ""]) assert.equal(rateAddressPart(address), address);
  assert.equal(rateAddressPart(undefined), undefined);
  // account-login ids carry a slot hash after the address; one /64 shares one budget per slot.
  const hash = "f".repeat(64);
  assert.equal(`account-login:${rateAddressPart("[2001:db8:1:2::1]")}:${hash}`, `account-login:${rateAddressPart("[2001:db8:1:2::abcd]")}:${hash}`);
  assert.equal(rateAddressKey(`account-login:${rateAddressPart(worker)}:${hash}`), `account-login:${rateAddressPart(worker)}:${hash}`);
});

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-rate-address-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  let previews = 0;
  const preview = store.invites.preview.bind(store.invites);
  store.invites.preview = code => { previews++; return preview(code); };
  // The resolver cloudflare/room.mjs passes: the Worker's trusted visitor address.
  const resolveClientAddress = req => { const a = req.headers["x-room-visitor-ip"], kind = isIP(a); if (!kind) throw new Error("no address"); return kind === 6 ? new URL(`http://[${a}]`).hostname : a; };
  const server = createRoomServer({ store, resolveClientAddress });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { origin: `http://127.0.0.1:${server.address().port}`, previews: () => previews };
}
const guess = i => `RM-${String(i).padStart(16, "0")}`;

test("rotating addresses inside one IPv6 /64 share the invite lookup limit", async t => {
  const { origin, previews } = await serve(t);
  const statuses = [];
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${origin}/a/${guess(i)}`, { headers: { "x-room-visitor-ip": `2001:db8:1:2::${(i + 1).toString(16)}` } });
    await res.arrayBuffer();
    statuses.push(res.status);
  }
  assert.ok(statuses.includes(429), `40 lookups from one /64 were never limited: ${[...new Set(statuses)]}`);
  assert.ok(previews() <= 30, `${previews()} scrypt lookups ran for 40 requests from one /64`);
  const other = await fetch(`${origin}/a/${guess(99)}`, { headers: { "x-room-visitor-ip": "2001:db8:1:3::1" } });
  await other.arrayBuffer();
  assert.notEqual(other.status, 429, "a different /64 keeps its own allowance");
});
