import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Names an unnamed session with a short slug after a run settles, so session
 * lists (including pi-remote ls) show what each session is about. It uses Pi's
 * own session name, so /name always wins and /resume shows the result.
 */

export const configPath = () => join(getAgentDir(), "auto-session-name.json");
const MAX_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 1500;
const MAX_SLUG_CHARS = 48;

export const INSTRUCTIONS = [
	"You name coding-agent sessions so a user can tell them apart in a list.",
	"Reply with ONE kebab-case slug of 2 to 6 words that says what the user is working on,",
	'for example "fix-login-redirect-loop" or "add-csv-export".',
	"Use lowercase ASCII letters, digits, and hyphens only. Reply with the slug only.",
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
export function excerpt(branch: SessionEntry[]): string | undefined {
	const messages = branch.flatMap((entry) => {
		if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return [];
		const text = textOf(entry.message.content).replace(/\s+/g, " ").trim();
		if (!text) return [];
		return [{ role: entry.message.role, text: text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text }];
	});
	if (!messages.some((m) => m.role === "user") || !messages.some((m) => m.role === "assistant")) return undefined;
	// The first request usually names the task; the latest messages show where it went.
	const selected = messages.length <= MAX_MESSAGES ? messages : [messages[0], ...messages.slice(-(MAX_MESSAGES - 1))];
	return selected.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n\n");
}

/** Model output is untrusted. Keep a bounded ASCII slug from its first non-empty line. */
export function slugify(text: string): string | undefined {
	const line = text.split("\n").map((value) => value.trim()).find(Boolean) ?? "";
	let slug = line.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	if (slug.length > MAX_SLUG_CHARS) slug = slug.slice(0, MAX_SLUG_CHARS).replace(/-[^-]*$/, "");
	return slug || undefined;
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
	let warned = false;

	pi.on("agent_settled", async (_event, ctx) => {
		if (active || pi.getSessionName()) return;
		const branch = ctx.sessionManager.getBranch();
		const conversation = excerpt(branch);
		if (!conversation) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const controller = active = new AbortController();
		try {
			const config = readConfig();
			if (!config.enabled) return;
			const model = namingModel(ctx, branch, config.model);
			const response = await ctx.modelRegistry.complete(model, {
				systemPrompt: INSTRUCTIONS,
				messages: [{ role: "user", content: [{ type: "text", text: conversation }], timestamp: Date.now() }],
			}, { signal: controller.signal, cacheRetention: "none" });
			if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage ?? `Naming request ${response.stopReason}`);
			const name = slugify(textOf(response.content));
			// A /name, session switch, or shutdown during the request wins.
			if (!name || controller.signal.aborted || pi.getSessionName() || ctx.sessionManager.getSessionId() !== sessionId) return;
			pi.setSessionName(name);
		} catch (error) {
			// Warn once per process; later settled runs try again with a newer excerpt.
			if (!controller.signal.aborted && !warned && ctx.hasUI) {
				warned = true;
				ctx.ui.notify(`Automatic session naming failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		} finally {
			if (active === controller) active = undefined;
		}
	});

	const cancel = () => { active?.abort(); active = undefined; };
	pi.on("session_info_changed", (event) => { if (event.name) cancel(); });
	pi.on("session_shutdown", cancel);
}
