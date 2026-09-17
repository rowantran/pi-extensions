import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, readFileSync, statSync, utimesSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getPackageDir, RpcClient, SessionManager } from "@earendil-works/pi-coding-agent";
import { AGENT_REFERENCE_ENTRY, readSavedAgent } from "../background/sessions.ts";
import { fixture, harness, installProvider } from "./background-helpers.mjs";

function mockClients(t) {
	const clients = [];
	t.mock.method(RpcClient.prototype, "start", async function () { clients.push(this); });
	t.mock.method(RpcClient.prototype, "getState", async function () {
		const saved = readSavedAgent(this.options.args[1]);
		return { sessionId: saved.sessionId, sessionFile: saved.sessionFile };
	});
	t.mock.method(RpcClient.prototype, "prompt", async () => {});
	t.mock.method(RpcClient.prototype, "steer", async () => {});
	t.mock.method(RpcClient.prototype, "abort", async () => {});
	t.mock.method(RpcClient.prototype, "stop", async () => {});
	t.mock.method(RpcClient.prototype, "waitForIdle", () => { throw new Error("Must not impose a 60-second run limit"); });
	return clients;
}

for (const provider of ["isara", "openai", "custom-provider"]) {
	test(`${provider} agents persist their initial task and use normal Pi discovery`, async (t) => {
		const f = fixture(t);
		const clients = mockClients(t);
		const h = harness(t, f, { provider, id: "test-model" });
		const result = await h.call("background_start", { kind: "agent", task: "Remember the original task.", cwd: f.cwd });
		const { id, sessionId, sessionFile } = result.details;
		assert.equal(id, `agent-${sessionId}`);
		assert.equal(dirname(sessionFile), join(f.cwd, ".pi", "subagents"));
		assert.equal(statSync(sessionFile).mode & 0o777, 0o600);
		assert.ok(result.content[0].text.includes(sessionFile));
		assert.deepEqual(clients[0].options, {
			cliPath: fileURLToPath(new URL("../background/runner.mjs", import.meta.url)),
			cwd: f.cwd,
			env: { PI_BACKGROUND_CLI_PATH: resolve(getPackageDir(), "dist", "cli.js") },
			args: ["--session", sessionFile, "--session-dir", dirname(sessionFile)],
		});
		const sm = SessionManager.open(sessionFile);
		assert.equal(sm.getHeader().parentSession, f.parentFile);
		assert.deepEqual(sm.buildSessionContext().model, { provider, modelId: "test-model" });
		assert.equal(sm.buildSessionContext().thinkingLevel, "high");
		assert.ok(sm.buildSessionContext().messages[0].content.endsWith("Task: Remember the original task."));
		assert.ok(h.parent.getBranch().some(e => e.type === "custom" && e.customType === AGENT_REFERENCE_ENTRY && e.data.sessionFile === sessionFile));
		assert.equal(result.details.state, "running");
	});
}

test("startup failures keep the durable session and reference for recovery", async (t) => {
	const f = fixture(t);
	mockClients(t);
	RpcClient.prototype.start.mock.mockImplementation(async () => { throw new Error("Simulated startup crash"); });
	const h = harness(t, f);
	await assert.rejects(h.call("background_start", { kind: "agent", task: "Do not lose this task" }), /Simulated startup crash[\s\S]*Saved session:/);
	const ref = h.parent.getBranch().find(e => e.type === "custom" && e.customType === AGENT_REFERENCE_ENTRY).data;
	assert.ok(existsSync(ref.sessionFile));
	assert.equal(readSavedAgent(ref.sessionFile).task, "Do not lose this task");
});

test("resuming a stopped agent respects running capacity", async (t) => {
	const f = fixture(t);
	mockClients(t);
	const h = harness(t, f);
	const ids = [];
	for (let i = 0; i < 4; i++) ids.push((await h.call("background_start", { kind: "agent", task: `Task ${i}` })).details.id);
	await assert.rejects(h.call("background_start", { kind: "agent", task: "Too many" }), /At most 4/);
	await h.call("background_stop", { id: ids[0] });
	await h.call("background_start", { kind: "agent", task: "Fill the free slot" });
	await assert.rejects(h.call("background_send", { id: ids[0], message: "Continue" }), /At most 4/);
});

test("concurrent resume calls start only one run", async (t) => {
	const f = fixture(t);
	mockClients(t);
	const h = harness(t, f);
	const started = await h.call("background_start", { kind: "agent", task: "One run at a time" });
	await h.call("background_stop", { id: started.details.id });
	const results = await Promise.allSettled([
		h.call("background_send", { id: started.details.id, message: "First continuation" }),
		h.call("background_send", { id: started.details.id, message: "Second continuation" }),
	]);
	assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
	assert.match(results.find(result => result.status === "rejected").reason.message, /starting|running/);
	assert.equal(RpcClient.prototype.prompt.mock.callCount(), 2);
});

