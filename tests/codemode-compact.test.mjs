import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const { compactCodemodeTool, parseNestedArgs, scriptTitle, CODEMODE_TITLE_GUIDELINE } = await import(
	"../codemode/render.ts"
);
const { compactRenderingState } = await import("../compact-tools.ts");
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

test("streaming without calls stays on one row", () => {
	const view = createView();
	assert.deepEqual(view.lines(), ["  ├─ Codemode(find the renderer) ── Running…"]);
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
		"  │  a.ts · 1 failed · 1.4s · truncated",
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
	assert.deepEqual(view.lines(), ["  ├─ Codemode(find the renderer) ── TypeError: boom · 1.4s"]);
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

test("untitled scripts show the bare label", () => {
	const view = createView({ args: { code: "return 1;" } });
	view.result({ content: [header("completed")], details: { calls: [] } });
	assert.deepEqual(view.lines(), ["  ├─ Codemode ── Completed · 1.4s"]);
});
