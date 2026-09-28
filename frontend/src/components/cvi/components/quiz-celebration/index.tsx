import { memo, useEffect, useRef, useState } from 'react';
import { useToolCallHandlers } from '../../hooks/use-tool-call';
import styles from './quiz-celebration.module.css';

// The card holds a prize code the visitor needs to walk over and show a
// NALCO staff member — a fixed few seconds (fine for a pure animation) is
// not enough time for that. It stays up until they dismiss it themselves,
// with a generous safety-net timeout so the kiosk can't get stuck showing
// someone else's prize code if they simply walk away without tapping.
const SAFETY_HIDE_MS = 45000;

type CelebrationState = {
	visitorName: string;
	tierLabel: string;
	prizeCode: string;
} | null;

/**
 * Full-screen win celebration for the prize quiz (engagement plan Section 5,
 * Feature 3). Tavus's own cards can't be custom-animated, so this is a
 * plain overlay in the kiosk app itself, triggered when the PAL calls the
 * `celebrate_win` tool right after `submit_quiz_answer` returns
 * `correct: true` — see quiz.ts's response `message` field, which instructs
 * the PAL to do exactly that, passing the visitor's name, the prize tier
 * label, and the prize code through as the tool's arguments.
 */
export const QuizCelebration = memo(() => {
	const [state, setState] = useState<CelebrationState>(null);
	const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const dismiss = () => {
		if (hideTimerRef.current !== null) {
			clearTimeout(hideTimerRef.current);
			hideTimerRef.current = null;
		}
		setState(null);
	};

	useToolCallHandlers({
		celebrate_win: (args) => {
			const visitorName = typeof args.visitor_name === 'string' ? args.visitor_name : 'Visitor';
			const tierLabel = typeof args.tier_label === 'string' ? args.tier_label : 'a prize';
			const prizeCode = typeof args.prize_code === 'string' ? args.prize_code : '';

			if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
			setState({ visitorName, tierLabel, prizeCode });
			hideTimerRef.current = setTimeout(() => setState(null), SAFETY_HIDE_MS);
		},
	});

	useEffect(() => {
		return () => {
			if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
		};
	}, []);

	if (!state) return null;

	return (
		<button type="button" className={styles.overlay} onClick={dismiss} aria-live="assertive">
			<div className={styles.card}>
				<span className={styles.emoji} aria-hidden="true">
					🎉🏆🎉
				</span>
				<p className={styles.name}>{state.visitorName}!</p>
				<p className={styles.tier}>You won {state.tierLabel}!</p>
				{state.prizeCode && (
					<>
						<p className={styles.instruction}>Show this code to a NALCO team member</p>
						<p className={styles.code}>{state.prizeCode}</p>
					</>
				)}
				<p className={styles.dismissHint}>Tap anywhere to continue</p>
			</div>
		</button>
	);
});

QuizCelebration.displayName = 'QuizCelebration';
