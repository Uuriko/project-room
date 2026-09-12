import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { confirmsAutomationCommand } from '../src/automation-policy.js';

const command = { id: 'save', type: 'automation.created' };
const data = { automationId: 'brief', expectedRevision: 0, definition: { title: 'Brief', trigger: { kind: 'manual' }, prompt: 'Summarize', recipientId: 'peer', maxRuns: 2, maxRuntimeMs: 1000, maxOutputBytes: 1024 } };
const receipt = () => ({ sequence: 1, duplicate: false, event: { id: 'event', type: command.type, roomId: 'room', actorId: 'owner', causationId: null,
  at: '2026-09-12T22:00:00.000Z', data: structuredClone(data), idempotencyKey: createHash('sha256').update('owner:save').digest('hex') } });
const confirms = value => confirmsAutomationCommand(value, command, data, 'room', 'owner');

test('automation receipts bind exact nested scope, identity, command and sequence', async () => {
  assert.equal(await confirms(receipt()), true);
  const duplicate = receipt(); duplicate.duplicate = true;
  duplicate.event.data.definition = Object.fromEntries(Object.entries(duplicate.event.data.definition).reverse());
  assert.equal(await confirms(duplicate), true);
  for (const mutate of [r => r.sequence = 0, r => r.duplicate = null, r => r.event.actorId = 'peer', r => r.event.roomId = 'other',
    r => r.event.idempotencyKey = 'wrong', r => r.event.causationId = 'other', r => r.event.type = 'automation.updated',
    r => r.event.at = 'invalid', r => r.event.data.definition.prompt = 'Changed', r => r.event.data.definition.maxRuns++,
    r => r.event.data.definition.extra = true, r => delete r.event.data.definition.trigger]) {
    const changed = receipt(); mutate(changed); assert.equal(await confirms(changed), false);
  }
});

test('automation dispatch receipt checks server-derived prompt and recipient', async () => {
  const dispatch = { id: 'save', type: 'message.posted' };
  const expected = { messageId: 'request', automationId: 'brief', automationRevision: 3, automationSlot: 0,
    body: 'Approved prompt', toMemberId: 'peer', requestKind: 'reply', workItemId: null, requestPolicyVersion: 1 };
  const value = receipt(); value.event.type = dispatch.type; value.event.data = structuredClone(expected);
  assert.equal(await confirmsAutomationCommand(value, dispatch, expected, 'room', 'owner'), true);
  value.event.data.toMemberId = 'other';
  assert.equal(await confirmsAutomationCommand(value, dispatch, expected, 'room', 'owner'), false);
});
