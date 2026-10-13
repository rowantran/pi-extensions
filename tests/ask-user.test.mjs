import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Compile } from "typebox/compile";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import askUser from "../ask-user.ts";
import { compactRenderingState } from "../compact-tools.ts";

// These mocked host dialogs have a UI consumer even when the test runner was
// launched by a managed background agent. Test that marker separately below.
const inheritedBackgroundCliPath = process.env.PI_BACKGROUND_CLI_PATH;
before(() => { delete process.env.PI_BACKGROUND_CLI_PATH; });
after(() => {
	if (inheritedBackgroundCliPath === undefined) delete process.env.PI_BACKGROUND_CLI_PATH;
	else process.env.PI_BACKGROUND_CLI_PATH = inheritedBackgroundCliPath;
});

const tools = [];
askUser({ registerTool: (tool) => tools.push(tool) });
const tool = tools[0];
const schema = Compile(tool.parameters);
const params = { question: "Proceed?", options: ["Yes", "No"] };
const textOf = (result) => result.content.map((block) => block.text).join("\n");

function fixture({ mode = "tui", hasUI = true, answer, signal, dialog } = {}) {
	const calls = [];
	const ctx = {
		mode, hasUI, signal,
		ui: {
			async select(...args) {
				calls.push({ method: "select", args });
				return dialog ? dialog(args[2]) : answer;
			},
			async input(...args) {
				calls.push({ method: "input", args });
				return dialog ? dialog(args[2]) : answer;
			},
		},
	};
	return { calls, ctx, execute: (args = params, executionSignal) => tool.execute("ask-1", args, executionSignal, undefined, ctx) };
}

function assertCancelled(result, reason = "dismissed") {
	assert.equal(result.details.status, "cancelled");
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.reason, reason);
	assert.equal(Object.hasOwn(result.details, "answer"), false);
	assert.match(textOf(result), /no answer was provided/i);
	assert.match(textOf(result), /not approval/i);
	assert.match(textOf(result), /do not proceed/i);
}

test("registers one direct model-only tool with input and background guidance", () => {
	assert.equal(tools.length, 1);
	assert.equal(tool.name, "ask_user");
	assert.equal(tool.exposure, "model-only");
	assert.equal(tool.executionMode, "sequential", "Multiple dialogs must not replace one another");
	assert.match(tool.description, /block until they answer or cancel/);
	assert.match(tool.description, /not inside codemode/);
	assert.match(tool.promptGuidelines.join("\n"), /call ask_user instead of only asking a question in final text/);
	assert.match(tool.promptGuidelines.join("\n"), /while background jobs are running/);
	assert.match(tool.promptGuidelines.join("\n"), /never as approval/);
	assert.equal(tool.annotations.readOnlyHint, true);
});

test("schema rejects empty questions and meaningless option lists", () => {
	for (const input of [
		{}, { question: "" }, { question: " \t\n " }, { question: null }, { question: 1 },
		{ question: "?", options: [] }, { question: "?", options: ["Only one"] },
		{ question: "?", options: ["Yes", ""] }, { question: "?", options: ["Yes", " \n "] },
		{ question: "?", options: ["Yes", "Yes"] }, { question: "?", options: ["Yes", 1] },
		{ question: "?", options: "Yes" }, { question: "?", options: null },
	]) {
		assert.equal(schema.Check(input), false, JSON.stringify(input));
	}
	assert.equal(schema.Check({ question: "Your name?" }), true);
	assert.equal(schema.Check(params), true);
	assert.equal(schema.Check({ question: "  Choose?  ", options: [" Yes ", " No "] }), true);
});

test("execution also rejects invalid and whitespace-equivalent options before opening UI", async () => {
	const f = fixture();
	for (const input of [
		{ question: "" }, { question: " \n " }, { question: 1 },
		{ ...params, options: [] }, { ...params, options: ["Yes"] },
		{ ...params, options: ["Yes", " "] }, { ...params, options: ["Yes", null] },
		{ ...params, options: null }, { ...params, options: "Yes" },
		{ ...params, options: ["Yes", "Yes"] }, { ...params, options: ["Yes", " Yes "] },
		{ ...params, options: ["Do it", "Do  it"] },
	]) await assert.rejects(f.execute(input), /ask_user (requires|options)/);
	assert.deepEqual(f.calls, []);
});

