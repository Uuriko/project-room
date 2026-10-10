import {readFileSync,writeFileSync} from 'node:fs';
const catalogPath=new URL('../strings/en.json',import.meta.url), outputPath=new URL('../strings/en.js',import.meta.url);
const catalog=JSON.parse(readFileSync(catalogPath,'utf8'));
const output='// Generated from strings/en.json by scripts/build-ui-strings.mjs.\nexport default '+JSON.stringify(catalog,null,2)+';\n';
if(process.argv.includes('--check')) {
  if(readFileSync(outputPath,'utf8')!==output) throw new Error('UI catalog module is stale');
} else writeFileSync(outputPath,output);
