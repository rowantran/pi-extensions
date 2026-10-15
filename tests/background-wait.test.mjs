import assert from "node:assert/strict";
import { test } from "node:test";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { readSavedAgent } from "../background/sessions.ts";
import { isBackgroundWaitEnding } from "../background/wait.ts";
import { fixture, harness } from "./background-helpers.mjs";

function waitEnding() {
	return [
		{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "background_wait", id: "wait", arguments: {} }] },
		{ role: "toolResult", toolName: "background_wait", toolCallId: "wait", isError: false, content: [] },
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Waiting for the task." }] },
	];
}

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
	h.ctx.ui.setStatus = (...args) => statuses.push(args);
	const emit = (event, client = clients.at(-1)) => { for (const listener of client.eventListeners) listener(event); };
	return {
		...h, statuses, clients, emit,
		start() { return h.call("background_start", { kind: "agent", task: "Long task" }); },
		messages(messages, client) { for (const message of messages) emit({ type: "message_end", message }, client); },
		settle(client, extra = {}) { emit({ type: "agent_settled", ...extra }, client); },
	};
}

test("background_wait fails without running work, including retained stopped activities", async t => {
	const h = setup(t);
	await h.open();
	await assert.rejects(h.call("background_wait", {}), /No background tasks are running/);
	assert.equal(h.tools.get("background_wait").exposure, "model-only", "Waiting must not be nested inside codemode");
	const first = await h.start();
	await h.call("background_stop", { id: first.details.id });
	await assert.rejects(h.call("background_wait", {}), /No background tasks are running/);
});

for (const mode of ["rpc", "tui", "json", "print"]) {
	test(`background_wait returns immediately without changing footer status in ${mode} mode`, async t => {
		const h = setup(t, mode);
		await h.open();
		const child = await h.start();
		const before = h.statuses.length;
		const result = await h.call("background_wait", {});
		assert.deepEqual(result.details, { activities: [child.details.id] });
		assert.match(result.content[0].text, /End this turn without asking for user input/);
		assert.equal(h.statuses.length, before);
		assert.ok(h.statuses.every(([key]) => key === "background"), "Only normal usage accounting may write footer status");
	});
}

test("a child waits only after agent_settled and resumes without a premature completion notice", async t => {
	const h = setup(t);
	await h.open();
	const child = await h.start();
	// A recovered reply must clear an older error before evaluating this run.
	h.messages([{ role: "assistant", content: [], stopReason: "error", errorMessage: "Temporary failure" }, ...waitEnding()]);
	h.emit({ type: "agent_end", messages: waitEnding() });
	assert.equal(RpcClient.prototype.getLastAssistantText.mock.callCount(), 0);
	h.settle();
	assert.equal(RpcClient.prototype.getLastAssistantText.mock.callCount(), 0, "A temporary pause is not child completion");
	assert.match((await h.call("background_status", { id: child.details.id })).content[0].text, /running/);
	h.emit({ type: "agent_start" });
	h.messages([{ role: "assistant", content: [{ type: "text", text: "Finished" }], stopReason: "stop" }]);
	h.settle();
	assert.equal((await h.nextNotice()).details.state, "completed");
	assert.equal(RpcClient.prototype.getLastAssistantText.mock.callCount(), 1);
});

test("a child wait survives notices and many assistant updates across inner turns", async t => {
	const h = setup(t);
	await h.open();
	const child = await h.start();
	h.messages(waitEnding().slice(0, 2));
	for (let index = 0; index < 30; index++) {
		h.emit({ type: "agent_end", messages: [] });
		h.emit({ type: "agent_start" });
		h.messages([
			{ role: "custom", customType: "background", content: `Progress check-in ${index}` },
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: `Update ${index}` }] },
		]);
	}
	h.settle();
	assert.equal(RpcClient.prototype.getLastAssistantText.mock.callCount(), 0);
	assert.match((await h.call("background_status", { id: child.details.id })).content[0].text, /running/);
});

