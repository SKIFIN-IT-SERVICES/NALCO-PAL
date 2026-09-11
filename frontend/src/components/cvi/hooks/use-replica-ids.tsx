import { useParticipantIds } from '@daily-co/daily-react';

export const useReplicaIDs = (): string[] => {
	// Tavus's docs now describe this participant's user_id as containing
	// 'tavus-face' (renamed from 'tavus-replica'); match both so this keeps
	// working regardless of which naming a given conversation's backend uses.
	const replicasIDs = useParticipantIds({
		filter: (participant) =>
			participant.user_id.includes('tavus-replica') ||
			participant.user_id.includes('tavus-face'),
	});

	return replicasIDs;
};
