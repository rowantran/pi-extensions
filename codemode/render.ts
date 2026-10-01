import type {
	AgentToolResult,
	ExtensionAPI,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import {
	branch,
	callHeading,
	collapseWhitespace,
	type CompactStatus,
	compactRenderingState,
	type DisplayRow,
	firstOutputLine,
	renderRows,
	toolHeading,
} from "../compact-tools.ts";

export const CODEMODE_TOOL_NAME = "codemode";

/** Asks the model for a title line, which the heading shows as `Codemode(<title>)`. */
export const CODEMODE_TITLE_GUIDELINE =
	"Start each codemode script with a short `// <purpose>` comment line (after any `// @options:` line); the UI shows it as the script's title.";

/** Nested calls shown while collapsed; Ctrl+O shows all of them. */
const COLLAPSED_CALL_LIMIT = 8;
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n$/;
const OPTIONS_LINE = /^\/\/\s*@options:/;
const SCRIPT_ERROR = "Script error:\n";

type NestedCallStatus = "running" | "ok" | "error" | "cancelled";

/** One entry of `CodemodeToolDetails.calls`, published by Pi's codemode executor. */
interface NestedCall {
	id: string;
	name: string;
	/** Compact JSON of the arguments, cut to 200 characters with a trailing `...`. */
	args: string;
	status: NestedCallStatus;
	durationMs?: number;
	error?: string;
	cost?: number;
}

interface CodemodeDetails {
	calls?: NestedCall[];
	fullOutputPath?: string;
}

interface CallRenderContext {
	expanded: boolean;
	isPartial: boolean;
	isError: boolean;
	state: Record<string, unknown>;
	invalidate: () => void;
}

interface CodemodeState {
	hasResult: boolean;
	status: CompactStatus;
	calls: NestedCall[];
	/** Styled one-line outcome, e.g. the first output line and the wall time. */
	summary: string;
	/** Script output without Pi's "Script completed" header. */
	output: string;
	/** Whether the summary starts with the first output line, which the expanded output then skips. */
	summaryRepeatsOutput: boolean;
	failed: boolean;
	fullOutputPath?: string;
}

function codemodeState(context: CallRenderContext): CodemodeState {
	const state = context.state as Partial<CodemodeState>;
	state.hasResult ??= false;
	state.status ??= "running";
	state.calls ??= [];
	state.summary ??= "";
	state.output ??= "";
	state.summaryRepeatsOutput ??= false;
	state.failed ??= false;
	return state as CodemodeState;
}

/** The first `// comment` line of the script, ignoring blank lines and the `// @options:` line. */
export function scriptTitle(code: string): string {
	for (const line of code.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || OPTIONS_LINE.test(trimmed)) continue;
		const comment = /^\/\/\s*(.*)$/.exec(trimmed);
		return comment ? collapseWhitespace(comment[1] ?? "") : "";
	}
	return "";
}

function unescapeJsonString(value: string): string {
	try {
		return JSON.parse(`"${value}"`);
	} catch {
		return value;
	}
}

/**
 * Parse a nested call's argument preview. Long previews are cut off mid-JSON, so fall back to the
 * string and number fields that are still readable, which is enough for the heading.
 */
