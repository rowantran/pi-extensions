import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Adds a small, static prompt caret to the first input line while preserving
 * the built-in editor's text editing, autocomplete, and app keybindings.
 */
class PromptCaretEditor extends CustomEditor {
	private readonly neutralBorderColor: (text: string) => string;
	private readonly caretColor: (text: string) => string;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		editorTheme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		caretColor: (text: string) => string,
	) {
		super(tui, editorTheme, keybindings, { paddingX: 2 });
		this.neutralBorderColor = editorTheme.borderColor;
		this.caretColor = caretColor;
	}

	// Pi copies the default editor's padding onto custom editors after creating
	// them. This editor needs two cells so the caret does not replace input text.
	override setPaddingX(_padding: number): void {
		super.setPaddingX(2);
	}

	render(width: number): string[] {
		// The host updates borderColor for each thinking level. Keep the editor
		// border neutral; thinking level is already shown in the footer.
		this.borderColor = this.neutralBorderColor;

		const lines = super.render(width);
		const firstInputLine = lines[1];

		// paddingX: 2 gives us two cells to replace with the prompt caret. The
		// guard keeps very narrow terminals safe, where the editor clamps padding.
		if (firstInputLine?.startsWith("  ")) {
			lines[1] = this.caretColor("› ") + firstInputLine.slice(2);
		}

		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new PromptCaretEditor(tui, theme, keybindings, (text) => ctx.ui.theme.fg("muted", text)),
		);
	});
}
