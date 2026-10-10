import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AGENT_REFERENCE_ENTRY, createSavedAgent } from "../background/sessions.ts";
import { fixture, harness } from "./background-helpers.mjs";

function savedChild(h, f, name = "Child") {
	const child = createSavedAgent(f.cwd, name, "Offline saved task", h.ctx);
	h.parent.appendCustomEntry(AGENT_REFERENCE_ENTRY, { id: child.id, sessionFile: child.sessionFile });
	return child;
}

function addUsage(child, stopReason = "stop") {
	SessionManager.open(child.sessionFile).appendMessage({
		role: "assistant", content: [{ type: "text", text: "Saved response" }],
		api: "openai-completions", provider: "discovery-provider", model: "discovery-model",
		usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 5, totalTokens: 40,
			cost: { input: 0.05, output: 0.1, cacheRead: 0.05, cacheWrite: 0.05, total: 0.25 } },
		stopReason, timestamp: Date.now(),
	});
}

function fakeIntervals(t) {
	const timers = [];
	t.mock.method(globalThis, "setInterval", (callback, delay) => {
		const timer = { callback, delay, cleared: false, unref() {} };
		timers.push(timer);
		return timer;
	});
	t.mock.method(globalThis, "clearInterval", timer => { timer.cleared = true; });
	return timers;
}

for (const mode of ["rpc", "tui"]) {
	test(`${mode} restores usage, follows external appends, retains forgotten spend, and clears on shutdown`, { timeout: 10_000 }, async t => {
		const f = fixture(t);
		const timers = fakeIntervals(t);
		const h = harness(t, f);
		h.ctx.mode = mode;
		const statuses = [];
		let onStatus;
		h.ctx.ui.setStatus = (key, value) => { statuses.push([key, value]); onStatus?.(value); };
		const child = savedChild(h, f);
		addUsage(child);
		const beforeQueries = readFileSync(f.parentFile, "utf8");
		await h.open();
		assert.deepEqual(statuses.at(-1), ["background", "subagents: $0.250"]);
		assert.equal(timers.length, 1);
		assert.equal(timers[0].delay, 5_000);
		const result = await h.call("background_status", {});
		assert.deepEqual(result.details.backgroundUsage, { agents: 1, tokens: 40, cost: 0.25, unavailable: 0 });
		assert.equal(result.usage, undefined, "Separate accounting must not change Pi's own total");
		assert.match(result.content[0].text, /Background usage \(saved, separate from parent\): 1 agent · 40 tokens · \$0\.2500/);
		assert.equal(statuses.length, 1, "Unchanged stats do not generate RPC status traffic");
		assert.equal(readFileSync(f.parentFile, "utf8"), beforeQueries, "Accounting writes nothing to the parent");

		// No local child process is running. The timer must still discover spend
		// written by another/recovered writer, including aborted responses.
		addUsage(child, "aborted");
		const updated = Promise.withResolvers();
		onStatus = value => { if (value === "subagents: $0.500") updated.resolve(); };
		timers[0].callback();
		await updated.promise;
		assert.equal(statuses.at(-1)[1], "subagents: $0.500");
		assert.match((await h.call("background_status", { id: child.id })).content[0].text, /Saved usage \(including nested agents\): 1 agent · 80 tokens · \$0\.5000/);
		await h.call("background_forget", { id: child.id });
		const forgotten = await h.call("background_status", {});
		assert.match(forgotten.content[0].text, /^No background activities\.\nBackground usage/);
		assert.equal(forgotten.details.backgroundUsage.cost, 0.5);
		await h.close();
		assert.deepEqual(statuses.at(-1), ["background", undefined]);
		assert.ok(timers.every(timer => timer.cleared));

		const restarted = harness(t, f);
		restarted.ctx.mode = mode;
		restarted.ctx.ui.setStatus = h.ctx.ui.setStatus;
		await restarted.open();
		assert.equal(statuses.at(-1)[1], "subagents: $0.500");
		assert.match((await restarted.call("background_status", {})).content[0].text, /^No background activities\.\nBackground usage/);
	});
}

