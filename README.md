# NALCO-PAL

## Working from a new device

Everything except secrets lives in this repo. To pick this project up
somewhere new:

```bash
git clone https://github.com/SKIFIN-IT-SERVICES/NALCO-PAL.git
cd NALCO-PAL
npm --prefix frontend install
npm --prefix functions install
firebase login          # needs access to the skifin-ccpro Firebase project
```

Then recreate `functions/.env` (gitignored — never committed, so it does not
come along with `git clone`). It needs exactly these four variables:

```
TAVUS_API_KEY=...              # from the Tavus dashboard
TAVUS_PAL_ID=...                # p29cbd5433be as of this writing
OTP_CODE=...                    # the current daily kiosk access code
TAVUS_TOOL_HMAC_SECRET=...      # shared secret for HMAC-signed tool calls
```

The values themselves are not written down anywhere in the repo on purpose —
copy them from the Tavus dashboard (API key, PAL ID) and from wherever you
already have them recorded (`OTP_CODE`, `TAVUS_TOOL_HMAC_SECRET`), or
transfer the existing `functions/.env` file directly between your own
devices out of band (AirDrop, a password manager, etc.) rather than through
Git.

Live deployment: <https://nalco-ai-assistant.web.app> (Firebase Hosting,
project `skifin-ccpro`). `firebase deploy --only hosting:nalco-ai-assistant`
and `firebase deploy --only functions:nalco-ai-assistant` push from any
machine once the above is set up — nothing about deployment is tied to one
computer.

**Note for whoever (human or Claude) picks this up next:** this file and the
sections below describe the code and how to run it, not the day-to-day
project history — for full context on what's been built, why, and what's
still open, see the engagement plan artifact referenced in the project's
Claude conversation history, or ask the person who ran the last session.

### Currently open / blocked

- The prize quiz's system-prompt instructions (the multi-question flow) are
  written and ready, but the last attempt to push them to the Tavus PAL hit
  a `409 maker_changes` conflict — someone has unpublished edits sitting in
  the Tavus dashboard's PAL Maker. Publish or discard those there, then the
  prompt patch can be retried. Until then, the PAL's own understanding of
  the quiz still reflects the older single-question wording, even though
  the backend already enforces the new 5-questions/1-attempt-each behaviour
  correctly regardless of what the prompt says.

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
