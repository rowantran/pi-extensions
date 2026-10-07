import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const { compactCodemodeTool, parseNestedArgs, scriptTitle, CODEMODE_TITLE_GUIDELINE } = await import(
	"../codemode/render.ts"
);
const { callHeading, compactRenderingState, renderRows } = await import("../compact-tools.ts");
initTheme("dark");

const theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};
const strip = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");

const code = [
	'// @options: {"timeout_ms": 1000}',
	"// find the renderer",
	"const files = await tools.bash({ command: 'ls ~/workplace' });",
	"return files;",
].join("\n");

const header = (status) => ({ type: "text", text: `Script ${status}\nWall time 1.4 seconds\nOutput:\n` });
const calls = [
	{ id: "1", name: "bash", args: JSON.stringify({ command: "ls ~/workplace" }), status: "ok", durationMs: 40 },
	{
		id: "2",
		name: "read",
		args: JSON.stringify({ path: `${homedir()}/x.ts`, offset: 10, limit: 5 }),
		status: "ok",
		durationMs: 3,
	},
	{
		id: "3",
		name: "grep",
		args: JSON.stringify({ pattern: "codemode", path: "/missing" }),
		status: "error",
		durationMs: 2,
		error: "No such directory\nsecond line",
	},
];

function createView({ expanded = false, args = { code } } = {}) {
	const tool = compactCodemodeTool({ name: "codemode", parameters: {}, promptGuidelines: ["base"] });
	const context = { expanded, isPartial: true, isError: false, state: {}, invalidate() {} };
	let call = tool.renderCall(args, theme, context);
	return {
		tool,
		result(result, { isPartial = false, isError = false } = {}) {
			context.isPartial = isPartial;
			context.isError = isError;
			call = tool.renderCall(args, theme, context);
			tool.renderResult(result, { expanded, isPartial }, theme, context);
		},
		lines: (width = 100) => call.render(width).map(strip),
	};
}

test("keeps the base guidelines and asks for a title comment", () => {
	const { tool } = createView();
	assert.deepEqual(tool.promptGuidelines, ["base", CODEMODE_TITLE_GUIDELINE]);
	assert.equal(tool.renderShell, "self");
});

test("titles come from the first comment after the options line", () => {
	assert.equal(scriptTitle(code), "find the renderer");
	assert.equal(scriptTitle("const x = 1;\n// late comment"), "");
	assert.equal(scriptTitle(""), "");
});

test("cut-off argument previews keep their readable fields", () => {
	assert.deepEqual(parseNestedArgs('{"path":"/a/b.ts","offset":10,"content":"abc...'), {
		path: "/a/b.ts",
		offset: 10,
		content: "abc...",
	});
	assert.deepEqual(parseNestedArgs(""), {});
});

test("streaming without calls shows the heading and outcome rows", () => {
	const view = createView();
	assert.deepEqual(view.lines(), ["  ┌─ Codemode(find the renderer)", "  └─ Running…"]);
});

test("collapsed view lists nested calls like direct tool calls", () => {
	const view = createView();
	view.result({ content: [header("completed"), { type: "text", text: "a.ts\nb.ts" }], details: { calls } });
	assert.deepEqual(view.lines(), [
		"  ┌─ Codemode(find the renderer)",
		"  │  ├─ Bash(ls ~/workplace) ── 40ms",
		"  │  ├─ Read(~/x.ts · lines 10–14) ── 3ms",
		"  │  └─ Grep(codemode · /missing) ── No such directory",
		"  └─ a.ts · 1 failed · 1.4s",
		"     (+ 1 line)",
	]);
});

test("running view shows progress of nested calls", () => {
	const view = createView();
	view.result(
		{ content: [], details: { calls: [{ ...calls[0], status: "running", durationMs: undefined }] } },
		{ isPartial: true },
	);
	assert.deepEqual(view.lines(), [
		"  ┌─ Codemode(find the renderer)",
		"  │  └─ Bash(ls ~/workplace) ── Running…",
		"  └─ Running…",
	]);
});

