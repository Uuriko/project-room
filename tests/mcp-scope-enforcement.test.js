// B008-2: per-agent MCP auth scope enforcement. Pure policy engine tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScopeEnforcer } from '../src/mcp-scope-enforcement.mjs';

const throwsCode = (fn, code) =>
  assert.throws(fn, (error) => error instanceof Error && error.code === code);

function makeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

function allowGrant(tools, extra = {}) {
  return {
    grantedAt: 1_000_000,
    tools,
    ...extra,
  };
}

test('check() allows an explicitly granted tool', () => {
  const clock = makeClock();
  const enforcer = createScopeEnforcer({ clock: clock.now });
  enforcer.grant('quill', allowGrant([{ tool: 'room.read-thread', allow: true }]));
  const result = enforcer.check('quill', 'room.read-thread', {});
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'ok');
  assert.ok(Object.isFrozen(result));
});

test('explicit deny beats allow for the same tool', () => {
  const clock = makeClock();
  const enforcer = createScopeEnforcer({ clock: clock.now });
  enforcer.grant(
    'quill',
    allowGrant([
      { tool: '*', allow: true },
      { tool: 'room.post', allow: false },
    ]),
  );
  const result = enforcer.check('quill', 'room.post', { body: 'hi' });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'explicit-deny');
  // Other tools remain allowed through the wildcard.
  assert.equal(enforcer.check('quill', 'room.read-thread', {}).allowed, true);
});

test('unknown agent is denied by default (no silent failure)', () => {
  const clock = makeClock();
  const enforcer = createScopeEnforcer({ clock: clock.now });
  const result = enforcer.check('ghost', 'room.read-thread', {});
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'unknown-agent');
});

test('expired grant is denied', () => {
  const clock = makeClock();
  const enforcer = createScopeEnforcer({ clock: clock.now });
  enforcer.grant(
    'quill',
    allowGrant([{ tool: 'room.read-thread', allow: true }], { expiresAt: 1_000_000 + 60_000 }),
  );
  assert.equal(enforcer.check('quill', 'room.read-thread', {}).allowed, true);
  clock.advance(60_001);
  const result = enforcer.check('quill', 'room.read-thread', {});
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'grant-expired');
});

test("wildcard tool '*' grants every tool", () => {
  const clock = makeClock();
  const enforcer = createScopeEnforcer({ clock: clock.now });
  enforcer.grant('grok', allowGrant([{ tool: '*', allow: true }]));
  assert.equal(enforcer.check('grok', 'room.post', {}).allowed, true);
  assert.equal(enforcer.check('grok', 'mcp:search', {}).allowed, true);
  assert.equal(enforcer.check('grok', 'anything.at.all', {}).allowed, true);
});

test('tool with no grant entry is denied by default', () => {
  const clock = makeClock();
  const enforcer = createScopeEnforcer({ clock: clock.now });
  enforcer.grant('quill', allowGrant([{ tool: 'room.read-thread', allow: true }]));
  const result = enforcer.check('quill', 'room.post', {});
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'no-scope-for-tool');
});

