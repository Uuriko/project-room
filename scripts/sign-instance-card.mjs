// Offline signer: private Ed25519 seed on stdin, public pin from operator custody.
// Produces only a public artifact, never a private-key file or automatic trust pin.
import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { signInstanceCardArtifact } from '../server/instance-card-artifact.mjs';
import { readPublicInstanceFile } from '../server/instance-card-files.mjs';
import { deployedInfo } from '../server/agent-discovery.mjs';
try {
  const build = deployedInfo();
  if (build.stale || !/^[a-f0-9]{40}$/.test(build.revision) || ['dev', 'unstamped'].includes(build.buildId)) throw Error('build');
  const [pinPath, output, ...extra] = process.argv.slice(2);
  if (extra.length || !isAbsolute(output ?? '')) throw Error('arguments');
  const pin = JSON.parse(readPublicInstanceFile(pinPath, 8192));
  if (!pin || Object.keys(pin).sort().join() !== 'agentId,keyId,origin,publicKey' || new URL(pin.origin).protocol !== 'https:') throw Error('pin');
  let privateKey = '';
  for await (const chunk of process.stdin) {
    privateKey += chunk.toString('utf8');
    if (Buffer.byteLength(privateKey) > 256) throw Error('input');
  }
  const artifact = signInstanceCardArtifact({ ...pin, privateKey: privateKey.trim() });
  privateKey = '';
  writeFileSync(output, JSON.stringify(artifact, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ signed: true, origin: pin.origin, keyId: pin.keyId }));
} catch {
  console.error('Instance card signing failed. Use a public HTTPS pin, matching private seed on stdin, and a fresh absolute output path. No key material is logged.');
  process.exitCode = 1;
}
