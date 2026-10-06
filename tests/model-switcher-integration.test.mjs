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
	primary: { provider: "model-switcher-test-primary", id: "planner" },
	secondary: { provider: "model-switcher-test-secondary", id: "builder" },
};
const goal = "Plan a cache with a strict capacity of 17. Do not implement before I approve.";
const correction = "Correction: evict the oldest insertion, not the least recently read item. Keep capacity 17.";
const approval = "I approve the revised pseudocode. Implement exactly that behavior.";
const summary = "The user approved a capacity-17 cache with insertion-order eviction. Implementation is in progress.";

function textOf(message) {
	return typeof message.content === "string" ? message.content
		: message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function userMessages(messages) {
	return messages.filter((message) => message.role === "user");
}

function customEntries(session, type) {
	return session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === type);
}

function routerStates(session) {
	return customEntries(session, "pi.virtual-model-state")
		.filter((entry) => entry.data.provider === "model-switcher" && entry.data.modelId === "auto");
}

function assertVirtualSelection(session) {
	assert.equal(session.model.provider, "model-switcher");
	assert.equal(session.model.id, "auto");
	assert.equal(session.model.api, "pi-virtual");
}

// These are real provider streams, not AgentSession/ExtensionAPI or router mocks.
// The script describes responses only; Pi chooses the provider and executes tools.
function fakeStream(f, model, context, options) {
	const stream = createAssistantMessageEventStream();
	const step = f.compacting ? { model: "secondary", text: summary } : f.steps.shift();
	const call = { model: { provider: model.provider, id: model.id }, messages: structuredClone(context.messages), compacting: f.compacting };
	f.calls.push(call);
	const output = {
		role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
		usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending", timestamp: Date.now(),
	};
	queueMicrotask(() => {
		try {
			options?.signal?.throwIfAborted();
			assert.ok(step, `Unexpected request to ${model.provider}/${model.id}`);
			assert.deepEqual(call.model, models[step.model], "Pi must dispatch to the expected physical provider");
			stream.push({ type: "start", partial: output });
			if (step.phase) {
				const id = `model-switcher-call-${f.calls.length}`;
				output.content.push({ type: "toolCall", id, name: "model_switcher_phase", arguments: {} });
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
				output.content[0].arguments = { phase: step.phase };
				stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify({ phase: step.phase }), partial: output });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: output.content[0], partial: output });
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
			f.providerErrors.push(error);
			output.stopReason = "error";
			output.errorMessage = String(error);
			stream.push({ type: "error", reason: "error", error: output });
		} finally {
			stream.end();
		}
	});
	return stream;
}

