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
import askUser from "../ask-user.ts";
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

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

async function within(promise, timeout = 5_000) {
	let timer;
	try {
		return await Promise.race([promise, new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error("The expected UI dialog did not open")), timeout);
		})]);
	} finally {
		clearTimeout(timer);
	}
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

async function setup(t, { managedBackground = false } = {}) {
	const f = Object.assign(fixture(t), {
		steps: [], requests: [], timeline: [], statuses: [], currentStatus: undefined,
		providerErrors: [], extensionErrors: [], pids: new Set(), dialog: undefined, dialogOpened: deferred(),
	});
	f.record = (event) => f.timeline.push({ ...event, waiting: f.currentStatus });
	// The host UI stubs below represent a normal RPC consumer. Do not inherit
	// the background runner marker unless this test is explicitly a managed child.
	const inheritedBackgroundCliPath = process.env.PI_BACKGROUND_CLI_PATH;
	if (managedBackground) process.env.PI_BACKGROUND_CLI_PATH = "/unused/test/pi-cli.js";
	else delete process.env.PI_BACKGROUND_CLI_PATH;
	f.cleanup.push(() => {
		if (inheritedBackgroundCliPath === undefined) delete process.env.PI_BACKGROUND_CLI_PATH;
		else process.env.PI_BACKGROUND_CLI_PATH = inheritedBackgroundCliPath;
	});
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
			extensionFactories: [background, askUser, (pi) => {
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
		services, sessionManager: SessionManager.open(f.parentFile), tools: ["background_start", "background_wait", "ask_user"],
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

	function openDialog(kind, question, choices, opts) {
		assert.equal(f.dialog, undefined, "Only one UI request may be outstanding");
		const pending = deferred();
		let done = false;
		const onAbort = () => reply(undefined);
		function reply(value) {
			if (done) return;
			done = true;
			opts?.signal?.removeEventListener("abort", onAbort);
			f.record({ type: "dialog_reply", kind, value });
			f.dialog = undefined;
			pending.resolve(value);
		}
		f.dialog = { kind, question, choices, signal: opts?.signal, promise: pending.promise, reply };
		f.record({ type: "dialog_open", kind, question });
		opts?.signal?.addEventListener("abort", onAbort, { once: true });
		if (opts?.signal?.aborted) onAbort();
		f.dialogOpened.resolve(f.dialog);
		return pending.promise;
	}
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
			async input(question, _placeholder, opts) { return openDialog("input", question, undefined, opts); },
			async select(question, choices, opts) { return openDialog("select", question, choices, opts); },
		},
		onError: (error) => f.extensionErrors.push(error),
	});
	for (const name of ["background_wait", "ask_user"]) {
		assert.equal(session.getAllTools().find((tool) => tool.name === name)?.exposure, "model-only");
		assert.ok(session.getActiveToolNames().includes(name), `${name} is declared directly to the model`);
		assert.equal(session.getCallableToolNames().includes(name), false, `${name} cannot be invoked from codemode/nested tools`);
	}
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
	assert.ok(f.requests.every(({ tools }) => tools.includes("background_wait") && tools.includes("ask_user")));
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

test("managed background RPC asks fail explicitly and resume the model without opening an unconsumed dialog", { timeout: 20_000 }, async (t) => {
	const f = await setup(t, { managedBackground: true });
	f.steps.push(toolCall("ask_user", { question: "Should the child proceed?" }), finalText(
		"Should the child proceed? Please ask the user before continuing.",
		({ messages }) => {
			const result = resultsOf(messages, "ask_user").at(-1);
			assert.equal(result.isError, true);
			assert.match(textOf(result), /Report the question in your final response so the parent can ask the user/);
			assert.match(textOf(result), /No user answer was obtained/);
		},
	));
	await f.session.prompt("Ask the user whether you should proceed.");
	f.assertHealthy();
	assert.equal(f.requests.length, 2, "The error is delivered to the model instead of leaving it blocked forever");
	assert.equal(f.dialog, undefined);
	assert.equal(f.timeline.some((event) => event.type === "dialog_open" || event.type === "ui_prompt_start"), false);
	assert.deepEqual(f.statuses, [undefined]);
	assert.equal(f.session.getLastAssistantText(), "Should the child proceed? Please ask the user before continuing.");
});

