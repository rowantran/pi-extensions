import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type WaitMessage = Extract<JsonAgentSessionEvent, { type: "message_end" }>["message"];

/** Evaluate only at agent_settled, using messages from that run. */
export function isBackgroundWaitEnding(messages: readonly WaitMessage[]): boolean {
	const [call, result, reply] = messages.slice(-3);
	if (call?.role !== "assistant" || call.stopReason !== "toolUse"
		|| result?.role !== "toolResult" || result.toolName !== "background_wait" || result.isError !== false
		|| reply?.role !== "assistant" || reply.stopReason !== "stop"
		|| !Array.isArray(call.content) || !Array.isArray(reply.content)) return false;
	const calls = call.content.filter((block) => block.type === "toolCall");
	return calls.length === 1 && calls[0].name === "background_wait"
		&& typeof calls[0].id === "string" && calls[0].id.length > 0
		&& result.toolCallId === calls[0].id
		&& !reply.content.some((block) => block.type === "toolCall");
}
