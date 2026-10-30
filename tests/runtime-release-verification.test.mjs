import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('runtime archive verification rejects altered, incomplete, duplicate and unsafe packages', () => {
  const result = spawnSync(process.env.PYTHON || 'python3', ['-c', `
import importlib.util, tempfile, pathlib, tarfile, io, json, sys, shutil
from unittest.mock import patch
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('verify','scripts/verify-runtime-release.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d);expected=p/'expected';expected.mkdir();(expected/'a').write_bytes(b'correct')
 def archive(entries):
  target=p/'package.tar.gz'
  with tarfile.open(target,'w:gz') as t:
   for name,body,kind in entries:
    info=tarfile.TarInfo(name);info.type=kind;info.size=len(body) if kind==tarfile.REGTYPE else 0
    if kind==tarfile.SYMTYPE: info.linkname='/tmp/outside'
    t.addfile(info,io.BytesIO(body) if kind==tarfile.REGTYPE else None)
  return target
 valid=[('./a',b'correct',tarfile.REGTYPE)]
 assert m.verify_archive(archive(valid),expected)['files']==1
 for bad in [[], [('a',b'corrupt',tarfile.REGTYPE)],valid+valid,[('../a',b'correct',tarfile.REGTYPE)],[('/a',b'correct',tarfile.REGTYPE)],[('a',b'',tarfile.SYMTYPE)],valid+[('extra',b'x',tarfile.REGTYPE)]]:
  try: m.verify_archive(archive(bad),expected)
  except ValueError: pass
  else: raise AssertionError('unsafe package accepted')
 sha='a'*40
 release={'id':1,'draft':False,'prerelease':False,'assets':[{'id':2,'name':m.ASSET,'state':'uploaded','size':100}]}
 assert m.release_identity(release,{'sha':sha},sha)['assetId']==2
 for r,c in [(release,{'sha':'b'*40}),({**release,'draft':True},{'sha':sha}),({**release,'assets':[]},{'sha':sha}),({**release,'assets':release['assets']*2},{'sha':sha})]:
  try: m.release_identity(r,c,sha)
  except ValueError: pass
  else: raise AssertionError('invalid release accepted')
 # Preflight rejects the incident's wrong basename, including gh's misleading label suffix,
 # before invoking even the package verifier, and never makes GitHub requests or writes.
 source=archive(valid)
 def preflight(path):
  return ['verify','--preflight-archive',str(path),'--sha',sha,'--expected',str(expected)]
 for wrong in [source,str(source)+'#'+m.ASSET]:
  with patch.object(sys,'argv',preflight(wrong)),patch.object(m.subprocess,'run') as run,patch.object(m.subprocess,'check_output') as network:
   try: m.main()
   except ValueError as error: assert 'upload filename' in str(error)
   else: raise AssertionError('wrong asset basename accepted')
   run.assert_not_called();network.assert_not_called()
 upload=p/m.ASSET;shutil.copyfile(source,upload)
 before=upload.read_bytes()
 with patch.object(sys,'argv',preflight(upload)),patch.object(m.subprocess,'run') as run,patch.object(m.subprocess,'check_output') as network:
  m.main();m.main() # read-only retry does not overwrite or publish
  assert run.call_count==2 and run.call_args.args[0][-3:]==['verify',str(expected),sha]
  network.assert_not_called();assert upload.read_bytes()==before
 # Matching name does not excuse corrupted contents or failed exact-source validation.
 upload.write_bytes(b'not an archive')
 with patch.object(sys,'argv',preflight(upload)),patch.object(m.subprocess,'run'),patch.object(m.subprocess,'check_output') as network:
  try: m.main()
  except tarfile.ReadError: pass
  else: raise AssertionError('corrupt upload accepted')
  network.assert_not_called()
 shutil.copyfile(source,upload)
 with patch.object(sys,'argv',preflight(upload)),patch.object(m.subprocess,'run',side_effect=RuntimeError('wrong source')),patch.object(m,'verify_archive') as compare:
  try: m.main()
  except RuntimeError: pass
  else: raise AssertionError('unverified source accepted')
  compare.assert_not_called()
 # Exercise orchestration without GitHub access: exact download and changed metadata.
 source=archive(valid);release['assets'][0]['size']=source.stat().st_size
 receipt=p/'receipt.json'
 argv=['verify','--repository','owner/repo','--tag','runtime-2026-10-29-aaaaaaa','--sha',sha,'--expected',str(expected),'--receipt',str(receipt)]
 def run(args,**kwargs):
  if args[:3]==['gh','release','download']:
   shutil.copyfile(source,pathlib.Path(args[args.index('--dir')+1])/m.ASSET)
 for changed in [False,True]:
  receipt.write_text('{"verified":true,"stale":true}');calls=[0]
  def read(args,**kwargs):
   calls[0]+=1
   if '/commits/' in args[-1]: return json.dumps({'sha':sha}).encode()
   return json.dumps({**release,'id':99 if changed and calls[0]>2 else 1}).encode()
  with patch.object(sys,'argv',argv),patch.object(m.subprocess,'run',run),patch.object(m.subprocess,'check_output',read):
   if changed:
    try: m.main()
    except ValueError: pass
    else: raise AssertionError('changed release accepted')
    assert not receipt.exists()
   else:
    m.main();r=json.loads(receipt.read_text());assert r['verified'] and not r['publicationPromoted'] and r['sourceCommit']==sha
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('existing and new publication verify before latest promotion', () => {
  const source = readFileSync('.github/workflows/deploy-prod.yml', 'utf8');
  assert.match(source, /then\n\s+verify_release\n\s+gh release edit/);
  assert.match(source, /--latest=false/);
  assert.match(source, /--preflight-archive[^\n]+\n[^\n]+\n\s+gh release create/);
  assert.doesNotMatch(source, /project-room-runtime\.tar\.gz#/);
  assert.match(source, /--notes [^\n]+\n\s+verify_release\n\s+gh release edit/);
});
