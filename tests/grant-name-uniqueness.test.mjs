import test from 'node:test';
import assert from 'node:assert/strict';
import {agentAccessProfiles, AGENT_PROFILE_ALIASES, agentProfilePermissions, isAgentProfile, isConnectionAccess} from '../server/agent-connections.mjs';
import {INVITATION_ROLES, INVITATION_ROLE_POLICIES} from '../src/events.js';
import {linkPermissions} from '../server/share-links.mjs';

// rules-p1: one grant name, one bit set. The agent profile "member" (steer,
// manage_claims, write_external, ...) and the invitation/share-link role
// "member" (accept/complete/verify) shared a name with different grants.
const tables = {
  'agent profiles': agentAccessProfiles,
  ...Object.fromEntries(Object.entries(INVITATION_ROLE_POLICIES).map(([v, roles]) => [`invitation roles v${v}`, roles]))
};
const bits = list => JSON.stringify([...list].sort());

test('no two live grant definitions share a name with different bits', () => {
  const seen = new Map();
  for (const [table, defs] of Object.entries(tables)) for (const [name, grant] of Object.entries(defs)) {
    if (seen.has(name)) assert.equal(bits(grant), seen.get(name).bits, `"${name}" in ${table} differs from ${seen.get(name).table}`);
    else seen.set(name, {table, bits: bits(grant)});
  }
  assert.equal(Object.hasOwn(agentAccessProfiles, 'member'), false);
});

test('the "member" alias keeps exactly the agent work set; human "member" keeps its own', () => {
  assert.deepEqual(AGENT_PROFILE_ALIASES, {member: 'agent_member'});
  assert.equal(isAgentProfile('member'), true);
  assert.deepEqual(agentProfilePermissions('member'), ['steer', 'accept_work', 'complete_work', 'verify', 'manage_claims', 'write_external']);
  assert.deepEqual(agentProfilePermissions('agent_member'), agentProfilePermissions('member'));
  assert.deepEqual([...INVITATION_ROLES.member], ['accept_work', 'complete_work', 'verify']);
  assert.deepEqual(linkPermissions('member'), ['accept_work', 'complete_work', 'verify']);
  for (const bogus of ['constructor', '__proto__', 'toString', 'owner', '']) assert.equal(isAgentProfile(bogus), false, bogus);
});

test('stored connection requests keep the spelling the previous release can re-validate', () => {
  assert.equal(isConnectionAccess('member'), true);
  assert.equal(isConnectionAccess('agent_member'), false);
  for (const name of Object.keys(agentAccessProfiles).filter(name => name !== 'agent_member')) assert.equal(isConnectionAccess(name), true, name);
  for (const bogus of ['constructor', '__proto__', '', null, undefined]) assert.equal(isConnectionAccess(bogus), false, String(bogus));
});
