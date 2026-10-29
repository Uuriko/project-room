import test from 'node:test';
import assert from 'node:assert/strict';
import { presenceGroups } from '../src/conversation.js';

const roster = (n, live = []) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, state: live.includes(i) ? 'online' : 'away' }));
const of = m => m.state;

test('a large room lists who is around and groups the rest', () => {
  const r = roster(9, [1, 4]);
  const g = presenceGroups(r, of, 'm0');
  assert.equal(g.split, true);
  assert.deepEqual(g.around.map(m => m.id), ['m0', 'm1', 'm4']);
  assert.deepEqual(g.others.map(m => m.id), ['m2', 'm3', 'm5', 'm6', 'm7', 'm8']);
});

test('working and listening agents count as around', () => {
  const r = roster(8); r[3].state = 'working'; r[5].state = 'listening';
  const g = presenceGroups(r, of, 'm0');
  assert.deepEqual(g.around.map(m => m.id), ['m0', 'm3', 'm5']);
});

test('a small room is never split', () => {
  const g = presenceGroups(roster(6, [1]), of, 'm0');
  assert.equal(g.split, false);
  assert.equal(g.around.length, 6);
  assert.deepEqual(g.others, []);
});

test('no live signal from anyone but the viewer (stale or unloaded presence) shows everyone', () => {
  const r = roster(12); r.forEach(m => { m.state = 'unknown'; });
  const g = presenceGroups(r, of, 'm0');
  assert.equal(g.split, false);
  assert.equal(g.around.length, 12);
});

test('the viewer is always around, even when idle', () => {
  const r = roster(8, [2]); r[0].state = 'idle';
  const g = presenceGroups(r, of, 'm0');
  assert.ok(g.around.some(m => m.id === 'm0'));
});

test('order is preserved and the input is not mutated', () => {
  const r = roster(8, [7, 2]);
  const before = JSON.stringify(r);
  const g = presenceGroups(r, of, 'm0');
  assert.deepEqual(g.around.map(m => m.id), ['m0', 'm2', 'm7']);
  assert.equal(JSON.stringify(r), before);
});
