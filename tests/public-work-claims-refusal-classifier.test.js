// FIX-28: clients must branch on error.code, not HTTP status.
// A 409 can ride under three different refusal codes (work_claim_conflict,
// work_board_full, too_many_open_claims); ramp2's client matcher missed
// refusals live because it branched on status alone. classifyClaimRefusal
// branches ONLY on err.code. These tests encode the properties a
// status-only matcher cannot satisfy:
//   - same status, different codes -> different classifications
//   - same code, different statuses -> the same classification
import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicWorkClaimsClient, withClaimRetryDiscipline, classifyClaimRefusal } from '../client/public-work-claims.mjs';
import { RoomClientError } from '../client/room-agent.mjs';

const refusal = (status, code) => new RoomClientError(status, code, `refused: ${code}`);

test('the three 409 refusal codes classify distinctly (status-only matcher would collapse them)', () => {
  const got = new Set([
    classifyClaimRefusal(refusal(409, 'work_claim_conflict')).classification,
    classifyClaimRefusal(refusal(409, 'work_board_full')).classification,
    classifyClaimRefusal(refusal(409, 'too_many_open_claims')).classification,
  ]);
  assert.equal(got.size, 3, `expected 3 distinct classifications, got ${[...got].join(', ')}`);
});

test('409 codes map to their stable classifications', () => {
  assert.equal(classifyClaimRefusal(refusal(409, 'work_claim_conflict')).classification, 'conflict');
  assert.equal(classifyClaimRefusal(refusal(409, 'work_board_full')).classification, 'board_full');
  assert.equal(classifyClaimRefusal(refusal(409, 'too_many_open_claims')).classification, 'cap');
});

test('the public-work conflict alias classifies as conflict too', () => {
  assert.equal(classifyClaimRefusal(refusal(409, 'public_work_claim_conflict')).classification, 'conflict');
});

test('classification follows the code, not the status: same code on 429 stays put', () => {
  // If the server ever retargets a code to another status, clients must not
  // change their minds about what the refusal means.
  assert.equal(classifyClaimRefusal(refusal(429, 'work_board_full')).classification, 'board_full');
  assert.equal(classifyClaimRefusal(refusal(429, 'too_many_open_claims')).classification, 'cap');
});

test('a 429 with a rate-limit code is unknown, not cap', () => {
  const result = classifyClaimRefusal(refusal(429, 'rate_limited'));
  assert.equal(result.classification, 'unknown');
  assert.equal(result.code, 'rate_limited');
});

test('a generic 500 is unknown, not conflict', () => {
  const result = classifyClaimRefusal(refusal(500, 'internal_error'));
  assert.equal(result.classification, 'unknown');
});

test('non-error inputs classify as unknown without throwing', () => {
  for (const input of [null, undefined, {}, { code: null }, 'work_board_full']) {
    const result = classifyClaimRefusal(input);
    assert.equal(result.classification, 'unknown', `expected unknown for ${String(input)}`);
  }
});

test('each classification carries code-specific recovery guidance', () => {
  const conflict = classifyClaimRefusal(refusal(409, 'work_claim_conflict'));
  const full = classifyClaimRefusal(refusal(409, 'work_board_full'));
  const cap = classifyClaimRefusal(refusal(409, 'too_many_open_claims'));
  assert.match(conflict.recovery, /coordinate/i);
  assert.match(full.recovery, /retry-after/i);
  assert.match(cap.recovery, /back ?off/i);
  assert.notEqual(conflict.recovery, full.recovery);
  assert.notEqual(full.recovery, cap.recovery);
});

test('withClaimRetryDiscipline annotates terminal refusals with the classification', async () => {
  const client = new PublicWorkClaimsClient({
    origin: 'http://127.0.0.1:1',
    identitySecret: 'pri_test_identity_secret_for_fix28',
    fetchImpl: async () => new Response(
      JSON.stringify({ error: { code: 'work_board_full', message: 'board is full' } }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }),
  });
  const input = { requestId: 'fix28-refusal-wire', expectedTermsVersion: 1 };
  const error = await withClaimRetryDiscipline(client, 'discipline:task', 'claim', input, { identityId: 'ai_test_one', maxAttempts: 3 })
    .then(() => null, err => err);
  assert.ok(error instanceof RoomClientError, 'expected the terminal refusal to surface');
  assert.equal(error.status, 409);
  assert.equal(error.code, 'work_board_full');
  assert.equal(error.refusal?.classification, 'board_full');
  assert.match(error.refusal?.recovery ?? '', /retry-after/i);
});
