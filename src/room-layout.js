// Relocate existing controls, preserving their listeners, authority and state.
// Account destinations keep their original home outside a room; no duplicate
// controls or parallel navigation state are introduced by this layout.
export function installRoomLayout() {
  const get = selector => document.querySelector(selector);
  const main = get('#main');
  const entries = [
    ['#workspace-nav', '#sidebar-workspace'],
    ['#session-menu', '.room-topbar .topbar-actions'],
    ['#invite-people-button', '#sidebar-invite'],
    ['#room-actions-open', '#sidebar-tools']
  ].map(([selector, destination]) => {
    const node = get(selector), anchor = document.createComment(`home:${node.id}`);
    node.before(anchor);
    return { node, anchor, destination: get(destination) };
  });
  get('#invite-people-button').textContent = 'Invite people';
  const invites = get('#invite-navigation');
  const invitationState = () => { invites.hidden = ['#invite-people-button', '#connect-agent-button', '#invite-agents-button'].every(selector => get(selector).hidden); };
  for (const selector of ['#invite-people-button', '#connect-agent-button', '#invite-agents-button']) new MutationObserver(invitationState).observe(get(selector), { attributes: true, attributeFilter: ['hidden'] });
  invitationState();
  for (const selector of ['#invite-people-button', '#connect-agent-button', '#invite-agents-button']) {
    get(selector).addEventListener('click', () => {
      if (main.hidden) return;
      invites.open = true;
      if (getComputedStyle(get('#room-sidebar')).display === 'none') get('#sidebar-toggle').click();
    }, { capture: true });
  }
  const panel = get('#session-menu-panel');
  panel.prepend(get('#identity-label'));
  const refresh = get('#refresh-button');
  refresh.classList.remove('icon-button');
  refresh.textContent = 'Refresh connection';
  panel.append(refresh);
  const connection = get('#connection-status');
  const details = get('#connection-details');
  const syncRecovery = () => {
    const destination = connection.dataset.state === 'connected' ? panel
      : connection.dataset.state === 'other' ? get('.connection-bar') : get('.app-shell > .topbar .topbar-actions');
    const detailHome = connection.dataset.state === 'connected' ? panel : get('.connection-bar');
    if (details.parentNode !== detailHome) detailHome.append(details);
    if (refresh.parentNode === destination) return;
    const focused = document.activeElement === refresh;
    destination.append(refresh);
    if (focused) (destination === panel ? get('#session-menu-button') : refresh).focus({ preventScroll: true });
  };
  new MutationObserver(syncRecovery).observe(connection, { attributes: true, attributeFilter: ['data-state'] });
  syncRecovery();
  const compact = matchMedia("(max-width: 940px)");
  let layout;
  const sync = () => {
    const room = !main.hidden;
    const nextLayout = `${room}:${compact.matches}`;
    if (layout === nextLayout) return;
    layout = nextLayout;
    for (const { node, anchor, destination } of entries) {
      if (room && (node.id !== "workspace-nav" || !compact.matches)) { if (node.parentNode !== destination) destination.append(node); }
      else if (node.previousSibling !== anchor) anchor.after(node);
    }
    // A menu left open in one destination must not carry over to another.
    get('#session-menu').classList.remove('open');
    get('#session-menu-button').setAttribute('aria-expanded', 'false');
    get('#skip-link').setAttribute('href', room ? '#conversation-title' : '#connection-status');
  };
  new MutationObserver(sync).observe(main, { attributes: true, attributeFilter: ['hidden'] });
  const workspace = get("#workspace-nav");
  new ResizeObserver(() => document.documentElement.style.setProperty("--workspace-nav-height", `${workspace.getBoundingClientRect().height}px`)).observe(workspace);
  compact.addEventListener("change", sync);
  sync();
}
