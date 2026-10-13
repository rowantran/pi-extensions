import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import background from "../background.ts";
import { fixture } from "./background-helpers.mjs";

const STATUS_KEY = "waiting-on-background";
const STATUS_TEXT = "Waiting on background task";
const provider = "background-wait-integration-test";
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const usage = { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { ...cost, total: 0 } };
const toolCall = (name, args = {}, inspect) => ({ tool: { name, args }, inspect });
const finalText = (text, inspect) => ({ text, inspect });
const textOf = (message) => typeof message.content === "string" ? message.content
	: (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
const resultsOf = (messages, name) => messages.filter((message) => message.role === "toolResult" && message.toolName === name);

function declaredTools(messages) {
	const names = new Set();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) names.add(tool.name);
	}
	return [...names];
}

function isAlive(pid) {
	try { process.kill(pid, 0); return true; }
	catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function assertShellsStopped(pids) {
	const deadline = Date.now() + 2_000;
	while ([...pids].some(isAlive) && Date.now() < deadline) await delay(10);
	assert.deepEqual([...pids].filter(isAlive), [], "Session shutdown must stop every real background shell");
}

// Only model I/O and the host's UI are scripted. Pi owns tool execution, continuation,
// UI-prompt events, run settlement, and the real background shell process.
function streamReply(f, model, context, options) {
	const stream = createAssistantMessageEventStream();
	const step = f.steps.shift();
	const request = { messages: structuredClone(context.messages), tools: declaredTools(context.messages) };
	f.requests.push(request);
	f.record({ type: "provider_request", request: f.requests.length });
	const output = {
		role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
		usage: structuredClone(usage), stopReason: "pending", timestamp: Date.now(),
	};
	queueMicrotask(() => {
		try {
			options?.signal?.throwIfAborted();
			assert.ok(step, "Unexpected model continuation request");
			step.inspect?.(request);
			stream.push({ type: "start", partial: output });
			if (step.tool) {
				const call = { type: "toolCall", id: `integration-call-${f.requests.length}`, name: step.tool.name, arguments: {} };
				output.content.push(call);
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
				call.arguments = step.tool.args;
				stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial: output });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: output });
				output.stopReason = "toolUse";
			} else {
				output.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: 0, partial: output });
				output.content[0].text = step.text;
				stream.push({ type: "text_delta", contentIndex: 0, delta: step.text, partial: output });
				stream.push({ type: "text_end", contentIndex: 0, content: step.text, partial: output });
				output.stopReason = "stop";
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
		} catch (error) {
			if (!options?.signal?.aborted) f.providerErrors.push(error);
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			stream.end();
		}
	});
	return stream;
}

async function setup(t) {
	const f = Object.assign(fixture(t), {
		steps: [], requests: [], timeline: [], statuses: [], currentStatus: undefined,
		providerErrors: [], extensionErrors: [], pids: new Set(),
	});
	f.record = (event) => f.timeline.push({ ...event, waiting: f.currentStatus });
	const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("Network access is forbidden in background wait integration tests"); });
	mkdirSync(f.agentDir, { recursive: true });
	const authPath = join(f.agentDir, "auth.json");
	writeFileSync(authPath, "{}\n", { mode: 0o600 });
	const modelRuntime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	const services = await createAgentSessionServices({
		cwd: f.cwd, agentDir: f.agentDir, modelRuntime,
		settingsManager: SettingsManager.inMemory({
			defaultProvider: provider, defaultModel: "offline", defaultThinkingLevel: "off",
			compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
		}),
		resourceLoaderOptions: {
			noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
			extensionFactories: [background, (pi) => {
				pi.registerProvider(provider, {
					baseUrl: "http://offline.invalid", apiKey: "unused-offline-test-key", api: "openai-completions",
					models: [{ id: "offline", name: "Offline background wait test", reasoning: false, input: ["text"],
						contextWindow: 128_000, maxTokens: 4_096, cost }],
					streamSimple: (model, context, options) => streamReply(f, model, context, options),
				});
				for (const type of ["agent_start", "agent_settled", "tool_execution_start", "tool_execution_end", "ui_prompt_start", "ui_prompt_end"]) {
					pi.on(type, (event) => {
						f.record(event);
						if (type === "tool_execution_end" && event.toolName === "background_start" && !event.isError) {
							const pid = Number(textOf(event.result).match(/\bPID (\d+)\./)?.[1]);
							assert.ok(pid > 0, "The actual shell start result must report its PID");
							f.pids.add(pid);
						}
					});
				}
			}],
		},
	});
	assert.deepEqual(services.diagnostics, []);
	assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
	const { session } = await createAgentSessionFromServices({
		services, sessionManager: SessionManager.open(f.parentFile), tools: ["background_start", "background_wait"],
	});
	f.session = session;
	f.cleanup.push(async () => {
		await session.abort();
		try {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
		} finally {
			session.dispose();
		}
		await assertShellsStopped(f.pids);
		assert.equal(fetch.mock.callCount(), 0, "No external fetches");
	});

	await session.bindExtensions({
		mode: "rpc",
		uiContext: {
			setStatus(key, value) {
				if (key !== STATUS_KEY) return;
				f.currentStatus = value;
				f.statuses.push(value);
				f.record({ type: "status", key, value });
			},
			setWidget() {}, notify() {},
		},
		onError: (error) => f.extensionErrors.push(error),
	});
	assert.equal(session.getAllTools().find((tool) => tool.name === "background_wait")?.exposure, "model-only");
	assert.ok(session.getActiveToolNames().includes("background_wait"), "background_wait is declared directly to the model");
	assert.equal(session.getCallableToolNames().includes("background_wait"), false, "background_wait cannot be invoked from codemode/nested tools");
	f.assertHealthy = () => {
		assert.deepEqual(f.providerErrors, []);
		assert.deepEqual(f.extensionErrors, []);
		assert.equal(session.messages.at(-1).stopReason, "stop", session.messages.at(-1).errorMessage);
		assert.deepEqual(f.steps, [], "Every scripted continuation must run");
		assert.equal(session.isIdle, true);
	};
	return f;
}

