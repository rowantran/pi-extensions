/** The lifecycle fields needed to recognize a wait, without retaining message payloads. */
export interface WaitMessage {
	role: string;
	stopReason?: string;
	content?: string | readonly { type: string; name?: string; id?: string }[];
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
}

export function waitMessageMetadata(message: WaitMessage): WaitMessage {
	return {
		role: message.role,
		stopReason: message.stopReason,
		content: message.role === "assistant" && Array.isArray(message.content)
			? message.content.filter((block) => block.type === "toolCall")
				.map((block) => ({ type: "toolCall", name: block.name, id: block.id })) : undefined,
		toolName: message.toolName,
		toolCallId: message.toolCallId,
		isError: message.isError,
	};
}

/** Evaluate only at normal settlement, with messages scoped to that logical run.
 * Delivered user input clears an earlier wait. Notices, reply text, and result order do not.
 * Errors and cancellation are handled by the caller, not by this tool-call predicate.
 */
export function isBackgroundWaitEnding(messages: readonly WaitMessage[]): boolean {
	let lastCall: { name?: string; id?: string } | undefined;
	let succeeded = false;
	for (const message of messages) {
		if (message.role === "user") { lastCall = undefined; succeeded = false; }
		if (message.role === "assistant" && Array.isArray(message.content)) {
			const call = message.content.findLast((block) => block.type === "toolCall");
			if (call) { lastCall = call; succeeded = false; }
		}
		if (lastCall && message.role === "toolResult" && message.toolCallId === lastCall.id) {
			succeeded = message.toolName === "background_wait" && message.isError === false;
		}
	}
	return lastCall?.name === "background_wait" && typeof lastCall.id === "string" && lastCall.id.length > 0 && succeeded;
}
