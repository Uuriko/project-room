import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAgentCardRegistry } from '../src/agent-card-registry.mjs';

function validCard(overrides = {}) {
  return {
    agentId: 'quill-agent',
    name: 'Quill',
    description: 'Coordinates the swarm room and merges PRs.',
    url: 'https://agents.example.com/quill',
    capabilities: ['pr-merge', 'swarm-coordination'],
    skills: ['javascript', 'git'],
    version: '1.0.0',
    ...overrides,
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error);
    assert.equal(err.code, code);
    return true;
  });
}

describe('publish + get', () => {
  it('stores a valid card and returns it frozen', () => {
    const registry = createAgentCardRegistry({ clock: () => 1700000000000 });
    const published = registry.publish(validCard());
    assert.equal(published.agentId, 'quill-agent');
    assert.equal(published.publishedAt, 1700000000000);
    assert.deepEqual(published.capabilities, ['pr-merge', 'swarm-coordination']);

    const got = registry.get('quill-agent');
    assert.deepEqual(got, published);
    assert.ok(Object.isFrozen(got));
  });

  it('defaults publishedAt to the injected clock when omitted', () => {
    const registry = createAgentCardRegistry({ clock: () => 12345 });
    const published = registry.publish(validCard({ publishedAt: undefined }));
    assert.equal(published.publishedAt, 12345);
  });
});

describe('republish', () => {
  it('replaces the stored card with a strictly higher version', () => {
    const registry = createAgentCardRegistry();
    registry.publish(validCard({ version: '1.0.0', name: 'Old' }));
    const replaced = registry.publish(validCard({ version: '1.2.0', name: 'New' }));
    assert.equal(replaced.name, 'New');
    assert.equal(registry.get('quill-agent').name, 'New');
  });

  it('rejects equal or lower versions as stale', () => {
    const registry = createAgentCardRegistry();
    registry.publish(validCard({ version: '2.0.0' }));
    expectCode(() => registry.publish(validCard({ version: '2.0.0' })), 'ACR_STALE_VERSION');
    expectCode(() => registry.publish(validCard({ version: '1.9.9' })), 'ACR_STALE_VERSION');
  });
});

describe('invalid cards', () => {
  it('rejects bad agentId, empty name, bad capabilities, bad version', () => {
    const registry = createAgentCardRegistry();
    expectCode(() => registry.publish(validCard({ agentId: 'BAD_ID' })), 'ACR_INVALID_CARD');
    expectCode(() => registry.publish(validCard({ agentId: '-lead' })), 'ACR_INVALID_CARD');
    expectCode(() => registry.publish(validCard({ name: '' })), 'ACR_INVALID_CARD');
    expectCode(() => registry.publish(validCard({ capabilities: 'pr-merge' })), 'ACR_INVALID_CARD');
    expectCode(() => registry.publish(validCard({ capabilities: ['ok', 7] })), 'ACR_INVALID_CARD');
    expectCode(() => registry.publish(validCard({ version: 'one' })), 'ACR_INVALID_CARD');
    expectCode(() => registry.publish(validCard({ skills: ['x', ''] })), 'ACR_INVALID_CARD');
  });

  it('verify() reports structure without throwing and never crypto-verifies', () => {
    const registry = createAgentCardRegistry();
    const good = registry.verify(validCard({ signature: 'deadbeef' }));
    assert.equal(good.valid, true);
    assert.deepEqual(good.problems, []);
    assert.equal(good.signaturePresent, true);
    assert.equal(good.signatureVerified, false);

    const bad = registry.verify(validCard({ agentId: 'NOPE' }));
    assert.equal(bad.valid, false);
    assert.ok(bad.problems.length > 0);
    assert.equal(bad.signatureVerified, false);
  });
});

describe('capability filter', () => {
  it('list({capability}) only returns matching live cards', () => {
    const registry = createAgentCardRegistry();
    registry.publish(validCard({ agentId: 'a-one', capabilities: ['deploy', 'pr-merge'] }));
    registry.publish(validCard({ agentId: 'b-two', capabilities: ['inbox-watch'] }));
    assert.deepEqual(
      registry.list({ capability: 'deploy' }).map((c) => c.agentId),
      ['a-one'],
    );
    assert.equal(registry.list({ capability: 'nope' }).length, 0);
    assert.equal(registry.list().length, 2);
  });
});

describe('withdraw', () => {
  it('tombstones the card: get throws ACR_WITHDRAWN, list hides it', () => {
    const registry = createAgentCardRegistry();
    registry.publish(validCard());
    const receipt = registry.withdraw('quill-agent');
    assert.equal(receipt.agentId, 'quill-agent');
    expectCode(() => registry.get('quill-agent'), 'ACR_WITHDRAWN');
    assert.equal(registry.list().length, 0);
    assert.equal(registry.search('quill').length, 0);
    expectCode(() => registry.withdraw('quill-agent'), 'ACR_WITHDRAWN');
  });

  it('get on an unknown agentId throws ACR_NOT_FOUND', () => {
    const registry = createAgentCardRegistry();
    expectCode(() => registry.get('ghost'), 'ACR_NOT_FOUND');
    expectCode(() => registry.withdraw('ghost'), 'ACR_NOT_FOUND');
  });

  it('republish with a higher version resurrects a withdrawn card', () => {
    const registry = createAgentCardRegistry();
    registry.publish(validCard({ version: '1.0.0' }));
    registry.withdraw('quill-agent');
    registry.publish(validCard({ version: '1.1.0' }));
    assert.equal(registry.get('quill-agent').version, '1.1.0');
  });
});

describe('search', () => {
  it('matches agentId, name, description, capabilities, and skills', () => {
    const registry = createAgentCardRegistry();
    registry.publish(
      validCard({
        agentId: 'instinct-agent',
        name: 'Instinct',
        description: 'Verification and deploy lane.',
        capabilities: ['deploy'],
        skills: ['typescript'],
      }),
    );
    registry.publish(validCard({ agentId: 'grok-bot', name: 'Grok Bot', description: 'Merge lane', capabilities: ['pr-merge'], skills: ['python'] }));

    assert.equal(registry.search('instinct').length, 1);
    assert.equal(registry.search('Merge Lane')[0].agentId, 'grok-bot');
    assert.equal(registry.search('deploy').length, 1);
    assert.equal(registry.search('TYPESCRIPT')[0].agentId, 'instinct-agent');
    assert.equal(registry.search('zzz-nope').length, 0);
    assert.equal(registry.search('').length, 0);
  });
});

describe('frozen cards', () => {
  it('cards are frozen: callers cannot mutate registry state', () => {
    const registry = createAgentCardRegistry();
    registry.publish(validCard());
    const card = registry.get('quill-agent');
    assert.ok(Object.isFrozen(card));
    assert.ok(Object.isFrozen(card.capabilities));
    assert.throws(() => {
      card.name = 'evil';
    }, TypeError);
    assert.equal(registry.get('quill-agent').name, 'Quill');
  });
});

describe('coded-error contract', () => {
  it('every failure throws an Error with a code property', () => {
    const registry = createAgentCardRegistry();
    const failures = [
      () => registry.publish({}),
      () => registry.publish(validCard({ agentId: 'Bad' })),
      () => registry.get('missing'),
      () => registry.withdraw('missing'),
    ];
    registry.publish(validCard({ version: '9.9.9' }));
    failures.push(() => registry.publish(validCard({ version: '9.9.9' })));

    for (const fn of failures) {
      assert.throws(fn, (err) => {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.equal(typeof err.code, 'string', 'must carry a code');
        return true;
      });
    }
  });
});
