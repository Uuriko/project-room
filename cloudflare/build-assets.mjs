import { mkdir, copyFile } from 'node:fs/promises';
const output = new URL('./public/', import.meta.url);
await mkdir(new URL('src/', output), { recursive: true });
const files = ['index.html', ...['app.js', 'client.js', 'events.js', 'conversation.js', 'workflow.js',
  'share-links.js', 'return-brief.js', 'work-status.js', 'styles.css'].map(file => 'src/' + file)];
for (const file of files) await copyFile(new URL('../' + file, import.meta.url), new URL(file, output));
console.log(`Prepared ${files.length} allowlisted application assets; no database, tests or operator files included.`);
