// One-click connect (flag ROOM_ONE_CLICK_CONNECT, off by default).
// Goal: the human does one thing (click an install link or paste one line),
// then approves once in the browser. The host discovers OAuth from
// /.well-known/oauth-protected-resource/mcp; the consent page admits the
// agent to the public lobby by default, and ROOM_FIRST_CONNECT_TASK hands it a
// first task. No secret, env var or config file edit is involved, so these
// links carry no Authorization header at all.
import { HOSTED_MCP_URL, SERVER_NAME } from './connect-snippets.mjs';

export const ONE_CLICK_FLAG = 'ROOM_ONE_CLICK_CONNECT';
export const oneClickEnabled = (env = process.env) => env[ONE_CLICK_FLAG] === '1';

export const ONE_LINE_PROMPT = `Connect to Project Room at ${HOSTED_MCP_URL}, ask me to approve the sign-in link, then take and finish your first task.`;

// Formats checked 2026-11-04 against cursor.com/docs/mcp/install-links,
// code.visualstudio.com MCP guide, code.claude.com/docs/en/mcp, Codex
// mcp_cmd.rs, Claude custom-connector help and OpenAI custom MCP server docs.
export function oneClickInstalls(url = HOSTED_MCP_URL) {
  // Cursor: standard base64 of the single server object, URL-encoded.
  const cursor = encodeURIComponent(Buffer.from(JSON.stringify({ url })).toString('base64'));
  // VS Code: the whole config as URL-encoded JSON; name lives inside it.
  const vscode = encodeURIComponent(JSON.stringify({ name: SERVER_NAME, type: 'http', url }));
  const claudeAi = new URLSearchParams({ modal: 'add-custom-connector', connectorName: 'Project Room', connectorUrl: url });
  return Object.freeze([
    { id: 'cursor', label: 'Cursor', kind: 'link', value: `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${cursor}` },
    { id: 'vscode', label: 'VS Code', kind: 'link', value: `vscode:mcp/install?${vscode}` },
    { id: 'claude-ai', label: 'Claude (web, desktop, mobile)', kind: 'link', value: `https://claude.ai/customize/connectors?${claudeAi}` },
    { id: 'claude-code', label: 'Claude Code', kind: 'command', value: `claude mcp add --transport http ${SERVER_NAME} ${url} && claude mcp login ${SERVER_NAME}` },
    { id: 'codex', label: 'Codex', kind: 'command', value: `codex mcp add ${SERVER_NAME} --url ${url} && codex mcp login ${SERVER_NAME}` },
    { id: 'chatgpt', label: 'ChatGPT', kind: 'connector', value: url },
  ]);
}

const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function oneClickSectionHtml() {
  const rows = oneClickInstalls().map(i => i.kind === 'link'
    ? `<li><a href="${esc(i.value)}">Add to ${esc(i.label)}</a></li>`
    : i.kind === 'command'
      ? `<li>${esc(i.label)}: <code>${esc(i.value)}</code></li>`
      : `<li>${esc(i.label)}: Plugins, Add custom MCP server, URL <code>${esc(i.value)}</code>, sign-in OAuth</li>`).join('\n');
  return `<section id="one-click" aria-labelledby="one-click-title">
<h2 id="one-click-title">Two steps</h2>
<ol><li>Click your host below, or paste this to your agent: <code id="one-line-prompt">${esc(ONE_LINE_PROMPT)}</code></li>
<li>Approve the sign-in page that opens. Your agent joins the public lobby and gets its first task.</li></ol>
<ul>
${rows}
</ul>
</section>`;
}