test("a failed background_wait automatically follows up in the same real SDK run without a waiting status", { timeout: 20_000 }, async (t) => {
	const f = await setup(t);
	f.steps.push(toolCall("background_wait"), finalText("No background work is running; continuing now.", ({ messages }) => {
		const result = resultsOf(messages, "background_wait").at(-1);
		assert.equal(result.isError, true);
		assert.match(textOf(result), /No background tasks are running/);
	}));
	await f.session.prompt("Wait if there is running background work.");
	f.assertHealthy();
	assert.equal(f.requests.length, 2, "The failed tool result triggers a model follow-up without a second user prompt");
	assert.ok(f.requests.every(({ tools }) => tools.includes("background_wait")));
	assert.equal(f.session.getLastAssistantText(), "No background work is running; continuing now.");
	assert.deepEqual(f.statuses, [undefined]);
	assert.equal(f.timeline.filter((event) => event.type === "agent_start").length, 1);
	assert.equal(f.timeline.filter((event) => event.type === "agent_settled").length, 1);
	const failed = f.timeline.findIndex((event) => event.type === "tool_execution_end" && event.toolName === "background_wait");
	const followUp = f.timeline.findIndex((event) => event.type === "provider_request" && event.request === 2);
	const settled = f.timeline.findIndex((event) => event.type === "agent_settled");
	assert.equal(f.timeline[failed].isError, true);
	assert.ok(failed < followUp && followUp < settled, "Failure precedes the automatic response, which precedes settlement");
	assert.ok(f.timeline.every((event) => event.waiting === undefined));
});

test("waiting survives settlement and clears before a plain-text question on the next run", { timeout: 20_000 }, async (t) => {
	const f = await setup(t);
	f.steps.push(
		toolCall("background_start", { kind: "shell", command: "sleep 60", name: "Integration waiting task" }),
		toolCall("background_wait"),
		finalText("Waiting for the background task.", ({ messages }) => {
			const start = resultsOf(messages, "background_start").at(-1);
			const wait = resultsOf(messages, "background_wait").at(-1);
			assert.equal(start.isError, false);
			assert.equal(wait.isError, false);
			assert.deepEqual(wait.details, { waitingOnBackground: true, activities: [start.details.id] });
		}),
	);
	await f.session.prompt("Start a long background task, then wait for it.");
	f.assertHealthy();
	assert.equal(f.requests.length, 3);
	assert.equal(f.session.getLastAssistantText(), "Waiting for the background task.");
	assert.equal(f.currentStatus, STATUS_TEXT, "Final text must not clear a successful wait");
	assert.equal(f.timeline.find((event) => event.type === "agent_settled").waiting, STATUS_TEXT);
	assert.deepEqual(f.statuses, [undefined, STATUS_TEXT]);
	assert.equal(f.pids.size, 1);
	assert.ok([...f.pids].every(isAlive), "The actual sleep process is still running after settlement");

	const question = "Should I keep the task running?";
	const boundary = f.timeline.length;
	f.steps.push(finalText(question, () => {
		assert.equal(f.currentStatus, undefined, "A new run clears the previous waiting decision before asking");
	}));
	await f.session.prompt("Ask me whether to keep the task running.");
	f.assertHealthy();
	assert.equal(f.requests.length, 4);
	assert.equal(f.session.getLastAssistantText(), question);
	assert.deepEqual(f.statuses, [undefined, STATUS_TEXT, undefined]);
	assert.ok([...f.pids].every(isAlive), "A running task alone must not suppress a question");
	const events = f.timeline.slice(boundary);
	assert.equal(events.filter((event) => event.type === "agent_start").length, 1);
	assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
	assert.equal(events.find((event) => event.type === "agent_settled").waiting, undefined);
});
