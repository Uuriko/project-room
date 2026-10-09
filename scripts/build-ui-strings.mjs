import {readFileSync,writeFileSync} from 'node:fs';
const catalogPath=new URL('../strings/en.json',import.meta.url), outputPath=new URL('../strings/en.js',import.meta.url);
const catalog=JSON.parse(readFileSync(catalogPath,'utf8'));
const output='// Generated from strings/en.json by scripts/build-ui-strings.mjs.\nexport default '+JSON.stringify(catalog,null,2)+';\n';
// Unknown flags fail loudly: a typo'd --chek must not silently rewrite en.js
// (and exit 0) when the caller meant --check.
for(const arg of process.argv.slice(2)) {
  if(arg!=='--check') { console.error(`build-ui-strings: unknown arg: ${arg}`); process.exit(2); }
}
if(process.argv.includes('--check')) {
  if(readFileSync(outputPath,'utf8')!==output) throw new Error('UI catalog module is stale');
} else writeFileSync(outputPath,output);
