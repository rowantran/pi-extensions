import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSessionContext, CONFIG_DIR_NAME, parseSessionEntries, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const AGENT_SESSION_ENTRY = "background-agent-session";
export const AGENT_REFERENCE_ENTRY = "background-agent-reference";
export const AGENT_FORGET_ENTRY = "background-agent-forget";

interface AgentMetadata {
	version: 1;
	name: string;
	task: string;
}

export interface SavedAgent {
	id: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	name: string;
	task: string;
	startedAt: number;
	updatedAt: number;
	state: "completed" | "failed" | "stopped";
	lastText: string;
	error?: string;
}

export function createSavedAgent(
	cwd: string,
	name: string,
	task: string,
	ctx: ExtensionContext,
): SavedAgent {
	const sessionDir = join(cwd, CONFIG_DIR_NAME, "subagents");
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
	const manager = SessionManager.create(cwd, sessionDir);
	manager.newSession({ parentSession: ctx.sessionManager.getSessionFile() });
	const sessionFile = manager.getSessionFile()!;
	// Pi normally waits for an assistant response before creating a new file.
	// Seed a valid header, then reopen it so even the initial task is persisted.
	writeFileSync(sessionFile, `${JSON.stringify(manager.getHeader())}\n`, { flag: "wx", mode: 0o600 });
	const saved = SessionManager.open(sessionFile, sessionDir);
	saved.appendCustomEntry(AGENT_SESSION_ENTRY, { version: 1, name, task } satisfies AgentMetadata);
	saved.appendSessionInfo(name);
	saved.appendModelChange(ctx.model!.provider, ctx.model!.id);
	saved.appendThinkingLevelChange(ctx.thinkingLevel);
	saved.appendMessage({
		role: "user",
		content: `You are a background subagent. Complete this delegated task autonomously. ` +
			`Keep changes scoped and finish with a concise report containing relevant file paths.\n\nTask: ${task}`,
		timestamp: Date.now(),
	});
	return readSavedAgent(sessionFile);
}

export function readSavedAgent(path: string): SavedAgent {
	// Resolve symlinks so the same file has one runtime and one writer lock.
	const sessionFile = realpathSync(path);
	// SessionManager.open can repair/migrate a file. Readers must not mutate a
	// live child's history; parse it in memory and leave repairs to the runner.
	const fileEntries = parseSessionEntries(readFileSync(sessionFile, "utf8"));
	const header = fileEntries[0];
	if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") {
		throw new Error(`Invalid saved background-agent session: ${sessionFile}`);
	}
	const entries = fileEntries.filter((entry) => entry.type !== "session");
	const metadata = entries.find((entry) => entry.type === "custom" && entry.customType === AGENT_SESSION_ENTRY);
	const data = metadata?.type === "custom" ? metadata.data as Partial<AgentMetadata> | undefined : undefined;
	if (data?.version !== 1 || typeof data.name !== "string" || typeof data.task !== "string") {
		throw new Error(`Not a saved background-agent session: ${sessionFile}`);
	}
	const messages = buildSessionContext(entries).messages;
	const lastMessage = messages.at(-1);
	const lastAssistant = messages.findLast((message) => message.role === "assistant");
	const lastText = lastAssistant?.role === "assistant"
		? lastAssistant.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim()
		: "";
	const state = lastMessage?.role === "assistant"
		? lastMessage.stopReason === "stop" || lastMessage.stopReason === "length"
			? "completed"
			: lastMessage.stopReason === "error" ? "failed" : "stopped"
		: "stopped";
	return {
		id: `agent-${header.id}`,
		sessionId: header.id,
		sessionFile,
		cwd: header.cwd,
		name: data.name,
		task: data.task,
		startedAt: Date.parse(header.timestamp),
		updatedAt: Date.parse(entries.at(-1)?.timestamp ?? header.timestamp),
		state,
		lastText,
		error: lastMessage?.role === "assistant" && lastMessage.stopReason === "error" ? lastMessage.errorMessage : undefined,
	};
}
