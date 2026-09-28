import { useCallback, useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import styles from "./pin-gate.module.css";

/**
 * Daily access-code gate shown before the kiosk's normal entry point.
 *
 * This is an OPERATIONAL gate, not a security boundary: it exists to stop a
 * code meant for one day being casually reused the next, not to defend
 * against someone inspecting network requests. The actual enforcement (one
 * redemption per calendar day, atomically) happens server-side in
 * functions/src/otp-gate.ts — this component just presents the PIN pad and
 * remembers, per-browser, that *this* device already unlocked today.
 */

const CODE_LENGTH = 4;
const GATE_TIMEZONE = "Asia/Kolkata";
const STORAGE_KEY = "nalco-otp-unlock";

type CheckStatusResult = { usedToday: boolean; today: string };
type RedeemResult = { success: boolean; today: string };

// Computed the same way as the server (functions/src/otp-gate.ts) so a
// device that unlocked earlier today can skip straight past this gate
// without waiting on a network round trip.
function clientTodayDateString(): string {
	return new Date().toLocaleDateString("en-CA", { timeZone: GATE_TIMEZONE });
}

function readStoredUnlockDate(): string | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as { date?: string };
		return typeof parsed.date === "string" ? parsed.date : null;
	} catch {
		return null;
	}
}

function storeUnlockDate(date: string) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ date }));
	} catch {
		// Best-effort convenience only. If storage is unavailable (private
		// browsing, quota exceeded), the visitor just sees the PIN screen
		// again next load — the server-side gate is unaffected either way.
	}
}

type GateState = "checking" | "closed" | "entry" | "unlocked";

export const PinGate = ({ children }: { children: React.ReactNode }) => {
	const [state, setState] = useState<GateState>(() =>
		readStoredUnlockDate() === clientTodayDateString() ? "unlocked" : "checking"
	);
	const [digits, setDigits] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	useEffect(() => {
		if (state !== "checking") return;
		let cancelled = false;

		(async () => {
			try {
				const checkOtpStatus = httpsCallable<Record<string, never>, CheckStatusResult>(
					functions,
					"checkOtpStatus"
				);
				const result = await checkOtpStatus({});
				if (cancelled) return;
				setState(result.data.usedToday ? "closed" : "entry");
			} catch {
				if (cancelled) return;
				// If we can't even ask, fail closed to the PIN screen rather than
				// silently letting someone in — worst case they see an error on
				// submit and can retry.
				setState("entry");
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [state]);

	const submitCode = useCallback(async (code: string) => {
		setIsSubmitting(true);
		setError(null);
		try {
			const redeemOtp = httpsCallable<{ code: string }, RedeemResult>(functions, "redeemOtp");
			const result = await redeemOtp({ code });
			storeUnlockDate(result.data.today);
			setState("unlocked");
		} catch {
			// Deliberately generic: whether the code was wrong, already used
			// today, or something else failed server-side, the visitor sees the
			// same message and the input resets — see otp-gate.ts for why.
			setError("Incorrect code. Please try again.");
			setDigits("");
		} finally {
			setIsSubmitting(false);
		}
	}, []);

	const pressDigit = useCallback(
		(digit: string) => {
			if (isSubmitting) return;
			setDigits((prev) => {
				if (prev.length >= CODE_LENGTH) return prev;
				const next = prev + digit;
				if (next.length === CODE_LENGTH) {
					submitCode(next);
				}
				return next;
			});
		},
		[isSubmitting, submitCode]
	);

	const pressBackspace = useCallback(() => {
		if (isSubmitting) return;
		setError(null);
		setDigits((prev) => prev.slice(0, -1));
	}, [isSubmitting]);

	if (state === "unlocked") {
		return <>{children}</>;
	}

	if (state === "checking") {
		return (
			<div className={styles.screen}>
				<p className={styles.status}>Checking access…</p>
			</div>
		);
	}

	if (state === "closed") {
		return (
			<div className={styles.screen}>
				<h1 className={styles.title}>Closed for Today</h1>
				<p className={styles.status}>
					Today's access code has already been used. Please check back tomorrow.
				</p>
			</div>
		);
	}

	return (
		<div className={styles.screen}>
			<h1 className={styles.title}>Enter Access Code</h1>
			<div className={styles.dots} aria-hidden="true">
				{Array.from({ length: CODE_LENGTH }).map((_, i) => (
					<span key={i} className={`${styles.dot} ${i < digits.length ? styles.dotFilled : ""}`} />
				))}
			</div>
			<p className={styles.srOnly} role="status" aria-live="polite">
				{digits.length} of {CODE_LENGTH} digits entered
			</p>
			{error && (
				<p className={styles.error} role="alert">
					{error}
				</p>
			)}
			<div className={styles.keypad}>
				{["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
					<button
						key={d}
						type="button"
						className={styles.key}
						onClick={() => pressDigit(d)}
						disabled={isSubmitting}
					>
						{d}
					</button>
				))}
				<span />
				<button
					type="button"
					className={styles.key}
					onClick={() => pressDigit("0")}
					disabled={isSubmitting}
				>
					0
				</button>
				<button
					type="button"
					className={`${styles.key} ${styles.keyBackspace}`}
					onClick={pressBackspace}
					disabled={isSubmitting || digits.length === 0}
					aria-label="Backspace"
				>
					⌫
				</button>
			</div>
		</div>
	);
};