export function parseNestedArgs(preview: string): unknown {
	if (!preview) return {};
	try {
		return JSON.parse(preview);
	} catch {
		const values: Record<string, unknown> = {};
		for (const match of preview.matchAll(/"([^"\\]+)":"((?:[^"\\]|\\.)*)/g)) {
			values[match[1]!] ??= unescapeJsonString(match[2]!);
		}
		for (const match of preview.matchAll(/"([^"\\]+)":(-?\d+(?:\.\d+)?)[,}]/g)) {
			values[match[1]!] ??= Number(match[2]);
		}
		return values;
	}
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(cost: number): string {
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

function nestedStatus(call: NestedCall): CompactStatus {
	if (call.status === "ok") return "success";
	if (call.status === "error") return "error";
	return "running";
}

function nestedHeading(theme: Theme, call: NestedCall): string {
	// Script globals such as `models.classify` carry a plain-text preview, not JSON arguments.
	if (call.name.includes(".")) return toolHeading(theme, call.name, collapseWhitespace(call.args));
	return callHeading(theme, call.name, parseNestedArgs(call.args));
}

function nestedSummary(theme: Theme, call: NestedCall): string {
	switch (call.status) {
		case "running":
			return theme.fg("toolOutput", "Running…");
		case "cancelled":
			return theme.fg("muted", "Cancelled");
		case "error":
			return theme.fg("error", firstOutputLine(call.error ?? "", "Failed"));
		case "ok": {
			const parts = [formatDuration(call.durationMs), call.cost ? formatCost(call.cost) : ""].filter(Boolean);
			return theme.fg("dim", parts.join(" · ") || "Done");
		}
	}
}

function nestedRows(theme: Theme, calls: NestedCall[], expanded: boolean): DisplayRow[] {
	const visible = expanded ? calls : calls.slice(-COLLAPSED_CALL_LIMIT);
	const rows: DisplayRow[] = [];
	const hidden = calls.length - visible.length;
	if (hidden > 0) {
		rows.push({
			prefix: theme.fg("dim", "│  "),
			content: theme.fg("muted", `⋯ ${hidden} earlier ${hidden === 1 ? "call" : "calls"}`),
		});
	}

	visible.forEach((call, index) => {
		const isLast = index === visible.length - 1;
		const guide = theme.fg("dim", "│  ");
		const continuation = guide + (isLast ? "   " : theme.fg("dim", "│  "));
		rows.push({
			prefix: guide + branch(theme, isLast ? "└─ " : "├─ ", nestedStatus(call)),
			continuation,
			content: nestedHeading(theme, call) + theme.fg("dim", " ── ") + nestedSummary(theme, call),
			truncate: !expanded,
		});
		// The summary shows the first error line; the expanded view adds the rest.
		const extraErrorLines = expanded && call.status === "error" ? (call.error ?? "").split("\n").slice(1) : [];
		for (const line of extraErrorLines) {
			rows.push({ prefix: continuation, continuation, content: theme.fg("error", line || " ") });
		}
	});
	return rows;
}

function scriptRows(theme: Theme, code: string): DisplayRow[] {
	const source = code.replace(/\r/g, "").replace(/\t/g, "   ").trimEnd();
	if (!source) return [];
	return highlightCode(source, "javascript").map((line) => ({
		prefix: theme.fg("dim", "│  "),
		continuation: theme.fg("dim", "│  "),
		content: line || " ",
	}));
}

function outputRows(theme: Theme, state: CodemodeState): DisplayRow[] {
	const color = state.failed ? "error" : "toolOutput";
	const lines = state.output ? state.output.split("\n") : [];
	if (state.summaryRepeatsOutput) {
		const first = lines.findIndex((line) => collapseWhitespace(line));
		if (first >= 0) lines.splice(0, first + 1);
	}
	if (state.fullOutputPath) lines.push(`Full output: ${state.fullOutputPath}`);
	const rows: DisplayRow[] = [
		{
			prefix: theme.fg("dim", lines.length > 0 ? "│  " : "└─ "),
			continuation: theme.fg("dim", lines.length > 0 ? "│  " : "   "),
			content: state.summary || theme.fg("toolOutput", "Running…"),
		},
	];
	lines.forEach((line, index) => {
		const isLast = index === lines.length - 1;
		rows.push({
			prefix: theme.fg("dim", isLast ? "└─ " : "│  "),
			continuation: theme.fg("dim", isLast ? "   " : "│  "),
			content: theme.fg(color, line || " "),
		});
	});
	return rows;
}

function renderCodemodeCall(args: { code?: unknown }, theme: Theme, context: CallRenderContext): Component {
	const renderingState = compactRenderingState();
	renderingState.invalidators.add(context.invalidate);
	const state = codemodeState(context);
	const code = typeof args?.code === "string" ? args.code : "";

	const rows = (): DisplayRow[] => {
		const heading = toolHeading(theme, "Codemode", scriptTitle(code));
		const summary = state.summary || theme.fg("toolOutput", "Running…");
		const status = state.hasResult ? state.status : "running";
		const showScript = renderingState.showFullToolCall;

		if (!context.expanded && !showScript && state.calls.length === 0) {
			return [{
				prefix: branch(theme, "├─ ", status),
				content: heading + theme.fg("dim", " ── ") + summary,
				truncate: true,
			}];
		}

		const result: DisplayRow[] = [
			{
				prefix: branch(theme, "┌─ ", status),
				continuation: theme.fg("dim", "│  "),
				content: heading,
			},
		];
		if (showScript) result.push(...scriptRows(theme, code));
		result.push(...nestedRows(theme, state.calls, context.expanded));
		if (context.expanded) {
			result.push(...outputRows(theme, state));
		} else {
			result.push({ prefix: theme.fg("dim", "└─ "), continuation: "   ", content: summary, truncate: true });
		}
		return result;
	};

	return {
		render: (width: number) => renderRows(rows(), width),
		invalidate(): void {},
	};
}

/** Split Pi's codemode result into the wall time and the script output that follows its header. */
function splitResult(result: AgentToolResult<unknown>): { wallTime?: string; output: string } {
	const [first, ...rest] = result.content;
	const header = first?.type === "text" ? SCRIPT_HEADER.exec(first.text) : null;
	const blocks = header ? rest : result.content;
	const output = blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.replace(/\n+$/, "");
	return { wallTime: header?.[2], output };
}

function summarizeResult(theme: Theme, state: CodemodeState, wallTime: string | undefined): string {
	let text: string;
	if (state.failed) {
		const errorIndex = state.output.indexOf(SCRIPT_ERROR);
		const error = errorIndex >= 0 ? state.output.slice(errorIndex + SCRIPT_ERROR.length) : state.output;
		text = theme.fg("error", firstOutputLine(error, "Script failed"));
	} else {
		text = theme.fg("toolOutput", firstOutputLine(state.output, "Completed"));
	}
	state.summaryRepeatsOutput = !state.failed && collapseWhitespace(state.output) !== "";

	const failedCalls = state.calls.filter((call) => call.status === "error").length;
	if (!state.failed && failedCalls > 0) {
		text += theme.fg("dim", " · ") + theme.fg("error", `${failedCalls} failed`);
	}
	if (wallTime) text += theme.fg("dim", ` · ${wallTime}s`);
	if (state.fullOutputPath) text += theme.fg("dim", " · truncated");
	return text;
}

function renderCodemodeResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: CallRenderContext,
): Component {
	const state = codemodeState(context);
	const details = (result.details ?? {}) as CodemodeDetails;
	state.hasResult = true;
	state.calls = details.calls ?? [];
	state.fullOutputPath = details.fullOutputPath;

	if (options.isPartial) {
		state.status = "running";
		state.failed = false;
		state.output = "";
		state.summaryRepeatsOutput = false;
		state.summary = theme.fg("toolOutput", "Running…");
	} else {
		const { wallTime, output } = splitResult(result);
		state.failed = context.isError;
		state.status = state.failed ? "error" : "success";
		state.output = output;
		state.summary = summarizeResult(theme, state, wallTime);
	}

	// The call component draws everything, so the nested calls stay between the heading and the outcome.
	return new Container();
}

/** Replace the codemode tool's renderers with the compact tree; execution is untouched. */
export function compactCodemodeTool(tool: ToolDefinition<any, any, any>): ToolDefinition<any, any, any> {
	return {
		...tool,
		renderShell: "self",
		promptGuidelines: [...(tool.promptGuidelines ?? []), CODEMODE_TITLE_GUIDELINE],
		renderCall(args, theme, context) {
			return renderCodemodeCall(args, theme, context as unknown as CallRenderContext);
		},
		renderResult(result, options, theme, context) {
			return renderCodemodeResult(result, options, theme, context as unknown as CallRenderContext);
		},
	};
}

/** Pass to Pi's codemode extension factory so the tool it registers uses the compact renderer. */
export function withCompactCodemodeRendering(pi: ExtensionAPI): ExtensionAPI {
	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (tool: ToolDefinition<any, any, any>) =>
					target.registerTool(tool.name === CODEMODE_TOOL_NAME ? compactCodemodeTool(tool) : tool);
			}
			return Reflect.get(target, property, receiver);
		},
	});
}
