import { useCallback, useRef, useState } from 'react';
import { useObservableEvent } from './cvi-events-hooks';
import { stripSpeechControlTags } from './strip-speech-control-tags';

const CAPTION_CLEAR_DELAY_MS = 2000;

export type ClosedCaption = {
	// `pal` is the current name for the Tavus side; `replica` is the legacy
	// duplicate of it. Compare against both when branching on the speaker.
	role: 'user' | 'pal' | 'replica';
	text: string;
};

export const useClosedCaption = (): ClosedCaption | null => {
	const [caption, setCaption] = useState<ClosedCaption | null>(null);
	const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const update = useCallback((next: ClosedCaption, final: boolean) => {
		setCaption(next);
		if (clearTimer.current !== null) {
			clearTimeout(clearTimer.current);
			clearTimer.current = null;
		}
		if (final) {
			clearTimer.current = setTimeout(() => {
				setCaption(null);
				clearTimer.current = null;
			}, CAPTION_CLEAR_DELAY_MS);
		}
	}, []);

	useObservableEvent<unknown>(
		useCallback(
			(event) => {
				if (event.event_type === 'conversation.utterance.streaming') {
					const { role, speech, final } = event.properties;
					// The duplicate `pal`/`replica` frames carry the same text, so
					// showing whichever arrives is an idempotent caption update.
					if (role === 'user' || role === 'pal' || role === 'replica') {
						update({ role, text: stripSpeechControlTags(speech ?? '') }, final ?? false);
					}
				}

				// The PAL's audio track and its transcript text arrive over two
				// separate channels (media track vs. data-channel app-message),
				// and the text has been observed lagging audibly behind the
				// audio start. `started_speaking` fires the instant the audio
				// begins, so use it to put *something* on screen immediately —
				// the very next `utterance.streaming` event overwrites it with
				// the real text within the same turn.
				if (event.event_type === 'conversation.started_speaking') {
					const { role } = event.properties;
					if (role === 'pal' || role === 'replica') {
						setCaption((prev) => (prev?.text ? prev : { role, text: '…' }));
					}
				}

				// If the PAL finished speaking without any transcript ever
				// arriving for that turn, drop the placeholder instead of
				// leaving a bare "…" on screen.
				if (event.event_type === 'conversation.stopped_speaking') {
					const { role } = event.properties;
					if (role === 'pal' || role === 'replica') {
						setCaption((prev) => (prev?.text === '…' ? null : prev));
					}
				}
			},
			[update]
		)
	);

	return caption;
};
