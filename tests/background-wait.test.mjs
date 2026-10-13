import assert from "node:assert/strict";
import { test } from "node:test";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { readSavedAgent } from "../background/sessions.ts";
import { fixture, harness } from "./background-helpers.mjs";

const STATUS_KEY = "waiting-on-background";
const STATUS_TEXT = "Waiting on background task";

function setup(t, mode = "rpc") {
	const f = fixture(t);
	const clients = [];
	t.mock.method(RpcClient.prototype, "start", async function () { clients.push(this); });
	t.mock.method(RpcClient.prototype, "getState", async function () {
		const saved = readSavedAgent(this.options.args[1]);
		return { sessionId: saved.sessionId, sessionFile: saved.sessionFile };
	});
	for (const name of ["prompt", "steer", "abort", "stop"]) t.mock.method(RpcClient.prototype, name, async () => {});
	t.mock.method(RpcClient.prototype, "getLastAssistantText", async () => "Finished");
	t.mock.method(RpcClient.prototype, "getSessionStats", async () => ({ tokens: { total: 0 }, cost: 0 }));
	const h = harness(t, f);
	h.ctx.mode = mode;
	const statuses = [];
	h.ctx.ui.setStatus = (key, value) => { if (key === STATUS_KEY) statuses.push(value); };
	return {
		...h, statuses, clients,
		start() { return h.call("background_start", { kind: "agent", task: "Long task" }); },
		settle(client = clients.at(-1)) { for (const listener of client.eventListeners) listener({ type: "agent_settled" }); },
	};
}

test("background_wait fails without running work and leaves no waiting status", async t => {
	const h = setup(t);
	await h.open();
	await assert.rejects(h.call("background_wait", {}), /No background tasks are running/);
	assert.deepEqual(h.statuses, [undefined]);
	assert.equal(h.tools.get("background_wait").exposure, "model-only", "Waiting must not be nested inside codemode");
	const first = await h.start();
	await h.call("background_stop", { id: first.details.id });
	await assert.rejects(h.call("background_wait", {}), /No background tasks are running/);
	assert.deepEqual(h.statuses, [undefined], "Retained but stopped activities do not count");
});

test("starting background work does not imply waiting; only background_wait asserts the signal", async t => {
	const h = setup(t);
	await h.open();
	const first = await h.start();
	assert.deepEqual(h.statuses, [undefined]);
	await h.emit("tool_execution_start", { toolName: "background_wait", toolCallId: "wait" });
	const result = await h.call("background_wait", {});
	await h.emit("tool_execution_end", { toolName: "background_wait", toolCallId: "wait", isError: false });
	assert.deepEqual(result.details, { waitingOnBackground: true, activities: [first.details.id] });
	assert.deepEqual(h.statuses, [undefined, STATUS_TEXT]);
	await h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
	await h.emit("agent_settled");
	assert.equal(h.statuses.at(-1), STATUS_TEXT, "The signal survives a successful final reply and settlement");
	await h.emit("agent_start");
	assert.equal(h.statuses.at(-1), undefined, "A new run must make its own waiting decision");
});

for (const [type, data] of [
	["tool_execution_start", { toolName: "ask_user", toolCallId: "question" }],
	["ui_prompt_start", { kind: "input", title: "Deploy?" }],
	["message_end", { message: { role: "assistant", stopReason: "error" } }],
	["message_end", { message: { role: "assistant", stopReason: "aborted" } }],
	["message_start", { message: { role: "user", content: "New instruction" } }],
	["message_start", { message: { role: "custom", customType: "background", content: "Progress update" } }],
	["session_start", {}], ["session_tree", {}],
]) {
	test(`${type} ${data.message?.stopReason ?? data.message?.role ?? data.toolName ?? data.kind ?? ""} clears waiting`, async t => {
		const h = setup(t);
		await h.open();
		await h.start();
		await h.call("background_wait", {});
		await h.emit(type, data);
		assert.deepEqual(h.statuses, [undefined, STATUS_TEXT, undefined]);
	});
}

