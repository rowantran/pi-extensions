import { existsSync } from "node:fs";
import { copyToClipboard, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
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
				const snapshotManager = SessionManager.open(sessionFile);
				snapshotFile = snapshotManager.createBranchedSession(snapshotLeafId);
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
