import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Names a session after a run settles, then updates it after compaction and at
 * user turns 4, 8, 16, etc. It uses Pi's own session name, so /resume and
 * pi-remote ls show the result. A manual /name stops automatic updates.
 */

export const configPath = () => join(getAgentDir(), "auto-session-name.json");
const MAX_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 1500;
const MAX_TITLE_CHARS = 80;
const MAX_TITLE_WORDS = 12;
const MAX_SUMMARY_CHARS = MAX_MESSAGES * MAX_MESSAGE_CHARS;
export const STATE_TYPE = "auto-session-name";

interface NameState {
	version: 1;
	paused: boolean;
	lastAutoTitle?: string;
	lastAutoNameId?: string;
	nextTurn: number;
	lastCompactionId?: string;
}

/** Names are session-wide, not branch-local, so ownership must be too. */
function savedState(entries: SessionEntry[]): NameState {
	const entry = entries.findLast((e) => e.type === "custom" && e.customType === STATE_TYPE);
	const data = entry?.type === "custom" ? entry.data as NameState | undefined : undefined;
	return data?.version === 1 && typeof data.paused === "boolean" && Number.isSafeInteger(data.nextTurn) && data.nextTurn >= 4
		? { ...data } : { version: 1, paused: false, nextTurn: 4 };
}

/** Keep the goals and recent progress if a summary exceeds the input budget. */
export function summaryText(summary: string, budget = MAX_SUMMARY_CHARS): string | undefined {
	const text = summary.trim();
	// pi-openai-server-compaction uses this note when its portable summary fails.
	if (!text || text.startsWith("OpenAI remote compaction applied for ")) return undefined;
	const half = Math.floor(budget / 2);
	return text.length <= budget ? text : `${text.slice(0, half)}\n…\n${text.slice(-half)}`;
}

export const INSTRUCTIONS = [
	"You name coding-agent sessions so a user can tell them apart in a list.",
	"Reply with ONE short, descriptive title of at most 80 characters that says what the user is working on,",
	'for example "Fix the login redirect loop" or "Add CSV export".',
	"Use normal words and spaces, in the conversation's language. Reply with the title only, without quotes, markdown, or explanation.",
].join(" ");