test("background_wait rejects an in-flight sibling tool; later parallel tools cancel waiting", async t => {
	const h = setup(t);
	await h.open();
	await h.start();
	await h.emit("tool_execution_start", { toolName: "read", toolCallId: "read" });
	await assert.rejects(h.call("background_wait", {}), /Other tools are still executing/);
	assert.deepEqual(h.statuses, [undefined]);
	await h.emit("tool_execution_end", { toolName: "read", toolCallId: "read", isError: false });
	await h.call("background_wait", {});
	await h.emit("tool_execution_start", { toolName: "read", toolCallId: "later" });
	assert.equal(h.statuses.at(-1), undefined);
});

test("the last child's completion clears waiting before the parent receives its wake-up notice", async t => {
	const h = setup(t);
	await h.open();
	await h.start();
	await h.start();
	await h.call("background_wait", {});
	h.settle(h.clients[0]);
	await h.nextNotice();
	assert.equal(h.statuses.at(-1), STATUS_TEXT, "Other background work remains");
	h.settle(h.clients[1]);
	assert.equal(h.statuses.at(-1), undefined, "Clear synchronously before async result retrieval");
	await h.nextNotice();
	await assert.rejects(h.call("background_wait", {}), /No background tasks are running/);
});

test("a child waiting on nested background work remains running until its actual final settlement", async t => {
	const h = setup(t);
	await h.open();
	const child = await h.start();
	await h.call("background_wait", {});
	const emit = event => { for (const listener of h.clients[0].eventListeners) listener(event); };
	// A successful retry may contain only tool calls, not text. It must clear an older error.
	emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Temporary failure" } });
	emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "toolUse" } });
	emit({ type: "extension_ui_request", method: "setStatus", statusKey: STATUS_KEY, statusText: STATUS_TEXT });
	h.settle();
	assert.equal(RpcClient.prototype.getLastAssistantText.mock.callCount(), 0, "A temporary child pause is not completion");
	assert.equal(h.statuses.at(-1), STATUS_TEXT);
	assert.match((await h.call("background_status", { id: child.details.id })).content[0].text, /running/);
	emit({ type: "extension_ui_request", method: "setStatus", statusKey: STATUS_KEY });
	assert.equal(h.statuses.at(-1), STATUS_TEXT, "A status clear alone is not child completion");
	emit({ type: "agent_start" });
	h.settle();
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal((await h.nextNotice()).details.state, "completed");
	assert.equal(RpcClient.prototype.getLastAssistantText.mock.callCount(), 1);
});