for (const kind of ["input", "select"]) {
	test(`waiting survives settlement, resets on the next run, and clears before a blocked ${kind} dialog`, { timeout: 20_000 }, async (t) => {
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

		const question = "What should I do while the task runs?";
		const choices = ["Keep running", "Stop later"];
		const answer = kind === "input" ? "  Keep running; I'll review later.  " : "Stop later";
		const args = { question, ...(kind === "select" ? { options: choices } : {}) };
		const boundary = f.timeline.length;
		f.steps.push(
			toolCall("background_wait", {}, () => assert.equal(f.currentStatus, undefined, "agent_start resets the previous run's waiting decision")),
			toolCall("ask_user", args, () => assert.equal(f.currentStatus, STATUS_TEXT, "The second run establishes a fresh wait before asking")),
			finalText("Acknowledged your reply.", ({ messages }) => {
				const result = resultsOf(messages, "ask_user").at(-1);
				assert.equal(result.isError, false);
				assert.equal(result.details.status, "answered");
				assert.equal(result.details.cancelled, false);
				assert.equal(result.details.answer, answer, "The model receives the exact UI response");
				assert.equal(textOf(result), `${kind === "input" ? "User replied" : "Selected"}: ${JSON.stringify(answer)}`);
			}),
		);
		let finished = false;
		const run = f.session.prompt("Wait again, then ask me what to do.").finally(() => { finished = true; });
		// Register a rejection handler while inspecting the blocked run so failures cannot escape.
		run.catch(() => {});
		const dialog = await within(f.dialogOpened.promise);
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(f.dialog, dialog, "The host still has an outstanding UI request");
		assert.ok(dialog.promise instanceof Promise);
		assert.equal(dialog.kind, kind);
		assert.equal(dialog.question, question);
		assert.deepEqual(dialog.choices, kind === "select" ? choices : undefined);
		assert.ok(dialog.signal instanceof AbortSignal);
		assert.equal(dialog.signal.aborted, false);
		assert.equal(f.currentStatus, undefined, "Waiting clears before the user sees the dialog");
		assert.equal(f.session.isIdle, false, "The real SDK run is blocked on user input, not settled");
		assert.equal(finished, false);
		assert.equal(f.requests.length, 5, "No model continuation is requested until the user answers");
		assert.equal(resultsOf(f.session.messages, "ask_user").length, 0, "No answer is fabricated while blocked");
		assert.ok([...f.pids].every(isAlive), "The background shell continues while user input is pending");

		const events = f.timeline.slice(boundary);
		const askStart = events.findIndex((event) => event.type === "tool_execution_start" && event.toolName === "ask_user");
		const opened = events.findIndex((event) => event.type === "dialog_open");
		assert.ok(askStart >= 0 && askStart < opened);
		assert.equal(events[askStart].waiting, undefined, "Tool execution clears the status before calling the UI");
		assert.equal(events[opened].waiting, undefined);
		const blocked = events.find((event) => event.type === "ui_prompt_start");
		assert.ok(blocked, "Pi emits the real blocking UI-prompt event");
		assert.equal(blocked.reason, "ui_prompt");
		assert.equal(blocked.kind, kind);
		assert.equal(blocked.title, question);
		assert.equal(blocked.waiting, undefined);
		assert.equal(events.some((event) => event.type === "ui_prompt_end" || event.type === "agent_settled"), false);
		assert.deepEqual(f.statuses, [undefined, STATUS_TEXT, undefined, STATUS_TEXT, undefined]);

		dialog.reply(answer);
		await run;
		f.assertHealthy();
		assert.equal(f.dialog, undefined);
		assert.equal(f.requests.length, 6);
		assert.equal(f.session.getLastAssistantText(), "Acknowledged your reply.");
		assert.equal(f.currentStatus, undefined);
		assert.equal(f.timeline.filter((event) => event.type === "agent_start").length, 2);
		assert.equal(f.timeline.filter((event) => event.type === "agent_settled").length, 2);
		const completed = f.timeline.slice(boundary);
		const uiEnd = completed.findIndex((event) => event.type === "ui_prompt_end");
		const askEnd = completed.findIndex((event) => event.type === "tool_execution_end" && event.toolName === "ask_user");
		const continuation = completed.findIndex((event) => event.type === "provider_request" && event.request === 6);
		const settled = completed.findIndex((event) => event.type === "agent_settled");
		assert.ok(uiEnd >= 0 && uiEnd < askEnd && askEnd < continuation && continuation < settled,
			"Answering ends the UI request, completes ask_user, resumes the model, and only then settles");
		assert.equal(completed[settled].waiting, undefined);
	});
}
