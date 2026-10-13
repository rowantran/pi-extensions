import { Type, type Static } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import {
	branch,
	collapseWhitespace,
	compactRenderingState,
	firstLineSummary,
	hiddenLinesRow,
	lazyRows,
	textOutput,
	toolHeading,
	type CompactStatus,
	type DisplayRow,
} from "./compact-tools.ts";

const parameters = Type.Object({
	question: Type.String({
		minLength: 1,
		pattern: "\\S",
		description: "The question to show the user. Must contain non-whitespace text.",
	}),
	options: Type.Optional(Type.Array(Type.String({ minLength: 1, pattern: "\\S" }), {
		minItems: 2,
		uniqueItems: true,
		description: "At least two distinct, nonblank choices. Omit for free-form text input.",
	})),
});

type AskUserParams = Static<typeof parameters>;
type AskUserDetails = {
	question: string;
	inputType: "select" | "input";
	options?: string[];
} & (
	| { status: "answered"; cancelled: false; answer: string }
	| { status: "cancelled"; cancelled: true; reason: "dismissed" | "aborted" }
);

interface RenderState {
	status?: CompactStatus;
	summary?: string;
	hiddenLines?: number;
}

type RenderContext = Parameters<NonNullable<
	ToolDefinition<typeof parameters, AskUserDetails, RenderState>["renderCall"]
>>[2];

function validateParams(params: AskUserParams): void {
	if (typeof params.question !== "string" || !params.question.trim()) {
		throw new Error("ask_user requires a nonblank question.");
	}
	if (params.options === undefined) return;
	if (!Array.isArray(params.options) || params.options.length < 2 ||
		params.options.some((option) => typeof option !== "string" || !option.trim())) {
		throw new Error("ask_user options must contain at least two nonblank strings; omit options for text input.");
	}
	if (new Set(params.options.map(collapseWhitespace)).size !== params.options.length) {
		throw new Error("ask_user options must be distinct, ignoring surrounding and repeated whitespace.");
	}
}

function cancelled(params: AskUserParams, reason: "dismissed" | "aborted") {
	return {
		content: [{
			type: "text" as const,
			text: `Cancelled${reason === "aborted" ? " (aborted)" : ""}: no answer was provided. ` +
				"This is not approval; do not proceed with actions that require the user's answer.",
		}],
		details: {
			...params,
			inputType: params.options === undefined ? "input" as const : "select" as const,
			status: "cancelled" as const,
			cancelled: true as const,
			reason,
		},
	};
}

function renderCall(args: AskUserParams, theme: Theme, context: RenderContext) {
	const shared = compactRenderingState();
	shared.invalidators.add(context.invalidate);
	const state = context.state;
	state.status ??= "running";
	state.summary ??= "Waiting for answer…";
	state.hiddenLines ??= 0;
	const collapsed = !context.expanded && !shared.showFullToolCall;
	const rows: DisplayRow[] = [{
		prefix: () => branch(theme, "┌─ ", state.status!),
		continuation: theme.fg("dim", "│  "),
		content: toolHeading(theme, "Ask user", typeof args.question === "string" ? collapseWhitespace(args.question) : "…"),
		truncate: collapsed,
	}];
	if (shared.showFullToolCall) {
		for (const line of JSON.stringify(args, null, 2).split("\n")) {
			rows.push({ prefix: theme.fg("dim", "│  "), content: theme.fg("toolOutput", line) });
		}
	}
	return lazyRows(() => context.expanded ? rows : [
		...rows,
		{
			prefix: theme.fg("dim", "└─ "),
			continuation: "   ",
			content: () => state.summary!,
			truncate: true,
		},
		...(state.hiddenLines! > 0 ? [hiddenLinesRow(theme, state.hiddenLines!)] : []),
	]);
}