test("a child records lifecycle metadata without retaining mutable message payloads", async t => {
	const h = setup(t);
	await h.open();
	const child = await h.start();
	const [call, result] = waitEnding();
	h.messages([call, result]);
	// SDK message objects and their content can change after delivery. The
	// child's wait decision must use the metadata observed at message_end.
	call.content[0].name = "read";
	call.content[0].id = "changed";
	call.content.push({ type: "toolCall", name: "write", id: "later" });
	result.toolCallId = "changed";
	result.isError = true;
	h.settle();
	assert.equal(RpcClient.prototype.getLastAssistantText.mock.callCount(), 0);
	assert.match((await h.call("background_status", { id: child.details.id })).content[0].text, /running/);
});

for (const waitLast of [false, true]) {
	for (const waitResultLast of [false, true]) {
		test(`child sibling calls follow content order (wait last: ${waitLast}, wait result last: ${waitResultLast})`, async t => {
			const h = setup(t);
			await h.open();
			const child = await h.start();
			const [call, result] = waitEnding();
			const sibling = { type: "toolCall", name: "read", id: "read", arguments: {} };
			call.content[waitLast ? "unshift" : "push"](sibling);
			const siblingResult = { role: "toolResult", toolName: "read", toolCallId: "read", isError: true, content: [] };
			h.messages([call, ...(waitResultLast ? [siblingResult, result] : [result, siblingResult])]);
			h.settle();
			if (waitLast) {
				assert.equal(RpcClient.prototype.getLastAssistantText.mock.callCount(), 0, "No final reply is required");
				assert.match((await h.call("background_status", { id: child.details.id })).content[0].text, /running/);
			} else {
				assert.equal((await h.nextNotice()).details.state, "completed");
			}
		});
	}
}

for (const failure of ["missing result", "failed result", "missing success flag", "wrong id", "wrong name"]) {
	test(`a child does not wait after a latest wait with ${failure}`, async t => {
		const h = setup(t);
		await h.open();
		await h.start();
		// A successful earlier wait cannot rescue the latest incomplete or failed call.
		h.messages(waitEnding());
		const [call, result] = waitEnding();
		call.content[0].id = result.toolCallId = "latest-wait";
		if (failure === "failed result") result.isError = true;
		if (failure === "missing success flag") delete result.isError;
		if (failure === "wrong id") result.toolCallId = "unrelated";
		if (failure === "wrong name") result.toolName = "read";
		h.messages(failure === "missing result" ? [call] : [call, result]);
		h.settle();
		assert.equal((await h.nextNotice()).details.state, "completed");
	});
}

test("a later tool call ends a child wait even when the old wait result arrives last", async t => {
	const h = setup(t);
	await h.open();
	await h.start();
	const [call, result] = waitEnding();
	h.messages([
		call,
		{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "read", id: "read", arguments: {} }] },
		{ role: "toolResult", toolName: "read", toolCallId: "read", isError: false, content: [] },
		result,
	]);
	h.settle();
	assert.equal((await h.nextNotice()).details.state, "completed");
});

for (const restoresWait of [false, true]) {
	test(`delivered user input clears a child wait${restoresWait ? " and a new successful wait restores it" : " despite a late old result"}`, async t => {
		const h = setup(t);
		await h.open();
		const child = await h.start();
		const [oldCall, oldResult] = waitEnding();
		h.messages([
			oldCall, oldResult,
			{ role: "user", content: "Change direction" },
			oldResult,
			{ role: "custom", content: "Background check-in" },
		]);
		if (restoresWait) {
			const [call, result] = waitEnding();
			call.content[0].id = result.toolCallId = "new-wait";
			h.messages([call, result]);
		}
		h.settle();
		if (restoresWait) {
			assert.equal(RpcClient.prototype.getLastAssistantText.mock.callCount(), 0);
			assert.match((await h.call("background_status", { id: child.details.id })).content[0].text, /running/);
		} else {
			assert.equal((await h.nextNotice()).details.state, "completed");
		}
	});
}

test("accepting queued input does not reset a wait before the user message is delivered", async t => {
	const h = setup(t);
	await h.open();
	const child = await h.start();
	h.messages(waitEnding().slice(0, 2));
	await h.call("background_send", { id: child.details.id, message: "Queued instruction" });
	h.settle();
	assert.equal(RpcClient.prototype.getLastAssistantText.mock.callCount(), 0);
	assert.match((await h.call("background_status", { id: child.details.id })).content[0].text, /running/);
});

