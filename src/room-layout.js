// Relocate existing controls, preserving their listeners, authority and state.
// Account destinations keep their original home outside a room; no duplicate
// controls or parallel navigation state are introduced by this layout.
export function installRoomLayout() {
  const get = selector => document.querySelector(selector);
  const main = get('#main');
  const entries = [
    ['#workspace-nav', '#sidebar-workspace'],
    ['#session-menu', '.room-topbar .topbar-actions'],
    ['#invite-people-button', '#sidebar-invite']
  ].map(([selector, destination]) => {
    const node = get(selector), anchor = document.createComment(`home:${node.id}`);
    node.before(anchor);
    return { node, anchor, destination: get(destination) };
  });
  get('#invite-people-button').textContent = 'Invite';
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

// Chat-first room: a new room's sidebar shows only what it uses. Landing is
// the pull-request land queue, so it waits for write-mode work. Referrals wait
// for a second human or a referral join. The Invite section still mints links.
export function sidebarSectionsInUse(state) {
  const members = Object.values(state?.members ?? {});
  const humans = members.filter(m => m.kind === 'human' && m.active !== false);
  return {
    landing: Object.values(state?.workItems ?? {}).some(item => item.mode === 'write' || item.claim),
    referrals: humans.length > 1 || members.some(m => m.referredBy)
  };
}

// An open panel stays, so a live render never pulls a section out from under
// someone reading it.
export function syncSidebarSections(state) {
  const inUse = sidebarSectionsInUse(state);
  for (const [id, show] of [['#land-queue-panel', inUse.landing], ['#referral-panel', inUse.referrals]]) {
    const panel = document.querySelector(id);
    if (panel) panel.hidden = Boolean(panel.closest("#room-sidebar")) && !show && !panel.open;
  }
}