for (const mode of ["tui", "rpc"]) {
	test(`${mode} selects from options and preserves the selected label`, async () => {
		const controller = new AbortController();
		const input = { question: "  Pick a branch?  ", options: [" main ", " feature/界 "] };
		const f = fixture({ mode, answer: input.options[1] });
		const result = await f.execute(input, controller.signal);
		assert.deepEqual(f.calls, [{ method: "select", args: [input.question, input.options, { signal: controller.signal }] }]);
		assert.deepEqual(result.details, {
			...input, inputType: "select", status: "answered", cancelled: false, answer: input.options[1],
		});
		assert.equal(textOf(result), `Selected: ${JSON.stringify(input.options[1])}`);
	});

	test(`${mode} uses text input when options are absent`, async () => {
		const input = { question: "  What should change?  " };
		const answer = '  Keep "quotes",\nnewlines, 界, and spaces.  ';
		const f = fixture({ mode, answer });
		const result = await f.execute(input);
		assert.deepEqual(f.calls, [{ method: "input", args: [input.question, undefined, { signal: undefined }] }]);
		assert.deepEqual(result.details, { ...input, inputType: "input", status: "answered", cancelled: false, answer });
		assert.equal(textOf(result), `User replied: ${JSON.stringify(answer)}`);
	});

	for (const input of [params, { question: "Your reply?" }]) {
		test(`${mode} ${input.options ? "selection" : "text input"} dismissal is not approval`, async () => {
			const result = await fixture({ mode }).execute(input);
			assertCancelled(result);
			assert.equal(result.details.question, input.question);
			assert.deepEqual(result.details.options, input.options);
			assert.equal(result.details.inputType, input.options ? "select" : "input");
		});
	}
}

test("empty and whitespace-only text are answers, not cancellation", async () => {
	for (const answer of ["", "  \t  "]) {
		const result = await fixture({ answer }).execute({ question: "Your reply?" });
		assert.equal(result.details.cancelled, false);
		assert.equal(result.details.answer, answer);
		assert.equal(textOf(result), `User replied: ${JSON.stringify(answer)}`);
	}
});

test("a negative selection is returned literally without claiming approval", async () => {
	const result = await fixture({ answer: "No" }).execute();
	assert.equal(result.details.answer, "No");
	assert.equal(textOf(result), 'Selected: "No"');
});

test("no UI and print/JSON modes fail instead of inventing a user response", async () => {
	for (const options of [
		{ hasUI: false }, { mode: "rpc", hasUI: false },
		{ mode: "print" }, { mode: "json" }, { mode: "print", hasUI: false },
	]) {
		const f = fixture({ ...options, answer: "Yes" });
		await assert.rejects(f.execute(), /requires a TUI or RPC client.*no user answer was obtained/);
		assert.deepEqual(f.calls, []);
	}
});

test("managed background RPC sessions fail without opening UI, while TUI still works", async (t) => {
	const previous = process.env.PI_BACKGROUND_CLI_PATH;
	process.env.PI_BACKGROUND_CLI_PATH = "/unused/test/pi-cli.js";
	t.after(() => {
		if (previous === undefined) delete process.env.PI_BACKGROUND_CLI_PATH;
		else process.env.PI_BACKGROUND_CLI_PATH = previous;
	});
	for (const input of [params, { question: "Your reply?" }]) {
		const f = fixture({ mode: "rpc", answer: "Yes" });
		await assert.rejects(f.execute(input), /Report the question in your final response so the parent can ask the user/);
		assert.deepEqual(f.calls, [], "A managed child must not wait on an unconsumed UI request");
	}
	const result = await fixture({ mode: "tui", answer: "No" }).execute();
	assert.equal(result.details.answer, "No", "The marker must not block TUI sessions");
	assert.equal(result.details.cancelled, false);
	assert.match(tool.promptGuidelines.join("\n"), /In managed background RPC sessions, do not call ask_user/);
	assert.match(tool.promptGuidelines.join("\n"), /Report the question in your final response so the parent can ask the user/);
});

test("invalid client responses never become answers", async () => {
	for (const answer of [null, true, "Allow", ""]) {
		await assert.rejects(fixture({ mode: "rpc", answer }).execute(), /invalid UI response/);
	}
	await assert.rejects(fixture({ answer: false }).execute({ question: "Reply?" }), /invalid UI response/);
});

for (const input of [params, { question: "Your reply?" }]) {
	test(`${input.options ? "selection" : "text input"} abort dismisses the dialog and returns no answer`, async () => {
		const controller = new AbortController();
		let started;
		const ready = new Promise((resolve) => { started = resolve; });
		const f = fixture({ dialog: ({ signal }) => new Promise((resolve) => {
			assert.strictEqual(signal, controller.signal);
			signal.addEventListener("abort", () => resolve(undefined), { once: true });
			started();
		}) });
		const pending = f.execute(input, controller.signal);
		await ready;
		controller.abort();
		assertCancelled(await pending, "aborted");
	});
}

test("pre-aborted calls do not open a dialog; the context signal is a fallback", async () => {
	const controller = new AbortController();
	controller.abort();
	for (const useContext of [false, true]) {
		const f = fixture({ answer: "Yes", ...(useContext ? { signal: controller.signal } : {}) });
		assertCancelled(await f.execute(params, useContext ? undefined : controller.signal), "aborted");
		assert.deepEqual(f.calls, []);
	}
});

test("a live context signal reaches the dialog when there is no execution signal", async () => {
	const controller = new AbortController();
	const f = fixture({ signal: controller.signal, answer: "No" });
	await f.execute();
	assert.strictEqual(f.calls[0].args[2].signal, controller.signal);
});