test("collapsed rows stay one terminal row each", () => {
	const view = createView();
	const long = { ...calls[0], args: JSON.stringify({ command: "x".repeat(300) }) };
	view.result({ content: [header("completed")], details: { calls: [long] } });
	const lines = view.lines(40);
	assert.equal(lines.length, 3);
	assert.ok(lines.every((line) => visibleWidth(line) <= 40));
	assert.equal(lines[2], "  └─ Completed · 1.4s");
});

test("collapsed view caps the nested calls it shows", () => {
	const view = createView();
	const many = Array.from({ length: 10 }, (_, index) => ({
		...calls[0],
		id: String(index),
		args: JSON.stringify({ command: `echo ${index}` }),
	}));
	view.result({ content: [header("completed")], details: { calls: many } });
	const lines = view.lines();
	assert.equal(lines[1], "  │  ⋯ 2 earlier calls");
	assert.equal(lines[2], "  │  ├─ Bash(echo 2) ── 40ms");
	assert.equal(lines.length, 1 + 1 + 8 + 1);
});

test("expanded view adds error details and the output", () => {
	const view = createView({ expanded: true });
	view.result({
		content: [header("completed"), { type: "text", text: "a.ts\nb.ts" }],
		details: { calls, fullOutputPath: "/tmp/out.txt" },
	});
	assert.deepEqual(view.lines(), [
		"  ┌─ Codemode(find the renderer)",
		"  │  ├─ Bash(ls ~/workplace) ── 40ms",
		"  │  ├─ Read(~/x.ts · lines 10–14) ── 3ms",
		"  │  └─ Grep(codemode · /missing) ── No such directory",
		"  │     second line",
		"  │  a.ts · 1 failed · 1.4s · output capped",
		"  │  b.ts",
		"  └─ Full output: /tmp/out.txt",
	]);
});

test("failed scripts summarize the script error", () => {
	const view = createView();
	view.result(
		{
			content: [header("failed"), { type: "text", text: "partial\nScript error:\nTypeError: boom\n    at x" }],
			details: { calls: [] },
		},
		{ isError: true },
	);
	assert.deepEqual(view.lines(), [
		"  ┌─ Codemode(find the renderer)",
		"  └─ TypeError: boom · 1.4s",
		"     (+ 3 lines)",
	]);
});

test("alt+o shows the original script", () => {
	const state = compactRenderingState();
	state.showFullToolCall = true;
	try {
		const view = createView({ args: { code: "// title\nreturn 1;" } });
		view.result({ content: [header("completed"), { type: "text", text: "1" }], details: { calls: [] } });
		assert.deepEqual(view.lines(), [
			"  ┌─ Codemode(title)",
			"  │  // title",
			"  │  return 1;",
			"  └─ 1 · 1.4s",
		]);
	} finally {
		state.showFullToolCall = false;
	}
});

test("wrapped script lines keep the guide", () => {
	const state = compactRenderingState();
	state.showFullToolCall = true;
	try {
		const view = createView({ args: { code: `// t\nreturn ${"1 + ".repeat(20)}1;` } });
		view.result({ content: [header("completed")], details: { calls: [] } });
		const lines = view.lines(40);
		assert.ok(lines.length > 4);
		assert.ok(lines.slice(1, -1).every((line) => line.startsWith("  │  ")));
	} finally {
		state.showFullToolCall = false;
	}
});

test("one-line output has no hidden-line count", () => {
	const view = createView();
	view.result({ content: [header("completed"), { type: "text", text: "\nonly line" }], details: { calls: [] } });
	assert.deepEqual(view.lines(), ["  ┌─ Codemode(find the renderer)", "  └─ only line · 1.4s"]);
});

test("scripts without nested calls put the count under the outcome", () => {
	const view = createView();
	view.result({ content: [header("completed"), { type: "text", text: "alpha\nbeta\ngamma" }], details: { calls: [] } });
	assert.deepEqual(view.lines(), [
		"  ┌─ Codemode(find the renderer)",
		"  └─ alpha · 1.4s",
		"     (+ 2 lines)",
	]);
});

test("hidden-line count sits under the displayed line", () => {
	const view = createView();
	view.result({
		content: [header("completed"), { type: "text", text: "first\nsecond\nthird" }],
		details: { calls: [calls[0]] },
	});
	assert.deepEqual(view.lines(), [
		"  ┌─ Codemode(find the renderer)",
		"  │  └─ Bash(ls ~/workplace) ── 40ms",
		"  └─ first · 1.4s",
		"     (+ 2 lines)",
	]);
});

