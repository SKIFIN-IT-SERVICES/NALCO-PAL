import { useCallback } from 'react';
import { useDaily } from '@daily-co/daily-react';

export const useCVICall = (): {
	joinCall: (props: { url: string }) => void;
	leaveCall: () => Promise<void>;
} => {
	const daily = useDaily();

	const joinCall = useCallback(
		({ url }: { url: string }) => {
			daily?.join({
				url: url,
				// Visitor's own camera is never shown back to them — don't even
				// request it, so there's no permission prompt or feed to hide.
				// The AI avatar's video (a remote track) is unaffected by this.
				startVideoOff: true,
				inputSettings: {
					audio: {
						processor: {
							type: 'none',
						},
					},
				},
			});
		},
		[daily]
	);

	const leaveCall = useCallback(async () => {
		await daily?.leave();
	}, [daily]);

	return { joinCall, leaveCall };
};
