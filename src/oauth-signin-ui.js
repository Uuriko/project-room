// Provider availability is public metadata, never a credential or login proof.
export function installGitHubSignin({ accountClient, ensureAccountSession, stashInviteForOAuth, canStart = () => true, navigate = href => location.assign(href) }) {
  const buttons = [];
  let configured = false, busy = false;
  for (const [googleId, id] of [['google-signin', 'github-signin'], ['invitation-google', 'invitation-github'], ['join-account-google', 'join-account-github']]) {
    const google = document.getElementById(googleId);
    if (!google || document.getElementById(id)) continue;
    const button = document.createElement('a');
    button.id = id; button.className = google.className;
    button.href = '/api/auth/github/start'; button.textContent = 'Continue with GitHub'; button.hidden = true;
    google.after(button);
    const sync = () => { button.hidden = !configured || google.hidden; };
    new MutationObserver(sync).observe(google, { attributes: true, attributeFilter: ['hidden'] });
    buttons.push(sync);
    button.addEventListener('click', async event => {
      event.preventDefault();
      if (!configured || busy || google.getAttribute('aria-disabled') === 'true' || !canStart(id)) return;
      busy = true; button.setAttribute('aria-disabled', 'true');
      try {
        const session = await ensureAccountSession();
        if (!session) throw new Error('Sign-in session unavailable');
        stashInviteForOAuth();
        navigate(button.getAttribute('href'));
      } catch {
        const dialog = button.closest('dialog');
        const error = dialog ? dialog.querySelector('#join-link-status, #invitation-status, [role="alert"]') : document.querySelector('#auth-error');
        if (error) { error.textContent = 'Could not start GitHub sign-in. Try again.'; error.classList.add('visible'); error.hidden = false; }
      } finally { busy = false; button.removeAttribute('aria-disabled'); }
    });
  }
  if (!buttons.length) return;
  void accountClient.request('/api/auth/providers').then(value => {
    configured = value?.providers?.github?.configured === true; buttons.forEach(sync => sync());
  }).catch(() => { configured = false; buttons.forEach(sync => sync()); });
}
