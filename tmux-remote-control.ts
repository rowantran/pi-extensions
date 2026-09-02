import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const SHORTCUT = "ctrl+shift+r";
type CustomEditorArguments = ConstructorParameters<typeof CustomEditor>;

class RemoteControlEditor extends CustomEditor {
	constructor(
		tui: CustomEditorArguments[0],
		theme: CustomEditorArguments[1],
		keybindings: CustomEditorArguments[2],
		private readonly statusText: () => string,
	) {
		super(tui, theme, keybindings);
	}

	render(width: number): string[] {
		return [truncateToWidth(this.statusText(), width)];
	}
}

export default function tmuxRemoteControl(pi: ExtensionAPI): void {
	let active = false;
	let changing = false;
	let previousEditor: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

	function disable(ctx: ExtensionContext): void {
		ctx.ui.setEditorComponent(previousEditor);
		previousEditor = undefined;
		active = false;
		ctx.ui.notify("Remote input disabled. The local controller can stay open.", "info");
	}

	async function enable(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Remote input requires Pi's interactive TUI mode.", "error");
			return;
		}

		const result = await pi.exec("tmux-remote-control", [], { timeout: 5_000 });
		if (result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
			ctx.ui.notify(`Could not start remote input: ${detail}`, "error");
			return;
		}

		previousEditor = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new RemoteControlEditor(
					tui,
					theme,
					keybindings,
					() => `📡  ${ctx.ui.theme.fg("dim", "remote control mode: enabled")}`,
				),
		);
		active = true;

		const message = result.stdout.trim();
		ctx.ui.notify(message || "Copied the local controller command.", "info");
	}

	async function toggle(ctx: ExtensionContext): Promise<void> {
		if (changing) return;
		changing = true;
		try {
			if (active) disable(ctx);
			else await enable(ctx);
		} finally {
			changing = false;
		}
	}

	pi.registerShortcut(SHORTCUT, {
		description: "Toggle tmux remote input and copy the local controller command",
		handler: toggle,
	});

	pi.registerCommand("remote-control", {
		description: "Toggle tmux remote input and copy the local controller command",
		handler: async (_args, ctx) => toggle(ctx),
	});
}
