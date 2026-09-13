// Keep the authorization code in this page's memory only; no storage or logging.
const callbackUrl = location.href;
history.replaceState(null, '', location.pathname);
const status = document.querySelector('#gmail-status');
async function finish() {
  try {
    const response = await fetch('/api/account-session', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('session');
    const session = await response.json();
    if (!session.authenticated || !session.csrf || !session.sessionBinding) throw new Error('session');
    const completed = await fetch('/api/inbox/connections/gmail/complete', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf, 'X-Session-Binding': session.sessionBinding },
      body: JSON.stringify({ callbackUrl })
    });
    if (!completed.ok) throw new Error('connection');
    status.textContent = 'Gmail connected. You can return to Project Room.';
  } catch {
    status.textContent = 'Connection didn’t finish. Return to Project Room and try again.';
  }
}
finish();
