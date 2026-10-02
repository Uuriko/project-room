# TOTP Two-Factor for Owner Accounts (F018)

Pure RFC 6238 time-based one-time-password support for owner accounts, implemented
in `src/totp-2fa.mjs`. Pure logic only: secret handling, code generation and
verification. No store, schema, route, or network changes — persistence and the
login gate are follow-up slices.

**No real secrets appear in this document or in the code/tests.** Test vectors
use the published RFC 6238 appendix B shared secret.

## Enrollment flow

1. **Generate a secret.** Call `generateSecret()` — it returns a 160-bit random
   secret (node `crypto.randomBytes`) as a base32 string, ready to store against
   the owner account.
2. **Show the QR provisioning URI.** Call `provisioningUri({ issuer, account, secret })`
   to get an `otpauth://` URI:

   ```
   otpauth://totp/project-room:owner%40example.com?secret=GEZDGNBVGY3TQOJQ…&issuer=project-room&algorithm=SHA1&digits=6&period=30
   ```

   Render this as a QR code on the enrollment screen. The account is the owner's
   stable identity (e.g. email or username), percent-encoded. Do not log, cache,
   or persist this URI beyond the enrollment screen — the secret is stored once,
   server-side, against the account.
3. **Confirm with a code.** Before enabling 2FA, require the owner to type the
   current code from their authenticator app. Verify with
   `verifyCode(code, secret)`. Only flip the account to "2FA enabled" after a
   successful confirmation — this catches mis-scanned QR codes immediately.

## Verification flow

At login, after the password (or other first factor) succeeds:

```js
import { verifyCode } from "../src/totp-2fa.mjs";

const ok = verifyCode(code, storedSecret); // window defaults to ±1 step
if (!ok) {
  // Reject with a generic "invalid code" message; do not say whether the
  // secret or the code was wrong.
}
```

`generateCode(secret, { digits: 6 | 8, time, stepSeconds })` generates the code
for any instant (default: now). 6-digit codes are the default; 8-digit codes are
supported per RFC 6238 and truncated per RFC 4226 §5.4.

## Clock-skew policy

- Time step: **30 seconds**, T0 = Unix epoch (RFC 6238 default).
- `verifyCode` accepts **±1 step** (`window = 1`) by default — i.e. the previous,
  current, and next 30-second codes are all valid. This absorbs normal phone
  clock drift without any server clock discipline.
- `window: 0` disables tolerance (strict current-step only); larger windows
  widen acceptance symmetrically. Do not raise the window above 2 in production:
  each extra step is 30 more seconds of replay exposure.
- Comparison is constant-time (`crypto.timingSafeEqual`) and malformed input
  (bad base32, non-digit code, unknown digits) fails closed — `verifyCode`
  returns `false`, never throws.

## Recovery-code guidance

TOTP alone locks owners out when they lose their device. Ship recovery codes
alongside this module (separate slice), following these rules:

- Generate 8–10 single-use codes from a CSPRNG; store only salted hashes.
- Show them once at enrollment, next to the QR code; require the owner to
  acknowledge saving them before enabling 2FA.
- Each code burns on use and logs an audit event.
- Never email recovery codes, and never accept them as a substitute for the
  primary factor on their own — they are a one-time break-glass path that
  should trigger a re-enrollment of a new TOTP secret.

## API reference

| Export | Description |
|---|---|
| `base32Encode(bytes)` / `base32Decode(str)` | Hand-rolled RFC 4648 base32; decode is case-insensitive, padding optional, throws on invalid alphabet |
| `generateSecret(secretBytes = 20)` | Random enrollment secret, base32 string (20 bytes = 160 bits, RFC 4226 minimum) |
| `generateCode(secret, { digits = 6, time = Date.now(), stepSeconds = 30 })` | TOTP code for a base32 secret |
| `verifyCode(code, secret, { digits = 6, window = 1, time = Date.now(), stepSeconds = 30 })` | Constant-time verification with ±`window` step tolerance; fails closed on bad input |
| `provisioningUri({ issuer, account, secret })` | `otpauth://totp/…` QR URI per the Key URI format |
| `TOTP_STEP_SECONDS`, `TOTP_DEFAULT_WINDOW`, `TOTP_DIGITS_6`, `TOTP_DIGITS_8` | Protocol constants |