test("expanded view drops the hidden-line count", () => {
	const view = createView({ expanded: true });
	view.result({ content: [header("completed"), { type: "text", text: "first\nsecond" }], details: { calls: [] } });
	assert.deepEqual(view.lines(), [
		"  ┌─ Codemode(find the renderer)",
		"  │  first · 1.4s",
		"  └─ second",
	]);
});

test("untitled scripts show the bare label", () => {
	const view = createView({ args: { code: "return 1;" } });
	view.result({ content: [header("completed")], details: { calls: [] } });
	assert.deepEqual(view.lines(), ["  ┌─ Codemode", "  └─ Completed · 1.4s"]);
});

test("one codemode component caches layout but keeps nested statuses, durations, results, and expansion live", () => {
	for (const width of [0, 1, 5, 12, 24, 80]) {
		const tool = compactCodemodeTool({ name: "codemode", parameters: {} });
		const context = { expanded: false, isPartial: true, isError: false, state: {}, invalidate() {} };
		const args = { code: "// live 👩🏽‍💻 界 e\u0301\nreturn 1;" };
		const call = tool.renderCall(args, theme, context);
		let nested = undefined, outcome = "Running…", hidden = 0, output = [];
		const frame = () => {
			const rows = [{ prefix: "┌─ ", continuation: "│  ", content: "Codemode(live 👩🏽‍💻 界 e\u0301)", truncate: !context.expanded }];
			if (nested) {
				rows.push({
					prefix: "│  └─ ", continuation: "│     ",
					content: `${callHeading(theme, "bash", { command: "echo 界" })} ── ${nested}`,
					truncate: !context.expanded,
				});
				if (context.expanded && nested === "boom") rows.push({ prefix: "│     ", continuation: "│     ", content: "second error line" });
			}
			if (context.expanded) {
				rows.push({ prefix: output.length ? "│  " : "└─ ", continuation: output.length ? "│  " : "   ", content: outcome });
				output.forEach((content, index) => {
					const last = index === output.length - 1;
					rows.push({ prefix: last ? "└─ " : "│  ", continuation: last ? "   " : "│  ", content });
				});
			} else {
				rows.push({ prefix: "└─ ", continuation: "   ", content: outcome, truncate: true });
				if (hidden) rows.push({ prefix: "   ", content: `(+ ${hidden} line)`, truncate: true });
			}
			const lines = call.render(width);
			assert.deepEqual(lines, renderRows(rows, width));
			assert.strictEqual(call.render(width), lines, "codemode uses the shared layout cache");
			return lines;
		};
		const result = (callStatus, extra = {}, isPartial = true) => {
			context.isPartial = isPartial;
			tool.renderResult({
				content: isPartial ? [] : [header("completed"), { type: "text", text: "first output\nsecond output" }],
				details: { calls: [{ id: "1", name: "bash", args: JSON.stringify({ command: "echo 界" }), status: callStatus, ...extra }] },
			}, { expanded: context.expanded, isPartial }, theme, context);
		};
		frame();
		nested = "Running…"; result("running"); frame();
		nested = "40ms"; result("ok", { durationMs: 40 }); frame();
		nested = "1.2s · $0.02"; result("ok", { durationMs: 1200, cost: 0.02 }); frame();
		nested = "boom"; result("error", { error: "boom\nsecond error line" }); frame();
		outcome = "first output · 1 failed · 1.4s"; hidden = 1;
		result("error", { error: "boom\nsecond error line" }, false); frame();
		// A settled call still follows later state/result changes without replacing its component.
		nested = "2.0s"; outcome = "first output · 1.4s";
		result("ok", { durationMs: 2000 }, false); frame();
		context.state.summary = outcome = "Live timer: 3s";
		const before = frame();
		context.state.summary = outcome = "Live timer: 4s";
		assert.notStrictEqual(frame(), before);
		context.expanded = true; output = ["second output"];
		const collapsed = before;
		call.invalidate();
		assert.notStrictEqual(frame(), collapsed);
		const expanded = frame();
		call.invalidate();
		assert.notStrictEqual(frame(), expanded, "invalidation discards even unchanged expanded layout");
	}
});
