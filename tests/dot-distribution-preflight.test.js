import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditDistribution, inspectPackage } from '../scripts/check-dot-distribution.mjs';

// Synthetic test data only: these fixtures do not nominate a publisher or URL.
function fixture() {
  const plugin = { name:'fixture', version:'1.0.0', description:'Test fixture', extensions:{ 'com.openai':{
    interface:{ displayName:'Fixture', shortDescription:'Test only', longDescription:'Synthetic test package', developerName:'Fixture', category:'Productivity',
      websiteURL:'https://fixture.invalid-domain.org', supportURL:'https://fixture.invalid-domain.org/support', privacyPolicyURL:'https://fixture.invalid-domain.org/privacy', termsOfServiceURL:'https://fixture.invalid-domain.org/terms', logo:'./icon.svg' },
    review:{ demo_recording_url:'https://fixture.invalid-domain.org/video', test_cases:{
      positive:Array.from({length:5}, () => ({description:'Scenario',prompt:'Test prompt',tools_triggered:'room_check_access',expected_behavior:'Expected test response'})),
      negative:Array.from({length:3}, () => ({description:'Refuse unauthorized access',prompt:'Read another room'})) } },
    publication:{release_notes:'Fixture only'} } } };
  const mcp = {mcpServers:{room:{type:'streamable-http',url:'https://fixture.invalid-domain.org/mcp',extensions:{'com.openai':{auth:{type:'oauth',client:{mode:'provided',clientId:'fixture-client',tokenEndpointAuthMethod:'none'},resource:'https://fixture.invalid-domain.org/mcp',baseScopes:['rooms:read','chat:read','chat:write','work:read','work:write']}}}}}};
  return {plugin,mcp,assetExists:()=>true};
}
test('offline pass never asserts installability or schema validation', () => {
  const r = auditDistribution(fixture());
  assert.equal(r.offlinePreparation,'passed_pending_human_and_host_gates');
  assert.equal(r.installability,'not_established_by_offline_check');
  assert.equal(r.structure,'basic_shape_passed_not_schema_validated');
  assert.ok(r.humanGates.length);
});
test('minimal hosted template remains structurally accepted but distribution not ready', () => {
  const f=fixture(); f.plugin={name:'template',version:'0.1.0',description:'Unconfigured template'};
  const r=auditDistribution(f); assert.deepEqual(r.structuralErrors,[]); assert.equal(r.offlinePreparation,'not_ready');
  assert.ok(r.releaseGaps.includes('listing_privacyPolicyURL_requires_public_https'));
});
for (const url of ['not a url','http://room.org/mcp','https://localhost/mcp','https://localhost./mcp','https://127.0.0.1/mcp','https://room.example.invalid/mcp','https://room.example.invalid./mcp','https://user:secret@room.org/mcp','https://room.org/mcp#fragment','https://room.org/mcp?token=secret',' https://room.org/mcp ']) {
  test(`rejects unsafe or placeholder endpoint ${url.replace('secret','redacted')}`, () => {
    const f=fixture(); f.mcp.mcpServers.room.url=url;
    assert.ok(auditDistribution(f).releaseGaps.includes('public_https_mcp_url_required'));
  });
}
test('resource mismatch, local execution, hooks and credential headers fail', () => {
  const f=fixture(), s=f.mcp.mcpServers.room;
  s.extensions['com.openai'].auth.resource='https://other.org/mcp'; s.command='node'; s.headers={Authorization:'secret-sentinel'}; f.localHooks=true;
  const r=auditDistribution(f);
  for (const code of ['resource_must_equal_mcp_url','local_or_unsupported_transport','server_headers_forbidden_in_public_submission','local_hooks_not_mobile_candidate']) assert.ok(r.releaseGaps.includes(code));
  assert.ok(!JSON.stringify(r).includes('secret-sentinel'));
});
test('malformed header declarations cannot bypass the public-header guard', () => {
  for (const headers of ['secret-sentinel', ['secret-sentinel'], null, 42]) {
    const f=fixture(); f.mcp.mcpServers.room.headers=headers;
    const r=auditDistribution(f);
    assert.ok(r.releaseGaps.includes('server_headers_forbidden_in_public_submission'));
    assert.ok(!JSON.stringify(r).includes('secret-sentinel'));
  }
});
test('incomplete review and missing icon fail', () => {
  const f=fixture(); f.assetExists=()=>false;
  f.plugin.extensions['com.openai'].review.test_cases={positive:[{}],negative:[]};
  const r=auditDistribution(f);
  for (const code of ['primary_icon_missing_or_outside_package','five_complete_positive_review_cases_required','three_negative_review_cases_required']) assert.ok(r.releaseGaps.includes(code));
});
test('malformed shapes report failures rather than crashing', () => {
  assert.ok(auditDistribution({plugin:null,mcp:{mcpServers:{bad:null}}}).structuralErrors.length);
});
test('filesystem checker refuses escaping icon symlink and CLI redacts invalid input', () => {
  const dir=mkdtempSync(join(tmpdir(),'dot-preflight-'));
  try {
    mkdirSync(join(dir,'pkg')); const f=fixture();
    writeFileSync(join(dir,'pkg/plugin.json'),JSON.stringify(f.plugin)); writeFileSync(join(dir,'pkg/mcp.json'),JSON.stringify(f.mcp));
    writeFileSync(join(dir,'outside.svg'),'<svg/>'); symlinkSync(join(dir,'outside.svg'),join(dir,'pkg/icon.svg'));
    assert.ok(inspectPackage(join(dir,'pkg')).releaseGaps.includes('primary_icon_missing_or_outside_package'));
    writeFileSync(join(dir,'pkg/mcp.json'),'private-sentinel-invalid-json');
    const cli=spawnSync(process.execPath,['scripts/check-dot-distribution.mjs',join(dir,'pkg')],{encoding:'utf8'});
    assert.equal(cli.status,2); assert.ok(!`${cli.stdout}${cli.stderr}`.includes('private-sentinel'));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('directory cannot satisfy the primary icon requirement', () => {
  const dir=mkdtempSync(join(tmpdir(),'dot-preflight-icon-'));
  try {
    const f=fixture(); mkdirSync(join(dir,'icon.svg'));
    writeFileSync(join(dir,'plugin.json'),JSON.stringify(f.plugin)); writeFileSync(join(dir,'mcp.json'),JSON.stringify(f.mcp));
    assert.ok(inspectPackage(dir).releaseGaps.includes('primary_icon_missing_or_outside_package'));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