test('channel constraint: only allowlisted channels pass', () => {
  const clock = makeClock();
  const enforcer = createScopeEnforcer({ clock: clock.now });
  enforcer.grant(
    'instinct',
    allowGrant([
      {
        tool: 'room.post',
        allow: true,
        constraints: { channels: ['announcements', 'alerts'] },
      },
    ]),
  );
  assert.equal(enforcer.check('instinct', 'room.post', { channel: 'announcements' }).allowed, true);
  const denied = enforcer.check('instinct', 'room.post', { channel: 'random' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'channel-not-allowed');
  const missing = enforcer.check('instinct', 'room.post', {});
  assert.equal(missing.allowed, false);
  assert.equal(missing.reason, 'channel-not-allowed');
});

test('maxLimit constraint caps limit args', () => {
  const clock = makeClock();
  const enforcer = createScopeEnforcer({ clock: clock.now });
  enforcer.grant(
    'codex',
    allowGrant([
      {
        tool: 'mcp:search',
        allow: true,
        constraints: { maxLimit: 10 },
      },
    ]),
  );
  assert.equal(enforcer.check('codex', 'mcp:search', { limit: 10 }).allowed, true);
  assert.equal(enforcer.check('codex', 'mcp:search', { limit: 5 }).allowed, true);
  assert.equal(enforcer.check('codex', 'mcp:search', {}).allowed, true);
  const denied = enforcer.check('codex', 'mcp:search', { limit: 11 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'limit-exceeded');
});

test('readOnly constraint blocks room.post but allows reads', () => {
  const clock = makeClock();
  const enforcer = createScopeEnforcer({ clock: clock.now });
  enforcer.grant(
    'observer',
    allowGrant([{ tool: '*', allow: true, constraints: { readOnly: true } }]),
  );
  const post = enforcer.check('observer', 'room.post', { body: 'hi' });
  assert.equal(post.allowed, false);
  assert.equal(post.reason, 'read-only');
  const reply = enforcer.check('observer', 'room.reply', { body: 'hi' });
  assert.equal(reply.allowed, false);
  assert.equal(reply.reason, 'read-only');
  assert.equal(enforcer.check('observer', 'room.read-thread', {}).allowed, true);
  assert.equal(enforcer.check('observer', 'mcp:search', {}).allowed, true);
});

test('audit log records every check with {agentId, tool, allowed, reason, at}', () => {
  const clock = makeClock();
  const enforcer = createScopeEnforcer({ clock: clock.now });
  enforcer.grant('quill', allowGrant([{ tool: 'room.read-thread', allow: true }]));
  enforcer.check('quill', 'room.read-thread', {});
  clock.advance(1000);
  enforcer.check('quill', 'room.post', {});
  clock.advance(1000);
  enforcer.check('ghost', 'room.read-thread', {});
  const audit = enforcer.audit;
  assert.equal(audit.length, 3);
  assert.deepEqual(
    audit.map(({ agentId, tool, allowed, reason }) => ({ agentId, tool, allowed, reason })),
    [
      { agentId: 'quill', tool: 'room.read-thread', allowed: true, reason: 'ok' },
      { agentId: 'quill', tool: 'room.post', allowed: false, reason: 'no-scope-for-tool' },
      { agentId: 'ghost', tool: 'room.read-thread', allowed: false, reason: 'unknown-agent' },
    ],
  );
  assert.deepEqual(
    audit.map((entry) => entry.at),
    [1_000_000, 1_001_000, 1_002_000],
  );
  assert.ok(audit.every((entry) => Object.isFrozen(entry)));
  // Audit grows monotonically — denies are never silent.
  assert.equal(enforcer.audit.length, 3);
});

test('grant/revoke/update lifecycle and listAgents()', () => {
  const clock = makeClock();
  const enforcer = createScopeEnforcer({ clock: clock.now });
  const snap = enforcer.grant('quill', allowGrant([{ tool: 'room.post', allow: true }]));
  assert.equal(snap.agentId, 'quill');
  assert.deepEqual(enforcer.listAgents(), ['quill']);
  assert.equal(enforcer.get('quill').tools.length, 1);

  // Re-granting without update() is a coded failure.
  throwsCode(
    () => enforcer.grant('quill', allowGrant([{ tool: 'room.post', allow: true }])),
    'SE_GRANT_EXISTS',
  );

  // update() replaces the tool set.
  const updated = enforcer.update('quill', {
    tools: [{ tool: 'room.read-thread', allow: true }],
  });
  assert.equal(updated.tools.length, 1);
  assert.equal(updated.tools[0].tool, 'room.read-thread');
  assert.equal(enforcer.check('quill', 'room.post', {}).allowed, false);
  assert.equal(enforcer.check('quill', 'room.read-thread', {}).allowed, true);

  // update() on unknown agent is a coded failure.
  throwsCode(() => enforcer.update('ghost', { tools: [] }), 'SE_UNKNOWN_AGENT');

  // revoke() drops the grant; the agent falls back to deny-by-default.
  enforcer.revoke('quill');
  assert.equal(enforcer.get('quill'), null);
  assert.deepEqual(enforcer.listAgents(), []);
  assert.equal(enforcer.check('quill', 'room.read-thread', {}).reason, 'unknown-agent');
  throwsCode(() => enforcer.revoke('quill'), 'SE_UNKNOWN_AGENT');
});

test('snapshot()/restore() round-trips grants and audit (pure, in-memory)', () => {
  const clock = makeClock();
  const enforcer = createScopeEnforcer({ clock: clock.now });
  enforcer.grant(
    'quill',
    allowGrant([{ tool: 'room.read-thread', allow: true }], { expiresAt: 2_000_000 }),
  );
  enforcer.check('quill', 'room.read-thread', {});
  enforcer.check('quill', 'room.post', {});

  const snapshot = enforcer.snapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.equal(snapshot.grants.length, 1);
  assert.equal(snapshot.audit.length, 2);

  // Restore into a fresh engine: grants and audit carry over exactly.
  const fresh = createScopeEnforcer({ clock: clock.now });
  fresh.restore(snapshot);
  assert.deepEqual(fresh.listAgents(), ['quill']);
  assert.equal(fresh.check('quill', 'room.read-thread', {}).allowed, true);
  assert.equal(fresh.check('quill', 'room.post', {}).reason, 'no-scope-for-tool');
  assert.equal(fresh.audit.length, 4); // 2 restored + 2 new checks
  assert.equal(fresh.audit[0].reason, 'ok');
  assert.equal(fresh.get('quill').expiresAt, 2_000_000);

  // restore() with malformed state is a coded failure.
  throwsCode(() => fresh.restore({ grants: 'nope', audit: [] }), 'SE_INVALID_GRANT');
  throwsCode(() => fresh.restore(null), 'SE_INVALID_GRANT');
});

test('coded-error contract: malformed inputs throw with a code', () => {
  const clock = makeClock();
  const enforcer = createScopeEnforcer({ clock: clock.now });

  // grant() validation
  throwsCode(() => enforcer.grant('', allowGrant([{ tool: 'x', allow: true }])), 'SE_INVALID_GRANT');
  throwsCode(() => enforcer.grant('a', { grantedAt: 1 }), 'SE_INVALID_GRANT'); // no tools
  throwsCode(() => enforcer.grant('a', allowGrant([])), 'SE_INVALID_GRANT'); // empty tools
  throwsCode(
    () => enforcer.grant('a', allowGrant([{ tool: 'x' }])),
    'SE_INVALID_GRANT',
  ); // allow missing
  throwsCode(
    () => enforcer.grant('a', allowGrant([{ tool: 'x', allow: true }], { expiresAt: 500 })),
    'SE_INVALID_GRANT',
  ); // expiresAt <= grantedAt

  // check() validation
  throwsCode(() => enforcer.check('', 'room.post', {}), 'SE_INVALID_INPUT');
  throwsCode(() => enforcer.check('quill', '', {}), 'SE_INVALID_INPUT');
  throwsCode(() => enforcer.check(null, 'room.post', {}), 'SE_INVALID_INPUT');

  // enforce() throws SE_SCOPE_DENIED on policy denial (check() would not).
  enforcer.grant('quill', allowGrant([{ tool: 'room.read-thread', allow: true }]));
  throwsCode(() => enforcer.enforce('quill', 'room.post', {}), 'SE_SCOPE_DENIED');
  assert.equal(enforcer.enforce('quill', 'room.read-thread', {}).allowed, true);

  // enforce() throws SE_GRANT_EXPIRED for an expired grant.
  const expiring = createScopeEnforcer({ clock: clock.now });
  expiring.grant(
    'grok',
    allowGrant([{ tool: '*', allow: true }], { expiresAt: 1_000_000 + 10 }),
  );
  clock.advance(11);
  throwsCode(() => expiring.enforce('grok', 'room.post', {}), 'SE_GRANT_EXPIRED');

  // Every thrown error carries a code — never a bare message.
  try {
    enforcer.enforce('quill', 'room.post', {});
    assert.fail('expected SE_SCOPE_DENIED');
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.code, 'SE_SCOPE_DENIED');
    assert.ok(error.message.length > 0);
  }
});
