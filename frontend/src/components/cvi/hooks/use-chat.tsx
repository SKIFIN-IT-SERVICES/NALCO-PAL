import { useCallback, useMemo, useReducer } from 'react';
import { useObservableEvent, useSendAppMessage } from './cvi-events-hooks';

// `pal` is the current name for the Tavus side; `replica` is the legacy
// duplicate of it. Compare against both when branching on the speaker.
export type ChatRole = 'user' | 'pal' | 'replica';

export type ChatMessage = {
	id: string;
	role: ChatRole;
	text: string;
	inference_id?: string;
	// True while a locally sent message is awaiting its server-side utterance.
	pending?: boolean;
};

type UtteranceLike = {
	inference_id: string;
	conversation_id?: string;
	properties: { role: string; speech: string };
};

function isChatRole(role: string): role is ChatRole {
	return role === 'user' || role === 'pal' || role === 'replica';
}

// Tavus emits duplicate utterances for one PAL turn — `pal` plus a legacy
// `replica` — so both must map to the same id or the turn renders twice.
export function makeMessageId(inferenceId: string, role: ChatRole): string {
	return `${inferenceId}:${role === 'user' ? 'user' : 'pal'}`;
}

export function applyUtterance(prev: ChatMessage[], event: UtteranceLike): ChatMessage[] {
	const speech = event.properties.speech;
	const role = event.properties.role;
	if (!speech || !isChatRole(role)) {
		return prev;
	}
	const id = makeMessageId(event.inference_id, role);

	const existingIdx = prev.findIndex((m) => m.id === id);
	if (existingIdx >= 0) {
		const next = prev.slice();
		next[existingIdx] = { ...next[existingIdx], text: speech };
		return next;
	}

	// Reconcile the optimistic echo in place so the message keeps its position
	// in the transcript and simply loses its `pending` flag.
	if (role === 'user') {
		const trimmed = speech.trim();
		const pendingIdx = prev.findIndex(
			(m) => m.pending && m.role === 'user' && m.text.trim() === trimmed
		);
		if (pendingIdx >= 0) {
			const next = prev.slice();
			next[pendingIdx] = { id, role, text: speech, inference_id: event.inference_id };
			return next;
		}
	}

	return [...prev, { id, role, text: speech, inference_id: event.inference_id }];
}

export function appendOptimistic(prev: ChatMessage[], text: string, id: string): ChatMessage[] {
	return [...prev, { id, role: 'user', text, pending: true }];
}

type ChatState = {
	messages: ChatMessage[];
	conversationId: string | null;
};

type ChatAction =
	| { type: 'utterance'; event: UtteranceLike }
	| { type: 'optimistic'; text: string; id: string };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
	switch (action.type) {
		case 'utterance':
			return {
				messages: applyUtterance(state.messages, action.event),
				conversationId: state.conversationId ?? action.event.conversation_id ?? null,
			};
		case 'optimistic':
			return {
				...state,
				messages: appendOptimistic(state.messages, action.text, action.id),
			};
	}
}

const INITIAL_STATE: ChatState = { messages: [], conversationId: null };

function generateLocalId(): string {
	const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
	if (cryptoObj?.randomUUID) {
		return `local-${cryptoObj.randomUUID()}`;
	}
	return `local-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export type UseChatReturn = {
	messages: ChatMessage[];
	conversationId: string | null;
	sendMessage: (text: string) => void;
};

export function useChat(): UseChatReturn {
	const [state, dispatch] = useReducer(chatReducer, INITIAL_STATE);
	const sendAppMessage = useSendAppMessage();

	useObservableEvent<never>(
		useCallback((event) => {
			if (event.event_type === 'conversation.utterance') {
				dispatch({ type: 'utterance', event });
			}
		}, [])
	);

	const sendMessage = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (!trimmed || !state.conversationId) {
				return;
			}
			const id = generateLocalId();
			dispatch({ type: 'optimistic', text: trimmed, id });
			sendAppMessage({
				message_type: 'conversation',
				event_type: 'conversation.respond',
				conversation_id: state.conversationId,
				properties: { text: trimmed },
			});
		},
		[state.conversationId, sendAppMessage]
	);

	return useMemo(
		() => ({
			messages: state.messages,
			conversationId: state.conversationId,
			sendMessage,
		}),
		[state.messages, state.conversationId, sendMessage]
	);
}
