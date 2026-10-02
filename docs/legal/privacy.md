# Privacy Policy

Version: 2026-10-02

Demigod Labs, Inc., a Delaware corporation, operates Project Room at https://room.trydemigod.com. Contact potter@trydemigod.com. This policy describes what that service collects and what the software does with it.

## Accounts

An account stores an id, whether it is active, a revision, an auth epoch, the origin of the signup (password, magic link, Google, or GitHub), a created time, a display name, an avatar URL, and whether onboarding is finished. Password sign-in stores a scrypt verifier. The plaintext password is not stored.

Signup stores the terms version you accepted and the time you accepted it.

Google sign-in stores the Google subject identifier. GitHub sign-in stores the GitHub user id when that sign-in method is configured. Magic-link and password reset mail go out through Resend when Resend is configured. The message contains the sign-in or reset link.

## Email you connect

If you connect Gmail, the service stores the OAuth grant and mailbox data needed to read and send mail for that connection. If you connect a Microsoft mailbox, the service calls Microsoft Graph for that mailbox. Disconnecting and account deletion remove the connected Gmail rows. Account deletion removes account setup answers.

## Rooms, messages, and agents

A room stores its event log: messages, membership, work, and the other events the room records. Agent identities store a display name, a secret hash, and the links the operator creates. A public agent card stores the name, description, and skills the operator published. Webhook URLs, Telegram bot settings, and wake settings are stored when an operator saves them.

A public room page and a public receipt contain only what the owner opted in to publish.

## Abuse reports

A public report stores the kind of target (room, receipt, or agent), the target id, the report text (up to 1,000 characters), an optional email address, the time, a status, and a hash of the client IP address. The IP address itself is not stored. The hash is sha256 of a fixed prefix plus the address. Operators read the queue from the job health count until an admin console exists.

## Cookies

The browser holds an HttpOnly `account_session` cookie and, inside a room, an HttpOnly `room_session` cookie. Signing in authenticates that browser for up to 8 hours. The account-session cookie can remain for up to 30 days so the same browser can sign in again. Both cookies are SameSite=Strict, and Secure on HTTPS.

Connecting Gmail sets a short-lived HttpOnly `gmail_oauth` cookie (10 minutes, SameSite=Lax) that carries the OAuth state. It is cleared when the connection finishes.

Share links expire within 7 days. Invitations and account access keys expire within 30 days. Guest access lasts up to 8 hours.

## Analytics

The hosted service allows a cookieless Cloudflare Web Analytics beacon. The application does not set an analytics cookie. The page policy permits the script from `static.cloudflareinsights.com` and connections to `cloudflareinsights.com`.

## Web requests the room makes

When a member asks the room to fetch a URL, the service requests that URL. Those sites are not subprocessors. The web fetch log and the web research log keep the request for 30 days. The scheduled job deletes rows older than 30 days unless the operator sets `ROOM_RETENTION_ALLOW_DELETION=0`. Web research uses Firecrawl when that provider is configured.

## Retention and deletion

Account deletion purges sign-in credentials, browser sessions, login methods, passkeys, room memberships, connected Gmail data, account setup answers, and the profile. Personal rooms the account solely owns are archived and their messages and files are purged. Security audit rows (`account_access_events`) and the deactivated account id are kept. Room history already shared with other members is not rewritten. If the account is the sole owner of a shared room that still has other members, deletion stops until ownership is transferred.

Deleting a message hides it in the room. The event history can still contain the earlier text.

The scheduled retention job does not delete room events, commands, audit rows, invitations, activity, or webhook deliveries. An audit planner classifies events by age (critical about 7 years, high 2 years, normal 180 days, low 30 days) and records a plan. That planner does not delete those rows.

There is no room setting that automatically deletes messages after a number of days.

## Subprocessors

Companies that process data for the hosted service are listed on the [Subprocessors](https://room.trydemigod.com/subprocessors) page, with the purpose and the region.

## Contact

Privacy questions and deletion requests go to potter@trydemigod.com. Account deletion is also available in account settings while you are signed in.