export default function askUser(pi: ExtensionAPI): void {
	const tool: ToolDefinition<typeof parameters, AskUserDetails, RenderState> = {
		name: "ask_user",
		label: "Ask user",
		description: "Ask the user a question and block until they answer or cancel. " +
			"Provide options for a selection dialog, or omit them for text input. " +
			"Requires a TUI or RPC client with UI support; unavailable in print/JSON mode or managed background RPC sessions. " +
			"Cancellation provides no answer and is never approval. Call directly, not inside codemode.",
		promptSnippet: "Ask the user for a decision, clarification, or text input and wait for their response",
		promptGuidelines: [
			"When user input is required and a UI consumer is available, call ask_user instead of only asking a question in final text. " +
				"This also applies while background jobs are running; they can continue while you wait for the answer.",
			"In managed background RPC sessions, do not call ask_user. Report the question in your final response so the parent can ask the user.",
			"Treat ask_user cancellation as no answer, never as approval or permission to proceed.",
		],
		parameters,
		exposure: "model-only",
		executionMode: "sequential",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		renderShell: "self",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			validateParams(params);
			if (!ctx.hasUI || ctx.mode === "print" || ctx.mode === "json") {
				throw new Error("ask_user requires a TUI or RPC client with UI support; no user answer was obtained.");
			}
			// background/runner.mjs inherits this marker when it imports Pi's CLI.
			// Its parent consumes activity events but cannot answer extension UI requests.
			if (ctx.mode === "rpc" && process.env.PI_BACKGROUND_CLI_PATH) {
				throw new Error("ask_user is unavailable in managed background RPC sessions because there is no UI consumer. " +
					"Report the question in your final response so the parent can ask the user. No user answer was obtained.");
			}
			const dialogSignal = signal ?? ctx.signal;
			if (dialogSignal?.aborted) return cancelled(params, "aborted");

			let answer: string | undefined;
			try {
				answer = params.options === undefined
					? await ctx.ui.input(params.question, undefined, { signal: dialogSignal })
					: await ctx.ui.select(params.question, params.options, { signal: dialogSignal });
			} catch (error) {
				if (dialogSignal?.aborted) return cancelled(params, "aborted");
				throw error;
			}
			// An abort wins even if a client supplied a value at the same time.
			if (dialogSignal?.aborted) return cancelled(params, "aborted");
			if (answer === undefined) return cancelled(params, "dismissed");
			if (typeof answer !== "string" || (params.options !== undefined && !params.options.includes(answer))) {
				throw new Error("ask_user received an invalid UI response; no valid user answer was obtained.");
			}
			return {
				content: [{ type: "text", text: `${params.options === undefined ? "User replied" : "Selected"}: ${JSON.stringify(answer)}` }],
				details: {
					...params,
					inputType: params.options === undefined ? "input" : "select",
					status: "answered",
					cancelled: false,
					answer,
				},
			};
		},
		renderCall,
		renderResult(result, options, theme, context) {
			const state = context.state;
			const isCancelled = result.details?.status === "cancelled";
			state.status = options.isPartial ? "running" : context.isError || isCancelled ? "error" : "success";
			const summary = options.isPartial
				? { text: "Waiting for answer…", hiddenLines: 0 }
				: firstLineSummary(textOutput(result), context.isError ? "Failed to ask user" : "No answer");
			state.summary = theme.fg(context.isError ? "error" : isCancelled ? "warning" : "toolOutput", summary.text);
			state.hiddenLines = summary.hiddenLines ?? 0;
			if (!options.expanded) return new Container();
			const lines = options.isPartial ? ["Waiting for answer…"] : textOutput(result).split("\n");
			return lazyRows(() => lines.map((line, index) => ({
				prefix: theme.fg("dim", index === lines.length - 1 ? "└─ " : "│  "),
				continuation: theme.fg("dim", index === lines.length - 1 ? "   " : "│  "),
				content: theme.fg(context.isError ? "error" : isCancelled ? "warning" : "toolOutput", line),
			})));
		},
	};
	pi.registerTool(tool);
}
