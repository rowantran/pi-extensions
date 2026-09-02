import {
	AssistantMessageComponent,
	type ExtensionAPI,
	type Theme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const originalAssistantRender = AssistantMessageComponent.prototype.render;
const originalToolRender = ToolExecutionComponent.prototype.render;
let activeTheme: Theme | undefined;

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

AssistantMessageComponent.prototype.render = renderWithAgentBackground;
ToolExecutionComponent.prototype.render = renderToolWithoutLeadingSpacer;

export default function assistantBackground(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		activeTheme = ctx.ui.theme;
	});

	pi.on("session_shutdown", () => {
		activeTheme = undefined;
		if (AssistantMessageComponent.prototype.render === renderWithAgentBackground) {
			AssistantMessageComponent.prototype.render = originalAssistantRender;
		}
		if (ToolExecutionComponent.prototype.render === renderToolWithoutLeadingSpacer) {
			ToolExecutionComponent.prototype.render = originalToolRender;
		}
	});
}
