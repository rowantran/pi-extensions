import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getBotToken } from "./slack-bot/token.ts";

// Known channel name -> ID mappings, resolved locally to skip a lookup call.
const KNOWN_CHANNELS: Record<string, string> = {
	"rowan-log": "C0ACK1LAFDH",
};
const SLACK_API_BASE = "https://slack.com/api/";

interface SlackResponse {
	ok: boolean;
	error?: string;
	response_metadata?: { next_cursor?: string };
	[key: string]: unknown;
}

interface SlackChannel {
	id: string;
	name?: string;
	is_member?: boolean;
	is_private?: boolean;
	is_archived?: boolean;
}

async function slackApi<T extends SlackResponse>(
	method: string,
	token: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<T> {
	const response = await fetch(`${SLACK_API_BASE}${method}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json; charset=utf-8",
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok) {
		const retryAfter = response.headers.get("retry-after");
		const hint = response.status === 429 && retryAfter ? ` Retry after ${retryAfter} seconds.` : "";
		throw new Error(`Slack ${method} request failed with HTTP ${response.status}.${hint}`);
	}

	const result = (await response.json()) as T;
	if (!result.ok) {
		throw new Error(`Slack ${method} failed: ${result.error ?? "unknown_error"}.`);
	}
	return result;
}

// Lists only channels the bot has joined. conversations.list would page through
// every channel in the workspace (2,000+), which exceeds its Tier 2 rate limit
// and returns HTTP 429. The bot can only post in channels it has joined anyway.
async function listJoinedChannels(token: string, signal?: AbortSignal): Promise<SlackChannel[]> {
	const channels: SlackChannel[] = [];
	let cursor = "";

	do {
		const result = await slackApi<SlackResponse & { channels?: SlackChannel[] }>(
			"users.conversations",
			token,
			{
				types: "public_channel,private_channel",
				exclude_archived: true,
				limit: 200,
				cursor,
			},
			signal,
		);
		channels.push(...(result.channels ?? []));
		cursor = result.response_metadata?.next_cursor ?? "";
	} while (cursor);

	return channels;
}

export async function resolveChannel(
	token: string,
	input: string,
	signal?: AbortSignal,
): Promise<{ id: string; display: string }> {
	const value = input.trim();
	if (/^[CDG][A-Z0-9]+$/i.test(value)) {
		return { id: value.toUpperCase(), display: value.toUpperCase() };
	}
	if (/^[UW][A-Z0-9]+$/i.test(value)) {
		// A user ID: open (or reuse) the bot's DM with that user.
		const user = value.toUpperCase();
		const result = await slackApi<SlackResponse & { channel?: { id?: string } }>(
			"conversations.open",
			token,
			{ users: user },
			signal,
		);
		const id = result.channel?.id;
		if (!id) throw new Error(`Slack conversations.open returned no DM channel for ${user}.`);
		return { id, display: `DM with <@${user}> (${id})` };
	}

	const name = value.replace(/^#/, "");
	const knownId = KNOWN_CHANNELS[name];
	if (knownId) {
		return { id: knownId, display: `#${name}` };
	}
	const channels = await listJoinedChannels(token, signal);
	const channel = channels.find((candidate) => candidate.name === name);
	if (!channel) {
		throw new Error(
			`walle_rowanbot has not joined Slack channel #${name}. Invite the bot to the channel first.`,
		);
	}
	return { id: channel.id, display: `#${channel.name ?? name}` };
}

export default function slackBotExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "slack_bot_send_message",
		label: "Slack Bot: Send Message",
		description:
			"Send a Slack message as the walle_rowanbot bot through Slack Web API, using the bot token stored in the OS credential store (macOS Keychain or Linux Secret Service). Use this instead of Slack MCP for all Slack message sending.",
		promptSnippet: "Send Slack messages as walle_rowanbot through the Slack Web API",
		promptGuidelines: [
			"Use slack_bot_send_message whenever the user asks to send or post a Slack message; never use Slack MCP to send messages.",
			"Prefer channel IDs over names: #rowan-log is C0ACK1LAFDH. To DM a person, pass their user ID (U...); the tool opens the bot's DM with them.",
			"To tag @rowan in a Slack message, use <@U0AAUUHUFRQ>.",
		],
		parameters: Type.Object({
			channel: Type.String({
				description:
					"Slack channel name such as #rowan-log, a channel/conversation ID, or a user ID (U...) to DM that user. Prefer IDs; #rowan-log is C0ACK1LAFDH.",
			}),
			text: Type.String({ description: "Exact message text to send" }),
			threadTs: Type.Optional(
				Type.String({ description: "Parent message timestamp when sending a thread reply" }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const token = await getBotToken(signal);
			const channel = await resolveChannel(token, params.channel, signal);
			const payload: Record<string, unknown> = {
				channel: channel.id,
				text: params.text,
			};
			if (params.threadTs) payload.thread_ts = params.threadTs;

			const result = await slackApi<SlackResponse & { channel?: string; ts?: string }>(
				"chat.postMessage",
				token,
				payload,
				signal,
			);

			return {
				content: [
					{
						type: "text" as const,
						text: `Sent Slack message as walle_rowanbot to ${channel.display} (timestamp ${result.ts ?? "unknown"}).`,
					},
				],
				details: {
					channel: result.channel ?? channel.id,
					channelDisplay: channel.display,
					timestamp: result.ts,
				},
			};
		},
	});

	pi.registerTool({
		name: "slack_bot_list_channels",
		label: "Slack Bot: List Channels",
		description:
			"List active Slack channels that walle_rowanbot has joined, using its bot token from the OS credential store and the Slack Web API.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			const token = await getBotToken(signal);
			const channels = (await listJoinedChannels(token, signal))
				.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
				.map((channel) => ({
					name: channel.name ?? channel.id,
					id: channel.id,
					private: Boolean(channel.is_private),
				}));

			const text =
				channels.length === 0
					? "walle_rowanbot has not joined any active channels."
					: channels
							.map(
								(channel) =>
									`#${channel.name} (${channel.id}, ${channel.private ? "private" : "public"})`,
							)
							.join("\n");

			return {
				content: [{ type: "text" as const, text }],
				details: { channels },
			};
		},
	});
}
