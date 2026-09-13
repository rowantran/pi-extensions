import {
	AssistantMessageComponent,
	type ExtensionAPI,
	type Theme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

export default function assistantBackground(pi: ExtensionAPI): void {
	let originalAssistantRender = AssistantMessageComponent.prototype.render;
	let originalToolRender = ToolExecutionComponent.prototype.render;
	let activeTheme: Theme | undefined;
	let installed = false;

	function renderWithAgentBackground(
		this: AssistantMessageComponent,
		width: number,
	): string[] {
		const lines = originalAssistantRender.call(this, width);
		if (!activeTheme || lines.length === 0) {
			return lines;
		}

		const background = (line: string): string => {
			const padding = " ".repeat(Math.max(0, width - visibleWidth(line)));
			return activeTheme?.bg("customMessageBg", `${line}${padding}`) ?? line;
		};
		return [...lines.map(background), background("")];
	}

	function renderToolWithoutLeadingSpacer(
		this: ToolExecutionComponent,
		width: number,
	): string[] {
		const lines = originalToolRender.call(this, width);
		return lines[0] === "" ? lines.slice(1) : lines;
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		activeTheme = ctx.ui.theme;
		if (installed) return;

		// Pi caches the factory across session switches, so install per session,
		// not at module load. Capture any renderers installed by other extensions.
		originalAssistantRender = AssistantMessageComponent.prototype.render;
		originalToolRender = ToolExecutionComponent.prototype.render;
		AssistantMessageComponent.prototype.render = renderWithAgentBackground;
		ToolExecutionComponent.prototype.render = renderToolWithoutLeadingSpacer;
		installed = true;
	});

	pi.on("session_shutdown", () => {
		if (!installed) return;
		activeTheme = undefined;
		if (AssistantMessageComponent.prototype.render === renderWithAgentBackground) {
			AssistantMessageComponent.prototype.render = originalAssistantRender;
		}
		if (ToolExecutionComponent.prototype.render === renderToolWithoutLeadingSpacer) {
			ToolExecutionComponent.prototype.render = originalToolRender;
		}
		installed = false;
	});
}
