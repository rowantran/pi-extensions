import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import background from "../background.ts";
import { BACKGROUND_WIDGET_ID, backgroundWidgetLines, renderBackgroundWidgetLines } from "../background/widget.ts";
import { readSavedAgent } from "../background/sessions.ts";
import { fixture, harness } from "./background-helpers.mjs";

const theme = { fg: (_color, text) => text };
const colors = { accent: 36, dim: 90, muted: 37 };
const coloredTheme = { fg: (color, text) => `\x1b[${colors[color]}m${text}\x1b[0m` };
const task = (kind, name, startedAt = 0) => Object.freeze({ kind, name, startedAt });

test("plain widget payload is empty or shows five tasks, durations, and overflow", () => {
	assert.equal(BACKGROUND_WIDGET_ID, "background-running");
	assert.deepEqual(backgroundWidgetLines([], 0), []);
	const active = Object.freeze([
		task("agent", "Review"), task("shell", "Tests", 74_000),
		task("agent", "Research", 134_000), task("shell", "Build", 135_000),
		task("shell", "Watch"), task("agent", "Hidden one"), task("shell", "Hidden two"),
	]);
	assert.deepEqual(backgroundWidgetLines(active, 134_000), [
		"Background: 7 running", "  (2m14s) Agent: Review", "  (1m) Task: Tests",
		"  (0s) Agent: Research", "  (0s) Task: Build", "  (2m14s) Task: Watch", "  (+ 2 more)",
	]);
	assert.deepEqual(backgroundWidgetLines([task("agent", "Long task")], 3_661_000), [
		"Background: 1 running", "  (1h1m) Agent: Long task",
	]);
	assert.deepEqual(backgroundWidgetLines([task("shell", "One hour")], 3_600_000), [
		"Background: 1 running", "  (1h) Task: One hour",
	]);
	assert.equal(backgroundWidgetLines([task("shell", "Invalid clock", NaN)], 0)[1], "  (0s) Task: Invalid clock");
});

test("shared renderer keeps the native bordered layout and semantic colors", () => {
	const lines = Object.freeze(["Background: 7 running", "  (2m14s) Agent: Review", "  (0s) Task: Tests", "  (+ 5 more)"]);
	const calls = [];
	const recordingTheme = { fg(color, text) { calls.push([color, text]); return coloredTheme.fg(color, text); } };
	const rendered = renderBackgroundWidgetLines(lines, 40, recordingTheme);
	assert.deepEqual(rendered.map(stripTerminalSequences), [
		"╭─ Background ───────────── 7 running ─╮",
		"│ (2m14s) Agent: Review                │",
		"│ (0s) Task: Tests                     │",
		"│ (+ 5 more)                           │",
		"╰──────────────────────────────────────╯",
	]);
	assert.ok(calls.some(([color, text]) => color === "accent" && text.includes("Background")));
	assert.deepEqual(calls.filter(([color]) => color === "dim"), [["dim", "(2m14s)"], ["dim", "(0s)"], ["dim", "(+ 5 more)"]]);
	assert.deepEqual(calls.filter(([color]) => color === "muted"), [["muted", "Agent:"], ["muted", "Task:"]]);
	assert.ok(calls.every(([, text]) => !text.includes("Review") && !text.includes("Tests")), "Names stay plain");
	assert.deepEqual(renderBackgroundWidgetLines([], 40, theme), []);
});