/** `{"model": "provider/id"}` pins the naming model; `{"enabled": false}` turns naming off. */
export function readConfig(): { enabled: boolean; model?: string } {
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(readFileSync(configPath(), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: true };
		throw new Error(`Cannot read ${configPath()}: ${String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)
		|| Object.keys(value).some((key) => key !== "model" && key !== "enabled")
		|| (value.enabled !== undefined && typeof value.enabled !== "boolean")
		|| (value.model !== undefined && (typeof value.model !== "string" || !/^[^\s/]+\/\S+$/.test(value.model)))) {
		throw new Error(`Invalid ${configPath()}. Expected {"model": "provider/id"} and optional "enabled": false.`);
	}
	return { enabled: value.enabled !== false, model: value.model as string | undefined };
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	// Only visible text: no thinking, tool calls, tool output, or images.
	return content.flatMap((block) => block?.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
}

/** Recent user and assistant text from the active branch, bounded. Undefined until both exist. */
export function excerpt(branch: SessionEntry[], recentOnly = false, maxMessages = MAX_MESSAGES): string | undefined {
	const messages = branch.flatMap((entry) => {
		if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return [];
		const text = textOf(entry.message.content).replace(/\s+/g, " ").trim();
		if (!text) return [];
		return [{ role: entry.message.role, text: text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text }];
	});
	if (!messages.some((m) => m.role === "user") || !messages.some((m) => m.role === "assistant")) return undefined;
	// Keep the opening request for initial naming, but let updates follow recent work.
	const selected = messages.length <= maxMessages ? messages : recentOnly
		? messages.slice(-maxMessages) : [messages[0], ...messages.slice(-(maxMessages - 1))];
	return selected.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n\n");
}

function titleContext(branch: SessionEntry[], initial: boolean, afterCompaction: boolean): string | undefined {
	const compaction = branch.findLast((e) => e.type === "compaction");
	if (compaction?.type !== "compaction") return excerpt(branch, !initial);
	const keptIndex = branch.findIndex((e) => e.id === compaction.firstKeptEntryId);
	const kept = branch.slice(keptIndex >= 0 ? keptIndex : branch.indexOf(compaction) + 1);
	if (!afterCompaction) return excerpt(kept, true) ?? excerpt(branch, true);
	// Reserve room for the latest two messages, including retries after compaction.
	const recent = excerpt(kept, true, 2);
	const summary = summaryText(compaction.summary, MAX_SUMMARY_CHARS - (recent?.length ?? 0));
	if (!summary) return excerpt(kept, true) ?? excerpt(branch, true);
	return recent ? `${summary}\n\nRecent conversation:\n${recent}` : summary;
}

/** Keep one display-safe line, preserving case, punctuation, and non-ASCII text. */
export function normalizeTitle(text: string): string | undefined {
	const line = text.split("\n").map((value) => value.trim()).find(Boolean) ?? "";
	const title = line.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ")
		.replace(/^["'`“‘]+|["'`”’]+$/g, "").trim();
	// Reject an answer-shaped response before truncation can disguise it.
	if (title.split(/\s+/).length > MAX_TITLE_WORDS) return undefined;
	return Array.from(title).slice(0, MAX_TITLE_CHARS).join("").trim() || undefined;
}

/** The configured model, or the physical model that wrote the latest reply (this
 * also works when the session uses a virtual model such as model-switcher). */
function namingModel(ctx: ExtensionContext, branch: SessionEntry[], ref: string | undefined): Model<Api> {
	let model: Model<Api> | undefined;
	if (ref) {
		const slash = ref.indexOf("/");
		model = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
		if (!model) throw new Error(`Naming model ${ref} is not installed`);
	} else {
		const reply = branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		const message = reply?.type === "message" && reply.message.role === "assistant" ? reply.message : undefined;
		model = message && ctx.modelRegistry.find(message.provider, message.model);
		if (!model) throw new Error("Cannot find the model of the latest reply; set a naming model");
	}
	if (model.api === "pi-virtual") throw new Error(`Naming model ${model.provider}/${model.id} must be a physical model`);
	return model;
}

export default function autoSessionName(pi: ExtensionAPI) {
	let active: AbortController | undefined;
	let applyingName = false;
	let warned = false;
	const cancel = () => { active?.abort(); active = undefined; };
	const save = (state: NameState) => pi.appendEntry(STATE_TYPE, { ...state });

	function ownedState(ctx: ExtensionContext): NameState {
		const entries = ctx.sessionManager.getEntries();
		let state = savedState(entries);
		const nameEntry = entries.findLast((e) => e.type === "session_info");
		// A fork copies one path; it can retain state but omit the old name entry.
		if (!state.paused && !nameEntry && state.lastAutoNameId && !entries.some((e) => e.id === state.lastAutoNameId)) {
			state = { version: 1, paused: false, nextTurn: 4 };
			save(state);
		}
		// The entry ID also detects /name with the same text or a cleared name.
		if (!state.paused && (pi.getSessionName() !== state.lastAutoTitle || nameEntry?.id !== state.lastAutoNameId)) {
			state.paused = true;
			save(state);
			cancel();
		}
		return state;
	}

	async function refresh(ctx: ExtensionContext) {
		if (active) return;
		let controller: AbortController | undefined;
		try {
			const state = ownedState(ctx);
			if (state.paused) return;
			const branch = ctx.sessionManager.getBranch();
			const entries = ctx.sessionManager.getEntries();
			const turns = branch.filter((e) => e.type === "message" && e.message.role === "user" && textOf(e.message.content).trim()).length;
			const compaction = branch.findLast((e) => e.type === "compaction");
			// File order prevents tree navigation from treating an older summary as new.
			const afterCompaction = compaction !== undefined && entries.findIndex((e) => e.id === compaction.id)
				> entries.findIndex((e) => e.id === state.lastCompactionId);
			if (state.lastAutoTitle && !afterCompaction && turns < state.nextTurn) return;
			const conversation = titleContext(branch, !state.lastAutoTitle, afterCompaction);
			if (!conversation) return;
			const sessionId = ctx.sessionManager.getSessionId();
			const previousName = pi.getSessionName();
			controller = active = new AbortController();
			const config = readConfig();
			if (!config.enabled) return;
			// Consume each scheduled check even on failure: do not retry every turn.
			while (state.nextTurn <= turns) state.nextTurn *= 2;
			state.lastCompactionId = entries.findLast((e) => e.type === "compaction")?.id;
			save(state);
			const model = namingModel(ctx, branch, config.model);
			const response = await ctx.modelRegistry.complete(model, {
				systemPrompt: INSTRUCTIONS,
				messages: [{ role: "user", content: [{ type: "text", text: conversation }], timestamp: Date.now() }],
			}, { signal: controller.signal, cacheRetention: "none" });
			if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage ?? `Naming request ${response.stopReason}`);
			const name = normalizeTitle(textOf(response.content));
			if (!name) throw new Error("Naming model did not return a usable title");
			// A manual name, session switch, tree navigation, or shutdown wins.
			if (controller.signal.aborted || ctx.sessionManager.getSessionId() !== sessionId
				|| pi.getSessionName() !== previousName || ownedState(ctx).paused) return;
			if (name !== previousName) {
				applyingName = true;
				try { pi.setSessionName(name); } finally { applyingName = false; }
			}
			state.lastAutoTitle = name;
			state.lastAutoNameId = ctx.sessionManager.getEntries().findLast((e) => e.type === "session_info")?.id;
			save(state);
		} catch (error) {
			// Warn once per process. Unnamed sessions retry; named ones wait for the next check.
			if (!controller?.signal.aborted && !warned && ctx.hasUI) {
				warned = true;
				ctx.ui.notify(`Automatic session naming failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		} finally {
			if (active === controller) active = undefined;
		}
	}

	// Do not delay idle notifications, new prompts, or compaction completion.
	pi.on("agent_settled", (_event, ctx) => { void refresh(ctx); });
	pi.on("session_compact", (event, ctx) => {
		// Automatic compaction may retry or continue the run. Name only once it settles.
		if (event.reason === "manual" && !event.willRetry) void refresh(ctx);
	});
	pi.on("session_info_changed", (_event, ctx) => {
		// Our synchronous setter emits this event too; delayed notifications use saved IDs.
		if (!applyingName) ownedState(ctx);
	});
	pi.on("session_start", (_event, ctx) => { cancel(); ownedState(ctx); });
	pi.on("session_before_switch", cancel);
	pi.on("session_before_fork", cancel);
	pi.on("session_before_tree", cancel);
	pi.on("session_tree", cancel);
	pi.on("session_shutdown", cancel);
}
