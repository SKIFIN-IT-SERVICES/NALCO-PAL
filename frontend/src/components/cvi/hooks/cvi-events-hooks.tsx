import { useCallback } from 'react';
import { useAppMessage, useDailyEvent } from '@daily-co/daily-react';

// Every event broadcast by Tavus carries `seq` for global monotonic ordering
// and `turn_idx` for grouping events by conversational turn.
// See the Interactions Protocol docs ("Event Ordering and Turn Tracking").
type EventOrdering = {
	seq: number;
	turn_idx?: number;
	// Unix timestamp (seconds since epoch) of when the event was created.
	// Useful for timestamped transcripts and reconstructing a timeline.
	timestamp?: number;
};

// Who spoke. `pal` is the current name — prefer it in new code. For PAL turns
// Tavus sends a *duplicate* app-message with `role: 'replica'` (legacy) and an
// otherwise identical payload, so filter on one or you will double-count.
// User turns only ever use `user`.
type Role = 'user' | 'pal' | 'replica';

type AppMessageUtterance = EventOrdering & {
	message_type: 'conversation';
	event_type: 'conversation.utterance';
	conversation_id: string;
	inference_id: string;
	properties: {
		role: Role;
		// For `pal`/`replica` this is the full LLM response for the inference,
		// which may differ from what was actually spoken if the user barged in.
		speech: string;
		// Not part of the documented schema; present only on some deployments.
		visual_context?: string;
		// Present only on user utterances when the PAL uses Raven-1.
		user_audio_analysis?: string;
		user_visual_analysis?: string;
		// Only included when true (barge-in / interrupted completion).
		interrupted?: boolean;
	};
};

// Streaming utterance event — emitted as either side speaks. Reflects what was
// actually spoken/transcribed (vs. `conversation.utterance` role=replica which
// contains the full intended LLM response, even if interrupted).
type AppMessageUtteranceStreaming = EventOrdering & {
	message_type: 'conversation';
	event_type: 'conversation.utterance.streaming';
	conversation_id: string;
	inference_id: string;
	properties: {
		role: Role;
		// Monotonic index per streaming sequence, for ordering.
		content_index: number;
		// Full accumulated transcript for the turn so far — not a delta.
		// Partial until `final` is true.
		speech: string;
		// True when no further chunks are coming for this turn.
		final: boolean;
		// PAL only: barge-in / interrupted completion. Omitted on user streaming.
		is_interrupted?: boolean;
	};
};

type AppMessageToolCall<T> = EventOrdering & {
	message_type: 'conversation';
	event_type: 'conversation.tool_call';
	conversation_id: string;
	inference_id: string;
	properties: T;
};

type PerceptionFrame = {
	data: string;
	mime_type: string;
};

type AppMessagePerceptionToolCall<T = unknown> = EventOrdering & {
	message_type: 'conversation';
	event_type: 'conversation.perception_tool_call';
	conversation_id: string;
	properties: {
		modality: 'vision' | 'audio';
		name: string;
		// For modality="audio" this is a JSON string. For modality="vision" this
		// is an object with the tool-defined fields. Caller chooses T accordingly.
		arguments: T;
		frames?: PerceptionFrame[];
	};
};

type AppMessagePerceptionAnalysis = EventOrdering & {
	message_type: 'conversation';
	event_type: 'conversation.perception_analysis';
	conversation_id: string;
	properties: {
		analysis: string;
	};
};

// Canonical role-based speaking events (current Tavus schema). Use the `role`
// field in `properties` to identify the speaker.
type AppMessageStartedSpeaking = EventOrdering & {
	message_type: 'conversation';
	event_type: 'conversation.started_speaking';
	conversation_id: string;
	inference_id: string;
	properties: {
		role: Role;
	};
};

type AppMessageStoppedSpeaking = EventOrdering & {
	message_type: 'conversation';
	event_type: 'conversation.stopped_speaking';
	conversation_id: string;
	inference_id: string;
	properties: {
		role: Role;
		// Whether the speaker was cut off before finishing naturally.
		interrupted: boolean;
		// Speaking duration in seconds. Null if the start time could not be determined.
		duration: number | null;
	};
};

// Legacy per-role speaking events. Kept for backward compatibility with older
// Tavus deployments that may still emit them.
type AppMessageReplicaStartedSpeaking = EventOrdering & {
	message_type: 'conversation';
	event_type: 'conversation.replica.started_speaking';
	inference_id: string;
};

type AppMessageReplicaStoppedSpeaking = EventOrdering & {
	message_type: 'conversation';
	event_type: 'conversation.replica.stopped_speaking';
	inference_id: string;
};

type AppMessageUserStartedSpeaking = EventOrdering & {
	message_type: 'conversation';
	event_type: 'conversation.user.started_speaking';
	inference_id: string;
};

type AppMessageUserStoppedSpeaking = EventOrdering & {
	message_type: 'conversation';
	event_type: 'conversation.user.stopped_speaking';
	inference_id: string;
};

type AppMessage<T> = {
	data:
		| AppMessageUtterance
		| AppMessageUtteranceStreaming
		| AppMessageToolCall<T>
		| AppMessagePerceptionToolCall<T>
		| AppMessagePerceptionAnalysis
		| AppMessageStartedSpeaking
		| AppMessageStoppedSpeaking
		| AppMessageReplicaStartedSpeaking
		| AppMessageReplicaStoppedSpeaking
		| AppMessageUserStartedSpeaking
		| AppMessageUserStoppedSpeaking;
};

export function useObservableEvent<T>(callback: (event: AppMessage<T>['data']) => void): void {
	return useDailyEvent(
		'app-message',
		useCallback(
			(event: AppMessage<T>) => {
				callback(event.data);
			},
			[callback]
		)
	);
}

type AppMessageEcho = {
	message_type: 'conversation';
	event_type: 'conversation.echo';
	conversation_id: string;
	properties: {
		modality: 'audio' | 'text';
		text?: string;
		audio?: string;
		sample_rate?: number;
		inference_id?: string;
		done?: boolean;
	};
};

type AppMessageRespond = {
	message_type: 'conversation';
	event_type: 'conversation.respond';
	conversation_id: string;
	properties: {
		text: string;
	};
};

type AppMessageInterrupt = {
	message_type: 'conversation';
	event_type: 'conversation.interrupt';
	conversation_id: string;
};

type AppMessageOverwriteLlmContext = {
	message_type: 'conversation';
	event_type: 'conversation.overwrite_llm_context';
	conversation_id: string;
	properties: {
		context: string;
	};
};

type AppMessageAppendLlmContext = {
	message_type: 'conversation';
	event_type: 'conversation.append_llm_context';
	conversation_id: string;
	properties: {
		context: string;
	};
};

type Sensitivity = 'superlow' | 'verylow' | 'low' | 'medium' | 'high' | 'auto';

type AppMessageSensitivity = {
	message_type: 'conversation';
	event_type: 'conversation.sensitivity';
	conversation_id: string;
	properties: {
		participant_pause_sensitivity: Sensitivity;
		participant_interrupt_sensitivity: Sensitivity;
	};
};

type SendAppMessageProps =
	| AppMessageEcho
	| AppMessageRespond
	| AppMessageInterrupt
	| AppMessageOverwriteLlmContext
	| AppMessageAppendLlmContext
	| AppMessageSensitivity;

export function useSendAppMessage(): (message: SendAppMessageProps) => void {
	const sendAppMessage = useAppMessage();

	return useCallback(
		(message: SendAppMessageProps) => {
			sendAppMessage(message, '*');
		},
		[sendAppMessage]
	);
}