function fixture(t, { legacyConfig = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-model-switcher-integration-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const home = join(root, "home");
	for (const dir of [cwd, agentDir, home]) mkdirSync(dir);
	const environment = { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
	const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
	Object.assign(process.env, environment);
	const authPath = join(agentDir, "auth.json");
	const configPath = join(agentDir, legacyConfig ? "workflow.json" : "model-switcher.json");
	const config = JSON.stringify({ interactive: "model-switcher-test-primary/planner", implementation: "model-switcher-test-secondary/builder", classifier: null });
	writeFileSync(authPath, "{}\n", { mode: 0o600 });
	writeFileSync(configPath, config, { mode: 0o600 });
	// Catalog refresh is disabled, both providers have local implementations, and
	// this guard makes accidental fetch-based network requests fail immediately.
	const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("Network access is forbidden in model-switcher integration tests"); });
	const f = { root, cwd, agentDir, steps: [], calls: [], providerErrors: [], extensionErrors: [], sessions: [], compacting: false };
	t.after(async () => {
		try {
			for (const session of f.sessions) {
				await session.abort();
				session.dispose();
			}
			assert.equal(fetch.mock.callCount(), 0, "No network fetches");
			assert.equal(readFileSync(authPath, "utf8"), "{}\n", "No credential mutations");
			assert.equal(readFileSync(configPath, "utf8"), config, "Phase tools do not change model-switcher configuration");
			assert.equal(existsSync(join(agentDir, "settings.json")), false, "Settings stay in memory");
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});
	f.open = async (manager = SessionManager.create(cwd, join(root, "sessions"))) => {
		const modelRuntime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: models.primary.provider, defaultModel: models.primary.id, defaultThinkingLevel: "high",
			// Do not supply a skill path: discovery must use the real package's pi.skills manifest.
			packages: [{ source: packageRoot, extensions: ["model-switcher.ts"], prompts: [], themes: [] }],
			compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 80 },
			retry: { enabled: false }, cacheWarming: "off", enableSkillCommands: true,
		});
		// Services pre-register extension models before startup selection. This is
		// important when a fresh ModelRuntime restores the saved virtual selection.
		const services = await createAgentSessionServices({
			cwd, agentDir, modelRuntime, settingsManager,
			resourceLoaderOptions: {
				noContextFiles: true, noPromptTemplates: true, noThemes: true,
				extensionFactories: [(pi) => {
					for (const [label, model] of Object.entries(models)) {
						pi.registerProvider(model.provider, {
							baseUrl: "http://127.0.0.1:1", apiKey: "unused-offline-test-key", api: "openai-completions",
							models: [{ id: model.id, name: `Offline ${label}`, reasoning: true, input: ["text"],
								contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
							streamSimple: (model, context, options) => fakeStream(f, model, context, options),
						});
					}
				}],
			},
		});
		assert.deepEqual(services.diagnostics, []);
		assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
		const result = await createAgentSessionFromServices({ services, sessionManager: manager, tools: ["model_switcher_phase"] });
		const { session } = result;
		f.sessions.push(session);
		assert.equal(result.modelFallbackMessage, undefined);
		await session.bindExtensions({ onError: (error) => f.extensionErrors.push(error) });
		return { session, services };
	};
	f.prompt = async (session, prompt, ...steps) => {
		assert.equal(f.steps.length, 0);
		f.steps.push(...steps);
		await session.prompt(prompt);
		assert.equal(f.steps.length, 0, "Pi must make all expected tool follow-up requests");
		assert.deepEqual(f.providerErrors, []);
		assert.deepEqual(f.extensionErrors, []);
		const failed = session.messages.filter((message) => (message.role === "toolResult" && message.isError)
			|| (message.role === "assistant" && ["error", "aborted"].includes(message.stopReason)));
		assert.deepEqual(failed, [], "Phase tools and provider requests must finish successfully");
	};
	return f;
}

async function plan(f, session) {
	const planningStart = f.calls.length;
	await f.prompt(session, `/skill:pseudocode ${goal}`,
		{ model: "primary", phase: "planning" },
		{ model: "primary", text: "Planning: propose a capacity-17 cache. Which eviction order should it use?" });
	assertVirtualSelection(session);
	await f.prompt(session, correction,
		{ model: "primary", text: "Revised pseudocode: evict the oldest insertion and keep capacity 17. Awaiting approval." });
	const planning = structuredClone(userMessages(session.messages));
	assertPlanningPreserved(f.calls.slice(planningStart), planning.slice(0, 1));
	return planning;
}

async function implement(f, session) {
	await f.prompt(session, approval,
		{ model: "primary", phase: "implementation" },
		{ model: "secondary", text: "Implementation checkpoint: the approved capacity and insertion-order eviction are retained." });
	assertVirtualSelection(session);
	assert.equal(routerStates(session).at(-1).data.state.phase, "implementation");
}

function assertPlanningPreserved(calls, planning) {
	for (const call of calls) {
		assert.deepEqual(userMessages(call.messages).slice(0, planning.length), planning,
			`Original planning messages must reach ${call.model.provider}/${call.model.id} unchanged`);
	}
}

test("model-switcher package skill is discoverable but requires explicit opt-in", { timeout: 30000 }, async (t) => {
	const f = fixture(t);
	const { session, services } = await f.open();
	const { skills, diagnostics } = services.resourceLoader.getSkills();
	assert.deepEqual(diagnostics, []);
	assert.deepEqual(skills.map((skill) => skill.name), ["pseudocode"]);
	assert.equal(skills[0].filePath, skillPath);
	assert.equal(skills[0].disableModelInvocation, true);
	assert.equal(session.model.provider, models.primary.provider);
	assert.doesNotMatch(session.systemPrompt, /<name>pseudocode<\/name>|Agree on pseudocode, then implement/);
	await f.prompt(session, "An ordinary question; do not enter the model-switcher.",
		{ model: "primary", text: "Ordinary response without model-switcher activation." });
	assert.equal(session.model.provider, models.primary.provider);
	assert.deepEqual(customEntries(session, "model-switcher.phase"), []);
	assert.deepEqual(routerStates(session), []);
	assert.doesNotMatch(JSON.stringify(f.calls[0].messages), /Agree on pseudocode, then implement/);
});

