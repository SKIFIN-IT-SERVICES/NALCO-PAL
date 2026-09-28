# NALCO-PAL

## Daily access code gate

The kiosk sits behind a PIN screen (`frontend/src/components/pin-gate`) that
requires a fixed 4-digit code before the app's normal entry point. The code
unlocks the app for exactly **one redemption per calendar day** (reset at
midnight `Asia/Kolkata`) — the first person to enter it correctly unlocks the
kiosk for the rest of that day; everyone else sees "Closed for Today."

**This is an operational gate, not a security boundary.** It exists so a code
meant for one day of a staffed, in-person event can't be casually reused the
next day — it is not designed to withstand a determined attacker inspecting
network requests (there's no rate limiting, hashing, or timing-safe
comparison). Anyone with physical or network access to the kiosk already has
more direct ways to interfere with it than guessing a 4-digit code.

How it works:

- **The code** lives in `functions/.env` as `OTP_CODE` — a plain environment
  variable, never sent to the client. To rotate it, edit that value and
  redeploy functions (`npm --prefix functions run deploy`).
- **Enforcement is server-side**, in `functions/src/otp-gate.ts`:
  - `checkOtpStatus` — read-only; lets the PIN screen show "Closed for Today"
    up front without spending a real redemption attempt.
  - `redeemOtp` — compares the submitted code against `OTP_CODE`, then marks
    a Firestore doc at `otpState/{YYYY-MM-DD}` as used **inside a
    transaction** (read-check-write atomically), so two near-simultaneous
    redemptions can't both succeed.
  - Both a wrong code and an already-used day return the same generic
    "not valid right now" error from `redeemOtp` — an attacker probing the
    endpoint can't tell those apart. `checkOtpStatus`'s "already used today"
    result is intentionally more specific, since that's shown *before* any
    redemption attempt and is operationally useful to a legitimate visitor.
  - Firestore rules (`firestore.rules`) deny all direct client access to
    `otpState/**` — only the Admin SDK inside these two functions touches it.
- **Per-device persistence is client-side only**: on a successful redemption,
  the browser stamps today's date (as returned by the server) into
  `localStorage`, and the PIN screen checks that before rendering anything —
  so a device that already unlocked today skips straight past the gate on
  refresh or relaunch. This is purely a convenience for the device that
  actually redeemed the code; it has no bearing on any other device, which
  still hits the server-side check.
