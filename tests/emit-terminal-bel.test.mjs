import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import terminalBell from "../emit-terminal-bel.ts";

const call = (name = "background_wait", id = "wait") => ({ type: "toolCall", name, id, arguments: {} });
const assistant = (content = [], stopReason = "stop") => ({ role: "assistant", content, stopReason });
const result = (id = "wait", name = "background_wait", isError = false) => ({ role: "toolResult", toolCallId: id, toolName: name, isError, content: [] });
const wait = () => [assistant([call()], "toolUse"), result(), assistant()];

function setup(t, mode = "tui") {
	const handlers = new Map();
	terminalBell({ on: (type, handler) => handlers.set(type, handler) });
	const manager = SessionManager.inMemory();
	const controller = new AbortController();
	const ctx = { mode, sessionManager: manager, signal: controller.signal };
	let bells = 0;
	const write = process.stdout.write.bind(process.stdout);
	t.mock.method(process.stdout, "write", (chunk, ...args) => {
		if (chunk === "\x07") { bells++; return true; }
		return write(chunk, ...args);
	});
	const emit = (type, extra = {}) => handlers.get(type)?.({ type, ...extra }, ctx);
	const append = (message) => manager.appendMessage({ timestamp: Date.now(), ...message });
	const run = (messages = [], ending = {}) => {
		emit("agent_start");
		for (const message of messages) append(message);
		emit("agent_settled", ending);
	};
	return { emit, append, run, manager, controller, ctx, get bells() { return bells; } };
}

for (const mode of ["tui", "rpc", "json", "print"]) {
	test(`completion bells are TUI-only in ${mode} mode`, t => {
		const h = setup(t, mode);
		h.run([assistant([{ type: "text", text: "Done" }])]);
		assert.equal(h.bells, mode === "tui" ? 1 : 0);
		h.emit("agent_settled");
		assert.equal(h.bells, mode === "tui" ? 1 : 0, "Settlement replay is quiet");
	});
}

for (const [name, change, waiting] of [
	["successful wait", () => {}, true],
	["no final reply", messages => messages.pop(), true],
	["intermixed notices", messages => messages.splice(1, 0, { role: "custom", content: "Still running" }), true],
	["many later replies and notices", messages => {
		for (let i = 0; i < 5; i++) messages.push({ role: "custom", content: "Check-in" }, assistant([{ type: "text", text: "Waiting" }]));
	}, true],
	["wait last among siblings", messages => {
		messages[0].content.unshift(call("read", "other"));
		messages.splice(2, 0, result("other", "read"));
	}, true],
	["later sibling", messages => messages[0].content.push(call("read", "other")), false],
	["later tool call", messages => messages.push(assistant([call("read", "other")], "toolUse"), result("other", "read"), assistant()), false],
	["failed wait", messages => { messages[1].isError = true; }, false],
	["missing success", messages => { delete messages[1].isError; }, false],
	["wrong result ID", messages => { messages[1].toolCallId = "other"; }, false],
	["wrong result name", messages => { messages[1].toolName = "read"; }, false],
	["delivered steering", messages => messages.push({ role: "user", content: "A new question" }, assistant()), false],
	["wait after new input", messages => messages.push({ role: "user", content: "Wait again" }, ...wait()), true],
]) {
	test(`native bell follows the last successful tool call: ${name}`, t => {
		const h = setup(t);
		const messages = wait(); change(messages);
		h.run(messages);
		assert.equal(h.bells, waiting ? 0 : 1);
	});
}

test("inner starts do not reset a logical run, but a fresh silent wake-up does", t => {
	const h = setup(t);
	h.emit("agent_start");
	for (const message of wait().slice(0, 2)) h.append(message);
	h.emit("agent_start");
	h.append(assistant());
	h.emit("agent_settled");
	assert.equal(h.bells, 0);
	h.run([assistant()]);
	assert.equal(h.bells, 1, "A no-tool wake-up cannot reuse the prior wait");
	h.run();
	assert.equal(h.bells, 2, "An empty fresh run cannot reuse any earlier call");
});