test("real phase tool routes planning → implementation → review without losing user messages", { timeout: 30000 }, async (t) => {
	const f = fixture(t);
	const { session, services } = await f.open();
	const sessionId = session.sessionId;
	const planning = await plan(f, session);
	assert.equal(planning.length, 2);
	assert.match(textOf(planning[0]), /Agree on pseudocode, then implement/);
	assert.ok(textOf(planning[0]).includes(goal), "Explicit skill expansion retains the original user request");
	assert.equal(textOf(planning[1]), correction);
	const implementationStart = f.calls.length;
	session.setThinkingLevel("medium");
	await implement(f, session);
	assert.equal(session.thinkingLevel, "medium", "phase changes must not restore the configured high thinking level");
	await f.prompt(session, "Implementation and tests are complete; return to interactive review.",
		{ model: "secondary", phase: "review" },
		{ model: "primary", text: "Review: capacity 17 and insertion-order eviction match the approved plan." });
	assertPlanningPreserved(f.calls.slice(implementationStart), planning);
	assertVirtualSelection(session);
	assert.equal(session.sessionId, sessionId, "Every phase stays in the same session");
	assert.deepEqual(f.calls.map((call) => call.model.provider), [
		models.primary.provider, models.primary.provider, models.primary.provider,
		models.primary.provider, models.secondary.provider, models.secondary.provider, models.primary.provider,
	]);
	const results = session.messages.filter((message) => message.role === "toolResult");
	assert.deepEqual(results.map((message) => message.details), [
		{ phase: "planning", override: "auto" }, { phase: "implementation", override: "auto" }, { phase: "review", override: "auto" },
	]);
	assert.deepEqual(customEntries(session, "model-switcher.phase").map((entry) => entry.data.phase), ["planning", "implementation", "review"]);
	assert.deepEqual(routerStates(session).map((entry) => entry.data.state.phase), ["planning", "implementation", "review"]);
	assert.equal(session.sessionManager.getBranch().some((entry) => entry.type === "compaction"), false);
	assert.equal(services.settingsManager.getDefaultProvider(), models.primary.provider, "pi.setModel must not rewrite default provider");
	assert.equal(services.settingsManager.getDefaultModel(), models.primary.id);
});

