import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	AssistantMessageComponent,
	initTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const originalAssistantRender = AssistantMessageComponent.prototype.render;
const originalToolRender = ToolExecutionComponent.prototype.render;
// Keep the module cached, as Pi does when replacing a session in the same cwd.
const { default: assistantBackground } = await import("../assistant-background.ts");
const renderAfterImport = AssistantMessageComponent.prototype.render;
const toolRenderAfterImport = ToolExecutionComponent.prototype.render;
initTheme("dark");

const purple = "\x1b[48;2;52;47;56m";
const ctx = {
	mode: "tui",
	hasUI: true,
	ui: {
		theme: {
			bg(color, text) {
				assert.equal(color, "customMessageBg");
				return `${purple}${text}\x1b[49m`;
			},
		},
	},
};
const sessions = [];

function createSession(context = ctx) {
	const handlers = new Map();
	assistantBackground({
		on(event, handler) {
			handlers.set(event, handler);
		},
	});
	const session = {
		start(reason = "startup") {
			return handlers.get("session_start")({ type: "session_start", reason }, context);
		},
		shutdown(reason = "quit") {
			return handlers.get("session_shutdown")({ type: "session_shutdown", reason }, context);
		},
	};
	sessions.push(session);
	return session;
}

function message(content = [{ type: "text", text: "A reply with `code`." }]) {
	return new AssistantMessageComponent({ role: "assistant", content, stopReason: "stop" });
}

function assertPurple(component = message()) {
	const lines = component.render(40);
	assert.ok(lines.length > 0);
	for (const line of lines) {
		assert.ok(line.startsWith(purple), "every assistant line should have a purple background");
		assert.equal(visibleWidth(line), 40);
	}
	return lines;
}

afterEach(() => {
	for (const session of sessions.splice(0).reverse()) session.shutdown();
	AssistantMessageComponent.prototype.render = originalAssistantRender;
	ToolExecutionComponent.prototype.render = originalToolRender;
});

test("import and factory registration do not patch the renderer", () => {
	assert.equal(renderAfterImport, originalAssistantRender);
	assert.equal(toolRenderAfterImport, originalToolRender);
	createSession();
	assert.equal(AssistantMessageComponent.prototype.render, originalAssistantRender);
	assert.equal(ToolExecutionComponent.prototype.render, originalToolRender);
});

test("startup adds the background and removes only the leading tool spacer", () => {
	const assistant = message();
	const assistantLines = assistant.render(40);
	const tool = new ToolExecutionComponent("test-tool", "test-call", {}, {}, undefined, undefined, process.cwd());
	const toolLines = tool.render(40);
	assert.equal(toolLines[0], "");

	const session = createSession();
	session.start();
	assert.equal(assertPurple(assistant).length, assistantLines.length + 1);
	assert.deepEqual(tool.render(40), toolLines.slice(1));

	session.shutdown();
	assert.deepEqual(assistant.render(40), assistantLines);
	assert.deepEqual(tool.render(40), toolLines);
});

for (const reason of ["new", "resume", "fork", "reload"]) {
	test(`cached factory reinstalls the background after ${reason}`, () => {
		const first = createSession();
		first.start();
		const expected = assertPurple();
		first.shutdown(reason);
		assert.equal(AssistantMessageComponent.prototype.render, originalAssistantRender);
		assert.equal(ToolExecutionComponent.prototype.render, originalToolRender);

		const next = createSession();
		next.start(reason);
		assert.deepEqual(assertPurple(), expected);
		assert.notEqual(ToolExecutionComponent.prototype.render, originalToolRender);
	});
}

test("repeated lifecycle events do not stack wrappers or padding", () => {
	const session = createSession();
	session.start();
	const expected = assertPurple();
	const render = AssistantMessageComponent.prototype.render;
	session.start();
	assert.equal(AssistantMessageComponent.prototype.render, render);
	assert.deepEqual(assertPurple(), expected);
	session.shutdown();
	session.shutdown();
	assert.equal(AssistantMessageComponent.prototype.render, originalAssistantRender);
	session.start("new");
	assert.deepEqual(assertPurple(), expected);
});

for (const mode of ["print", "json", "rpc"]) {
	test(`${mode} sessions do not change an active TUI renderer`, () => {
		const tui = createSession();
		tui.start();
		const expected = assertPurple();
		const render = AssistantMessageComponent.prototype.render;
		const headless = createSession({
			mode,
			hasUI: mode === "rpc",
			get ui() { throw new Error("non-TUI sessions must not access the terminal theme"); },
		});
		headless.start();
		headless.shutdown();
		assert.equal(AssistantMessageComponent.prototype.render, render);
		assert.deepEqual(assertPurple(), expected);
	});
}

test("empty assistant messages remain empty", () => {
	createSession().start();
	assert.deepEqual(message([]).render(40), []);
});

test("startup captures the current renderers and shutdown restores them", () => {
	const session = createSession();
	const previousAssistant = () => ["previous assistant renderer"];
	const previousTool = () => ["", "previous tool renderer"];
	AssistantMessageComponent.prototype.render = previousAssistant;
	ToolExecutionComponent.prototype.render = previousTool;
	session.start();
	assert.ok(assertPurple()[0].includes("previous assistant renderer"));
	assert.deepEqual(ToolExecutionComponent.prototype.render.call({}, 40), ["previous tool renderer"]);
	session.shutdown();
	assert.equal(AssistantMessageComponent.prototype.render, previousAssistant);
	assert.equal(ToolExecutionComponent.prototype.render, previousTool);
});

test("shutdown does not overwrite a renderer installed later", () => {
	const session = createSession();
	session.start();
	const laterAssistant = () => ["later assistant renderer"];
	const laterTool = () => ["later tool renderer"];
	AssistantMessageComponent.prototype.render = laterAssistant;
	ToolExecutionComponent.prototype.render = laterTool;
	session.shutdown();
	assert.equal(AssistantMessageComponent.prototype.render, laterAssistant);
	assert.equal(ToolExecutionComponent.prototype.render, laterTool);
});
