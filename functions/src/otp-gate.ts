/**
 * Daily access code gate for the kiosk.
 *
 * WHAT THIS IS: an operational gate for a staffed, in-person kiosk — its job
 * is to stop a code meant for one day being casually reused the next, not to
 * defend against a determined attacker inspecting network requests. It does
 * not need to be a cryptographic security boundary (no hashing, no rate
 * limiting, no timing-safe comparison) — anyone with physical/network access
 * to the kiosk already has more direct ways to interfere with it.
 *
 * HOW IT WORKS: one fixed code (OTP_CODE, set in functions/.env — change and
 * redeploy functions to rotate it) unlocks the app for exactly one
 * redemption per calendar day, in the timezone below. Redemption state lives
 * in Firestore as a single doc per day (`otpState/{YYYY-MM-DD}`), written
 * inside a transaction so two near-simultaneous redemption attempts can't
 * both succeed.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// NALCO's kiosk deployments are in India — the daily reset should land at
// local midnight there, not at a UTC boundary that would flip mid-afternoon
// or mid-evening local time.
const GATE_TIMEZONE = "Asia/Kolkata";

function todayDateString(): string {
  // en-CA's date format is YYYY-MM-DD, which is both human-sortable and a
  // safe Firestore document id.
  return new Date().toLocaleDateString("en-CA", { timeZone: GATE_TIMEZONE });
}

function getOtpCode(): string {
  const code = process.env.OTP_CODE;
  if (!code) {
    throw new HttpsError(
      "failed-precondition",
      "OTP_CODE is not configured. Add it to functions/.env."
    );
  }
  return code;
}

export const checkOtpStatus = onCall(async () => {
  const db = getFirestore();
  const today = todayDateString();
  const doc = await db.collection("otpState").doc(today).get();
  // `today` is returned so the client stamps its localStorage unlock marker
  // with the server's notion of "today" (Asia/Kolkata) rather than computing
  // its own from the browser's local clock/timezone, which could disagree
  // near the midnight boundary.
  return { usedToday: doc.exists && doc.data()?.used === true, today };
});

export const redeemOtp = onCall(async (request) => {
  const submittedCode: string | undefined = request.data?.code;

  // Same generic failure for a wrong code, an already-used day, or a
  // malformed request — an attacker probing the endpoint shouldn't be able
  // to distinguish "wrong code" from "code was right but already spent
  // today" from the response alone. The client separately calls
  // checkOtpStatus up front, which is how a legitimate visitor learns
  // "closed for today" without spending a real attempt.
  const genericDenial = () =>
    new HttpsError("permission-denied", "This code is not valid right now.");

  if (typeof submittedCode !== "string" || submittedCode !== getOtpCode()) {
    throw genericDenial();
  }

  const db = getFirestore();
  const today = todayDateString();
  const docRef = db.collection("otpState").doc(today);

  try {
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(docRef);
      // Read-check-write inside one transaction: if two redemptions race,
      // Firestore guarantees only one transaction commits against this doc,
      // so only one of them ever sees `used !== true` here and proceeds.
      if (doc.exists && doc.data()?.used === true) {
        throw genericDenial();
      }
      tx.set(docRef, { used: true, usedAt: FieldValue.serverTimestamp() });
    });
  } catch (err) {
    if (err instanceof HttpsError) {
      throw err;
    }
    throw new HttpsError("internal", "Could not redeem the code. Try again.");
  }

  return { success: true, today };
});
