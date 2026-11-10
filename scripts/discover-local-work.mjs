import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { discoverLocalWork } from '../client/local-work-supply.mjs';
const exec = promisify(execFile);
if (process.argv.length !== 3) throw Error('Usage: node scripts/discover-local-work.mjs policies.json');
const policies = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const result = await discoverLocalWork({ policies, readPullRequest: async (repository, number) => {
  const { stdout } = await exec('gh', ['pr', 'view', String(number), '--repo', repository,
    '--json', 'headRefOid,state,statusCheckRollup'], { timeout: 30000, maxBuffer: 1048576 });
  return JSON.parse(stdout);
} });
console.log(JSON.stringify(result, null, 2));
