import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { copyToClipboard, getAgentDir, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** customType of the context message that starts every side conversation. */
export const SIDE_BOUNDARY_TYPE = "side-boundary";

/** Modeled on Codex's /side boundary prompt. Codex also limits side chats to non-mutating
 * work; this text does not, because a Pi side conversation is for a separate task. */
export const SIDE_BOUNDARY_TEXT = `Side conversation boundary.

This is a side conversation forked from a main conversation. Everything before this message is inherited history from the main conversation. Use it only as reference context. It is not your current task.

Do not continue, retry, or complete any task, plan, tool call, or request from before this message. The main conversation's agent owns that work and can still be doing it. Only user messages after this message are instructions for this side conversation. If there is no user message after this one yet, wait for one.

Use the inherited context to help with the separate task that the user gives you here. The main conversation's agent can be working in the same files at the same time. Do not undo, overwrite, or commit its work unless the user asks for that in this side conversation.`;

/** Key of the footer status that marks a side conversation. codex-footer.ts shows it before the session name. */
export const SIDE_STATUS_KEY = "side";
export const SIDE_STATUS_TEXT = "[side]";

/** True when the session has a side boundary, so it was started by /side (here or by pi-remote). */
export function isSideSession(entries: ReadonlyArray<{ type: string; customType?: string }>): boolean {
	return entries.some((entry) => entry.type === "custom_message" && entry.customType === SIDE_BOUNDARY_TYPE);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Where side sessions for `cwd` are kept: like Pi's own session folders, but under
 * `side-sessions`, so they stay out of the main conversation's /resume. pi-remote uses the
 * same folder.
 */
export function sideSessionDir(cwd: string, agentDir = getAgentDir()): string {
	return join(agentDir, "side-sessions", `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

/**
 * Save the conversation up to `leafId` as a new session file in `sessionDir`, then append the
 * boundary message. The side conversation opens this file, so it starts with the inherited
 * history followed by the boundary. Appending the message does not start a model turn.
 */
export function createSideSnapshot(sessionFile: string, leafId: string, sessionDir: string): string | undefined {
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
	const snapshotManager = SessionManager.open(sessionFile, sessionDir);
	const snapshotFile = snapshotManager.createBranchedSession(leafId);
	if (snapshotFile) snapshotManager.appendCustomMessageEntry(SIDE_BOUNDARY_TYPE, SIDE_BOUNDARY_TEXT, true);
	return snapshotFile;
}

/** The event that finds pi-remote's extension API in a pi-remote slot. */
export const PI_REMOTE_API_EVENT = "pi-remote:api";

/** pi-remote's API for other extensions, version 1 (pi-remote: src/protocol/extension-api.ts). */
export interface PiRemoteApi {
	readonly version: 1;
	readonly slotId: string;
	readonly slotNumber?: number;
	/** Rejects when no slot was started. Resolves with `error` when the slot started but exited. */
	createChildSlot(options: { sessionFile: string; sessionDir?: string; prompt?: string }): Promise<{
		slotId: string;
		slotNumber?: number;
		error?: string;
	}>;
	/** Resolves once a pane attached to the slot is open; rejects with the reason otherwise. */
	openSlot(options: { slotId: string }): Promise<void>;
}

/** pi-remote's API when this Pi runs in a pi-remote slot. The event is answered synchronously. */
export function discoverPiRemote(pi: ExtensionAPI): PiRemoteApi | undefined {
	let remote: PiRemoteApi | undefined;
	pi.events.emit(PI_REMOTE_API_EVENT, {
		respond: (api: PiRemoteApi) => {
			remote = api;
		},
	});
	return remote?.version === 1 ? remote : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * In a pi-remote slot: start the side conversation in a child slot and open it in a pane.
 * The child stops with this slot, and 90 seconds after its pane closes.
 */
async function startInPiRemote(
	remote: PiRemoteApi,
	snapshotFile: string,
	sessionDir: string,
	prompt: string | undefined,
	notify: (message: string, type: "info" | "warning" | "error") => void,
): Promise<void> {
	let child: Awaited<ReturnType<PiRemoteApi["createChildSlot"]>>;
	try {
		child = await remote.createChildSlot({ sessionFile: snapshotFile, sessionDir, ...(prompt ? { prompt } : {}) });
	} catch (error) {
		notify(`Could not start the side conversation: ${errorMessage(error)}`, "error");
		return;
	}
	const label = child.slotNumber === undefined ? child.slotId.slice(0, 8) : `#${child.slotNumber}`;
	if (child.error) {
		notify(`The side conversation's slot ${label} exited: ${child.error}`, "error");
		return;
	}
	try {
		await remote.openSlot({ slotId: child.slotId });
		notify(`Side conversation started in slot ${label}.`, "info");
	} catch (error) {
		notify(
			`Side conversation started in slot ${label}, but its pane did not open: ${errorMessage(error)} ` +
				"It stops 90 seconds after its last client leaves.",
			"warning",
		);
	}
}

async function findIsaraExecutable(pi: ExtensionAPI): Promise<string | undefined> {
	try {
		const result = await pi.exec("/bin/sh", ["-c", "command -v isara"]);
		if (result.code === 0 && result.stdout.trim()) {
			return result.stdout.trim().split("\n")[0];
		}
	} catch {
		// Report a user-facing error from the command handler.
	}

	return undefined;
}

export default function sideExtension(pi: ExtensionAPI) {
	let lastSettledLeafId: string | null = null;

	pi.on("session_start", (_event, ctx) => {
		lastSettledLeafId = ctx.sessionManager.getLeafId();
		// session_start also runs after /new, /resume and /fork, so clear the status when it does not apply.
		ctx.ui.setStatus(
			SIDE_STATUS_KEY,
			isSideSession(ctx.sessionManager.getEntries()) ? SIDE_STATUS_TEXT : undefined,
		);
	});

	pi.on("agent_settled", (_event, ctx) => {
		lastSettledLeafId = ctx.sessionManager.getLeafId();
	});

	pi.registerCommand("side", {
		description: "Fork this conversation into a side conversation",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/side is only available in pi's interactive terminal mode.", "error");
				return;
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile || !existsSync(sessionFile)) {
				ctx.ui.notify(
					"This conversation has not been saved yet. Send a prompt and wait for the response first.",
					"error",
				);
				return;
			}

			const snapshotLeafId = ctx.isIdle() ? ctx.sessionManager.getLeafId() : lastSettledLeafId;
			if (!snapshotLeafId) {
				ctx.ui.notify("No completed conversation turn is available to fork yet.", "error");
				return;
			}

			// In a pi-remote slot, pi-remote starts the side agent with this slot's options.
			const remote = discoverPiRemote(pi);
			const isaraExecutable = remote ? undefined : await findIsaraExecutable(pi);
			if (!remote && !isaraExecutable) {
				ctx.ui.notify("Could not find the isara CLI required to start the sandboxed side agent.", "error");
				return;
			}

			const sessionDir = sideSessionDir(ctx.cwd);
			let snapshotFile: string | undefined;
			try {
				snapshotFile = createSideSnapshot(sessionFile, snapshotLeafId, sessionDir);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not snapshot the completed conversation: ${reason}`, "error");
				return;
			}

			if (!snapshotFile || !existsSync(snapshotFile)) {
				ctx.ui.notify("Could not create a saved snapshot of the completed conversation.", "error");
				return;
			}

			if (remote) {
				await startInPiRemote(remote, snapshotFile, sessionDir, args.trim() || undefined, (message, type) =>
					ctx.ui.notify(message, type),
				);
				return;
			}

			const invocation = [isaraExecutable!, "pi", "run", "--", "--session", snapshotFile, "--session-dir", sessionDir];
			const shellCommand =
				`cd ${shellQuote(ctx.cwd)} && ` +
				`ISARA_ORIGINAL_CWD=${shellQuote(ctx.cwd)} ${invocation.map(shellQuote).join(" ")}`;

			try {
				await copyToClipboard(shellCommand);
				ctx.ui.notify("Command copied. Open a new terminal pane, paste the command, and press Enter.", "info");
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not copy the side-conversation command: ${reason}`, "error");
			}
		},
	});
}
