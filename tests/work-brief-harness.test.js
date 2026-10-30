import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { qualifyWorkBrief, SCENARIOS, STRATEGIES } from '../scripts/qualify-work-brief.mjs';

test('handoff harness uses real mutations, honest omissions and authenticated failures', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'brief-harness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const report = await qualifyWorkBrief({ packetsDirectory: dir });
  assert.deepEqual(report.cases.map(x => x.scenario), SCENARIOS);
  const row = (scenario, strategy) => report.cases.find(x => x.scenario === scenario).strategies.find(x => x.strategy === strategy);
  for (const item of report.cases) {
    assert.ok(item.sequenceAfter > item.sequenceBefore, 'every scenario changes real canonical store events');
    assert.deepEqual(item.strategies.map(x => x.strategy), STRATEGIES);
    for (const strategy of item.strategies) {
      assert.equal(strategy.calls, 2);
      assert.ok(strategy.elapsedMs >= 0 && Number.isFinite(strategy.elapsedMs));
      assert.ok(strategy.responseBytes > 0);
      assert.equal(strategy.comparison.authorityGranted, false);
    }
  }
  for (const strategy of STRATEGIES) {
    assert.equal(row('access_revoked', strategy).after.outcome, 'error');
    assert.equal(row('access_revoked', strategy).after.payload, null);
    assert.equal(row('access_revoked', strategy).after.failure.status, 401);
    assert.equal(row('source_omitted', strategy).comparison.sourceContent, 'unknown');
    assert.equal(row('source_private', strategy).comparison.sourceContent, 'unknown');
  }
  assert.equal(row('source_edited', 'current_brief').comparison.representedFields, 'same');
  assert.equal(row('source_edited', 'current_brief').comparison.sourceContent, 'unknown');
  assert.equal(row('charter_changed', 'current_brief').comparison.representedFields, 'changed');
  assert.equal(row('charter_changed', 'minimal').comparison.representedFields, 'same');
  assert.equal(row('replacement', 'current_brief').comparison.representedFields, 'changed');
  assert.equal(row('unrelated_traffic', 'current_brief').comparison.representedFields, 'same');
  assert.equal(row('source_edited', 'freshness_aware').comparison.sourceContent, 'changed');
  assert.equal(row('unrelated_traffic', 'freshness_aware').comparison.sourceContent, 'unchanged');
  assert.equal(row('unrelated_traffic', 'freshness_aware').comparison.representedFields, 'same', 'observed-to-unchanged relative labels do not invalidate stable observation');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE-HARNESS-(?:SOURCE|EDIT)-SENTINEL/);
  assert.equal(report.packetFiles.length, 48);
  for (const file of report.packetFiles) {
    const raw = readFileSync(join(dir, file.file));
    assert.equal(createHash('sha256').update(raw).digest('hex'), file.sha256);
    if (!file.file.endsWith('.json')) continue;
    const packet = JSON.parse(raw);
    if (!file.file.endsWith('/initial.json')) continue;
    assert.equal(Object.hasOwn(packet, 'scenario'), false);
    assert.equal(Object.hasOwn(packet, 'comparison'), false);
    assert.equal(Object.hasOwn(packet, 'expected'), false);
  }
  for (let i = 1; i <= 7; i++) {
    const latest = STRATEGIES.map(strategy => readFileSync(join(dir, `${strategy}/case-${i}/latest.json`), 'utf8'));
    assert.equal(new Set(latest).size, 1, 'all arms have identical permitted current observations');
  }
  assert.match(report.source.revision, /^[a-f0-9]{40}$/);
  assert.match(report.source.sha256['scripts/qualify-work-brief.mjs'], /^[a-f0-9]{64}$/);
});
