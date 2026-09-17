/**
 * mcp-tool-registry.test.js — tests for the central MCP tool catalog.
 *
 * Covers: register + get, duplicate rejection, invalid-name/version/schema
 * rejection, version resolution (latest non-deprecated), deprecate filtering,
 * validateArgs (required, type, enum, min/max), search, unregister, frozen
 * defs, and the coded-error contract.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpToolRegistry } from '../src/mcp-tool-registry.mjs';

let now;
let registry;
beforeEach(() => {
  now = 1_000_000;
  registry = createMcpToolRegistry({ clock: () => now });
});

const DEF = (over = {}) => ({
  name: 'room.post-draft',
  version: '1.0.0',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 3, maxLength: 80 },
      priority: { type: 'number', minimum: 0, maximum: 5 },
      mode: { type: 'string', enum: ['fast', 'careful'] },
      tags: { type: 'array', minItems: 1, maxItems: 4 },
      meta: { type: 'object' },
      dryRun: { type: 'boolean' },
    },
    required: ['title', 'priority'],
  },
  description: 'Post a draft message to the room lane',
  scopesRequired: ['room.write'],
  ...over,
});

function assertCoded(fn, code) {
  assert.throws(
    fn,
    (err) => err instanceof Error && err.code === code,
    `expected coded error ${code}`,
  );
}

describe('register + get', () => {
  it('registers a def and returns it frozen', () => {
    const stored = registry.register(DEF());
    assert.equal(stored.name, 'room.post-draft');
    assert.equal(stored.version, '1.0.0');
    assert.equal(stored.registeredAt, now);
    assert.ok(Object.isFrozen(stored));
    assert.ok(Object.isFrozen(stored.inputSchema));
  });

  it('get(name, version) returns the pinned version', () => {
    registry.register(DEF({ version: '1.0.0' }));
    registry.register(DEF({ version: '2.0.0', description: 'v2 draft post' }));
    assert.equal(registry.get('room.post-draft', '1.0.0').version, '1.0.0');
    assert.equal(registry.get('room.post-draft', '2.0.0').version, '2.0.0');
  });

  it('copies caller-held schema so later mutation cannot leak in', () => {
    const def = DEF();
    registry.register(def);
    def.inputSchema.properties.title.type = 'number';
    assert.equal(registry.get('room.post-draft', '1.0.0').inputSchema.properties.title.type, 'string');
  });
});

describe('duplicate rejection', () => {
  it('duplicate name+version throws TR_TOOL_EXISTS', () => {
    registry.register(DEF());
    assertCoded(() => registry.register(DEF()), 'TR_TOOL_EXISTS');
  });

  it('same name with a different version is allowed', () => {
    registry.register(DEF());
    const second = registry.register(DEF({ version: '1.1.0' }));
    assert.equal(second.version, '1.1.0');
  });
});

describe('schema validation', () => {
  it('rejects non-object defs', () => {
    assertCoded(() => registry.register(null), 'TR_INVALID_SCHEMA');
    assertCoded(() => registry.register([]), 'TR_INVALID_SCHEMA');
  });

  it('rejects bad names', () => {
    assertCoded(() => registry.register(DEF({ name: 'Room.Post' })), 'TR_INVALID_NAME');
    assertCoded(() => registry.register(DEF({ name: '1room' })), 'TR_INVALID_NAME');
    assertCoded(() => registry.register(DEF({ name: 'room_post' })), 'TR_INVALID_NAME');
    assertCoded(() => registry.register(DEF({ name: '' })), 'TR_INVALID_NAME');
  });

  it('rejects non-semver versions', () => {
    assertCoded(() => registry.register(DEF({ version: '1.0' })), 'TR_INVALID_VERSION');
    assertCoded(() => registry.register(DEF({ version: 'v1.0.0' })), 'TR_INVALID_VERSION');
    assertCoded(() => registry.register(DEF({ version: '' })), 'TR_INVALID_VERSION');
  });

  it('accepts semver with pre-release/build metadata', () => {
    const d = registry.register(DEF({ version: '2.0.0-beta.1+build.7' }));
    assert.equal(d.version, '2.0.0-beta.1+build.7');
  });

  it('rejects malformed def fields', () => {
    assertCoded(() => registry.register(DEF({ inputSchema: null })), 'TR_INVALID_SCHEMA');
    assertCoded(() => registry.register(DEF({ inputSchema: [] })), 'TR_INVALID_SCHEMA');
    assertCoded(() => registry.register(DEF({ description: '   ' })), 'TR_INVALID_SCHEMA');
    assertCoded(() => registry.register(DEF({ scopesRequired: 'room.write' })), 'TR_INVALID_SCHEMA');
    assertCoded(() => registry.register(DEF({ scopesRequired: [42] })), 'TR_INVALID_SCHEMA');
  });
});

describe('version resolution', () => {
  it('get(name) returns the latest non-deprecated version', () => {
    registry.register(DEF({ version: '1.0.0' }));
    registry.register(DEF({ version: '1.10.0' }));
    registry.register(DEF({ version: '1.2.0' }));
    assert.equal(registry.get('room.post-draft').version, '1.10.0');
  });

  it('get(name) skips deprecated versions', () => {
    registry.register(DEF({ version: '1.0.0' }));
    registry.register(DEF({ version: '2.0.0' }));
    registry.deprecate('room.post-draft', '2.0.0');
    assert.equal(registry.get('room.post-draft').version, '1.0.0');
  });

  it('get(name) throws TR_NOT_FOUND when every version is deprecated', () => {
    registry.register(DEF({ version: '1.0.0' }));
    registry.deprecate('room.post-draft', '1.0.0');
    assertCoded(() => registry.get('room.post-draft'), 'TR_NOT_FOUND');
    // pinned lookup of a deprecated version still works
    assert.equal(registry.get('room.post-draft', '1.0.0').deprecated, true);
  });

  it('pre-release sorts below the release', () => {
    registry.register(DEF({ version: '2.0.0-beta.1' }));
    registry.register(DEF({ version: '2.0.0' }));
    assert.equal(registry.get('room.post-draft').version, '2.0.0');
  });
});

describe('deprecate + list filtering', () => {
  it('deprecate marks the version and stamps deprecatedAt', () => {
    registry.register(DEF());
    now += 500;
    const marked = registry.deprecate('room.post-draft', '1.0.0');
    assert.equal(marked.deprecated, true);
    assert.equal(marked.deprecatedAt, now);
    assert.ok(Object.isFrozen(marked));
  });

  it('deprecate is idempotent', () => {
    registry.register(DEF());
    registry.deprecate('room.post-draft', '1.0.0');
    const again = registry.deprecate('room.post-draft', '1.0.0');
    assert.equal(again.deprecated, true);
  });

  it('deprecate of unknown version throws TR_NOT_FOUND', () => {
    registry.register(DEF());
    assertCoded(() => registry.deprecate('room.post-draft', '9.9.9'), 'TR_NOT_FOUND');
    assertCoded(() => registry.deprecate('nope', '1.0.0'), 'TR_NOT_FOUND');
  });

  it('list() excludes deprecated unless includeDeprecated', () => {
    registry.register(DEF({ name: 'a.tool', version: '1.0.0' }));
    registry.register(DEF({ name: 'b.tool', version: '1.0.0' }));
    registry.deprecate('a.tool', '1.0.0');
    const live = registry.list();
    assert.deepEqual(live.map((d) => d.name), ['b.tool']);
    const all = registry.list({ includeDeprecated: true });
    assert.deepEqual(all.map((d) => d.name), ['a.tool', 'b.tool']);
  });
});

describe('validateArgs', () => {
  it('accepts valid args', () => {
    registry.register(DEF());
    const r = registry.validateArgs('room.post-draft', '1.0.0', {
      title: 'hello world',
      priority: 2,
      mode: 'fast',
      tags: ['x'],
      dryRun: false,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
  });

  it('flags missing required fields', () => {
    registry.register(DEF());
    const r = registry.validateArgs('room.post-draft', '1.0.0', { title: 'abc' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.field === 'priority' && /required/.test(e.message)));
  });

  it('flags wrong types', () => {
    registry.register(DEF());
    const r = registry.validateArgs('room.post-draft', '1.0.0', {
      title: 123,
      priority: 'high',
      tags: 'x',
    });
    assert.equal(r.ok, false);
    assert.equal(r.errors.find((e) => e.field === 'title').message, 'expected string, got number');
    assert.equal(r.errors.find((e) => e.field === 'priority').message, 'expected number, got string');
    assert.equal(r.errors.find((e) => e.field === 'tags').message, 'expected array, got string');
  });

  it('flags enum and min/max violations', () => {
    registry.register(DEF());
    const r = registry.validateArgs('room.post-draft', '1.0.0', {
      title: 'ok title',
      priority: 9,
      mode: 'reckless',
      tags: [],
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.field === 'priority' && /maximum/.test(e.message)));
    assert.ok(r.errors.some((e) => e.field === 'mode' && /enum/.test(e.message)));
    assert.ok(r.errors.some((e) => e.field === 'tags' && /minItems/.test(e.message)));
  });

  it('rejects non-object args', () => {
    registry.register(DEF());
    const r = registry.validateArgs('room.post-draft', '1.0.0', null);
    assert.equal(r.ok, false);
    assert.ok(r.errors[0].message.includes('object'));
  });

  it('throws TR_NOT_FOUND for unknown tools', () => {
    assertCoded(() => registry.validateArgs('nope.tool', '1.0.0', {}), 'TR_NOT_FOUND');
  });
});

describe('search', () => {
  it('matches by name and description, case-insensitive', () => {
    registry.register(DEF({ name: 'room.post-draft', description: 'Post a draft' }));
    registry.register(DEF({ name: 'room.get-thread', version: '1.0.0', description: 'Fetch a thread' }));
    const byName = registry.search('GET-THREAD');
    assert.deepEqual(byName.map((d) => d.name), ['room.get-thread']);
    const byDesc = registry.search('draft');
    assert.deepEqual(byDesc.map((d) => d.name), ['room.post-draft']);
  });

  it('excludes deprecated by default', () => {
    registry.register(DEF({ name: 'room.old-tool', version: '1.0.0', description: 'legacy helper' }));
    registry.deprecate('room.old-tool', '1.0.0');
    assert.deepEqual(registry.search('legacy'), []);
    assert.equal(registry.search('legacy', { includeDeprecated: true }).length, 1);
  });

  it('rejects empty queries', () => {
    assertCoded(() => registry.search('   '), 'TR_INVALID_SCHEMA');
  });
});

describe('unregister', () => {
  it('removes the version and returns the frozen def', () => {
    registry.register(DEF());
    const removed = registry.unregister('room.post-draft', '1.0.0');
    assert.equal(removed.version, '1.0.0');
    assertCoded(() => registry.get('room.post-draft', '1.0.0'), 'TR_NOT_FOUND');
  });

  it('removing the last version clears the name', () => {
    registry.register(DEF());
    registry.unregister('room.post-draft', '1.0.0');
    assert.deepEqual(registry.list(), []);
    assertCoded(() => registry.unregister('room.post-draft', '1.0.0'), 'TR_NOT_FOUND');
  });

  it('leaves sibling versions intact', () => {
    registry.register(DEF({ version: '1.0.0' }));
    registry.register(DEF({ version: '2.0.0' }));
    registry.unregister('room.post-draft', '1.0.0');
    assert.equal(registry.get('room.post-draft', '2.0.0').version, '2.0.0');
  });
});

describe('frozen defs', () => {
  it('stored defs cannot be mutated', () => {
    const stored = registry.register(DEF());
    assert.throws(() => {
      stored.name = 'hacked';
    });
    assert.equal(registry.get('room.post-draft', '1.0.0').name, 'room.post-draft');
  });

  it('get results are the same frozen identity', () => {
    const a = registry.register(DEF());
    assert.strictEqual(registry.get('room.post-draft', '1.0.0'), a);
  });
});

describe('coded-error contract', () => {
  it('every error carries a string code and a message', () => {
    const codes = [
      () => registry.register(null),
      () => registry.register(DEF({ name: 'Bad' })),
      () => registry.register(DEF({ version: 'x' })),
      () => registry.get('missing', '1.0.0'),
    ];
    registry.register(DEF());
    codes.push(() => registry.register(DEF()));
    for (const fn of codes) {
      try {
        fn();
        assert.fail('expected an error');
      } catch (err) {
        assert.ok(err instanceof Error);
        assert.equal(typeof err.code, 'string');
        assert.ok(err.code.startsWith('TR_'));
        assert.ok(err.message.length > 0);
      }
    }
  });
});
