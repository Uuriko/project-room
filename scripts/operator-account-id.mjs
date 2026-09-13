import { providerAccountId } from '../server/operator-account-id.mjs';

const [, , issuer, sub] = process.argv;
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!issuer || !sub) {
    console.error('usage: node scripts/operator-account-id.mjs ISSUER SUB');
    process.exit(1);
  }
  console.log(JSON.stringify({ accountId: providerAccountId(issuer, sub) }));
}