test("/background and the status list show each agent's own cost, not the global or nested total", { timeout: 10_000 }, async t => {
	const f = fixture(t);
	const h = harness(t, f);
	h.ctx.mode = "tui";
	const planner = savedChild(h, f, "Planner");
	const reviewer = savedChild(h, f, "Reviewer");
	addUsage(planner);
	addUsage(planner);
	addUsage(reviewer);
	const plannerSession = SessionManager.open(planner.sessionFile);
	const nested = createSavedAgent(f.cwd, "Nested", "Offline nested task", { ...h.ctx, sessionManager: plannerSession });
	plannerSession.appendCustomEntry(AGENT_REFERENCE_ENTRY, { id: nested.id, sessionFile: nested.sessionFile });
	addUsage(nested);
	await h.open();
	await h.call("background_start", { kind: "shell", command: "true", name: "Build" });
	await h.nextNotice();

	const notifications = [];
	h.ctx.ui.notify = message => notifications.push(message);
	await h.command("background");
	const rows = notifications[0].split("\n");
	assert.match(rows.find(line => line.startsWith(`${planner.id} [`)), /Planner · \$0\.500$/);
	assert.match(rows.find(line => line.startsWith(`${reviewer.id} [`)), /Reviewer · \$0\.250$/);
	assert.match(rows.find(line => line.startsWith("shell-1 [")), /Build$/);
	assert.match(rows.at(-1), /3 agents · 160 tokens · \$1\.0000$/);

	addUsage(planner, "aborted");
	const result = await h.call("background_status", {});
	const updatedRows = result.content[0].text.split("\n");
	assert.match(updatedRows.find(line => line.startsWith(`${planner.id} [`)), /Planner · \$0\.750$/);
	assert.match(updatedRows.find(line => line.startsWith(`${reviewer.id} [`)), /Reviewer · \$0\.250$/);
	assert.deepEqual(result.details.backgroundUsage, { agents: 3, tokens: 200, cost: 1.25, unavailable: 0 });
});

test("accounting includes every saved reference even when runtime restoration keeps only 20", async t => {
	const f = fixture(t);
	const h = harness(t, f);
	for (let i = 0; i < 23; i++) addUsage(savedChild(h, f, `Child ${i}`));
	await h.open();
	const result = await h.call("background_status", {});
	assert.equal(result.details.count, 20);
	assert.deepEqual(result.details.backgroundUsage, { agents: 23, tokens: 920, cost: 5.75, unavailable: 0 });
});

for (const mode of ["json", "print"]) {
	test(`${mode} returns saved usage without UI calls or polling timers`, async t => {
		const f = fixture(t);
		const timers = fakeIntervals(t);
		const h = harness(t, f);
		h.ctx.mode = mode;
		const statuses = [];
		h.ctx.ui.setStatus = (...args) => statuses.push(args);
		addUsage(savedChild(h, f));
		await h.open();
		const result = await h.call("background_status", {});
		assert.equal(result.details.backgroundUsage.cost, 0.25);
		await h.close();
		assert.deepEqual(statuses, []);
		assert.deepEqual(timers, []);
	});
}

test("an expired usage UI does not reject a refresh or prevent status results, and can recover", async t => {
	const f = fixture(t);
	const timers = fakeIntervals(t);
	const h = harness(t, f);
	h.ctx.mode = "rpc";
	addUsage(savedChild(h, f));
	h.ctx.ui.setStatus = () => { throw new Error("Extension context is no longer active"); };
	await h.open();
	const result = await h.call("background_status", {});
	assert.equal(result.details.backgroundUsage.cost, 0.25);
	assert.deepEqual(timers, [], "An expired display must not keep scheduling refreshes");
	const statuses = [];
	h.ctx.ui.setStatus = (...args) => statuses.push(args);
	await h.call("background_status", {});
	assert.deepEqual(statuses.at(-1), ["background", "subagents: $0.250"]);
	assert.equal(timers.length, 1);
});

test("a session switch resets usage and discards the old session's in-flight snapshot", async t => {
	const f = fixture(t);
	const timers = fakeIntervals(t);
	const h = harness(t, f);
	h.ctx.mode = "rpc";
	const statuses = [];
	h.ctx.ui.setStatus = (...args) => statuses.push(args);
	const child = savedChild(h, f);
	addUsage(child);
	await h.open();
	addUsage(child);
	timers[0].callback();
	await h.emit("session_shutdown");
	h.ctx.sessionManager = SessionManager.inMemory(f.cwd);
	await h.emit("session_start");
	const status = await h.call("background_status", {});
	assert.deepEqual(status.details.backgroundUsage, { agents: 0, tokens: 0, cost: 0, unavailable: 0 });
	assert.deepEqual(statuses.at(-1), ["background", undefined]);
	assert.ok(!statuses.some(([, text]) => text === "subagents: $0.500"), "An old snapshot must not reach the new UI");
	assert.ok(timers.every(timer => timer.cleared));
});

test("shutdown drops an in-flight usage refresh instead of restoring a stale status", async t => {
	const f = fixture(t);
	const timers = fakeIntervals(t);
	const h = harness(t, f);
	h.ctx.mode = "rpc";
	const statuses = [];
	h.ctx.ui.setStatus = (...args) => statuses.push(args);
	const child = savedChild(h, f);
	addUsage(child);
	await h.open();
	addUsage(child);
	timers[0].callback();
	await h.close();
	const afterShutdown = statuses.length;
	// Joining background_status waits for the outstanding snapshot without
	// making any new UI updates; no arbitrary sleep is needed.
	await h.call("background_status", {});
	assert.equal(statuses.length, afterShutdown);
	assert.deepEqual(statuses.at(-1), ["background", undefined]);
});