test("a real saved child discovers resources and survives a parent restart", { timeout: 30_000 }, async (t) => {
	const f = fixture(t);
	installProvider(f);
	const originalPrompt = RpcClient.prototype.prompt;
	t.mock.method(RpcClient.prototype, "prompt", async function (message) {
		const names = (await this.getCommands()).map(command => command.name);
		for (const name of ["discovery-command", "skill:discovery-skill", "discovery-prompt"]) assert.ok(names.includes(name));
		return originalPrompt.call(this, message);
	});
	const h = harness(t, f);
	const started = await h.call("background_start", { kind: "agent", task: "Remember durable-token-823." });
	const completed = await h.nextNotice();
	assert.equal(completed.details.state, "completed");
	assert.ok(completed.content.includes("durable-token-823"));
	assert.equal(completed.details.sessionFile, started.details.sessionFile);
	const sessionId = started.details.sessionId;
	assert.ok(!(await SessionManager.list(f.cwd)).some(session => session.id === sessionId));
	assert.ok(!(await SessionManager.listAll()).some(session => session.id === sessionId));
	await h.close();

	const restarted = harness(t, f, { provider: "different-parent", id: "different-model" });
	await restarted.open();
	assert.match((await restarted.call("background_status", {})).content[0].text, new RegExp(started.details.id));
	const resumed = await restarted.call("background_send", { id: started.details.id, message: "What was the original token?" });
	assert.equal(resumed.details.sessionId, sessionId);
	const notice = await restarted.nextNotice();
	assert.equal(notice.details.state, "completed");
	assert.ok(notice.content.includes("durable-token-823"));
	const text = (await restarted.call("background_output", { id: started.details.id })).content[0].text;
	const output = JSON.parse(text);
	assert.equal(output.provider, "discovery-provider");
	assert.equal(output.model, "discovery-model");
	assert.ok(output.users.at(-1).includes("What was the original token?"));
	const headers = readFileSync(started.details.sessionFile, "utf8").trim().split("\n").map(JSON.parse).filter(e => e.type === "session");
	assert.equal(headers.length, 1);
	assert.equal(headers[0].id, sessionId);
});

test("idle runtime cleanup preserves the file and background_send reopens it", { timeout: 30_000 }, async (t) => {
	const f = fixture(t);
	installProvider(f);
	const reapers = [];
	const setTimeoutOriginal = globalThis.setTimeout;
	t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
		if (delay === 300_000) {
			reapers.push(callback);
			return setTimeoutOriginal(() => {}, 3_600_000);
		}
		return setTimeoutOriginal(callback, delay, ...args);
	});
	const released = Promise.withResolvers();
	const stop = RpcClient.prototype.stop;
	t.mock.method(RpcClient.prototype, "stop", async function () { await stop.call(this); released.resolve(); });
	const h = harness(t, f);
	const started = await h.call("background_start", { kind: "agent", task: "Remember idle-token." });
	await h.nextNotice();
	assert.equal(reapers.length, 1);
	reapers.shift()();
	await released.promise;
	assert.ok(existsSync(started.details.sessionFile));
	await h.call("background_send", { id: started.details.id, message: "Continue after cleanup." });
	const notice = await h.nextNotice();
	assert.equal(notice.details.state, "completed");
	assert.ok(notice.content.includes("idle-token"));
});

test("a killed child can resume saved history after a parent restart and torn-tail repair", { timeout: 30_000 }, async (t) => {
	const f = fixture(t);
	installProvider(f);
	let client;
	const start = RpcClient.prototype.start;
	t.mock.method(RpcClient.prototype, "start", async function () { client = this; await start.call(this); });
	const h = harness(t, f);
	const started = await h.call("background_start", { kind: "agent", task: "Remember crash-token." });
	await h.nextNotice();
	const busy = Promise.withResolvers();
	const unsubscribe = client.onEvent(event => {
		if (event.type === "message_start" && event.message.role === "assistant") busy.resolve();
	});
	await h.call("background_send", { id: started.details.id, message: "WAIT_FOREVER" });
	await busy.promise;
	unsubscribe();
	assert.ok(readFileSync(started.details.sessionFile, "utf8").includes("WAIT_FOREVER"));
	const exited = once(client.process, "exit");
	client.process.kill("SIGKILL");
	await exited;
	await h.call("background_status", { id: started.details.id });
	assert.equal((await h.nextNotice()).details.state, "failed");
	await h.close();
	assert.ok(existsSync(started.details.sessionFile));
	// Simulate elapsed stale-lock time without delaying the test suite.
	const expired = new Date(Date.now() - 30_000);
	utimesSync(`${started.details.sessionFile}.lock`, expired, expired);
	appendFileSync(started.details.sessionFile, '{"type":"message","broken":');
	const restarted = harness(t, f);
	await restarted.open();
	await restarted.call("background_send", { id: started.details.id, message: "Resume after the crash." });
	const notice = await restarted.nextNotice();
	assert.equal(notice.details.state, "completed");
	assert.ok(notice.content.includes("crash-token"));
	assert.ok(notice.content.includes("WAIT_FOREVER"));
	for (const line of readFileSync(started.details.sessionFile, "utf8").trim().split("\n")) JSON.parse(line);
});

