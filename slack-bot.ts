import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const KEYCHAIN_SERVICE = "pi-slack-bot-token";
// Known channel name -> ID mappings, resolved locally to avoid rate-limited
// conversations.list calls (which return HTTP 429 fairly often).
const KNOWN_CHANNELS: Record<string, string> = {
	"rowan-log": "C0ACK1LAFDH",
};
const LOGIN_KEYCHAIN = join(homedir(), "Library/Keychains/login.keychain-db");
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

function getBotToken(signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error, token?: string) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(token ?? "");
		};

		const child = execFile(
			"/usr/bin/security",
			[
				"find-generic-password",
				"-s",
				KEYCHAIN_SERVICE,
				"-w",
				LOGIN_KEYCHAIN,
			],
			{ encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 },
			(error, stdout) => {
				if (error) {
					finish(
						new Error(
							`Could not retrieve the Slack bot token from the macOS login Keychain. ` +
							`Approve the Keychain prompt and confirm that service ${KEYCHAIN_SERVICE} exists.`,
						),
					);
					return;
				}

				const token = stdout.trim();
				if (!token) {
					finish(new Error("The Slack bot token Keychain item is empty."));
					return;
				}
				finish(undefined, token);
			},
		);

		const onAbort = () => {
			child.kill();
			finish(new Error("Slack operation cancelled."));
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
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
		throw new Error(`Slack ${method} request failed with HTTP ${response.status}.`);
	}

	const result = (await response.json()) as T;
	if (!result.ok) {
		throw new Error(`Slack ${method} failed: ${result.error ?? "unknown_error"}.`);
	}
	return result;
}

async function listVisibleChannels(token: string, signal?: AbortSignal): Promise<SlackChannel[]> {
	const channels: SlackChannel[] = [];
	let cursor = "";

	do {
		const result = await slackApi<SlackResponse & { channels?: SlackChannel[] }>(
			"conversations.list",
			token,
			{
				types: "public_channel,private_channel",
				exclude_archived: false,
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

async function resolveChannel(
	token: string,
	input: string,
	signal?: AbortSignal,
): Promise<{ id: string; display: string }> {
	const value = input.trim();
	if (/^[CDG][A-Z0-9]+$/i.test(value)) {
		return { id: value.toUpperCase(), display: value.toUpperCase() };
	}

	const name = value.replace(/^#/, "");
	const knownId = KNOWN_CHANNELS[name];
	if (knownId) {
		return { id: knownId, display: `#${name}` };
	}
	const channels = await listVisibleChannels(token, signal);
	const channel = channels.find((candidate) => candidate.name === name);
	if (!channel) {
		throw new Error(
			`Slack channel #${name} is not visible to the bot. Use a channel ID or invite the bot first.`,
		);
	}
	return { id: channel.id, display: `#${channel.name ?? name}` };
}

export default function slackBotExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "slack_bot_send_message",
		label: "Slack Bot: Send Message",
		description:
			"Send a Slack message as the walle_rowanbot bot through Slack Web API, using the bot token stored in the macOS Keychain. Use this instead of Slack MCP for all Slack message sending.",
		promptSnippet: "Send Slack messages as walle_rowanbot through the Slack Web API",
		promptGuidelines: [
			"Use slack_bot_send_message whenever the user asks to send or post a Slack message; never use Slack MCP to send messages.",
			"Prefer channel IDs over names: #rowan-log is C0ACK1LAFDH (name lookup via conversations.list is often rate-limited with HTTP 429).",
			"To tag @rowan in a Slack message, use <@U0AAUUHUFRQ>.",
		],
		parameters: Type.Object({
			channel: Type.String({
				description:
					"Slack channel name such as #rowan-log, or a channel/conversation ID. Prefer IDs; #rowan-log is C0ACK1LAFDH.",
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
			"List active Slack channels that walle_rowanbot has joined, using its bot token from the macOS Keychain and the Slack Web API.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			const token = await getBotToken(signal);
			const channels = (await listVisibleChannels(token, signal))
				.filter((channel) => channel.is_member && !channel.is_archived)
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

	pi.on("tool_call", (event) => {
		if (event.toolName === "slack_bot_send_message") return;
		const name = event.toolName.toLowerCase();
		if (name.includes("slack") && /(?:send|post|draft).*message|message.*(?:send|post|draft)/.test(name)) {
			return {
				block: true,
				reason:
					"Slack MCP message sending is disabled. Use slack_bot_send_message so the message is sent as walle_rowanbot.",
			};
		}
	});
}
