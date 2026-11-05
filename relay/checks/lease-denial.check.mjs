// REL-C1: a capability-denied lease call must not install its lease.
//
// Pure-Node check (no Miniflare): drive authorize() from relay/src/auth.mjs
// with real Ed25519 lease tokens. Pre-fix, authorizeLease ran
// rememberLease() before the tool/capability checks, so a denied call left
// state.leases.desk / state.activeLease pointing at the denied claim and a
// different, fully valid claim for the same slot was refused slot_held
// until the denied token expired (up to the 15-minute lease TTL).
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { authorize } from "../src/auth.mjs";

const ORIGIN = "https://room.example.test";
const MACHINE_ID = "mch_0123456789abcdef";
const NOW = Date.now();

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicJwk = publicKey.export({ format: "jwk" });

const b64url = value => Buffer.from(value).toString("base64url");

function tokenFor({ claim, caps, sub = "mem_x", jti = `jti-${claim}` }) {
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: ORIGIN,
    aud: `relay:${MACHINE_ID}`,
    sub,
    room: "room_alpha",
    claim,
    slot: "desk",
    caps,
    epoch: 0,
    exp: Math.floor(NOW / 1000) + 600,
    jti,
  }));
  const signature = cryptoSign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function freshState() {
  return {
    machineId: MACHINE_ID,
    resourceId: null,
    haltEpoch: 0,
    revoked: [],
    halted: false,
    pausedUntil: null,
    leases: {},
    activeLease: null,
  };
}

function call(state, token, tool) {
  const request = new Request(`${ORIGIN}/v0/machines/${MACHINE_ID}/call`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const env = { ROOM_ORIGIN: ORIGIN, ROOM_RESOURCE_LEASE_PUBLIC_JWK: JSON.stringify(publicJwk) };
  return authorize(env, state, request, { needLease: true, slotHint: "desk", tool, now: NOW });
}

test("a capability-denied lease call leaves the slot free for a valid claim", async () => {
  const state = freshState();
  const denied = tokenFor({ claim: "claim_A", caps: ["files"] });
  await assert.rejects(call(state, denied, "desktop.screenshot"),
    error => error?.status === 403 && error?.code === "capability_denied");
  assert.equal(state.leases?.desk, undefined, "the denied call installed no desk lease");
  assert.equal(state.activeLease, null, "the denied call is not the active lease");

  const valid = tokenFor({ claim: "claim_B", caps: ["desktop.gui"], sub: "mem_y" });
  const granted = await call(state, valid, "desktop.screenshot");
  assert.equal(granted.lease.claimId, "claim_B");
  assert.equal(state.leases.desk.claimId, "claim_B");
});

test("a tool-not-allowed lease call also leaves the slot free", async () => {
  const state = freshState();
  const denied = tokenFor({ claim: "claim_C", caps: ["desktop.gui"] });
  await assert.rejects(call(state, denied, "shell.host"),
    error => error?.status === 403 && error?.code === "tool_not_allowed");
  assert.equal(state.leases?.desk, undefined, "the denied call installed no desk lease");
  assert.equal(state.activeLease, null, "the denied call is not the active lease");
});
