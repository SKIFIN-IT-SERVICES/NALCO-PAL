import { useCallback, useRef } from 'react';
import { useObservableEvent, useSendAppMessage } from './cvi-events-hooks';

type ToolCallProperties = {
	tool_call_id: string;
	tool_name: string;
	arguments: Record<string, unknown>;
};

type ToolCallHandler = (args: Record<string, unknown>) => void;

/**
 * Generic dispatcher for app-message-delivered Tavus tools — as opposed to
 * HTTPS-delivered tools (get_aluminium_price, start_quiz, submit_quiz_answer)
 * which never touch the browser at all. This is the piece that was
 * completely missing from the app (see the engagement plan's defect #1):
 * six tools were attached to the PAL with app-message delivery, and nothing
 * here ever answered them.
 *
 * Register a handler per tool name. A `conversation.tool_result` is always
 * sent back for a tool this dispatcher has a handler for — the PAL is left
 * waiting on a result that must arrive, or the turn can stall. A tool name
 * with no registered handler is left alone rather than answered with a
 * failure, in case something else in the app owns it.
 */
export function useToolCallHandlers(handlers: Record<string, ToolCallHandler>): void {
	const handlersRef = useRef(handlers);
	handlersRef.current = handlers;
	const sendAppMessage = useSendAppMessage();

	useObservableEvent<ToolCallProperties>(
		useCallback(
			(event) => {
				if (event.event_type !== 'conversation.tool_call') return;
				const { tool_call_id, tool_name, arguments: args } = event.properties;
				const handler = handlersRef.current[tool_name];
				if (!handler) return;

				try {
					handler(args ?? {});
					sendAppMessage({
						message_type: 'conversation',
						event_type: 'conversation.tool_result',
						conversation_id: event.conversation_id,
						properties: { tool_call_id, output: 'ok', status: 'success' },
					});
				} catch (err) {
					sendAppMessage({
						message_type: 'conversation',
						event_type: 'conversation.tool_result',
						conversation_id: event.conversation_id,
						properties: { tool_call_id, output: String(err), status: 'error' },
					});
				}
			},
			[sendAppMessage]
		)
	);
}
