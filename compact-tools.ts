import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Component,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { homedir } from "node:os";

interface ToolStatus {
	isError: boolean;
	isPartial: boolean;
}

type RenderContext = ToolStatus & {
	expanded: boolean;
	state: Record<string, unknown>;
	invalidate: () => void;
};

type CompactStatus = "running" | "success" | "error";

interface CompactState {
	status: CompactStatus;
	summary: string;
}

interface Summary {
	text: string;
	styled?: boolean;
}

function shortenPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function textOutput(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.replace(/\n+$/, "");
}

function nonEmptyLines(value: string): number {
	return value ? value.split("\n").filter((line) => line.length > 0).length : 0;
}

function firstOutputLine(value: string, fallback: string): string {
	return value
		.split("\n")
		.map(collapseWhitespace)
		.find(Boolean) ?? fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMcpPayload(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function summarizeMcpPayload(value: unknown): string {
	const normalized = normalizeMcpPayload(value);
	if (typeof normalized === "string") return collapseWhitespace(normalized);
	if (!isRecord(normalized)) return summarizeCustomToolArguments(normalized);

	for (const key of ["operation", "query", "name", "path", "id", "type"]) {
		if (typeof normalized[key] === "string" && normalized[key]) {
			return collapseWhitespace(normalized[key]);
		}
	}
	return summarizeCustomToolArguments(normalized);
}

interface McpHeading {
	action?: string;
	actionValue?: string;
	server?: string;
	tool?: string;
	argumentPreview?: string;
}

interface ToolCallHeading {
	name: string;
	detail: string;
	expandedArgs: unknown;
	isMcpCall: boolean;
	mcp?: McpHeading;
}

function customToolHeading(toolName: string, args: unknown): ToolCallHeading {
	if (!isRecord(args)) {
		return {
			name: toolName,
			detail: summarizeCustomToolArguments(args),
			expandedArgs: args,
			isMcpCall: false,
		};
	}

	const values = args;
	const namespaceServer = toolName.startsWith("mcp__") ? toolName.slice("mcp__".length) : undefined;
	if (toolName === "mcp" || namespaceServer) {
		if (typeof values.tool === "string" && values.tool) {
			const server = typeof values.server === "string" && values.server
				? values.server
				: namespaceServer;
			const payload = normalizeMcpPayload(values.args);
			return {
				name: "mcp",
				detail: "",
				expandedArgs: payload,
				isMcpCall: true,
				mcp: {
					server,
					tool: values.tool,
					argumentPreview: values.args === undefined ? "" : summarizeMcpPayload(payload),
				},
			};
		}

		for (const action of ["connect", "describe", "instructions", "search"] as const) {
			if (typeof values[action] === "string" && values[action]) {
				const server = action === "search" && typeof values.server === "string"
					? ` · ${values.server}`
					: "";
				return {
					name: "mcp",
					detail: "",
					expandedArgs: args,
					isMcpCall: false,
					mcp: { action, actionValue: `${values[action]}${server}` },
				};
			}
		}
		if (typeof values.server === "string" && values.server) {
			return {
				name: "mcp",
				detail: "",
				expandedArgs: args,
				isMcpCall: false,
				mcp: { action: "list", actionValue: values.server },
			};
		}
		if (typeof values.action === "string" && values.action) {
			return {
				name: "mcp",
				detail: "",
				expandedArgs: args,
				isMcpCall: false,
				mcp: { action: values.action },
			};
		}
		return {
			name: "mcp",
			detail: "",
			expandedArgs: args,
			isMcpCall: false,
			mcp: { action: "status" },
		};
	}

	return {
		name: toolName,
		detail: summarizeCustomToolArguments(args),
		expandedArgs: args,
		isMcpCall: false,
	};
}

function capitalize(value: string): string {
	return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function renderCustomToolHeading(theme: Theme, heading: ToolCallHeading): string | undefined {
	if (!heading.mcp) return undefined;

	let text = theme.fg("toolTitle", theme.bold("mcp")) + theme.fg("dim", " · ");
	if (heading.mcp.action) {
		text += theme.fg("accent", capitalize(heading.mcp.action));
		if (heading.mcp.actionValue) {
			text += theme.fg("dim", " (") + theme.fg("text", heading.mcp.actionValue) + theme.fg("dim", ")");
		}
		return text;
	}

	if (heading.mcp.server) {
		text += theme.fg("text", heading.mcp.server) + theme.fg("dim", " / ");
	}
	text += theme.fg("text", heading.mcp.tool ?? "unknown");
	if (heading.mcp.argumentPreview) {
		text += theme.fg("dim", " (") + theme.fg("text", heading.mcp.argumentPreview) + theme.fg("dim", ")");
	}
	return text;
}

function summarizeMcpOutput(output: string, failed: boolean): Summary {
	if (failed) return { text: firstOutputLine(output, "Failed") };

	const trimmed = output.trim();
	if (!trimmed) return { text: "Completed" };
	try {
		const parsed = JSON.parse(trimmed);
		if (Array.isArray(parsed)) {
			return { text: `Returned ${parsed.length} ${parsed.length === 1 ? "item" : "items"}` };
		}
		if (isRecord(parsed)) return { text: "Returned JSON" };
	} catch {
		if (/^[{[]/.test(trimmed)) return { text: "Returned JSON" };
	}
	return { text: firstOutputLine(output, "Completed") };
}

function compactState(context: RenderContext): CompactState {
	const state = context.state as Partial<CompactState>;
	state.status ??= "running";
	state.summary ??= "";
	return state as CompactState;
}

function status(context: ToolStatus, output = ""): CompactStatus {
	if (context.isPartial) return "running";
	if (context.isError || /^(error|failed|access denied)\b/i.test(output.trim())) return "error";
	return "success";
}

function branch(theme: Theme, value: string, toolStatus: CompactStatus): string {
	const color = toolStatus === "success" ? "success" : toolStatus === "error" ? "error" : "dim";
	return theme.fg(color, value);
}

function toolHeading(theme: Theme, name: string, detail: string): string {
	return (
		theme.fg("toolTitle", theme.bold(name)) +
		theme.fg("dim", "(") +
		theme.fg("text", detail) +
		theme.fg("dim", ")")
	);
}

type DisplayValue = string | (() => string);

interface DisplayRow {
	prefix: DisplayValue;
	continuation?: DisplayValue;
	content: DisplayValue;
}

function displayValue(value: DisplayValue): string {
	return typeof value === "function" ? value() : value;
}

/** Render framed rows with the same margin, wrapping, and persistent guide as the reference config. */
function block(rows: DisplayRow[]): Component {
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;

	return {
		render(width: number): string[] {
			if (cachedWidth === width && cachedLines) return cachedLines;

			const horizontalPad = Math.min(2, Math.max(0, width - 1));
			const innerWidth = Math.max(1, width - horizontalPad * 2);
			const rendered: string[] = [];

			for (const row of rows) {
				const prefix = displayValue(row.prefix);
				const content = displayValue(row.content);
				const continuation = displayValue(row.continuation ?? " ".repeat(visibleWidth(prefix)));
				const prefixWidth = Math.max(visibleWidth(prefix), visibleWidth(continuation));
				const contentWidth = Math.max(1, innerWidth - prefixWidth);
				const wrapped = wrapTextWithAnsi(content || " ", contentWidth);

				rendered.push(
					truncateToWidth(" ".repeat(horizontalPad) + prefix + (wrapped[0] ?? ""), width, ""),
				);
				for (const line of wrapped.slice(1)) {
					rendered.push(
						truncateToWidth(" ".repeat(horizontalPad) + continuation + line, width, ""),
					);
				}
			}

			cachedWidth = width;
			cachedLines = rendered;
			return rendered;
		},
		invalidate(): void {
			cachedWidth = undefined;
			cachedLines = undefined;
		},
	};
}

/** Keep the normal view to exactly one terminal row, even when arguments or output are long. */
function collapsedLine(getText: () => string): Component {
	return {
		render(width: number): string[] {
			const horizontalPad = Math.min(2, Math.max(0, width - 1));
			return [
				" ".repeat(horizontalPad) +
					truncateToWidth(getText(), Math.max(1, width - horizontalPad), "…"),
			];
		},
		invalidate(): void {},
	};
}

interface CompactRenderingState {
	showFullToolCall: boolean;
	invalidators: Set<() => void>;
}

type CompactRenderingGlobal = typeof globalThis & {
	__piExtensionsCompactRendering?: CompactRenderingState;
};

function compactRenderingState(): CompactRenderingState {
	const sharedGlobal = globalThis as CompactRenderingGlobal;
	sharedGlobal.__piExtensionsCompactRendering ??= {
		showFullToolCall: false,
		invalidators: new Set(),
	};
	return sharedGlobal.__piExtensionsCompactRendering;
}

function compactCall(
	theme: Theme,
	name: string,
	detail: string,
	args: unknown,
	context: RenderContext,
	headingOverride?: string,
): Component {
	const renderingState = compactRenderingState();
	renderingState.invalidators.add(context.invalidate);
	const state = compactState(context);
	state.status = status(context);
	if (context.isPartial && !state.summary) {
		state.summary = theme.fg("toolOutput", "Running…");
	}
	const heading = headingOverride ?? toolHeading(theme, name, detail);

	if (!context.expanded && !renderingState.showFullToolCall) {
		return collapsedLine(() => {
			const output = state.summary
				? theme.fg("dim", " ── ") + state.summary
				: "";
			return branch(theme, "├─ ", state.status) + heading + output;
		});
	}

	const rows: DisplayRow[] = [
		{
			prefix: () => branch(theme, "┌─ ", state.status),
			continuation: theme.fg("dim", "│  "),
			content: heading,
		},
	];

	if (renderingState.showFullToolCall) {
		const argumentLines = JSON.stringify(args, null, 2)?.split("\n") ?? [];
		for (const line of argumentLines) {
			rows.push({
				prefix: theme.fg("dim", "│  "),
				continuation: theme.fg("dim", "│  "),
				content: theme.fg("toolOutput", line),
			});
		}
	}

	if (!context.expanded) {
		rows.push({
			prefix: theme.fg("dim", "└─ "),
			continuation: "   ",
			content: () => state.summary || theme.fg("toolOutput", "Ready"),
		});
	}

	return block(rows);
}

function compactResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
	pendingLabel: string,
	summarize: (output: string, failed: boolean) => Summary,
	outputOverride?: string,
	outputStyle: (line: string) => string = (line) => theme.fg("toolOutput", line),
): Component {
	const rawOutput = textOutput(result);
	const output = outputOverride?.replace(/\n+$/, "") ?? rawOutput;
	const failed = status({ isPartial: options.isPartial, isError: context.isError }, rawOutput) === "error";
	const state = compactState(context);
	state.status = options.isPartial ? "running" : failed ? "error" : "success";

	const summary = options.isPartial
		? { text: pendingLabel }
		: summarize(rawOutput, failed);
	state.summary = summary.styled
		? summary.text
		: theme.fg(failed ? "error" : "toolOutput", summary.text);

	if (!options.expanded) return new Container();

	const lines = output ? output.split("\n") : [];
	if (
		!summary.styled &&
		lines[0] &&
		collapseWhitespace(lines[0]) === collapseWhitespace(summary.text)
	) {
		lines.shift();
	}
	const rows: DisplayRow[] = [
		{
			prefix: theme.fg("dim", lines.length > 0 ? "│  " : "└─ "),
			continuation: theme.fg("dim", lines.length > 0 ? "│  " : "   "),
			content: () => state.summary,
		},
	];

	for (let index = 0; index < lines.length; index++) {
		const isLast = index === lines.length - 1;
		rows.push({
			prefix: theme.fg("dim", isLast ? "└─ " : "│  "),
			continuation: theme.fg("dim", isLast ? "   " : "│  "),
			content: outputStyle(lines[index] || " "),
		});
	}

	return block(rows);
}

function summarizeCustomToolArguments(args: unknown): string {
	if (!args || typeof args !== "object") return "";

	const values = args as Record<string, unknown>;
	for (const key of ["query", "path", "command", "action", "task", "id", "name", "kind"]) {
		if (typeof values[key] === "string" && values[key]) {
			return collapseWhitespace(values[key]);
		}
	}

	for (const key of ["search_queries", "urls"]) {
		const items = values[key];
		if (Array.isArray(items) && typeof items[0] === "string") {
			const suffix = items.length > 1 ? ` (+${items.length - 1})` : "";
			return `${collapseWhitespace(items[0])}${suffix}`;
		}
	}

	if (typeof values.objective === "string" && values.objective) {
		return collapseWhitespace(values.objective);
	}

	try {
		return collapseWhitespace(JSON.stringify(args));
	} catch {
		return "";
	}
}

function compactCustomTool(
	tool: ToolDefinition<any, any, any>,
): ToolDefinition<any, any, any> {
	return {
		...tool,
		renderShell: "self",
		renderCall(args, theme, context) {
			const heading = customToolHeading(tool.name, args);
			return compactCall(
				theme,
				heading.name,
				heading.detail,
				heading.expandedArgs,
				context as RenderContext,
				renderCustomToolHeading(theme, heading),
			);
		},
		renderResult(result, options, theme, context) {
			const heading = customToolHeading(tool.name, context.args);
			return compactResult(
				result,
				options,
				theme,
				context as RenderContext,
				"Working…",
				heading.isMcpCall
					? summarizeMcpOutput
					: (output, failed) => ({
						text: failed ? firstOutputLine(output, "Failed") : firstOutputLine(output, "Completed"),
					}),
			);
		},
	};
}

/**
 * Decorate every tool registered through this API with the compact renderer.
 * Use this when loading another extension so its execution stays untouched.
 */
export function withCompactToolRendering(pi: ExtensionAPI): ExtensionAPI {
	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (tool: ToolDefinition<any, any, any>) =>
					target.registerTool(compactCustomTool(tool));
			}
			return Reflect.get(target, property, receiver);
		},
	});
}

