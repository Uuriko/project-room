import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { scenarios, scenario, contextPacket, variants } from './scenarios.mjs';
import { score } from './oracle.mjs';

export function createExperimentServer() {
  const files = { '/': ['index.html', 'text/html'], '/ui.js': ['ui.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
  return createServer(async (req, res) => {
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      // Local-only test service. Browser writes must originate here.
      const origin = `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== origin) return json(403, { error: 'Cross-origin request refused' });
      const url = new URL(req.url, origin), path = url.pathname;
      if (req.method === 'GET' && files[path]) {
        const [name, type] = files[path];
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'" });
        return res.end(await readFile(new URL(name, import.meta.url)));
      }
      if (req.method === 'GET' && path === '/api/catalog') return json(200, { variants, scenarios: scenarios.map(({ id, title }) => ({ id, title })) });
      const match = path.match(/^\/api\/scenario\/([a-z]+)(?:\/(discussion|context))?$/);
      if (req.method === 'GET' && match) {
        const s = scenario(match[1]);
        return json(200, match[2] === 'discussion' ? { messages: s.messages } : match[2] === 'context' ? contextPacket(s, url.searchParams.get('mode')) : s);
      }
      if (req.method === 'POST' && path === '/api/score') {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 32768) return json(413, { error: 'Answer too large' }); }
        const value = JSON.parse(raw);
        return json(200, score(value.scenario, value.task, value.answer));
      }
      return json(404, { error: 'Not found' });
    } catch { return json(400, { error: 'Invalid experiment request' }); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createExperimentServer();
  server.listen(0, '127.0.0.1', () => console.log(`Experiment: http://127.0.0.1:${server.address().port} (synthetic, local only)`));
}
