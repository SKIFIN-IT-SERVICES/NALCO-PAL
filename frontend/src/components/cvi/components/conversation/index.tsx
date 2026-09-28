import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { DailyAudioTrack, DailyVideo, useDevices, useMeetingState, useVideoTrack } from '@daily-co/daily-react';
import { MicSelectBtn } from '../device-select';
import { ClosedCaptions, ClosedCaptionsButton, ClosedCaptionsProvider } from '../closed-captions';
import { ChatButton, ChatPanel, ChatProvider } from '../chat';
import { ConnectingState, LeavingState } from '../conversation-status';
import { VisitorSessionDebug } from '../visitor-session-debug';
import { QuizCelebration } from '../quiz-celebration';
import { useReplicaIDs } from '../../hooks/use-replica-ids';
import { useCVICall } from '../../hooks/use-cvi-call';

import styles from './conversation.module.css';

interface ConversationProps {
	onLeave: () => void;
	conversationUrl: string;
}

const CONNECT_TIMEOUT_MS = 25000;

const MainVideo = React.memo(({ onStuck }: { onStuck: () => void }) => {
	const replicaIds = useReplicaIDs();
	const videoState = useVideoTrack(replicaIds[0]);
	const meetingState = useMeetingState();
	const replicaId = replicaIds[0];
	const [hasReplicaConnected, setHasReplicaConnected] = useState(false);

	useEffect(() => {
		if (replicaId && videoState.state === 'playable') {
			setHasReplicaConnected(true);
		}
	}, [replicaId, videoState.state]);

	// A kiosk left unattended for hours needs to recover on its own from a
	// call that never actually connects (the exact "stuck on Connecting…"
	// failure mode this app has hit before) — nobody is there to reload it.
	useEffect(() => {
		if (hasReplicaConnected) return;
		const timer = setTimeout(onStuck, CONNECT_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [hasReplicaConnected, onStuck]);

	if (meetingState === 'left-meeting' || meetingState === 'error') {
		return <LeavingState />;
	}

	if (!hasReplicaConnected) {
		return <ConnectingState />;
	}

	if (!replicaId) {
		return <ConnectingState />;
	}

	return (
		<div className={styles.mainVideoContainer}>
			<DailyVideo
				automirror
				sessionId={replicaId}
				type="video"
				className={`${styles.mainVideo} ${videoState.isOff ? styles.mainVideoHidden : ''}`}
			/>
			<DailyAudioTrack sessionId={replicaId} />
		</div>
	);
});

const MoreMenu = memo(() => {
	const [isOpen, setIsOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!isOpen) {
			return;
		}
		const handlePointerDown = (e: PointerEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setIsOpen(false);
			}
		};
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				setIsOpen(false);
			}
		};
		document.addEventListener('pointerdown', handlePointerDown);
		document.addEventListener('keydown', handleKey);
		return () => {
			document.removeEventListener('pointerdown', handlePointerDown);
			document.removeEventListener('keydown', handleKey);
		};
	}, [isOpen]);

	return (
		<div ref={ref} className={styles.moreMenu}>
			<button
				type="button"
				onClick={() => setIsOpen((v) => !v)}
				aria-pressed={isOpen}
				aria-label={isOpen ? 'Close more controls' : 'More controls'}
				aria-haspopup="true"
				aria-expanded={isOpen}
				className={`${styles.moreButton} ${isOpen ? styles.moreButtonActive : ''}`}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="24"
					height="24"
					viewBox="0 0 24 24"
					fill="none"
					aria-hidden="true"
					focusable="false"
				>
					<circle cx="5" cy="12" r="1.75" fill="currentColor" />
					<circle cx="12" cy="12" r="1.75" fill="currentColor" />
					<circle cx="19" cy="12" r="1.75" fill="currentColor" />
				</svg>
			</button>
			{isOpen && (
				<div className={styles.morePopover} role="menu">
					<ClosedCaptionsButton />
				</div>
			)}
		</div>
	);
});

MoreMenu.displayName = 'MoreMenu';

export const Conversation = React.memo(({ onLeave, conversationUrl }: ConversationProps) => {
	const { joinCall, leaveCall } = useCVICall();
	const meetingState = useMeetingState();
	const { hasMicError } = useDevices();

	useEffect(() => {
		// Whenever Daily's own state machine reaches a terminal state — however
		// it got there (button click, network drop, permission revoked) — make
		// sure the app actually unmounts and ends the conversation. Without this,
		// reaching "left-meeting" any way other than our own leave button left
		// the UI stuck on the "Leaving…" screen with its controls hidden and the
		// Tavus conversation still marked active.
		if (meetingState === 'error' || meetingState === 'left-meeting') {
			onLeave();
		}
	}, [meetingState, onLeave]);

	useEffect(() => {
		joinCall({ url: conversationUrl });
		// Release the singleton call on unmount: otherwise the next mount's join()
		// is rejected ("already joined meeting") and the stale room's death ends
		// the new conversation via onLeave above. Also StrictMode-safe.
		return () => {
			leaveCall();
		};
	}, []);

	const handleLeave = useCallback(() => {
		// Never gate the UI on daily.leave() resolving — it can hang (flaky
		// network, already-degraded meeting state), and any wait, even a
		// timeout-guarded one, is a window where the button can feel broken.
		// Return to the start screen immediately; tear down the call object
		// as best-effort cleanup in the background.
		onLeave();
		leaveCall().catch((err) => {
			console.error('Error leaving call:', err);
		});
	}, [leaveCall, onLeave]);

	return (
		<ClosedCaptionsProvider defaultEnabled>
			<ChatProvider>
				<div className={styles.containerWrapper}>
					<div className={styles.container}>
						<div className={styles.videoContainer}>
							{hasMicError && (
								<div className={styles.errorContainer}>
									<p>
										Microphone access denied. Please check your settings and try again.
									</p>
								</div>
							)}

							<div className={styles.mainVideoContainer}>
								<MainVideo onStuck={handleLeave} />
							</div>

							<ClosedCaptions />

							{/* TEMPORARY testing aid — see visitor-session-debug/index.tsx
							for why this must come off before the kiosk goes live. */}
							<VisitorSessionDebug />

							<QuizCelebration />
						</div>

						<ChatPanel />

						<div
							className={`${styles.footer} ${meetingState === 'left-meeting' ? styles.footerLeaving : ''}`}
							aria-hidden={meetingState === 'left-meeting'}
						>
							<div className={styles.footerControls}>
								<MicSelectBtn />
								<MoreMenu />
								<ChatButton />
								<button type="button" className={styles.leaveButton} onClick={handleLeave}>
									<span className={styles.leaveButtonIcon}>
										<svg
											xmlns="http://www.w3.org/2000/svg"
											width="24"
											height="24"
											viewBox="0 0 24 24"
											fill="none"
											role="img"
											aria-label="Leave Call"
										>
											<path
												d="M18 6L6 18M6 6L18 18"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											/>
										</svg>
									</span>
								</button>
							</div>
						</div>
					</div>
				</div>
			</ChatProvider>
		</ClosedCaptionsProvider>
	);
});