// Preserve the old native renderer as an independent layout and color reference.
function legacyRender(active, now, width, theme) {
	const accent = (text) => theme.fg("accent", text);
	function row(content) {
		if (width <= 0) return "";
		if (width === 1) return accent("│");
		const truncated = truncateToWidth(content, width - 2);
		return accent("│") + truncated + " ".repeat(Math.max(0, width - 2 - visibleWidth(truncated))) + accent("│");
	}
	function top() {
		if (width <= 0) return "";
		if (width === 1) return accent("╭");
		const title = "─ Background ";
		const info = ` ${active.length} running ─`;
		const inner = truncateToWidth(title + "─".repeat(Math.max(0, width - 2 - visibleWidth(title) - visibleWidth(info))) + info, width - 2, "");
		return accent(`╭${inner}${"─".repeat(Math.max(0, width - 2 - visibleWidth(inner)))}╮`);
	}
	function elapsed(from) {
		const seconds = Math.max(0, Math.floor((now - from) / 1_000));
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m${seconds % 60 > 0 ? `${seconds % 60}s` : ""}`;
		return `${Math.floor(minutes / 60)}h${minutes % 60 > 0 ? `${minutes % 60}m` : ""}`;
	}
	const lines = [top(), ...active.slice(0, 5).map((item) => row(
		` ${theme.fg("dim", `(${elapsed(item.startedAt)})`)} ${theme.fg("muted", item.kind === "agent" ? "Agent:" : "Task:")} ${item.name} `,
	))];
	if (active.length > 5) lines.push(row(` ${theme.fg("dim", `(+ ${active.length - 5} more)`)} `));
	lines.push(width <= 0 ? "" : width === 1 ? accent("╰") : accent(`╰${"─".repeat(width - 2)}╯`));
	return lines;
}

test("zero, narrow, and unicode widths match native frames with or without colors", () => {
	const active = Object.freeze(Array.from({ length: 8 }, (_, i) => task(i % 2 ? "shell" : "agent", `界 👩🏽‍💻 e\u0301 ${i} ${"wide 界 ".repeat(10)}`.trim())));
	const lines = Object.freeze(backgroundWidgetLines(active, 134_000));
	for (const activeTheme of [theme, coloredTheme]) {
		for (const width of [0, 1, 2, 3, 4, 5, 12, 20, 40, 80, 200]) {
			const actual = renderBackgroundWidgetLines(lines, width, activeTheme);
			assert.deepEqual(actual, legacyRender(active, 134_000, width, activeTheme));
			assert.ok(actual.every(line => visibleWidth(line) <= width), `Width ${width} must bound every line`);
		}
	}
	for (const width of [-1, NaN, Infinity]) {
		assert.ok(renderBackgroundWidgetLines(lines, width, theme).every(line => line === ""));
	}
	assert.ok(renderBackgroundWidgetLines(lines, 3.9, theme).every(line => visibleWidth(line) <= 3));
});

test("payload and renderer sanitize terminal controls and retain unknown or malformed content", () => {
	const unsafe = "\x1b[31mred\x1b[0m\x1b]52;c;injected\x07\x1b_Gpayload\x1b\\\nnext\tline\x00\x9b31m";
	const payload = backgroundWidgetLines([task("shell", unsafe)], 0);
	assert.equal(payload[1], "  (0s) Task: red next line 31m");
	assert.ok(payload.every(line => !/[\x00-\x1f\x7f-\x9f]/.test(line)));
	const known = ["Background: 1 running", `  (0s) Task: ${unsafe}`];
	const rendered = renderBackgroundWidgetLines(known, 100, coloredTheme);
	assert.ok(!rendered.join("\n").includes("injected"));
	assert.ok(!rendered.join("\n").includes("payload"));
	assert.ok(rendered.map(stripTerminalSequences).every(line => !/[\x00-\x1f\x7f-\x9f]/.test(line)));
	const unknown = ["Future background heading", "  (broken) Agent: Keep this", unsafe];
	assert.deepEqual(renderBackgroundWidgetLines(unknown, 100, coloredTheme), [
		"Future background heading", "  (broken) Agent: Keep this", "red next line  31m",
	]);
	const malformedRows = ["Background: 1 running", "  (broken) Agent: Keep this", "  (+ x more)", "Unexpected row 界"];
	assert.deepEqual(renderBackgroundWidgetLines(malformedRows, 80, coloredTheme), malformedRows);
	for (const width of [0, 1, 2, 3, 5]) {
		assert.ok(renderBackgroundWidgetLines(unknown, width, coloredTheme).every(line => visibleWidth(line) <= width));
	}
	assert.deepEqual(renderBackgroundWidgetLines(["Background: zero running", "Never lose this"], 80, theme), ["Background: zero running", "Never lose this"]);
});

function fakeWidgetTimers(t) {
	const intervals = [];
	t.mock.method(globalThis, "setInterval", (callback, delay) => {
		const timer = { callback, delay, cleared: false, unrefed: false, unref() { this.unrefed = true; } };
		intervals.push(timer);
		return timer;
	});
	t.mock.method(globalThis, "clearInterval", (timer) => { timer.cleared = true; });
	return { intervals, tick() { for (const timer of intervals) if (!timer.cleared) timer.callback(); } };
}

function widgetHarness(t, mode) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-background-widget-test-"));
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const widgets = [];
	const statuses = [];
	const notices = [];
	const waiters = [];
	const ctx = { cwd, mode, hasUI: mode === "rpc" || mode === "tui", sessionManager: { getBranch: () => [] }, ui: {
		setWidget(key, value, options) {
			assert.equal(key, BACKGROUND_WIDGET_ID);
			assert.deepEqual(options, { placement: "belowEditor" });
			widgets.push(value);
			for (const resolve of [...waiters]) resolve("widget", value);
		},
		setStatus(...args) { statuses.push(args); },
		notify() {},
	} };
	background({
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, command) { commands.set(name, command); },
		registerMessageRenderer() {},
		on(type, handler) { handlers.set(type, handler); },
		sendMessage(message) { notices.push(message); for (const resolve of [...waiters]) resolve("notice", message); },
	});
	let closed = false;
	const h = {
		ctx, widgets, statuses, notices,
		open() { return handlers.get("session_start")({}, ctx); },
		command() { return commands.get("background").handler("", ctx); },
		call(name, args) { return tools.get(name).execute("widget-test", args, undefined, undefined, ctx); },
		wait(type, predicate) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => { waiters.splice(waiters.indexOf(listener), 1); reject(new Error(`No ${type} event within 5 seconds`)); }, 5_000);
				const listener = (eventType, value) => {
					if (eventType !== type || !predicate(value)) return;
					clearTimeout(timer);
					waiters.splice(waiters.indexOf(listener), 1);
					resolve(value);
				};
				waiters.push(listener);
			});
		},
		async close() { if (!closed) { closed = true; await handlers.get("session_shutdown")(); } },
	};
	t.after(async () => { await h.close(); rmSync(cwd, { recursive: true, force: true }); });
	return h;
}

for (const mode of ["rpc", "tui"]) {
	test(`${mode} session widget updates elapsed time, completion, stop, restart, and shutdown`, async (t) => {
		const timers = fakeWidgetTimers(t);
		let now = 1_000_000;
		t.mock.method(Date, "now", () => now);
		const h = widgetHarness(t, mode);
		assert.deepEqual(timers.intervals, [], "Loading the extension does not start a widget timer");
		assert.deepEqual(h.widgets, []);
		await h.open();
		assert.deepEqual(h.widgets, [undefined]);
		assert.deepEqual(timers.intervals, []);
		const first = await h.call("background_start", { kind: "shell", command: "sleep 60", name: "Tests 界" });
		const initialWidget = h.widgets.at(-1);
		const asLines = value => mode === "rpc" ? value : value({}, theme).render(50);
		assert.equal(typeof initialWidget, mode === "rpc" ? "object" : "function");
		if (mode === "rpc") assert.deepEqual(initialWidget, ["Background: 1 running", "  (0s) Task: Tests 界"]);
		else assert.deepEqual(asLines(initialWidget), renderBackgroundWidgetLines(["Background: 1 running", "  (0s) Task: Tests 界"], 50, theme));
		assert.equal(timers.intervals.length, 1);
		assert.equal(timers.intervals[0].delay, 1_000);
		assert.equal(timers.intervals[0].unrefed, true);
		now += 134_000;
		timers.tick();
		assert.ok(asLines(h.widgets.at(-1)).some(line => line.includes("(2m14s)")));
		if (mode === "tui") assert.ok(asLines(initialWidget).some(line => line.includes("(2m14s)")), "Native render reads the current clock");
		const completion = h.wait("notice", message => message.details.event === "completion");
		await h.call("background_start", { kind: "shell", command: "sleep 0.05; printf done", name: "Short task" });
		assert.ok(asLines(h.widgets.at(-1)).some(line => line.includes("2 running")));
		const notice = await completion;
		assert.equal(notice.details.state, "completed");
		assert.ok(asLines(h.widgets.at(-1)).some(line => line.includes("1 running")));
		assert.ok(!asLines(h.widgets.at(-1)).some(line => line.includes("Short task")));
		const cleared = h.wait("widget", value => value === undefined);
		await h.call("background_stop", { id: first.details.id });
		await cleared;
		assert.equal(timers.intervals[0].cleared, true);
		assert.match((await h.call("background_status", { id: first.details.id })).content[0].text, /State: stopped/);
		const updatesAfterStop = h.widgets.length;
		timers.tick();
		assert.equal(h.widgets.length, updatesAfterStop);
		await h.call("background_start", { kind: "shell", command: "sleep 60", name: "Restart" });
		assert.equal(timers.intervals.length, 2);
		await h.close();
		assert.equal(h.widgets.at(-1), undefined);
		assert.equal(timers.intervals[1].cleared, true);
		const updatesAfterShutdown = h.widgets.length;
		await new Promise(resolve => setTimeout(resolve, 20)); // Let killed shells deliver their exit callbacks.
		timers.tick();
		assert.equal(h.widgets.length, updatesAfterShutdown);
	});

	test(`${mode} clears the last shell widget and timer on normal completion`, async (t) => {
		const timers = fakeWidgetTimers(t);
		const h = widgetHarness(t, mode);
		await h.open();
		const completed = h.wait("notice", message => message.details.state === "completed");
		await h.call("background_start", { kind: "shell", command: "sleep 0.05; printf done", name: "Last shell" });
		await completed;
		assert.equal(h.widgets.at(-1), undefined);
		assert.equal(timers.intervals.length, 1);
		assert.equal(timers.intervals[0].cleared, true);
		const updates = h.widgets.length;
		timers.tick();
		assert.equal(h.widgets.length, updates);
	});

	test(`${mode} captures UI mode from /background or the first tool without session_start`, async (t) => {
		const timers = fakeWidgetTimers(t);
		for (const capture of ["command", "tool"]) {
			const h = widgetHarness(t, mode);
			if (capture === "command") await h.command();
			await h.call("background_start", { kind: "shell", command: "sleep 60", name: "Command capture" });
			const value = h.widgets.at(-1);
			assert.equal(typeof value, mode === "rpc" ? "object" : "function");
			if (mode === "rpc") assert.deepEqual(value, ["Background: 1 running", "  (0s) Task: Command capture"]);
			await h.close();
		}
		assert.ok(timers.intervals.every(timer => timer.cleared));
	});
}

for (const mode of ["rpc", "tui"]) {
	test(`${mode} mixed shell/agent widget caps rows and clears completed or stopped agents`, async (t) => {
		const timers = fakeWidgetTimers(t);
		const eventHandlers = new Map();
		t.mock.method(RpcClient.prototype, "onEvent", function (handler) { eventHandlers.set(this, handler); return () => {}; });
		t.mock.method(RpcClient.prototype, "start", async () => {});
		t.mock.method(RpcClient.prototype, "getState", async function () {
			const saved = readSavedAgent(this.options.args[1]);
			return { sessionId: saved.sessionId, sessionFile: saved.sessionFile };
		});
		for (const method of ["prompt", "abort", "stop"]) t.mock.method(RpcClient.prototype, method, async () => {});
		t.mock.method(RpcClient.prototype, "getLastAssistantText", async () => "Done.");
		t.mock.method(RpcClient.prototype, "getSessionStats", async () => ({ tokens: { total: 0 }, cost: 0 }));
		const f = fixture(t);
		const h = harness(t, f);
		h.ctx.mode = mode;
		const widgets = [];
		h.ctx.ui.setWidget = (key, value, options) => {
			assert.equal(key, BACKGROUND_WIDGET_ID);
			assert.deepEqual(options, { placement: "belowEditor" });
			widgets.push(value);
		};
		const asLines = value => mode === "rpc" ? value : value({}, theme).render(70);
		await h.open();
		const agent = await h.call("background_start", { kind: "agent", task: "Review code", name: "Review" });
		for (let i = 0; i < 5; i++) await h.call("background_start", { kind: "shell", command: "sleep 60", name: `Shell ${i}` });
		const mixed = asLines(widgets.at(-1));
		assert.ok(mixed.some(line => line.includes("6 running")));
		assert.ok(mixed.some(line => line.includes("Agent: Review")));
		assert.ok(mixed.some(line => line.includes("Task: Shell 3")));
		assert.ok(!mixed.some(line => line.includes("Shell 4")));
		assert.ok(mixed.some(line => line.includes("(+ 1 more)")));
		eventHandlers.values().next().value({ type: "agent_settled" });
		await h.nextNotice();
		const afterCompletion = asLines(widgets.at(-1));
		assert.ok(afterCompletion.some(line => line.includes("5 running")));
		assert.ok(afterCompletion.some(line => line.includes("Shell 4")));
		assert.ok(!afterCompletion.some(line => line.includes("Agent:") || line.includes("more)")));
		await h.close();
		assert.equal(widgets.at(-1), undefined);
		assert.ok(timers.intervals.every(timer => timer.cleared));

		// A separate session checks the last agent without any shell tasks.
		const resumed = harness(t, f);
		resumed.ctx.mode = mode;
		resumed.ctx.ui.setWidget = h.ctx.ui.setWidget;
		await resumed.open();
		await resumed.call("background_send", { id: agent.details.sessionFile, message: "Continue review" });
		assert.ok(asLines(widgets.at(-1)).some(line => line.includes("1 running")));
		await resumed.call("background_stop", { id: agent.details.id });
		assert.equal(widgets.at(-1), undefined);
		assert.ok(timers.intervals.every(timer => timer.cleared));
		await resumed.call("background_send", { id: agent.details.id, message: "Finish review" });
		const resumedHandler = [...eventHandlers.values()].at(-1);
		resumedHandler({ type: "agent_settled" });
		await resumed.nextNotice();
		assert.equal(widgets.at(-1), undefined);
		assert.ok(timers.intervals.every(timer => timer.cleared));
	});
}

for (const mode of ["json", "print"]) {
	test(`${mode} starts shell tasks without UI calls or widget timers`, async (t) => {
		const timers = fakeWidgetTimers(t);
		const h = widgetHarness(t, mode);
		await h.open();
		await h.command();
		await h.call("background_start", { kind: "shell", command: "sleep 60", name: "Headless task" });
		await h.close();
		assert.deepEqual(timers.intervals, []);
		assert.deepEqual(h.widgets, []);
		assert.deepEqual(h.statuses, []);
	});
}

test("standalone widget import loads no worker, process, session, or credential module and starts no timers", () => {
	const widgetUrl = new URL("../background/widget.ts", import.meta.url).href;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import assert from "node:assert/strict";
		import { registerHooks, syncBuiltinESMExports } from "node:module";
		import childProcess from "node:child_process";
		import workerThreads from "node:worker_threads";
		const widgetUrl = ${JSON.stringify(widgetUrl)};
		const runtimeImports = [];
		const forbidden = () => { throw new Error("Widget import must not start a worker, process, or timer"); };
		for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[method] = forbidden;
		workerThreads.Worker = class { constructor() { forbidden(); } };
		syncBuiltinESMExports();
		globalThis.setTimeout = globalThis.setInterval = forbidden;
		registerHooks({ resolve(specifier, context, nextResolve) {
			if (context.parentURL === widgetUrl) {
				runtimeImports.push(specifier);
				assert.equal(specifier, "@earendil-works/pi-tui", "Unexpected widget dependency");
			}
			return nextResolve(specifier, context);
		} });
		const widget = await import(widgetUrl);
		assert.equal(widget.BACKGROUND_WIDGET_ID, "background-running");
		assert.equal(typeof widget.backgroundWidgetLines, "function");
		assert.equal(typeof widget.renderBackgroundWidgetLines, "function");
		assert.deepEqual(runtimeImports, ["@earendil-works/pi-tui"]);
	`], { encoding: "utf8", timeout: 10_000 });
	assert.equal(result.status, 0, result.stderr || result.error?.message);
});
