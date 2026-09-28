import { memo } from 'react';
import { useVisitorSession } from '../../hooks/use-visitor-session';
import styles from './visitor-session-debug.module.css';

/**
 * On-screen readout for testing the voice-change / visitor-session feature
 * (see use-voice-fingerprint.tsx and use-visitor-session.tsx) — there is no
 * other way to observe pitch/deviation/question-count live while two people
 * take turns talking during one call.
 *
 * TEMPORARY: this is a testing aid for validating the feature, not a kiosk
 * feature itself. Remove this component (and its mount point in
 * Conversation) once the voice-change heuristic has been validated against
 * real visitors, before this goes live on the production kiosk — a debug
 * overlay reading out pitch numbers has no business being visible to the
 * public at a NALCO stall.
 */
export const VisitorSessionDebug = memo(() => {
	const session = useVisitorSession();
	const { voice } = session;

	return (
		<div className={styles.panel} aria-hidden="true">
			<div className={styles.row}>
				<span className={styles.label}>Visitor #</span>
				<span className={styles.value}>{session.visitorCount}</span>
			</div>
			<div className={styles.row}>
				<span className={styles.label}>Questions this visitor</span>
				<span className={styles.value}>{session.questionsThisVisitor} / 3</span>
			</div>
			<div className={styles.row}>
				<span className={styles.label}>Activity nudge fired</span>
				<span className={styles.value}>{session.nudgeFiredThisVisitor ? 'yes' : 'no'}</span>
			</div>
			<div className={styles.divider} />
			<div className={styles.row}>
				<span className={styles.label}>Profile pitch</span>
				<span className={styles.value}>
					{voice.profile ? `${voice.profile.pitchHz.toFixed(0)} Hz` : '—'}
				</span>
			</div>
			<div className={styles.row}>
				<span className={styles.label}>Profile centroid</span>
				<span className={styles.value}>
					{voice.profile ? `${voice.profile.centroidHz.toFixed(0)} Hz` : '—'}
				</span>
			</div>
			<div className={styles.row}>
				<span className={styles.label}>Last utterance pitch</span>
				<span className={styles.value}>
					{voice.lastUtterance ? `${voice.lastUtterance.pitchHz.toFixed(0)} Hz` : '—'}
				</span>
			</div>
			<div className={styles.row}>
				<span className={styles.label}>Last deviation</span>
				<span className={styles.value}>
					{voice.lastDeviation !== null ? `${(voice.lastDeviation * 100).toFixed(0)}%` : '—'}
				</span>
			</div>
			<div className={styles.row}>
				<span className={styles.label}>Consecutive deviations</span>
				<span className={styles.value}>{voice.consecutiveDeviations} / 2</span>
			</div>
		</div>
	);
});

VisitorSessionDebug.displayName = 'VisitorSessionDebug';