for (const [type, stopReason] of [["auto_retry_start", "error"], ["compaction_start", "error"], ["compaction_start", "length"]]) {
	test(`a recovered ${type} ${stopReason} attempt preserves the current run's wait`, async t => {
		const h = setup(t);
		await h.open();
		await h.start();
		const ending = waitEnding();
		h.messages(ending.slice(0, 2));
		h.messages([{ role: "assistant", content: [], stopReason, errorMessage: "Temporary failure" }]);
		h.emit({ type, reason: "overflow" });
		h.emit({ type: "agent_start" });
		h.messages([ending[2]]);
		h.settle();
		assert.equal(RpcClient.prototype.getLastAssistantText.mock.callCount(), 0, "Recovery is part of the same logical run");
		h.emit({ type: "agent_start" });
		h.messages([{ role: "assistant", content: [], stopReason: "stop" }]);
		h.settle();
		assert.equal((await h.nextNotice()).details.state, "completed");
	});
}

for (const aborted of [false, true]) {
	for (const stopReason of ["error", "length"]) {
		test(`overflow recovery ${aborted ? "cancellation" : "failure"} finalizes a waiting child (${stopReason})`, async t => {
			const h = setup(t);
			await h.open(); await h.start();
			h.messages([...waitEnding(), { role: "assistant", content: [], stopReason }]);
			h.emit({ type: "compaction_start", reason: "overflow" });
			h.emit({ type: "compaction_end", reason: "overflow", aborted, errorMessage: aborted ? undefined : "Recovery failed" });
			RpcClient.prototype.getLastAssistantText.mock.mockImplementation(async () => "");
			h.settle();
			assert.equal((await h.nextNotice()).details.state, aborted ? "completed" : "failed");
		});
	}
}

test("cancelling a retry after a failed final reply cannot leave the child waiting", async t => {
	const h = setup(t);
	await h.open();
	await h.start();
	h.messages([...waitEnding().slice(0, 2), { role: "assistant", content: [], stopReason: "error", errorMessage: "Overloaded" }]);
	h.emit({ type: "auto_retry_start" });
	h.emit({ type: "auto_retry_end", success: false, finalError: "Retry cancelled" });
	RpcClient.prototype.getLastAssistantText.mock.mockImplementation(async () => "");
	h.settle();
	assert.equal((await h.nextNotice()).details.state, "failed");
});

for (const [name, ending, extra] of [
	["error", [...waitEnding(), { role: "assistant", content: [], stopReason: "error", errorMessage: "Child failed" }]],
	["abort reply", [...waitEnding(), { role: "assistant", content: [], stopReason: "aborted" }]],
	["newer aborted settlement", waitEnding(), { aborted: true }],
	["newer error settlement", waitEnding(), { error: true }],
	["new input", [...waitEnding(), { role: "user", content: "Change direction" }]],
]) {
	test(`a child cannot keep waiting after ${name}`, async t => {
		const h = setup(t);
		await h.open();
		await h.start();
		h.messages([...ending, { role: "custom", content: "A late progress notice" }]);
		RpcClient.prototype.getLastAssistantText.mock.mockImplementation(async () => "");
		h.settle(undefined, extra);
		assert.equal((await h.nextNotice()).details.state, name === "error" || name === "newer error settlement" ? "failed" : "completed");
	});
}

for (const wakeMessages of [[], [{ role: "custom", content: "Nested task finished" }]]) {
	test(`a fresh child wake cannot reuse the previous run's wait (${wakeMessages.length ? "notice only" : "silent"})`, async t => {
		const h = setup(t);
		await h.open();
		await h.start();
		h.messages(waitEnding());
		h.settle();
		h.emit({ type: "agent_start" });
		h.messages(wakeMessages);
		h.settle();
		assert.equal((await h.nextNotice()).details.state, "completed");
	});
}

