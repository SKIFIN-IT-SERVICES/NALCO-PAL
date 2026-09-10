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
