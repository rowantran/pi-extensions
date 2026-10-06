import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const skillPath = join(packageRoot, "skills", "pseudocode", "SKILL.md");
const models = {
	interactive: { provider: "model-switcher-test-primary", id: "planner" },
	implementation: { provider: "model-switcher-test-secondary", id: "builder" },
};
const classifier = { provider: "model-switcher-test-classifier", id: "phase", api: "offline-phase-classifier" };
const classifierRef = `${classifier.provider}/${classifier.id}`;
const goal = "Plan a cache with a strict capacity of 17. Do not implement before I approve.";
const correction = "Correction: evict the oldest insertion, not the least recently read item. Keep capacity 17.";
const approval = "I approve the revised pseudocode. Implement exactly that behavior.";
const summary = "The user approved a capacity-17 cache with insertion-order eviction. Implementation is in progress.";
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const usage = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { ...cost, total: 0 } };
const decision = (phase, probability = 0.99) => ({ answer: { type: "choice", choice: phase, probabilities: { [phase]: probability }, confidence: probability } });
const chat = (model, text = "Offline response.") => ({ model, text });

function textOf(message) {
	return typeof message.content === "string" ? message.content
		: (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function userMessages(messages) {
	return messages.filter((message) => message.role === "user");
}

function routerStates(session) {
	return session.sessionManager.getBranch().filter((entry) => entry.type === "custom"
		&& entry.customType === "pi.virtual-model-state"
		&& entry.data.provider === "model-switcher" && entry.data.modelId === "auto");
}

function assertVirtualSelection(session) {
	assert.equal(session.model.provider, "model-switcher");
	assert.equal(session.model.id, "auto");
	assert.equal(session.model.api, "pi-virtual");
}

function assertPlanningPreserved(calls, planning) {
	for (const call of calls) {
		assert.deepEqual(userMessages(call.messages).slice(0, planning.length), planning,
			`Planning messages must reach ${call.model.provider}/${call.model.id} unchanged`);
	}
}

// Only provider I/O is scripted. The real SDK loads the package, routes requests,
// executes its ordinary read tool, persists state, retries, and compacts context.
function fakeChat(f, model, context, options) {
	const stream = createAssistantMessageEventStream();
	const step = f.compacting ? chat(f.compacting, summary) : f.chatSteps.shift();
	const call = {
		model: { provider: model.provider, id: model.id }, messages: structuredClone(context.messages),
		thinking: options?.reasoning, compacting: Boolean(f.compacting),
	};
	f.calls.push(call);
	const output = {
		role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
		usage: structuredClone(usage), stopReason: "pending", timestamp: Date.now(),
	};
	queueMicrotask(() => {
		try {
			options?.signal?.throwIfAborted();
			assert.ok(step, `Unexpected chat request to ${model.provider}/${model.id}`);
			assert.deepEqual(call.model, models[step.model], "Pi must dispatch to the expected physical provider");
			step.beforeResponse?.();
			stream.push({ type: "start", partial: output });
			if (step.error) {
				output.stopReason = "error";
				output.errorMessage = step.error;
				stream.push({ type: "error", reason: "error", error: output });
				return;
			}
			if (step.thinking) {
				output.content.push({ type: "thinking", thinking: step.thinking, thinkingSignature: "private-signature" });
				stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
				stream.push({ type: "thinking_delta", contentIndex: 0, delta: step.thinking, partial: output });
				stream.push({ type: "thinking_end", contentIndex: 0, content: step.thinking, partial: output });
			}
			const index = output.content.length;
			if (step.read) {
				const toolCall = { type: "toolCall", id: `read-${f.calls.length}`, name: "read", arguments: {} };
				output.content.push(toolCall);
				stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
				toolCall.arguments = { path: step.read };
				stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(toolCall.arguments), partial: output });
				stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
				output.stopReason = "toolUse";
			} else {
				output.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: index, partial: output });
				output.content[index].text = step.text;
				stream.push({ type: "text_delta", contentIndex: index, delta: step.text, partial: output });
				stream.push({ type: "text_end", contentIndex: index, content: step.text, partial: output });
				output.stopReason = "stop";
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
		} catch (error) {
			f.providerErrors.push(error);
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			stream.end();
		}
	});
	return stream;
}