test("a failed child cannot remain waiting on nested work", async t => {
	const h = setup(t);
	await h.open();
	await h.start();
	await h.call("background_wait", {});
	for (const event of [
		{ type: "extension_ui_request", method: "setStatus", statusKey: STATUS_KEY, statusText: STATUS_TEXT },
		{ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Child failed" } },
	]) for (const listener of h.clients[0].eventListeners) listener(event);
	// Result retrieval returns empty output, so it cannot overwrite the observed error.
	RpcClient.prototype.getLastAssistantText.mock.mockImplementation(async () => "");
	h.settle();
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal((await h.nextNotice()).details.state, "failed");
});

test("sending to an idle waiting child starts it instead of only queuing steering", async t => {
	const h = setup(t);
	await h.open();
	const child = await h.start();
	for (const listener of h.clients[0].eventListeners) listener({ type: "extension_ui_request", method: "setStatus", statusKey: STATUS_KEY, statusText: STATUS_TEXT });
	h.settle();
	await h.call("background_send", { id: child.details.id, message: "Change direction" });
	assert.deepEqual(RpcClient.prototype.prompt.mock.calls[1].arguments, ["Change direction", undefined, "steer"]);
	assert.equal(RpcClient.prototype.steer.mock.callCount(), 0);
});

for (const cleared of [false, true]) {
	test(`stopping a waiting child immediately releases its runtime (status cleared: ${cleared})`, async t => {
		const h = setup(t);
		await h.open();
		const child = await h.start();
		await h.call("background_wait", {});
		const client = h.clients[0];
		for (const listener of client.eventListeners) listener({ type: "extension_ui_request", method: "setStatus", statusKey: STATUS_KEY, statusText: STATUS_TEXT });
		h.settle();
		if (cleared) for (const listener of client.eventListeners) listener({ type: "extension_ui_request", method: "setStatus", statusKey: STATUS_KEY });
		await h.call("background_stop", { id: child.details.id });
		assert.equal(RpcClient.prototype.stop.mock.callCount(), 1);
		assert.equal(h.statuses.at(-1), undefined);
		for (const listener of client.eventListeners) listener({ type: "agent_settled" });
		assert.equal(RpcClient.prototype.getLastAssistantText.mock.callCount(), 0, "The stopped child cannot produce a late completion");
	});
}

test("resuming during a stop waits for the old runtime and cannot be killed by that stop", async t => {
	const h = setup(t);
	await h.open();
	const child = await h.start();
	let finishStop;
	RpcClient.prototype.stop.mock.mockImplementation(() => new Promise(resolve => { finishStop = resolve; }));
	const stopping = h.call("background_stop", { id: child.details.id });
	assert.equal(typeof finishStop, "function");
	const resuming = h.call("background_send", { id: child.details.id, message: "Resume now" });
	assert.equal(h.clients.length, 1);
	finishStop();
	await Promise.all([stopping, resuming]);
	assert.equal(h.clients.length, 2);
	assert.equal(RpcClient.prototype.stop.mock.callCount(), 1);
	assert.equal(RpcClient.prototype.prompt.mock.callCount(), 2);
	RpcClient.prototype.stop.mock.mockImplementation(async () => {});
});

test("a crashed child waiting on nested work still fails and wakes the parent", async t => {
	const h = setup(t);
	await h.open();
	const child = await h.start();
	await h.call("background_wait", {});
	for (const listener of h.clients[0].eventListeners) listener({ type: "extension_ui_request", method: "setStatus", statusKey: STATUS_KEY, statusText: STATUS_TEXT });
	h.settle();
	RpcClient.prototype.getState.mock.mockImplementation(async () => { throw new Error("Child process exited"); });
	await h.call("background_status", { id: child.details.id });
	assert.equal((await h.nextNotice()).details.state, "failed");
	assert.equal(h.statuses.at(-1), undefined);
});

test("an already open dialog prevents background_wait until it closes", async t => {
	const h = setup(t);
	await h.open();
	await h.start();
	await h.emit("ui_prompt_start", { kind: "input" });
	await assert.rejects(h.call("background_wait", {}), /dialog is waiting for user input/);
	await h.emit("ui_prompt_end", { kind: "input" });
	await h.call("background_wait", {});
	assert.equal(h.statuses.at(-1), STATUS_TEXT);
});

test("a stopping shell cannot be used as a future wake-up", async t => {
	const h = setup(t);
	await h.open();
	const shell = await h.call("background_start", { kind: "shell", command: "sleep 60" });
	await h.call("background_stop", { id: shell.details.id });
	await assert.rejects(h.call("background_wait", {}), /No background tasks are running/);
	assert.equal(h.statuses.at(-1), undefined);
});

test("shell completion clears waiting and still delivers its completion notice", { timeout: 5_000 }, async t => {
	const h = setup(t);
	await h.open();
	// Enough time for a deterministic synchronous wait declaration, without long-running children.
	await h.call("background_start", { kind: "shell", command: "sleep 0.1" });
	await h.call("background_wait", {});
	assert.equal(h.statuses.at(-1), STATUS_TEXT);
	await h.nextNotice();
	assert.equal(h.statuses.at(-1), undefined);
});

test("shutdown clears waiting, and cancellation never sets it", async t => {
	const h = setup(t);
	await h.open();
	await h.start();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(h.tools.get("background_wait").execute("cancelled", {}, controller.signal, undefined, h.ctx), /cancelled/);
	assert.deepEqual(h.statuses, [undefined]);
	await h.call("background_wait", {});
	await h.close();
	assert.equal(h.statuses.at(-1), undefined);
});

test("an expired status UI cannot prevent a completion wake-up", async t => {
	const h = setup(t);
	await h.open();
	await h.start();
	await h.call("background_wait", {});
	const setStatus = h.ctx.ui.setStatus;
	h.ctx.ui.setStatus = () => { throw new Error("Expired UI"); };
	try {
		h.settle();
		assert.equal((await h.nextNotice()).details.state, "completed");
	} finally {
		h.ctx.ui.setStatus = setStatus;
	}
});

for (const mode of ["tui", "json", "print"]) {
	test(`${mode} does not emit the RPC-only waiting signal`, async t => {
		const h = setup(t, mode);
		await h.open();
		await h.start();
		await h.call("background_wait", {});
		await h.close();
		assert.deepEqual(h.statuses, []);
	});
}
