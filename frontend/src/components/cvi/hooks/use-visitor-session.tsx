import { useCallback, useEffect, useRef, useState } from 'react';
import { useSendAppMessage } from './cvi-events-hooks';
import { useChat } from './use-chat';
import { useVoiceFingerprint, type VoiceFingerprintDebugState } from './use-voice-fingerprint';

/**
 * Ties the voice-change heuristic (use-voice-fingerprint.tsx) to two
 * concrete behaviours for a single, all-day, never-ending kiosk call:
 *
 *  1. After a visitor's 3rd question, nudge the PAL to mention the photo
 *     booth AND the prize quiz at the next natural pause — once per visitor.
 *     This is the quiz's only reliable trigger: the system prompt tells the
 *     PAL it *can* offer the quiz, but leaves the "when" entirely to its own
 *     judgment, which means a visitor who never asks about it and catches
 *     the PAL on a turn where it doesn't think to bring it up would simply
 *     never hear about it. This nudge is the deterministic backstop.
 *  2. When the voice fingerprint decides a new person has started talking,
 *     reset that counter/flag and tell the PAL a new visitor has arrived,
 *     so it stops referencing the previous person's questions.
 *
 * Deliberately uses `conversation.append_llm_context` for the reset, not
 * `conversation.overwrite_llm_context` — Tavus's own docs page for that
 * event 404s at the moment, so its exact effect (does it also wipe
 * knowledge-base grounding? persona instructions?) could not be confirmed.
 * `append_llm_context` is the one already proven safe in production for the
 * activity nudge; risking an unverified destructive call here, for a
 * heuristic that is itself imperfect, is not a good trade.
 */

const QUESTIONS_BEFORE_NUDGE = 3;

const NUDGE_CONTEXT =
	'[System note] This visitor has now asked 3 questions. At the next natural pause — never ' +
	'interrupting mid-answer — briefly invite them to either try the photo booth for a printed ' +
	'souvenir photo of a mining experience, or test their NALCO knowledge with the prize quiz ' +
	'(start_quiz). Mention both as options in one short line — do not force either, just offer — ' +
	'then continue answering normally. This is the reliable moment these get offered, since a ' +
	'visitor may never think to ask about either one themselves.';

const NEW_VISITOR_CONTEXT =
	'[System note] The kiosk detected that a different person has likely started speaking. Treat ' +
	'this as a brand new visitor: do not reference the previous visitor\'s questions, name, or ' +
	'context, and do not assume continuity with what was discussed before. Greet this person as if ' +
	'the conversation is starting fresh.';

export type VisitorSessionDebugState = {
	questionsThisVisitor: number;
	nudgeFiredThisVisitor: boolean;
	visitorCount: number;
	voice: VoiceFingerprintDebugState;
};

export const useVisitorSession = (): VisitorSessionDebugState => {
	const { messages, conversationId } = useChat();
	const sendAppMessage = useSendAppMessage();

	const questionsCountedRef = useRef(0); // how many final user messages already counted
	const questionsThisVisitorRef = useRef(0);
	const nudgeFiredRef = useRef(false);
	const visitorCountRef = useRef(1);
	const conversationIdRef = useRef<string | null>(null);
	conversationIdRef.current = conversationId;

	// State (not just refs) so the debug panel actually re-renders — see the
	// identical note in use-voice-fingerprint.tsx.
	const [questionsThisVisitor, setQuestionsThisVisitor] = useState(0);
	const [nudgeFiredThisVisitor, setNudgeFiredThisVisitor] = useState(false);
	const [visitorCount, setVisitorCount] = useState(1);

	const sendContext = useCallback(
		(context: string) => {
			const currentConversationId = conversationIdRef.current;
			if (!currentConversationId) return;
			sendAppMessage({
				message_type: 'conversation',
				event_type: 'conversation.append_llm_context',
				conversation_id: currentConversationId,
				properties: { context },
			});
		},
		[sendAppMessage]
	);

	const onLikelyNewSpeaker = useCallback(() => {
		questionsThisVisitorRef.current = 0;
		nudgeFiredRef.current = false;
		visitorCountRef.current += 1;
		setQuestionsThisVisitor(0);
		setNudgeFiredThisVisitor(false);
		setVisitorCount(visitorCountRef.current);
		sendContext(NEW_VISITOR_CONTEXT);
	}, [sendContext]);

	const voice = useVoiceFingerprint(onLikelyNewSpeaker);

	// Count newly-finalized user turns as they arrive in the chat transcript
	// — the same data source the visible transcript renders from, so this
	// stays in lockstep with what the visitor actually sees said back.
	useEffect(() => {
		const userMessages = messages.filter((m) => m.role === 'user' && !m.pending);
		if (userMessages.length <= questionsCountedRef.current) return;

		const newlyCounted = userMessages.length - questionsCountedRef.current;
		questionsCountedRef.current = userMessages.length;

		questionsThisVisitorRef.current += newlyCounted;
		setQuestionsThisVisitor(questionsThisVisitorRef.current);

		if (!nudgeFiredRef.current && questionsThisVisitorRef.current >= QUESTIONS_BEFORE_NUDGE) {
			nudgeFiredRef.current = true;
			setNudgeFiredThisVisitor(true);
			sendContext(NUDGE_CONTEXT);
		}
	}, [messages, sendContext]);

	return { questionsThisVisitor, nudgeFiredThisVisitor, visitorCount, voice };
};
