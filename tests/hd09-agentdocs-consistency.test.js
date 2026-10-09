import test from "node:test";
import assert from "node:assert/strict";
import {
  agentCard, llmsTxt, llmsFullTxt, kitsTxt, skillMd,
} from "../deploy/agent-discovery.mjs";
import {
  GUEST_INVITE_REDEEM_DEFAULT_MS,
  GUEST_INVITE_REDEEM_MIN_MS,
  GUEST_INVITE_REDEEM_MAX_MS,
  GUEST_CREDENTIAL_TTL_DEFAULT_MS,
  GUEST_CREDENTIAL_TTL_MIN_MS,
  GUEST_CREDENTIAL_TTL_MAX_MS,
} from "../server/guest-invites.mjs";

const dur = ms => {
  const h = Math.round(ms / 3_600_000);
  return (h >= 168 && h % 24 === 0) ? `${h / 24}d` : `${h}h`;
};

// HD-09 (agent-docs vs human-door): the guest-invite copy used to conflate
// the GX- code's REDEEM WINDOW (redeem_by: 24h default, 1h–7d range) with the
// issued GUEST PASS TTL (72h default, 1h–14d range) into "GX-code redemption
// pass 72h default, 1h–14d adjustable" — one ambiguous pair of numbers for two
// different server constants. Both durations must be stated separately, and
// the copy must track the constants in server/guest-invites.mjs.
test("guest-invite copy states the GX- redeem window and the guest-pass TTL separately", () => {
  const bodies = {
    llmsTxt: llmsTxt(),
    llmsFullTxt: llmsFullTxt(),
    kitsTxt: kitsTxt(),
    card: JSON.stringify(agentCard()),
  };
  const redeemDefault = dur(GUEST_INVITE_REDEEM_DEFAULT_MS); // 24h
  const redeemRange = `${dur(GUEST_INVITE_REDEEM_MIN_MS)}–${dur(GUEST_INVITE_REDEEM_MAX_MS)}`; // 1h–7d
  const passDefault = dur(GUEST_CREDENTIAL_TTL_DEFAULT_MS); // 72h
  const passRange = `${dur(GUEST_CREDENTIAL_TTL_MIN_MS)}–${dur(GUEST_CREDENTIAL_TTL_MAX_MS)}`; // 1h–14d
  for (const [name, text] of Object.entries(bodies)) {
    assert.ok(!/GX-code redemption pass 72h default/.test(text),
      `${name}: conflated wording "GX-code redemption pass 72h default" must be gone`);
    assert.ok(text.includes(`redeem within ${redeemDefault}`),
      `${name}: states the GX- redeem window default (${redeemDefault})`);
    assert.ok(text.includes(redeemRange),
      `${name}: states the GX- redeem window range (${redeemRange})`);
    assert.ok(text.includes(`guest pass ${passDefault}`),
      `${name}: states the guest-pass TTL default (${passDefault})`);
    assert.ok(text.includes(passRange),
      `${name}: states the guest-pass TTL range (${passRange})`);
  }
});

// HD-09: SKILL.md Step 4 told agents "The room owner approves." as the only
// path, but rooms may configure auto-approve (server/access-requests.mjs:
// approved inline in the same call when the requested permissions fit the
// standing rule). Agents must know an immediate approval is possible.
test("SKILL.md Step 4 names auto-approve, not owner approval alone", () => {
  const skill = skillMd();
  const step4 = skill.slice(skill.indexOf("## Step 4"));
  assert.ok(step4.length > 0, "skill has a Step 4");
  assert.ok(/owner approves/i.test(step4), "Step 4 still says the owner approves");
  assert.ok(/auto-approve/i.test(step4), "Step 4 must mention that some rooms auto-approve");
});