test("sending to an idle waiting child starts it instead of only queuing steering", async t => {
	const h = setup(t);
	await h.open();
	const child = await h.start();
	h.messages(waitEnding());
	h.settle();
	await h.call("background_send", { id: child.details.id, message: "Change direction" });
	assert.deepEqual(RpcClient.prototype.prompt.mock.calls[1].arguments, ["Change direction", undefined, "steer"]);
	assert.equal(RpcClient.prototype.steer.mock.callCount(), 0);
});

test("stopping a waiting child immediately releases its runtime and ignores late completion", async t => {
	const h = setup(t);
	await h.open();
	const child = await h.start();
	h.messages(waitEnding());
	h.settle();
	await h.call("background_stop", { id: child.details.id });
	assert.equal(RpcClient.prototype.stop.mock.callCount(), 1);
	h.settle();
	assert.equal(RpcClient.prototype.getLastAssistantText.mock.callCount(), 0);
});

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
	h.messages(waitEnding());
	h.settle();
	RpcClient.prototype.getState.mock.mockImplementation(async () => { throw new Error("Child process exited"); });
	await h.call("background_status", { id: child.details.id });
	assert.equal((await h.nextNotice()).details.state, "failed");
});

test("a stopping shell cannot be used as a future wake-up", async t => {
	const h = setup(t);
	await h.open();
	const shell = await h.call("background_start", { kind: "shell", command: "sleep 60" });
	await h.call("background_stop", { id: shell.details.id });
	await assert.rejects(h.call("background_wait", {}), /No background tasks are running/);
});

test("shell completion still delivers its completion notice after background_wait", { timeout: 5_000 }, async t => {
	const h = setup(t);
	await h.open();
	await h.call("background_start", { kind: "shell", command: "sleep 0.1" });
	await h.call("background_wait", {});
	await h.nextNotice();
	await assert.rejects(h.call("background_wait", {}), /No background tasks are running/);
});

test("background_wait rejects cancellation and shutdown", async t => {
	const h = setup(t);
	await h.open();
	await h.start();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(h.tools.get("background_wait").execute("cancelled", {}, controller.signal, undefined, h.ctx), /cancelled/);
	await h.close();
	await assert.rejects(h.call("background_wait", {}), /cancelled/);
});

test("the wait decision uses the last tool call and a matching later successful result", () => {
	assert.equal(isBackgroundWaitEnding(waitEnding()), true);
	assert.equal(isBackgroundWaitEnding(waitEnding().slice(0, 2)), true, "No final assistant reply is required");
	for (const count of [0, 1]) assert.equal(isBackgroundWaitEnding(waitEnding().slice(0, count)), false);
	const rejected = [
		messages => { messages[1].isError = true; },
		messages => { delete messages[1].isError; },
		messages => { messages[1].toolCallId = "other"; },
		messages => { messages[1].toolName = "other"; },
		messages => { messages[0].content[0].id = messages[1].toolCallId = ""; },
		messages => { messages[0].content.push({ type: "toolCall", name: "read", id: "read" }); },
		messages => { messages[2].content.push({ type: "toolCall", name: "read", id: "read" }); },
		messages => { messages.splice(2, 0, { role: "user", content: "New instruction" }); },
		messages => { messages.unshift(messages.splice(1, 1)[0]); },
	];
	for (const change of rejected) {
		const messages = waitEnding();
		change(messages);
		assert.equal(isBackgroundWaitEnding(messages), false, change.toString());
	}
	const accepted = [
		messages => { messages[0].stopReason = "stop"; },
		messages => { messages[2].stopReason = "pending"; },
		messages => { messages[2].stopReason = "error"; },
		messages => { messages[2].stopReason = "aborted"; },
		messages => { messages[0].content.unshift({ type: "toolCall", name: "read", id: "read" }); },
		messages => { messages.splice(2, 0, { role: "custom", content: "Background finished" }); },
		messages => { messages.splice(2, 0, { role: "assistant", content: [], stopReason: "stop" }); },
	];
	for (const change of accepted) {
		const messages = waitEnding();
		change(messages);
		assert.equal(isBackgroundWaitEnding(messages), true, change.toString());
	}
});
