import { readFileSync } from 'node:fs';
import { planLocalWork } from '../client/local-work-planner.mjs';

// No shell execution, credentials, persistence, subscriptions or automatic claims.
const path = process.argv[2];
if (!path || process.argv.length !== 3) throw Error('Usage: node scripts/plan-local-work.mjs snapshot.json');
console.log(JSON.stringify(planLocalWork(JSON.parse(readFileSync(path, 'utf8'))), null, 2));
