// Every reviewed MCP profile that lets an agent open a formal request also
// lets it cancel that request, so a superseded ask never has to wait on the
// recipient (bug ledger B8 follow-up).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const snapshot = JSON.parse(readFileSync(new URL('./fixtures/mcp-catalog.snapshot.json', import.meta.url), 'utf8'));
test('profiles that list room_request_reply also list room_cancel_request', () => {
  const checked = [];
  for (const [profile, tools] of Object.entries(snapshot)) {
    const names = Array.isArray(tools) ? tools.map(tool => tool.name ?? tool) : Object.keys(tools ?? {});
    if (!names.includes('room_request_reply')) continue;
    checked.push(profile);
    assert.ok(names.includes('room_cancel_request'), `${profile} can ask but not cancel`);
  }
  assert.ok(checked.length >= 3, `expected several asking profiles, saw ${checked}`);
});