function toggleToolCall(ctx: ExtensionContext): void {
	const renderingState = compactRenderingState();
	renderingState.showFullToolCall = !renderingState.showFullToolCall;

	// Both extension entry points use this shared state even when Pi evaluates
	// compact-tools.ts as separate module instances.
	const invalidators = [...renderingState.invalidators];
	renderingState.invalidators.clear();
	for (const invalidate of invalidators) invalidate();
	ctx.ui.notify(
		`Tool calls: ${renderingState.showFullToolCall ? "full" : "compact"}`,
		"info",
	);
}

function createBuiltInTools(cwd: string) {
	return {
		bash: createBashToolDefinition(cwd),
		edit: createEditToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
		read: createReadToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
	};
}

type BuiltInTools = ReturnType<typeof createBuiltInTools>;
const toolCache = new Map<string, BuiltInTools>();

function getBuiltInTools(cwd: string): BuiltInTools {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		toolCache.set(cwd, tools);
	}
	return tools;
}

export default function compactTools(pi: ExtensionAPI): void {
	const initialTools = getBuiltInTools(process.cwd());
	const renderingState = compactRenderingState();
	renderingState.showFullToolCall = false;
	renderingState.invalidators.clear();

	pi.registerShortcut("alt+o", {
		description: "Expand or collapse compact tool calls",
		handler: async (ctx) => toggleToolCall(ctx),
	});
	pi.registerCommand("tool-call", {
		description: "Expand or collapse compact tool calls",
		handler: async (_args, ctx) => toggleToolCall(ctx),
	});

	pi.registerTool({
		...initialTools.read,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			const path = shortenPath(args.path || "...");
			const range = args.offset || args.limit
				? ` · lines ${args.offset ?? 1}${args.limit ? `–${(args.offset ?? 1) + args.limit - 1}` : "+"}`
				: "";
			return compactCall(theme, "Read", `${path}${range}`, args, context as RenderContext);
		},
		renderResult(result, options, theme, context) {
			const image = result.content.find((item) => item.type === "image");
			return compactResult(
				result,
				options,
				theme,
				context as RenderContext,
				"Reading…",
				(output, failed) => {
					if (failed) return { text: firstOutputLine(output, "Read failed") };
					if (image) return { text: "Read image" };
					const lines = nonEmptyLines(output);
					const truncated = (result.details as any)?.truncation?.truncated ? " · truncated" : "";
					return { text: `Read ${lines} ${lines === 1 ? "line" : "lines"}${truncated}` };
				},
			);
		},
	});

	pi.registerTool({
		...initialTools.bash,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			return compactCall(
				theme,
				"Bash",
				collapseWhitespace(args.command || "..."),
				args,
				context as RenderContext,
			);
		},
		renderResult(result, options, theme, context) {
			return compactResult(
				result,
				options,
				theme,
				context as RenderContext,
				"Running…",
				(output, failed) => ({
					text: failed ? firstOutputLine(output, "Command failed") : firstOutputLine(output, "Completed"),
				}),
			);
		},
	});

	pi.registerTool({
		...initialTools.edit,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			const path = shortenPath(args.path || "...");
			const count = args.edits?.length ?? 0;
			const suffix = count > 0 ? ` · ${count} ${count === 1 ? "change" : "changes"}` : "";
			return compactCall(theme, "Edit", `${path}${suffix}`, args, context as RenderContext);
		},
		renderResult(result, options, theme, context) {
			const output = textOutput(result);
			const diff = (result.details as any)?.diff ?? "";
			const additions = diff.split("\n").filter((line: string) => line.startsWith("+") && !line.startsWith("+++"))
				.length;
			const removals = diff.split("\n").filter((line: string) => line.startsWith("-") && !line.startsWith("---"))
				.length;
			const failed = status(
				{ isPartial: options.isPartial, isError: (context as RenderContext).isError },
				output,
			) === "error";
			return compactResult(
				result,
				options,
				theme,
				context as RenderContext,
				"Editing…",
				(_raw, failed) => failed
					? { text: firstOutputLine(output, "Edit failed") }
					: diff
						? {
							text:
								theme.fg("toolOutput", "Updated · ") +
								theme.fg("success", `+${additions}`) +
								theme.fg("toolOutput", " ") +
								theme.fg("error", `-${removals}`),
							styled: true,
						}
						: { text: "Updated" },
				diff || output,
				(line) => {
					if (!diff) return theme.fg(failed ? "error" : "toolOutput", line);
					if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("toolDiffAdded", line);
					if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("toolDiffRemoved", line);
					return theme.fg("toolDiffContext", line);
				},
			);
		},
	});

	pi.registerTool({
		...initialTools.write,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			const path = shortenPath(args.path || "...");
			const lines = args.content ? args.content.split("\n").length : 0;
			const suffix = lines > 0 ? ` · ${lines} ${lines === 1 ? "line" : "lines"}` : "";
			return compactCall(theme, "Write", `${path}${suffix}`, args, context as RenderContext);
		},
		renderResult(result, options, theme, context) {
			return compactResult(
				result,
				options,
				theme,
				context as RenderContext,
				"Writing…",
				(output, failed) => ({ text: failed ? firstOutputLine(output, "Write failed") : "Written" }),
			);
		},
	});

	pi.registerTool({
		...initialTools.find,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).find.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			const path = shortenPath(args.path || ".");
			return compactCall(
				theme,
				"Find",
				`${args.pattern || "..."}${args.path ? ` · ${path}` : ""}`,
				args,
				context as RenderContext,
			);
		},
		renderResult(result, options, theme, context) {
			return compactResult(
				result,
				options,
				theme,
				context as RenderContext,
				"Searching…",
				(output, failed) => ({
					text: failed ? firstOutputLine(output, "Find failed") : `Found ${nonEmptyLines(output)} paths`,
				}),
			);
		},
	});

	pi.registerTool({
		...initialTools.grep,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).grep.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			const path = shortenPath(args.path || ".");
			const where = args.path ? ` · ${path}` : "";
			const glob = args.glob ? ` · ${args.glob}` : "";
			return compactCall(
				theme,
				"Grep",
				`${collapseWhitespace(args.pattern || "...")}${where}${glob}`,
				args,
				context as RenderContext,
			);
		},
		renderResult(result, options, theme, context) {
			return compactResult(
				result,
				options,
				theme,
				context as RenderContext,
				"Searching…",
				(output, failed) => ({
					text: failed ? firstOutputLine(output, "Grep failed") : `Found ${nonEmptyLines(output)} matches`,
				}),
			);
		},
	});

	pi.registerTool({
		...initialTools.ls,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).ls.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			const path = shortenPath(args.path || ".");
			return compactCall(theme, "List", path, args, context as RenderContext);
		},
		renderResult(result, options, theme, context) {
			return compactResult(
				result,
				options,
				theme,
				context as RenderContext,
				"Listing…",
				(output, failed) => ({
					text: failed ? firstOutputLine(output, "List failed") : `Listed ${nonEmptyLines(output)} entries`,
				}),
			);
		},
	});
}