test("abort wins over a simultaneous client answer or rejection", async () => {
	for (const rejects of [false, true]) {
		const controller = new AbortController();
		const f = fixture({ dialog: () => {
			controller.abort();
			if (rejects) throw new DOMException("Aborted", "AbortError");
			return "Yes";
		} });
		assertCancelled(await f.execute(params, controller.signal), "aborted");
	}
});

test("ordinary UI failures remain failed tools, not cancellation or approval", async () => {
	const failure = new Error("RPC client disconnected");
	await assert.rejects(fixture({ dialog: () => { throw failure; } }).execute(), (error) => error === failure);
});

test("execution waits for the user while independent background work can finish", async () => {
	let answer;
	let settled = false;
	const f = fixture({ dialog: () => new Promise((resolve) => { answer = resolve; }) });
	const pending = f.execute().then((result) => { settled = true; return result; });
	let backgroundFinished = false;
	await new Promise((resolve) => setImmediate(() => { backgroundFinished = true; resolve(); }));
	assert.equal(backgroundFinished, true);
	assert.equal(settled, false, "No answer should be synthesized while the dialog is pending");
	answer("No");
	assert.equal((await pending).details.answer, "No");
});

const theme = { fg: (_color, text) => text, bold: (text) => text };
const renderContext = (expanded = false) => ({ args: params, expanded, isPartial: true, isError: false, state: {}, invalidate() {} });
const linesOf = (component, width = 100) => component.render(width).map(stripTerminalSequences);

function renderResult(context, result, expanded = false, activeTheme = theme) {
	context.isPartial = false;
	return tool.renderResult(result, { expanded, isPartial: false }, activeTheme, context);
}

test("compact rendering shows the question, waiting state, and then the exact answer", async () => {
	const context = renderContext();
	const call = tool.renderCall(params, theme, context);
	assert.deepEqual(linesOf(call), ["  ┌─ Ask user(Proceed?)", "  └─ Waiting for answer…"]);
	const result = await fixture({ answer: "No" }).execute();
	assert.deepEqual(linesOf(renderResult(context, result)), []);
	assert.deepEqual(linesOf(call), ["  ┌─ Ask user(Proceed?)", '  └─ Selected: "No"']);
});

test("cancellation renders a warning, not a successful approval", async () => {
	const colors = [];
	const activeTheme = { ...theme, fg(color, text) { colors.push([color, text]); return text; } };
	const context = renderContext();
	const call = tool.renderCall(params, activeTheme, context);
	const result = await fixture().execute();
	renderResult(context, result, false, activeTheme);
	const frame = linesOf(call, 200);
	assert.match(frame[1], /Cancelled: no answer was provided.*not approval/);
	assert.ok(colors.some(([color, text]) => color === "warning" && text.startsWith("Cancelled")));
	assert.equal(context.state.status, "error", "The cancelled question must not get a green success branch");
});

test("expanded rendering and full-call toggle expose detail without duplicating the outcome", async () => {
	const result = await fixture({ answer: "No" }).execute();
	const context = renderContext(true);
	const call = tool.renderCall(params, theme, context);
	const output = renderResult(context, result, true);
	assert.deepEqual([...linesOf(call), ...linesOf(output)], ["  ┌─ Ask user(Proceed?)", '  └─ Selected: "No"']);

	const shared = compactRenderingState();
	shared.showFullToolCall = true;
	try {
		const fullContext = renderContext();
		const fullCall = tool.renderCall(params, theme, fullContext);
		renderResult(fullContext, result);
		assert.match(linesOf(fullCall).join("\n"), /"options": \[/);
		assert.equal(linesOf(fullCall).filter((line) => line.includes("Selected:")).length, 1);
	} finally {
		shared.showFullToolCall = false;
	}
});

test("incomplete or invalid question arguments do not break call rendering", () => {
	for (const args of [{}, { question: null }, { question: 1 }]) {
		assert.deepEqual(linesOf(tool.renderCall(args, theme, renderContext())), [
			"  ┌─ Ask user(…)", "  └─ Waiting for answer…",
		]);
	}
});

test("partial results and failures render clearly; narrow widths stay bounded", () => {
	const context = renderContext();
	const args = { question: "Choose 👩🏽‍💻 界 e\u0301? ".repeat(20) };
	const call = tool.renderCall(args, theme, context);
	tool.renderResult({ content: [], details: undefined }, { expanded: false, isPartial: true }, theme, context);
	assert.match(linesOf(call).join("\n"), /Waiting for answer/);
	context.isError = true;
	renderResult(context, { content: [{ type: "text", text: "UI failed\ndisconnected" }], details: undefined });
	assert.deepEqual(linesOf(call).slice(1), ["  └─ UI failed", "     (+ 1 line)"]);
	for (const width of [0, 1, 5, 12, 24, 80]) {
		assert.ok(call.render(width).every((line) => visibleWidth(line) <= width), `width ${width}`);
		call.invalidate();
	}
});
