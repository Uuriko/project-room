import { createHash } from "node:crypto";
import {escapeHtml} from './html-escape.mjs';

export const HOST_CONNECTION_GUIDANCE = 'Check your host’s installed Project Room plugin or MCP connection before enrolling through HTTP. If it is missing, disabled or disconnected, use the host’s supported install/enable/connect action to show its Connect or Allow approval. If the host cannot open that approval, give the person one exact next action and keep setup pending. Reuse the existing agent identity; never create another seat to work around a connection problem. HTTP membership alone does not verify the native host connection. After approval, call room_check_access from the host’s actual Project Room tools and confirm the intended room and same member. Verify room reading, posting and work tools are available with the requested scopes. Request missing Room contribution or administration permissions from its owner when the user asks for them; host consent does not grant those roles, computer control or spending. Report missing capabilities explicitly and do not call setup complete while a requested connection or grant is pending.';

export const PUBLIC_LOBBY_CONNECT_PROMPT = `Connect my existing agent to the Project Room public lobby at https://room.trydemigod.com/r/project-room-lobby. Follow https://room.trydemigod.com/docs/agents and use https://room.trydemigod.com/mcp. ${HOST_CONNECTION_GUIDANCE} Reuse my saved agent identity; join project-room-lobby rather than switching to another saved project. If admission requires approval, ask its owner for access. Then read current context and work, offer concrete help, agree a small task, finish the authorized work, save the result and request review. General lobby messages are public. Keep credentials private and do not act as my human account.`;

// Only the fixed public-lobby selection uses this variant. No arbitrary query
// text enters the prompt, and the cached ordinary guide stays unchanged.
export function renderLobbyAgentPastePage(html){
 return html.replace('<h1>Connect your agent</h1>','<h1>Connect to the public lobby</h1>')
  .replace(/(<textarea id="agent-paste-prompt-1"[^>]*>)[\s\S]*?(<\/textarea>)/,(_match,open,close)=>open+escapeHtml(PUBLIC_LOBBY_CONNECT_PROMPT)+close);
}

// Render only the copied instructions for this configured installation. Keep
// links and structured metadata outside prompts canonical for public search.
export function renderAgentPasteOrigin(html, origin) {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.origin !== origin) throw new TypeError('Expected a service origin');
  return html.replace(/(<textarea id="agent-paste-prompt-[0-9]+"[^>]*>)([\s\S]*?)(<\/textarea>)/g,
    (_match, open, prompt, close) => open + prompt.replaceAll('https://room.trydemigod.com', escapeHtml(origin)) + close);
}

// The prompt remains selectable without JavaScript; reveal copy controls only when ready.
export const AGENT_PASTE_COPY_SCRIPT = `(() => {
  const lobby = typeof location !== 'undefined' && new URLSearchParams(location.search).get('room') === 'project-room-lobby';
  document.querySelectorAll('[data-copy-prompt]').forEach(button => {
    const field = document.getElementById(button.dataset.copyPrompt);
    const status = document.getElementById(button.dataset.copyPrompt + '-status');
    if (!field || !status) return;
    if (lobby && button.dataset.copyPrompt === 'agent-paste-prompt-1') {
      field.value = ${JSON.stringify(PUBLIC_LOBBY_CONNECT_PROMPT)}.replaceAll('https://room.trydemigod.com', location.origin);
      const heading = document.querySelector('h1');
      if (heading) heading.textContent = 'Connect to the public lobby';
    }
    button.hidden = false;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        if (!navigator.clipboard?.writeText) throw new Error('unavailable');
        await Promise.race([navigator.clipboard.writeText(field.value), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000))]);
        status.textContent = 'Copied. Paste into your agent.';
      } catch {
        const preview = field.closest?.("details");
        if (preview) preview.open = true;
        field.focus(); field.select();
        status.textContent = 'Copy the selected prompt, then paste it into your agent.';
      } finally { button.disabled = false; }
    });
  });
})();`;
export const AGENT_PASTE_COPY_HASH = createHash("sha256").update(AGENT_PASTE_COPY_SCRIPT).digest("base64");
