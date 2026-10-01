import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";

const { default: compactTools, compactRenderingState } = await import("../compact-tools.ts");
initTheme("dark");

const theme = { fg: (_color, text) => text, bold: (text) => text };
const strip = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");

const tools = new Map();
compactTools({
	registerShortcut() {},
	registerCommand() {},
	registerTool(tool) {
		tools.set(tool.name, tool);
	},
});

/** Render one tool call the way Pi does: the call, then the result, sharing renderer state. */
function render(name, args, text, { expanded = false, isError = false } = {}) {
	const tool = tools.get(name);
	const context = { args, expanded, isPartial: false, isError, state: {}, invalidate() {} };
	const call = tool.renderCall(args, theme, context);
	const result = tool.renderResult(
		{ content: [{ type: "text", text }], details: {} },
		{ expanded, isPartial: false },
		theme,
		context,
	);
	return [...call.render(100), ...result.render(100)].map(strip);
}

test("multi-line bash output shows a count under the row", () => {
	assert.deepEqual(render("bash", { command: "ls" }, "a.txt\nb.txt\nc.txt"), [
		"  ┌─ Bash(ls)",
		"  └─ a.txt",
		"     (+ 2 lines)",
	]);
});

test("one-line bash output has no count", () => {
	assert.deepEqual(render("bash", { command: "echo hi" }, "\nhi\n"), ["  ┌─ Bash(echo hi)", "  └─ hi"]);
});

test("collapsed rows stay one terminal row each", () => {
	const lines = render("bash", { command: "x".repeat(200) }, "y".repeat(200)).map((line) => line.length);
	assert.equal(lines.length, 2);
	assert.ok(lines.every((width) => width <= 100));
});

test("failures count the lines after the first error line", () => {
	assert.deepEqual(render("bash", { command: "false" }, "boom\nat x\nexit 1", { isError: true }), [
		"  ┌─ Bash(false)",
		"  └─ boom",
		"     (+ 2 lines)",
	]);
	assert.deepEqual(render("read", { path: "/missing" }, "ENOENT\ndetails", { isError: true }), [
		"  ┌─ Read(/missing)",
		"  └─ ENOENT",
		"     (+ 1 line)",
	]);
});

test("count summaries do not repeat as a line count", () => {
	assert.deepEqual(render("read", { path: "/a" }, "x\ny\nz"), ["  ┌─ Read(/a)", "  └─ Read 3 lines"]);
	assert.deepEqual(render("grep", { pattern: "x" }, "a:1\nb:2"), ["  ┌─ Grep(x)", "  └─ Found 2 matches"]);
});

test("expanded output skips the summary line and drops the count", () => {
	assert.deepEqual(render("bash", { command: "ls" }, "\na.txt\nb.txt", { expanded: true }), [
		"  ┌─ Bash(ls)",
		"  │  a.txt",
		"  └─ b.txt",
	]);
});

test("alt+o view keeps the count under the outcome", () => {
	const state = compactRenderingState();
	state.showFullToolCall = true;
	try {
		assert.deepEqual(render("bash", { command: "ls" }, "a.txt\nb.txt"), [
			"  ┌─ Bash(ls)",
			"  │  {",
			'  │    "command": "ls"',
			"  │  }",
			"  └─ a.txt",
			"     (+ 1 line)",
		]);
	} finally {
		state.showFullToolCall = false;
	}
});
