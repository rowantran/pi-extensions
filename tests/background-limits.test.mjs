import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import {
	createAgentSessionFromServices, createAgentSessionServices,
	ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import background from "../background.ts";
import { fixture, harness } from "./background-helpers.mjs";

const budget = 128 * 1_024;
const created = { type: "response.created", response: { id: "test-response" } };
const added = (index, name, args = "") => ({ type: "response.output_item.added", output_index: index,
	item: { type: "function_call", id: `item-${index}`, call_id: `call-${index}`, name, arguments: args } });
const delta = (index, text) => ({ type: "response.function_call_arguments.delta", output_index: index, delta: text });

function guard(t) {
	const h = harness(t, fixture(t));
	const abort = t.mock.method(h.ctx, "abort");
	const notify = t.mock.method(h.ctx.ui, "notify");
	const emit = (data, api = "openai-responses") => h.emit("provider_stream_event", { api, data });
	emit(created);
	return { emit, abort, notify };
}

for (const name of ["background_start", "background_send"]) {
	test(`${name} stream accepts exactly 128 KiB and aborts once above it`, (t) => {
		const { emit, abort, notify } = guard(t);
		emit(added(0, name));
		emit(delta(0, "x".repeat(budget)));
		assert.equal(abort.mock.callCount(), 0);
		emit(delta(0, "x"));
		emit(delta(0, "x".repeat(budget)));
		assert.equal(abort.mock.callCount(), 1);
		assert.match(notify.mock.calls[0].arguments[0], /128 KiB.*instruction was not sent/);
		emit(created);
		emit(added(0, name));
		emit(delta(0, "x".repeat(budget + 1)));
		assert.equal(abort.mock.callCount(), 2, "A new response resets the guard");
	});
}

test("interleaved calls have separate budgets; other tools and APIs are untouched", (t) => {
	const { emit, abort } = guard(t);
	emit(added(0, "write"));
	emit(delta(0, "x".repeat(budget * 2)));
	emit(added(1, "background_send"));
	emit(added(2, "background_start"));
	emit(delta(1, "x".repeat(budget / 2)));
	emit(delta(2, "x".repeat(budget / 2)));
	emit(delta(1, "x".repeat(budget / 2)));
	emit(delta(1, "x"), "openai-completions");
	assert.equal(abort.mock.callCount(), 0);
	emit(delta(1, "x"));
	assert.equal(abort.mock.callCount(), 1);
});

test("stream budget counts UTF-8 bytes and allows JSON escaping overhead", (t) => {
	const { emit, abort } = guard(t);
	const args = JSON.stringify({ id: "agent-test", message: '\n"\\'.repeat(5_461) });
	assert.ok(args.length > 16_384);
	emit(added(0, "background_send"));
	emit(delta(0, args));
	assert.equal(abort.mock.callCount(), 0);
	emit(added(1, "background_send"));
	emit(delta(1, "é".repeat(budget / 2)));
	assert.equal(abort.mock.callCount(), 0);
	emit(delta(1, "é"));
	assert.equal(abort.mock.callCount(), 1);
});

for (const stage of ["added", "arguments.done", "item.done"]) {
	test(`oversized ${stage} arguments also abort`, (t) => {
		const { emit, abort } = guard(t);
		const args = "x".repeat(budget + 1);
		emit(added(0, "background_send", stage === "added" ? args : ""));
		if (stage === "arguments.done") {
			emit({ type: "response.function_call_arguments.done", output_index: 0, arguments: args });
		} else if (stage === "item.done") {
			emit({ ...added(0, "background_send", args), type: "response.output_item.done" });
		}
		assert.equal(abort.mock.callCount(), 1);
	});
}

const sse = (events) => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

// Real SDK, Responses parser, and OpenAI SSE transport; only fetch is faked.
// Put every event in one body chunk to exercise cancellation of buffered events.
for (const name of ["background_send", "background_start"]) {
	test(`real Pi aborts a buffered 700 KB ${name} stream and remains usable`, { timeout: 20_000 }, async (t) => {
		const f = fixture(t);
		mkdirSync(f.agentDir, { recursive: true });
		const authPath = join(f.agentDir, "auth.json");
		writeFileSync(authPath, "{}\n");
		t.mock.method(globalThis, "fetch", () => { throw new Error("External network access is forbidden"); });
		const prefix = name === "background_send" ? '{"id":"unused","message":"' : '{"kind":"agent","task":"';
		const events = [created, added(0, name), delta(0, prefix)];
		for (let size = 0; size < 700_000; size += 256) events.push(delta(0, "x".repeat(256)));
		const args = prefix + "x".repeat(700_160) + '"}';
		events.push({ type: "response.function_call_arguments.done", output_index: 0, arguments: args },
			{ ...added(0, name, args), type: "response.output_item.done" },
			{ type: "response.completed", response: { id: "test-response", status: "completed", output: [] } });
		const second = [created,
			{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "text", role: "assistant", content: [] } },
			{ type: "response.output_text.delta", output_index: 0, delta: "Still responsive." },
			{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "text", role: "assistant", content: [{ type: "output_text", text: "Still responsive." }] } },
			{ type: "response.completed", response: { id: "second-response", status: "completed", output: [] } }];
		let requests = 0;
		let bytesConsumed = 0;
		let requestSignal;
		const notifications = [];
		const errors = [];
		const fetch = async (_url, init) => {
			requestSignal = init.signal;
			const payload = new TextEncoder().encode(sse(requests++ === 0 ? events : second));
			return new Response(new ReadableStream({ start(controller) { controller.enqueue(payload); controller.close(); } }),
				{ headers: { "content-type": "text/event-stream" } });
		};
		const modelRuntime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
		const services = await createAgentSessionServices({
			cwd: f.cwd, agentDir: f.agentDir, modelRuntime,
			settingsManager: SettingsManager.inMemory({ defaultProvider: "background-limit-test", defaultModel: "test",
				compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }),
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
				extensionFactories: [background, (pi) => {
					pi.registerProvider("background-limit-test", {
						baseUrl: "http://offline.invalid/v1", apiKey: "unused-test-key", api: "openai-responses",
						models: [{ id: "test", name: "Offline limit test", reasoning: false, input: ["text"],
							contextWindow: 128_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
						streamSimple: (model, context, options) => streamSimple(model, context, { ...options, apiKey: "unused-test-key", fetch }),
					});
					pi.on("provider_stream_event", (event) => {
						if (event.data.type === "response.function_call_arguments.delta") bytesConsumed += Buffer.byteLength(event.data.delta);
					});
				}],
			},
		});
		assert.deepEqual(services.diagnostics, []);
		const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(f.cwd), tools: [] });
		f.cleanup.push(async () => { await session.extensionRunner?.emit({ type: "session_shutdown" }); session.dispose(); });
		await session.bindExtensions({ mode: "rpc", uiContext: { setStatus() {}, setWidget() {}, notify: (message) => notifications.push(message) }, onError: error => errors.push(error) });
		const executions = [];
		session.subscribe(event => { if (event.type === "tool_execution_start") executions.push(event); });
		await session.prompt("Generate an oversized background instruction.");
		assert.equal(requests, 1);
		assert.equal(requestSignal.aborted, true);
		assert.ok(bytesConsumed > budget && bytesConsumed <= budget + 256, `Consumed ${bytesConsumed} bytes, not the full 700 KB`);
		assert.equal(session.messages.at(-1).stopReason, "aborted");
		assert.equal(session.isIdle, true);
		assert.deepEqual(executions, []);
		assert.deepEqual(errors, []);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0], /instruction was not sent/);
		await session.prompt("Are you still responsive?");
		assert.equal(session.getLastAssistantText(), "Still responsive.");
		assert.equal(requests, 2);
	});
}