test("model-switcher router state survives fresh SDK resume, tree branches, and real compaction", { timeout: 30000 }, async (t) => {
	const f = fixture(t);
	const first = await f.open();
	const planning = await plan(f, first.session);
	await implement(f, first.session);
	const savedState = structuredClone(routerStates(first.session).at(-1));
	const savedFile = first.session.sessionFile;
	const sessionId = first.session.sessionId;
	first.session.dispose();

	// Recreate services, extension runtime, ModelRuntime, and SessionManager, not
	// merely Agent.state. No explicit model is supplied on resume.
	const { session } = await f.open(SessionManager.open(savedFile, join(f.root, "sessions")));
	assert.equal(session.sessionId, sessionId);
	assertVirtualSelection(session);
	assert.deepEqual(routerStates(session).at(-1), savedState);
	const resumedAt = f.calls.length;
	await f.prompt(session, "Continue the approved implementation after resuming.",
		{ model: "secondary", text: "Resumed implementation; no new phase signal is needed." });
	assert.deepEqual(routerStates(session).at(-1), savedState, "Resume reuses state rather than reapplying an old signal");
	const implementationLeaf = session.sessionManager.getLeafId();
	await f.prompt(session, "Now review the finished implementation.",
		{ model: "secondary", phase: "review" }, { model: "primary", text: "Review on the original branch." });
	const reviewLeaf = session.sessionManager.getLeafId();
	assert.equal(routerStates(session).at(-1).data.state.phase, "review");
	assertPlanningPreserved(f.calls.slice(resumedAt), planning);

	const navigation = await session.navigateTree(implementationLeaf, { summarize: false });
	assert.equal(navigation.cancelled, false);
	assert.deepEqual(routerStates(session).at(-1), savedState, "Tree navigation restores the implementation branch's state");
	await f.prompt(session, "Continue implementation on this alternative branch.",
		{ model: "secondary", text: "Alternative implementation branch, still using the approved design." });
	assertPlanningPreserved([f.calls.at(-1)], planning);
	assert.equal(customEntries(session, "model-switcher.phase").some((entry) => entry.data.phase === "review"), false);
	assert.equal(f.calls.at(-1).messages.some((message) => textOf(message) === "Review on the original branch."), false);
	assert.ok(session.sessionManager.getEntry(reviewLeaf), "Abandoned review history remains in the session tree");

	const statesBeforeCompaction = structuredClone(routerStates(session));
	const summaryStart = f.calls.length;
	f.compacting = true;
	let compaction;
	try {
		compaction = await session.compact("Preserve the approved cache behavior and the implementation phase.");
	} finally {
		f.compacting = false;
	}
	assert.ok(compaction.summary.includes(summary));
	assert.ok(f.calls.length > summaryStart, "Manual compaction makes an actual fake-provider summary request");
	assert.deepEqual(f.providerErrors, []);
	assert.ok(f.calls.slice(summaryStart).every((call) => call.compacting && call.model.provider === models.secondary.provider),
		"Direct compaction requests stay on the last physical model");
	assert.deepEqual(routerStates(session), statesBeforeCompaction, "Direct requests must not overwrite router state");
	assert.ok(session.sessionManager.getBranch().some((entry) => entry.type === "compaction"));
	assert.ok(session.messages.some((message) => message.role === "compactionSummary"));
	await f.prompt(session, "Continue after normal context compaction.",
		{ model: "secondary", text: "Implementation continues with preserved model-switcher state." });
	assert.deepEqual(routerStates(session), statesBeforeCompaction);
	assertVirtualSelection(session);

	// Compaction may summarize planning in model context; the original messages
	// must still exist verbatim in the saved conversation, not a handoff session.
	const entries = readFileSync(savedFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const savedUsers = entries.filter((entry) => entry.type === "message" && entry.message.role === "user").map((entry) => entry.message);
	assert.deepEqual(savedUsers.slice(0, planning.length), planning);
	assert.equal(session.sessionFile, savedFile);
});

test("legacy config and saved workflow session resume through the renamed command without losing the phase", { timeout: 30000 }, async (t) => {
	const f = fixture(t, { legacyConfig: true });
	const first = await f.open();
	const planning = await plan(f, first.session);
	await implement(f, first.session);
	const savedFile = first.session.sessionFile;
	const sessionId = first.session.sessionId;
	first.session.dispose();

	// Reproduce the old public session format in this temporary fixture only.
	// Resume must load it without registering an obsolete virtual-model alias.
	const entries = readFileSync(savedFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	for (const entry of entries) {
		if (entry.type === "model_change" && entry.provider === "model-switcher") entry.provider = "workflow";
		if (entry.type !== "custom") continue;
		if (entry.customType === "pi.virtual-model-state" && entry.data.provider === "model-switcher") entry.data.provider = "workflow";
		if (entry.customType === "model-switcher.phase") entry.customType = "workflow.phase";
		if (entry.customType === "model-switcher.override") entry.customType = "workflow.override";
	}
	writeFileSync(savedFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const oldState = entries.findLast((entry) => entry.type === "custom" && entry.customType === "pi.virtual-model-state").data.state;
	const { session } = await f.open(SessionManager.open(savedFile, join(f.root, "sessions")));
	assert.equal(session.sessionId, sessionId);
	assert.equal(session.model.provider, models.secondary.provider, "Pi falls back to the last physical model until the new router is selected");
	assert.deepEqual(routerStates(session), []);
	const start = f.calls.length;
	await f.prompt(session, "/model-switcher auto");
	assert.equal(f.calls.length, start, "the renamed command activates routing without a model request");
	assertVirtualSelection(session);
	await f.prompt(session, "Continue the already approved implementation.",
		{ model: "secondary", text: "Continued implementation using the existing phase, not a repeated phase signal." });
	assert.deepEqual(routerStates(session).at(-1).data.state, oldState);
	assertPlanningPreserved(f.calls.slice(start), planning);
	assert.equal(existsSync(join(f.agentDir, "model-switcher.json")), false, "reading legacy settings does not rewrite them");
});