test("a second parent cannot open a session with a live writer", { timeout: 30_000 }, async (t) => {
	const f = fixture(t);
	installProvider(f);
	const busy = Promise.withResolvers();
	const start = RpcClient.prototype.start;
	t.mock.method(RpcClient.prototype, "start", async function () {
		this.onEvent(event => {
			if (event.type === "message_start" && event.message.role === "assistant") busy.resolve();
		});
		await start.call(this);
	});
	const h = harness(t, f);
	const started = await h.call("background_start", { kind: "agent", task: "WAIT_FOREVER; remember writer-token." });
	await busy.promise;
	const before = readFileSync(started.details.sessionFile, "utf8");
	const other = harness(t, f);
	await assert.rejects(other.call("background_send", { id: started.details.sessionFile, message: "Do not run twice" }), /live process|locked/);
	assert.equal(readFileSync(started.details.sessionFile, "utf8"), before);
	await h.close();
	await other.call("background_send", { id: started.details.sessionFile, message: "Resume now that the owner has stopped." });
	assert.ok((await other.nextNotice()).content.includes("writer-token"));
});

test("a killed parent leaves a discoverable child session that a new parent can resume", { timeout: 30_000 }, async (t) => {
	const f = fixture(t);
	installProvider(f);
	const script = `
		import { harness } from ${JSON.stringify(new URL("./background-helpers.mjs", import.meta.url).href)};
		const f = ${JSON.stringify({ cwd: f.cwd, parentFile: f.parentFile, cleanup: [] })};
		const h = harness({}, f);
		await h.open();
		const result = await h.call("background_start", { kind: "agent", task: "WAIT_FOREVER; remember parent-crash-token." });
		console.log(JSON.stringify(result.details));
	`;
	const parent = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
	f.cleanup.push(async () => {
		if (parent.exitCode === null && parent.signalCode === null) {
			const exit = once(parent, "exit"); parent.kill("SIGKILL"); await exit;
		}
	});
	const started = await new Promise((resolve, reject) => {
		let output = "";
		parent.on("error", reject);
		parent.stdout.on("data", chunk => {
			output += chunk;
			if (output.includes("\n")) {
				try { resolve(JSON.parse(output.slice(0, output.indexOf("\n")))); } catch (error) { reject(error); }
			}
		});
	});
	const released = Promise.withResolvers();
	const watcher = watch(dirname(started.sessionFile), () => {
		if (!existsSync(`${started.sessionFile}.lock`) && !existsSync(`${started.sessionFile}.owner.json`)) released.resolve();
	});
	f.cleanup.push(() => watcher.close());
	const exited = once(parent, "exit");
	parent.kill("SIGKILL");
	await exited;
	await released.promise;
	watcher.close();
	const restarted = harness(t, f);
	await restarted.open();
	assert.ok((await restarted.call("background_status", {})).content[0].text.includes(started.id));
	await restarted.call("background_send", { id: started.id, message: "Resume after parent death." });
	assert.ok((await restarted.nextNotice()).content.includes("parent-crash-token"));
});

test("forget only untracks an agent; its file can be resumed explicitly", { timeout: 30_000 }, async (t) => {
	const f = fixture(t);
	installProvider(f);
	const h = harness(t, f);
	const started = await h.call("background_start", { kind: "agent", task: "Remember forgotten-token." });
	await h.nextNotice();
	await h.call("background_forget", { id: started.details.id });
	assert.ok(existsSync(started.details.sessionFile));
	await h.close();
	const restarted = harness(t, f);
	await restarted.open();
	assert.equal((await restarted.call("background_status", {})).content[0].text, "No background activities.");
	await restarted.call("background_send", { id: started.details.sessionFile, message: "Recover the saved conversation." });
	assert.ok((await restarted.nextNotice()).content.includes("forgotten-token"));
});