async function fakeClassifier(f, model, context, options) {
	const step = f.classifierSteps.shift();
	f.classifications.push({ model: { provider: model.provider, id: model.id, api: model.api }, context: structuredClone(context), signal: options?.signal });
	try {
		assert.ok(step, "Unexpected classifier request (tool continuations, retries, direct requests, and physical selections must not classify)");
		assert.deepEqual({ provider: model.provider, id: model.id, api: model.api }, classifier);
		assert.equal(context.questions.nextPhase.type, "choice");
		assert.deepEqual(Object.keys(context.questions.nextPhase.criteria).sort(), ["implementation", "planning", "review"]);
		assert.ok(options.signal instanceof AbortSignal, "Classifier receives request cancellation");
	} catch (error) {
		f.providerErrors.push(error);
		throw error;
	}
	if (step.waitForAbort) {
		step.started();
		await new Promise((resolve, reject) => {
			if (options.signal.aborted) return reject(options.signal.reason);
			options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
		});
	}
	if (step.throw) throw new Error(step.throw);
	return {
		api: model.api, provider: model.provider, model: model.id,
		answers: step.answer ? { nextPhase: step.answer } : {},
		stopReason: step.stopReason ?? "stop", ...(step.errorMessage ? { errorMessage: step.errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function fixture(t, { legacyConfig = false, classifierSetting = classifierRef, retry = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-model-switcher-integration-"));
	const cwd = join(root, "work");
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	for (const dir of [cwd, agentDir]) mkdirSync(dir, { recursive: true });
	const environment = { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
	const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
	Object.assign(process.env, environment);
	const authPath = join(agentDir, "auth.json");
	const configPath = join(agentDir, legacyConfig ? "workflow.json" : "model-switcher.json");
	const config = { interactive: `${models.interactive.provider}/${models.interactive.id}`, implementation: `${models.implementation.provider}/${models.implementation.id}`, classifier: classifierSetting };
	writeFileSync(authPath, "{}\n", { mode: 0o600 });
	const expectedConfigs = new Map();
	const f = {
		root, cwd, agentDir, config, chatSteps: [], classifierSteps: [], calls: [], classifications: [],
		providerErrors: [], extensionErrors: [], sessions: [], notifications: [], statuses: [], compacting: false,
	};
	f.writeConfig = (updates = {}, path = configPath) => {
		Object.assign(config, updates);
		const content = JSON.stringify(config);
		writeFileSync(path, content, { mode: 0o600 });
		expectedConfigs.set(path, content);
	};
	f.writeConfig();
	// No catalog refresh, real credentials, network providers, or shell tools.
	const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("Network access is forbidden in model-switcher integration tests"); });
	t.after(async () => {
		try {
			for (const session of f.sessions) {
				await session.abort();
				session.dispose();
			}
			assert.equal(fetch.mock.callCount(), 0, "No network fetches");
			assert.equal(readFileSync(authPath, "utf8"), "{}\n", "No credential mutations");
			for (const [path, content] of expectedConfigs) assert.equal(readFileSync(path, "utf8"), content, "Routing must not write configuration");
			assert.equal(existsSync(join(agentDir, "settings.json")), false, "Settings stay in memory");
			assert.deepEqual(f.providerErrors, []);
			assert.deepEqual(f.extensionErrors, []);
			assert.deepEqual(f.statuses, [], "The extension has no status UI");
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});
	f.open = async (manager = SessionManager.create(cwd, join(root, "sessions")), { allowFallback = false } = {}) => {
		const modelRuntime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: models.interactive.provider, defaultModel: models.interactive.id, defaultThinkingLevel: "high",
			// Omit skills so discovery exercises the package's real pi.skills manifest.
			packages: [{ source: packageRoot, extensions: ["model-switcher.ts"], prompts: [], themes: [] }],
			compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 80 },
			retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 },
			cacheWarming: "off", enableSkillCommands: true,
		});
		const services = await createAgentSessionServices({
			cwd, agentDir, modelRuntime, settingsManager,
			resourceLoaderOptions: {
				noContextFiles: true, noPromptTemplates: true, noThemes: true,
				extensionFactories: [(pi) => {
					for (const [label, model] of Object.entries(models)) {
						pi.registerProvider(model.provider, {
							baseUrl: "http://127.0.0.1:1", apiKey: "unused-offline-test-key", api: "openai-completions",
							models: [{ id: model.id, name: `Offline ${label}`, reasoning: true, input: ["text"],
								contextWindow: 128000, maxTokens: 4096, cost }],
							streamSimple: (model, context, options) => fakeChat(f, model, context, options),
						});
					}
					// Pi's classifier operation is not a chat completion. Register its
					// explicit type and API implementation through the real model registry.
					pi.registerProvider(classifier.provider, {
						apiKey: "unused-offline-classifier-key", baseUrl: "http://127.0.0.1:1",
						models: [{ type: "classifier", id: classifier.id, name: "Offline phase classifier", api: classifier.api,
							input: ["text"], cost, contextWindow: 64000 }],
						classifiers: { [classifier.api]: { classify: (model, context, options) => fakeClassifier(f, model, context, options) } },
					});
				}],
			},
		});
		assert.deepEqual(services.diagnostics, []);
		assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
		const result = await createAgentSessionFromServices({ services, sessionManager: manager, tools: ["read"] });
		const { session } = result;
		f.sessions.push(session);
		if (!allowFallback) assert.equal(result.modelFallbackMessage, undefined);
		await session.bindExtensions({
			mode: "rpc",
			uiContext: {
				notify: (message, type) => f.notifications.push({ sessionId: session.sessionId, message, type }),
				setStatus: (...args) => f.statuses.push(args),
			},
			onError: (error) => f.extensionErrors.push(error),
		});
		return { session, services };
	};
	f.select = async (session, services, provider = "model-switcher", id = "auto") => {
		const model = services.modelRuntime.getModel(provider, id);
		assert.ok(model, `Selectable model ${provider}/${id} must be registered`);
		await session.setModel(model); // Native /model uses this SDK operation.
	};
	f.prompt = async (session, prompt, classifications, ...responses) => {
		assert.equal(f.chatSteps.length, 0);
		assert.equal(f.classifierSteps.length, 0);
		f.classifierSteps.push(...classifications);
		f.chatSteps.push(...responses);
		await session.prompt(prompt);
		assert.equal(f.chatSteps.length, 0, "Pi must make every expected chat/tool continuation request");
		assert.equal(f.classifierSteps.length, 0, "Pi must classify each expected user request");
		assert.deepEqual(f.providerErrors, []);
		assert.deepEqual(f.extensionErrors, []);
		const last = session.messages.at(-1);
		assert.equal(last.role, "assistant");
		assert.equal(last.stopReason, "stop", last.errorMessage);
		assert.equal(session.messages.some((message) => message.role === "toolResult" && message.isError), false);
	};
	return f;
}

async function plan(f, session) {
	await f.prompt(session, `/skill:pseudocode ${goal}`, [decision("planning")],
		chat("interactive", "Planning: propose a capacity-17 cache. Which eviction order should it use?"));
	await f.prompt(session, correction, [decision("planning")],
		chat("interactive", "Revised pseudocode: evict the oldest insertion and keep capacity 17. Awaiting approval."));
	return structuredClone(userMessages(session.messages));
}

async function implement(f, session) {
	await f.prompt(session, approval, [decision("implementation")], chat("implementation", "Implementation checkpoint for the approved cache."));
	assertVirtualSelection(session);
	assert.equal(routerStates(session).at(-1).data.state.phase, "implementation");
}

test("package registers only auto routing; explicit skill use does not activate or change models", { timeout: 30000 }, async (t) => {
	const f = fixture(t);
	const { session, services } = await f.open();
	const { skills, diagnostics } = services.resourceLoader.getSkills();
	assert.deepEqual(diagnostics, []);
	assert.deepEqual(skills.map((skill) => skill.name), ["pseudocode"]);
	assert.equal(skills[0].filePath, skillPath);
	assert.equal(skills[0].disableModelInvocation, true);
	const extension = services.resourceLoader.getExtensions().extensions.find((entry) => entry.resolvedPath === join(packageRoot, "model-switcher.ts"));
	assert.ok(extension);
	for (const field of ["tools", "commands", "handlers", "flags", "shortcuts", "messageRenderers"]) assert.equal(extension[field].size, 0, `No ${field}`);
	const runtime = services.modelRuntime;
	assert.deepEqual(runtime.getModels("model-switcher").map((model) => model.id), ["auto"]);
	assert.equal(runtime.getModel("workflow", "auto"), undefined, "No legacy virtual alias");
	assert.doesNotMatch(session.systemPrompt, /<name>pseudocode<\/name>|<skill name="pseudocode"/);
	await f.prompt(session, "An ordinary question.", [], chat("interactive"));
	assert.equal(f.calls[0].messages.some((message) => textOf(message).includes('<skill name="pseudocode"')), false);
	await f.select(session, services, models.implementation.provider, models.implementation.id);
	await f.prompt(session, `/skill:pseudocode ${goal}`, [], chat("implementation", "Plan without changing the user's selected model."));
	assert.equal(session.model.provider, models.implementation.provider);
	assert.match(textOf(userMessages(session.messages).at(-1)), /<skill name="pseudocode" location=/);
	assert.ok(textOf(userMessages(session.messages).at(-1)).includes(goal));
	assert.deepEqual(f.classifications, []);
	assert.deepEqual(routerStates(session), []);
	assert.deepEqual(session.getActiveToolNames(), ["read"]);

	await f.select(session, services);
	assertVirtualSelection(session);
	assert.deepEqual(f.classifications, [], "Native selection itself does not classify");
	await f.prompt(session, "Now use automatic routing.", [decision("implementation")], chat("implementation"));
	const saved = structuredClone(routerStates(session));
	await f.select(session, services, models.interactive.provider, models.interactive.id);
	await f.prompt(session, "Keep this physical model even if the work is implementation.", [], chat("interactive"));
	assert.equal(f.classifications.length, 1, "Physical selections bypass classification");
	assert.deepEqual(routerStates(session), saved);
	assert.equal(session.model.provider, models.interactive.provider);
	assert.equal(services.settingsManager.getDefaultProvider(), models.interactive.provider);
	assert.equal(services.settingsManager.getDefaultModel(), models.interactive.id);
});

test("user decisions preserve planning dialogue while real tool continuations keep the same model", { timeout: 30000 }, async (t) => {
	const f = fixture(t);
	const { session, services } = await f.open();
	await f.select(session, services);
	const sessionId = session.sessionId;
	const planning = await plan(f, session);
	assert.equal(planning.length, 2);
	assert.equal(textOf(planning[1]), correction);
	const start = f.calls.length;
	const evidence = "Implementation and tests are complete: capacity 17, insertion-order eviction. Ready for user review.";
	const path = join(f.cwd, "verification.txt");
	writeFileSync(path, evidence);
	session.setThinkingLevel("medium");
	await f.prompt(session, approval, [decision("implementation", 0.8)],
		{ model: "implementation", read: path }, { model: "implementation", read: path },
		chat("implementation", "Implementation and verification are complete."));
	assert.equal(f.classifications.length, 3, "Two tool follow-ups reuse the user decision without classifying");
	assert.deepEqual(routerStates(session).map((entry) => entry.data.state.phase), ["planning", "implementation"], "Review evidence does not switch models mid-turn");
	const reviewRequest = "Review the completed implementation.";
	await f.prompt(session, reviewRequest, [decision("review")],
		chat("interactive", "Review: the implementation matches the approved design."));
	assertPlanningPreserved(f.calls.slice(start), planning);
	for (const call of f.calls.slice(start)) {
		assert.ok(call.messages.some((message) => textOf(message).includes("Which eviction order should it use?")));
		assert.ok(call.messages.some((message) => textOf(message).includes("Revised pseudocode: evict the oldest insertion")), "Planning answers, not just user requests, remain in context");
	}
	assert.equal(session.sessionId, sessionId);
	assert.equal(session.thinkingLevel, "medium");
	assertVirtualSelection(session);
	assert.deepEqual(f.calls.map((call) => call.model.provider), [models.interactive.provider, models.interactive.provider,
		models.implementation.provider, models.implementation.provider, models.implementation.provider, models.interactive.provider]);
	assert.deepEqual(f.calls.slice(start).map((call) => call.thinking), ["medium", "medium", "medium", "medium"]);
	assert.deepEqual(f.classifications.map((call) => call.context.state.requestReason), ["user", "user", "user", "user"]);
	const nextUser = f.classifications.at(-1).context.state;
	assert.equal(nextUser.currentPhase, "implementation");
	assert.equal(nextUser.latestUserMessage, reviewRequest);
	assert.ok(nextUser.recentMessages.some((message) => message.role === "toolResult" && message.toolName === "read" && !message.isError && message.text.includes(evidence)));
	const result = session.messages.find((message) => message.role === "toolResult");
	assert.equal(result.toolName, "read");
	assert.ok(textOf(result).includes(evidence));
	assert.deepEqual(routerStates(session).map((entry) => entry.data.state.phase), ["planning", "implementation", "review"]);
	assert.ok(session.sessionManager.getBranch().filter((entry) => entry.type === "custom").every((entry) => entry.customType === "pi.virtual-model-state"), "No extension-owned phase or override journals");
	assert.equal(session.sessionManager.getBranch().some((entry) => entry.type === "compaction"), false);
});

test("classifier receives bounded recent text, not full history, tool arguments, or hidden reasoning", { timeout: 30000 }, async (t) => {
	const f = fixture(t);
	const { session, services } = await f.open();
	for (let i = 0; i < 6; i++) await f.prompt(session, `Old user turn ${i}.`, [], chat("interactive", `Old response ${i}.`));
	await f.select(session, services);
	const longPrompt = `LATEST-BEGIN ${"user-context ".repeat(1800)} LATEST-END`;
	const path = join(f.cwd, "private-tool-argument.txt");
	const toolText = `TOOL-BEGIN ${"tool-evidence ".repeat(900)} TOOL-END`;
	writeFileSync(path, toolText);
	await f.prompt(session, longPrompt, [decision("planning")],
		{ model: "interactive", read: path, thinking: "HIDDEN-REASONING-SENTINEL" }, chat("interactive"));
	assert.equal(f.classifications.length, 1, "Tool output is not classified until the next user request");
	assert.ok(textOf(f.calls.at(-1).messages.findLast((message) => message.role === "toolResult")).includes(toolText));
	await f.prompt(session, longPrompt, [decision("implementation")], chat("implementation"));
	for (const { context } of f.classifications) {
		assert.ok(context.state.recentMessages.length <= 8);
		assert.ok(context.state.latestUserMessage.length <= 6100);
		assert.match(context.state.latestUserMessage, /LATEST-BEGIN/);
		assert.match(context.state.latestUserMessage, /LATEST-END/);
		assert.ok(context.state.recentMessages.every((message) => message.role !== "system" && message.text.length <= (message.role === "toolResult" ? 1100 : 3100)));
		assert.ok(JSON.stringify(context.state).length < 33000, "Classifier context remains bounded");
		assert.doesNotMatch(JSON.stringify(context), /Old user turn 0|HIDDEN-REASONING-SENTINEL|private-signature|private-tool-argument/);
	}
	assert.equal(textOf(userMessages(f.calls.at(-1).messages).at(-1)), longPrompt, "Only classifier input is truncated");
	assert.ok(textOf(f.calls.at(-1).messages.findLast((message) => message.role === "toolResult")).includes(toolText));
	assert.ok(f.classifications.at(-1).context.state.recentMessages.some((message) => message.role === "toolResult" && message.text.includes("TOOL-BEGIN") && message.text.includes("TOOL-END")));
});

test("Pi-owned routing state survives fresh resume, tree navigation, compaction, and another resume", { timeout: 30000 }, async (t) => {
	const f = fixture(t);
	const first = await f.open();
	await f.select(first.session, first.services);
	const planning = await plan(f, first.session);
	await implement(f, first.session);
	const savedState = structuredClone(routerStates(first.session).at(-1));
	const savedFile = first.session.sessionFile;
	const sessionId = first.session.sessionId;
	first.session.dispose();
	const { session } = await f.open(SessionManager.open(savedFile, join(f.root, "sessions")));
	assert.equal(session.sessionId, sessionId);
	assertVirtualSelection(session);
	assert.deepEqual(routerStates(session).at(-1), savedState);
	const resumedAt = f.calls.length;
	await f.prompt(session, "Continue after resuming.", [decision("planning", 0.79)], chat("implementation"));
	assert.equal(f.classifications.at(-1).context.state.currentPhase, "implementation");
	assert.deepEqual(routerStates(session).at(-1), savedState, "An uncertain decision retains the persisted object");
	const implementationLeaf = session.sessionManager.getLeafId();
	await f.prompt(session, "Now review the finished implementation.", [decision("review")], chat("interactive", "Review on the original branch."));
	const reviewLeaf = session.sessionManager.getLeafId();
	assertPlanningPreserved(f.calls.slice(resumedAt), planning);
	const navigation = await session.navigateTree(implementationLeaf, { summarize: false });
	assert.equal(navigation.cancelled, false);
	assert.deepEqual(routerStates(session).at(-1), savedState);
	await f.prompt(session, "Continue on the alternative branch.", [decision("review", 0.5)], chat("implementation"));
	assert.equal(f.classifications.at(-1).context.state.currentPhase, "implementation");
	assertPlanningPreserved([f.calls.at(-1)], planning);
	assert.equal(f.calls.at(-1).messages.some((message) => textOf(message) === "Review on the original branch."), false);
	assert.ok(session.sessionManager.getEntry(reviewLeaf), "Abandoned review remains in the tree");
	const statesBefore = structuredClone(routerStates(session));
	const classifierCount = f.classifications.length;
	const summaryStart = f.calls.length;
	f.compacting = "implementation";
	let compaction;
	try { compaction = await session.compact("Preserve the approved cache behavior."); }
	finally { f.compacting = false; }
	assert.ok(compaction.summary.includes(summary));
	assert.ok(f.calls.length > summaryStart);
	assert.ok(f.calls.slice(summaryStart).every((call) => call.compacting && call.model.provider === models.implementation.provider));
	assert.equal(f.classifications.length, classifierCount, "Direct compaction requests never classify");
	assert.deepEqual(routerStates(session), statesBefore, "Compaction does not change phase state");
	assert.ok(session.messages.some((message) => message.role === "compactionSummary"));
	await f.prompt(session, "Continue after compaction.", [{}], chat("implementation"));
	assert.deepEqual(routerStates(session), statesBefore);
	session.dispose();
	const resumed = await f.open(SessionManager.open(savedFile, join(f.root, "sessions")));
	assertVirtualSelection(resumed.session);
	await f.prompt(resumed.session, "Continue after reopening the compacted session.", [{}], chat("implementation"));
	assert.deepEqual(routerStates(resumed.session), statesBefore);
	assert.equal(resumed.session.sessionId, sessionId);
	const entries = readFileSync(savedFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const savedUsers = entries.filter((entry) => entry.type === "message" && entry.message.role === "user").map((entry) => entry.message);
	assert.deepEqual(savedUsers.slice(0, planning.length), planning, "Original planning remains verbatim in the same saved conversation");
});

test("uncertain and invalid classifier answers retain the phase; valid decisions include the 0.8 boundary", { timeout: 30000 }, async (t) => {
	const f = fixture(t);
	const { session, services } = await f.open();
	await f.select(session, services);
	await f.prompt(session, "No confident decision yet.", [decision("implementation", 0.799)], chat("interactive"));
	assert.equal(routerStates(session).at(-1).data.state.phase, "planning");
	await implement(f, session);
	const saved = structuredClone(routerStates(session));
	const invalid = [
		decision("review", 0.79), decision("review", 1.1), decision("review", Number.NaN),
		decision("review", Number.POSITIVE_INFINITY), decision("unsupported", 1), {},
		{ answer: { type: "choice", choice: "review", probabilities: {}, confidence: 1 } },
		{ answer: { type: "score", score: 1, confidence: 1 } },
	];
	for (const [i, answer] of invalid.entries()) {
		await f.prompt(session, `Uncertain or invalid result ${i}.`, [answer], chat("implementation"));
		assert.deepEqual(routerStates(session), saved, "Rejected decisions do not add router state");
	}
	await f.prompt(session, "Review with confidence at the accepted threshold.", [decision("review", 0.8)], chat("interactive"));
	assert.equal(routerStates(session).at(-1).data.state.phase, "review");
	assert.deepEqual(f.notifications, [], "Uncertainty is not a provider failure");
});

test("classifier failures, unavailable models, and disabled classification retain state and warn once per session", { timeout: 30000 }, async (t) => {
	const f = fixture(t);
	const { session, services } = await f.open();
	await f.select(session, services);
	await f.prompt(session, "Classifier fails before any phase is saved.", [{ throw: "offline provider unavailable" }], chat("interactive"));
	assert.equal(routerStates(session).at(-1).data.state.phase, "planning");
	await implement(f, session);
	const states = structuredClone(routerStates(session));
	await f.prompt(session, "Another failure retains implementation.", [{ stopReason: "error", errorMessage: "different provider failure" }], chat("implementation"));
	await f.prompt(session, "Provider-aborted classification retains implementation.", [{ stopReason: "aborted", errorMessage: "provider aborted" }], chat("implementation"));
	f.writeConfig({ classifier: "model-switcher-test-missing/absent" });
	await f.prompt(session, "Unavailable classifier retains implementation.", [], chat("implementation"));
	f.writeConfig({ classifier: null });
	await f.prompt(session, "Disabled classifier retains implementation.", [], chat("implementation"));
	assert.deepEqual(routerStates(session), states);
	assert.equal(f.notifications.length, 1, "All classifier failure kinds share one warning per session");
	assert.equal(f.notifications[0].type, "warning");

	const disabled = await f.open();
	await f.select(disabled.session, disabled.services);
	await f.prompt(disabled.session, "Disabled classifier starts in planning.", [], chat("interactive"));
	assert.equal(routerStates(disabled.session).at(-1).data.state.phase, "planning");
	assert.ok(f.notifications.filter((notice) => notice.sessionId === disabled.session.sessionId).length <= 1, "Disabled classification does not repeat warnings");
	f.writeConfig({ classifier: "model-switcher-test-missing/absent" });
	const unavailable = await f.open();
	await f.select(unavailable.session, unavailable.services);
	await f.prompt(unavailable.session, "Unavailable classifier starts in planning.", [], chat("interactive"));
	await f.prompt(unavailable.session, "The same failure is not repeated.", [], chat("interactive"));
	assert.equal(routerStates(unavailable.session).at(-1).data.state.phase, "planning");
	assert.equal(f.notifications.filter((notice) => notice.sessionId === unavailable.session.sessionId).length, 1, "A new session gets its own warning budget");
	assert.notEqual(session.sessionId, unavailable.session.sessionId);
});

test("cancelling a classifier aborts the SDK request without dispatching chat or changing state", { timeout: 30000 }, async (t) => {
	const f = fixture(t);
	const { session, services } = await f.open();
	await f.select(session, services);
	await implement(f, session);
	const states = structuredClone(routerStates(session));
	const calls = f.calls.length;
	const started = Promise.withResolvers();
	f.classifierSteps.push({ waitForAbort: true, started: started.resolve });
	const pending = session.prompt("Cancel while the classifier is deciding.");
	await started.promise;
	await session.abort();
	await pending;
	assert.equal(f.classifications.at(-1).signal.aborted, true);
	assert.equal(f.calls.length, calls, "Cancellation must not become a fallback chat request");
	assert.deepEqual(routerStates(session), states);
	assert.equal(session.messages.at(-1).stopReason, "aborted");
	assert.deepEqual(f.notifications, [], "User cancellation is not a classifier failure warning");
	await f.prompt(session, "Continue after cancellation.", [{}], chat("implementation"));
});

test("automatic retries keep the failed physical model and thinking level without classifying again", { timeout: 30000 }, async (t) => {
	const f = fixture(t, { retry: true });
	const { session, services } = await f.open();
	await f.select(session, services);
	session.setThinkingLevel("medium");
	const events = [];
	const unsubscribe = session.subscribe((event) => events.push(event));
	try {
		await f.prompt(session, "Implement the approved behavior.", [decision("implementation")],
			{ model: "implementation", error: "503 Service Unavailable" }, chat("implementation", "Retry succeeded."));
	} finally { unsubscribe(); }
	assert.ok(events.some((event) => event.type === "auto_retry_start"));
	assert.ok(events.some((event) => event.type === "auto_retry_end" && event.success));
	assert.equal(f.classifications.length, 1);
	assert.deepEqual(f.calls.map((call) => call.model), [models.implementation, models.implementation]);
	assert.deepEqual(f.calls.map((call) => call.thinking), ["medium", "medium"]);
	assert.equal(routerStates(session).length, 1, "Retry does not write another state entry");
	assert.equal(routerStates(session)[0].data.state.phase, "implementation");
	assertVirtualSelection(session);
});

test("legacy config is read-only fallback; old custom pins and phase signals cannot override classifier decisions", { timeout: 30000 }, async (t) => {
	const f = fixture(t, { legacyConfig: true });
	const { session, services } = await f.open();
	await f.select(session, services);
	for (const prefix of ["workflow", "model-switcher"]) {
		session.sessionManager.appendCustomEntry(`${prefix}.phase`, { phase: "implementation", userId: null });
		session.sessionManager.appendCustomEntry(`${prefix}.override`, { mode: "implementation" });
	}
	await f.prompt(session, "The classifier says planning despite old implementation pins.", [decision("planning")], chat("interactive"));
	for (const prefix of ["workflow", "model-switcher"]) {
		session.sessionManager.appendCustomEntry(`${prefix}.phase`, { phase: "planning", userId: null });
		session.sessionManager.appendCustomEntry(`${prefix}.override`, { mode: "interactive" });
	}
	await implement(f, session);
	const path = join(f.cwd, "legacy-signal-fixture.txt");
	writeFileSync(path, "Continue implementing the approved cache.");
	for (const prefix of ["workflow", "model-switcher"]) session.sessionManager.appendCustomEntry(`${prefix}.override`, { mode: "auto" });
	const classifierCount = f.classifications.length;
	await f.prompt(session, "Inspect the fixture, then continue implementation.", [decision("implementation")], {
		model: "implementation", read: path,
		beforeResponse: () => {
			// A same-turn signal would have overridden classification in the old
			// extension. Seed it through Pi's real session manager, not a router mock.
			const userId = session.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user").id;
			for (const prefix of ["workflow", "model-switcher"]) session.sessionManager.appendCustomEntry(`${prefix}.phase`, { phase: "review", userId });
		},
	}, chat("implementation"));
	assert.equal(f.classifications.length, classifierCount + 1, "Legacy signals do not trigger continuation classification");
	assert.equal(f.classifications.at(-1).context.state.requestReason, "user");
	assert.equal(routerStates(session).at(-1).data.state.phase, "implementation", "Even fresh same-turn legacy signals are ignored");
	assert.equal(existsSync(join(f.agentDir, "model-switcher.json")), false, "Reading workflow.json never migrates or rewrites it");
	// An existing new file takes precedence over the legacy filename.
	f.writeConfig({ interactive: f.config.implementation, implementation: f.config.interactive }, join(f.agentDir, "model-switcher.json"));
	await f.prompt(session, "Use the interactive model from the new configuration.", [decision("review")], chat("implementation"));
	assert.equal(routerStates(session).at(-1).data.state.phase, "review");
});

test("legacy workflow virtual state is not reconstructed after native model selection", { timeout: 30000 }, async (t) => {
	const f = fixture(t, { legacyConfig: true });
	const first = await f.open();
	await f.select(first.session, first.services);
	await implement(f, first.session);
	const savedFile = first.session.sessionFile;
	const sessionId = first.session.sessionId;
	first.session.dispose();
	// Reproduce only the old public session format in this temporary fixture.
	const entries = readFileSync(savedFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	for (const entry of entries) {
		if (entry.type === "model_change" && entry.provider === "model-switcher") entry.provider = "workflow";
		if (entry.type === "custom" && entry.customType === "pi.virtual-model-state" && entry.data.provider === "model-switcher") entry.data.provider = "workflow";
	}
	writeFileSync(savedFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const { session, services } = await f.open(SessionManager.open(savedFile, join(f.root, "sessions")), { allowFallback: true });
	assert.equal(session.sessionId, sessionId);
	assert.equal(session.model.provider, models.implementation.provider, "Pi falls back to the last physical model for an unregistered old selection");
	assert.deepEqual(routerStates(session), []);
	await f.prompt(session, "Ordinary old-session continuation.", [], chat("implementation"));
	await f.select(session, services);
	await f.prompt(session, "Start the current router without a confident decision.", [{}], chat("interactive"));
	assert.equal(f.classifications.at(-1).context.state.currentPhase, "planning");
	assert.equal(routerStates(session).at(-1).data.state.phase, "planning", "workflow/auto state is not current router state");
});

test("Pi restores current model-switcher state with obsolete signal metadata without consulting custom journals", { timeout: 30000 }, async (t) => {
	const f = fixture(t);
	const first = await f.open();
	await f.select(first.session, first.services);
	await implement(f, first.session);
	const savedFile = first.session.sessionFile;
	first.session.dispose();
	const entries = readFileSync(savedFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const state = entries.findLast((entry) => entry.type === "custom" && entry.customType === "pi.virtual-model-state");
	state.data.state.signalId = "obsolete-phase-tool-id";
	writeFileSync(savedFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const { session } = await f.open(SessionManager.open(savedFile, join(f.root, "sessions")));
	assertVirtualSelection(session);
	await f.prompt(session, "Keep the current phase when the classifier is uncertain.", [{}], chat("implementation"));
	assert.equal(f.classifications.at(-1).context.state.currentPhase, "implementation");
	assert.equal(routerStates(session).at(-1).data.state.phase, "implementation");
	await f.prompt(session, "A fresh classifier decision overrides obsolete metadata.", [decision("review")], chat("interactive"));
	assert.equal(routerStates(session).at(-1).data.state.phase, "review");
});
