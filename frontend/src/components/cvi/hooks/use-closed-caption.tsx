import { useCallback, useRef, useState } from 'react';
import { useObservableEvent } from './cvi-events-hooks';

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
						update({ role, text: speech }, final ?? false);
					}
				}
			},
			[update]
		)
	);

	return caption;
};