test("Pi's omitted failed retry does not lose the successful wait", t => {
	const h = setup(t);
	h.emit("agent_start");
	for (const message of wait().slice(0, 2)) h.append(message);
	const failed = h.append(assistant([call("read", "unexecuted")], "error"));
	h.manager.appendContextEdit(failed, null);
	h.emit("agent_start");
	h.append(assistant());
	h.emit("agent_settled");
	assert.equal(h.bells, 0);
});

for (const ending of ["error reply", "aborted reply", "error flag", "aborted flag", "aborted signal"]) {
	test(`error and cancellation override a successful wait: ${ending}`, t => {
		const h = setup(t);
		h.emit("agent_start");
		for (const message of wait()) h.append(message);
		if (ending === "error reply") h.append(assistant([], "error"));
		if (ending === "aborted reply") h.append(assistant([], "aborted"));
		if (ending === "aborted signal") h.controller.abort();
		h.emit("agent_settled", { error: ending === "error flag", aborted: ending === "aborted flag" });
		assert.equal(h.bells, ending.startsWith("error") ? 1 : 0);
	});
}

test("compaction cannot erase a successful wait from the current run", t => {
	const h = setup(t);
	h.emit("agent_start");
	for (const message of wait().slice(0, 2)) h.append(message);
	const reply = h.append(assistant());
	h.manager.appendCompaction("Earlier work summarized", reply, 1000);
	h.emit("agent_settled");
	assert.equal(h.bells, 0);
});

test("an omitted delivered user message still clears an earlier wait", t => {
	const h = setup(t);
	h.emit("agent_start");
	for (const message of wait()) h.append(message);
	const user = h.append({ role: "user", content: "A new question" });
	h.append(assistant());
	h.manager.appendContextEdit(user, null);
	h.emit("agent_settled");
	assert.equal(h.bells, 1);
});

for (const aborted of [false, true]) {
	for (const stopReason of ["error", "length"]) {
		test(`overflow recovery ${aborted ? "cancellation" : "failure"} overrides an earlier wait (${stopReason})`, t => {
			const h = setup(t);
			h.emit("agent_start");
			for (const message of wait()) h.append(message);
			const failed = h.append(assistant([], stopReason));
			h.manager.appendContextEdit(failed, null);
			h.emit("session_compact_failed", { reason: "overflow", aborted });
			h.emit("agent_settled");
			assert.equal(h.bells, aborted ? 0 : 1);
		});
	}
}

test("cancelling a later inner run uses that run's signal", t => {
	const h = setup(t);
	h.emit("agent_start");
	h.append(assistant());
	const later = new AbortController();
	h.ctx.signal = later.signal; h.emit("agent_start");
	later.abort(); h.emit("agent_settled");
	assert.equal(h.bells, 0);
});

test("cancelling threshold compaction stays quiet after a plain answer", t => {
	const h = setup(t);
	h.emit("agent_start"); h.append(assistant());
	h.emit("session_compact_failed", { reason: "threshold", aborted: true });
	h.emit("agent_settled");
	assert.equal(h.bells, 0);
});

for (const failedOverflow of [false, true]) {
	test(`an omitted final retry is ${failedOverflow ? "an overflow failure" : "a cancelled backoff"}`, t => {
		const h = setup(t);
		h.emit("agent_start");
		for (const message of wait()) h.append(message);
		h.append(assistant([call("read", "other")], "toolUse")); h.append(result("other", "read"));
		const failure = h.append(assistant([], "error"));
		h.manager.appendContextEdit(failure, null);
		if (failedOverflow) h.emit("session_compact_failed", { reason: "overflow", aborted: false });
		h.emit("agent_settled");
		assert.equal(h.bells, failedOverflow ? 1 : 0);
	});
}

test("an omitted overflow without a compaction or failure event still rings", t => {
	const h = setup(t);
	h.emit("agent_start");
	for (const message of wait()) h.append(message);
	const failure = h.append(assistant([], "length"));
	h.manager.appendContextEdit(failure, null);
	h.emit("agent_settled");
	assert.equal(h.bells, 1);
});

for (const event of ["session_start", "session_tree", "session_shutdown"]) {
	test(`${event} clears an in-flight run without ringing`, t => {
		const h = setup(t);
		h.emit("agent_start"); h.append(assistant());
		h.emit(event); h.emit("agent_settled");
		assert.equal(h.bells, 0);
	});
}
