import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import background from "../background.ts";
import { renderBackgroundMessage } from "../background/render.ts";

const theme = { fg: (_color, text) => text };
const options = { expanded: false, outputPad: 0 };
const message = (content, kind = "shell") => ({
	role: "custom", customType: "background", content, display: true, timestamp: 0,
	details: { id: `${kind}-1`, kind, event: "completion", state: "completed" },
});
const render = (content, kind, renderOptions = options) =>
	renderBackgroundMessage(message(content, kind), renderOptions, theme).render(200)
		.map(line => stripTerminalSequences(line).trimEnd());

for (const kind of ["shell", "agent"]) {
	const heading = `Background ${kind} ${kind}-1 (example) completed after 1s.`;
	const label = kind === "shell" ? "Last output:" : "Result:";

	test(`short ${kind} content shows all lines without a hidden-line count`, () => {
		assert.deepEqual(render(`${heading}\n${label}\nDone.`, kind), [
			`  ● ${heading}`, `    ${label}`, "    Done.",
		]);
	});

	test(`long ${kind} content shows the heading plus five lines and a count`, () => {
		const body = [label, "one", "two", "three", "four", "five", "six", "seven"];
		assert.deepEqual(render([heading, ...body].join("\n"), kind), [
			`  ● ${heading}`, `    ${label}`, "    one", "    two", "    three", "    four", "    (+ 3 lines)",
		]);
	});
}

test("exactly five output lines have no count; a sixth uses the singular count", () => {
	assert.deepEqual(render("Heading\n1\n2\n3\n4\n5"), [
		"  ● Heading", "    1", "    2", "    3", "    4", "    5",
	]);
	assert.deepEqual(render("Heading\n1\n2\n3\n4\n5\n6"), [
		"  ● Heading", "    1", "    2", "    3", "    4", "    5", "    (+ 1 line)",
	]);
});

test("empty content, blank output, and non-string content keep the previous display", () => {
	assert.deepEqual(render("Heading"), ["  ● Heading"]);
	assert.deepEqual(render(""), ["  ●"]);
	assert.deepEqual(render([{ type: "text", text: "Structured content" }]), ["  ●"]);
	assert.deepEqual(render("Heading\n\nDone\n"), ["  ● Heading", "", "    Done", ""]);
	assert.deepEqual(render("Heading\n1\n2\n3\n4\n5\n"), [
		"  ● Heading", "    1", "    2", "    3", "    4", "    5", "    (+ 1 line)",
	]);
});

test("expansion, output padding, and message details do not change compact notices", () => {
	const content = "Heading\n1\n2\n3\n4\n5\n6";
	assert.deepEqual(render(content, "shell"), render(content, "agent", { expanded: true, outputPad: 3 }));
});

test("semantic colors remain accent for the bullet, muted for the heading, and dim for output", () => {
	const calls = [];
	const activeTheme = { fg(color, text) { calls.push([color, text]); return text; } };
	const component = renderBackgroundMessage(message("Heading\n\n2\n3\n4\n5\n6"), options, activeTheme);
	assert.ok(component instanceof Text);
	assert.deepEqual(calls, [
		["accent", "● "], ["muted", "Heading"], ["dim", " "], ["dim", "2"],
		["dim", "3"], ["dim", "4"], ["dim", "5"], ["dim", "(+ 1 line)"],
	]);
});

// The pre-extraction renderer is kept here to compare layout, ANSI handling, and padding.
function legacyRenderer(message, _options, theme) {
	const content = typeof message.content === "string" ? message.content : "";
	const [first = "", ...output] = content.split("\n");
	const visibleOutput = output.slice(0, 5);
	const hiddenLines = output.length - visibleOutput.length;
	const lines = [
		`  ${theme.fg("accent", "● ")}${theme.fg("muted", first)}`,
		...visibleOutput.map((line) => `    ${theme.fg("dim", line || " ")}`),
	];
	if (hiddenLines > 0) {
		lines.push(`    ${theme.fg("dim", `(+ ${hiddenLines} ${hiddenLines === 1 ? "line" : "lines"})`)}`);
	}
	return new Text(lines.join("\n"), 0, 0);
}

test("extracted renderer matches legacy frames at narrow widths and after invalidation", () => {
	const colors = { accent: 36, muted: 37, dim: 90 };
	const activeTheme = { fg: (color, text) => `\x1b[${colors[color]}m${text}\x1b[0m` };
	for (const content of [
		"", "Short notice", "Heading\n\nDone\n",
		"Background shell 界 👩🏽‍💻 e\u0301 completed.\nLast output:\n\x1b[31mred\x1b[0m\n2\n3\n4\n5\n6",
		"Background agent agent-1 completed.\nResult:\n" + "wide 界 output ".repeat(20) + "\n2\n3\n4\n5\n6\n7",
	]) {
		const notice = message(content);
		const expected = legacyRenderer(notice, options, activeTheme);
		const actual = renderBackgroundMessage(notice, options, activeTheme);
		for (const width of [1, 5, 12, 40, 100]) {
			assert.deepEqual(actual.render(width), expected.render(width));
			actual.invalidate();
			assert.deepEqual(actual.render(width), expected.render(width));
		}
	}
});

test("background extension registers the exported renderer directly", () => {
	const renderers = new Map();
	background({
		registerTool() {}, registerCommand() {}, on() {},
		registerMessageRenderer(type, renderer) { renderers.set(type, renderer); },
	});
	assert.strictEqual(renderers.get("background"), renderBackgroundMessage);
});

test("standalone display import does not load worker, session, or credential modules", () => {
	const rendererUrl = new URL("../background/render.ts", import.meta.url).href;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import assert from "node:assert/strict";
		import { registerHooks } from "node:module";
		const rendererUrl = ${JSON.stringify(rendererUrl)};
		const runtimeImports = [];
		registerHooks({ resolve(specifier, context, nextResolve) {
			if (context.parentURL === rendererUrl) {
				runtimeImports.push(specifier);
				assert.equal(specifier, "@earendil-works/pi-tui", "Unexpected display dependency");
			}
			return nextResolve(specifier, context);
		} });
		const { renderBackgroundMessage } = await import(rendererUrl);
		assert.equal(typeof renderBackgroundMessage, "function");
		assert.deepEqual(runtimeImports, ["@earendil-works/pi-tui"]);
	`], { encoding: "utf8", timeout: 10_000 });
	assert.equal(result.status, 0, result.stderr || result.error?.message);
});
