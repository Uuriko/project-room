import {readFileSync,writeFileSync} from 'node:fs';
const catalogPath=new URL('../strings/en.json',import.meta.url), outputPath=new URL('../strings/en.js',import.meta.url);
const catalog=JSON.parse(readFileSync(catalogPath,'utf8'));
const output='// Generated from strings/en.json by scripts/build-ui-strings.mjs.\nexport default '+JSON.stringify(catalog,null,2)+';\n';
// Anti-slop: UI copy uses periods or commas, never an em dash. The catalog
// reached zero in #2373, so any em dash in a user-facing string is new.
export function emDashKeys(entries){return Object.entries(entries).filter(([key,value])=>key!=='_meta'&&typeof value==='string'&&value.includes('\u2014')).map(([key])=>key);}
if(process.argv.includes('--check')) {
  if(readFileSync(outputPath,'utf8')!==output) throw new Error('UI catalog module is stale');
  const dashed=emDashKeys(catalog);
  if(dashed.length) throw new Error(`UI strings must not use an em dash (use a period or comma): ${dashed.join(', ')}`);
} else writeFileSync(outputPath,output);
