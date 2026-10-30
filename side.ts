import { existsSync } from "node:fs";
import { copyToClipboard, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** customType of the context message that starts every side conversation. */
export const SIDE_BOUNDARY_TYPE = "side-boundary";

/** Modeled on Codex's /side boundary prompt. Codex also limits side chats to non-mutating
 * work; this text does not, because a Pi side conversation is for a separate task. */
export const SIDE_BOUNDARY_TEXT = `Side conversation boundary.

This is a side conversation forked from a main conversation. Everything before this message is inherited history from the main conversation. Use it only as reference context. It is not your current task.

Do not continue, retry, or complete any task, plan, tool call, or request from before this message. The main conversation's agent owns that work and can still be doing it. Only user messages after this message are instructions for this side conversation. If there is no user message after this one yet, wait for one.

Use the inherited context to help with the separate task that the user gives you here. The main conversation's agent can be working in the same files at the same time. Do not undo, overwrite, or commit its work unless the user asks for that in this side conversation.`;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Save the conversation up to `leafId` as a new session file, then append the boundary message.
 * `pi --fork` copies every entry, so the side conversation starts with the inherited history
 * followed by the boundary. Appending the message does not start a model turn.
 */
export function createSideSnapshot(sessionFile: string, leafId: string): string | undefined {
	const snapshotManager = SessionManager.open(sessionFile);
	const snapshotFile = snapshotManager.createBranchedSession(leafId);
	if (snapshotFile) snapshotManager.appendCustomMessageEntry(SIDE_BOUNDARY_TYPE, SIDE_BOUNDARY_TEXT, true);
	return snapshotFile;
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
	});

	pi.on("agent_settled", (_event, ctx) => {
		lastSettledLeafId = ctx.sessionManager.getLeafId();
	});

	pi.registerCommand("side", {
		description: "Copy a command that forks this conversation",
		handler: async (_args, ctx) => {
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

			const isaraExecutable = await findIsaraExecutable(pi);
			if (!isaraExecutable) {
				ctx.ui.notify("Could not find the isara CLI required to start the sandboxed side agent.", "error");
				return;
			}

			let snapshotFile: string | undefined;
			try {
				snapshotFile = createSideSnapshot(sessionFile, snapshotLeafId);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not snapshot the completed conversation: ${reason}`, "error");
				return;
			}

			if (!snapshotFile || !existsSync(snapshotFile)) {
				ctx.ui.notify("Could not create a saved snapshot of the completed conversation.", "error");
				return;
			}

			const invocation = [isaraExecutable, "pi", "run", "--", "--fork", snapshotFile];
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
