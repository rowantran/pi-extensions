import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import modelSwitcher, { classifierContext } from "../model-switcher.ts";
import { configPath, modelRef, readConfig } from "../model-switcher/config.ts";

const primary = { provider: "test", id: "interactive", api: "openai-completions" };
const secondary = { provider: "test", id: "implementation", api: "openai-completions" };
const virtual = { provider: "model-switcher", id: "auto", api: "pi-virtual" };
const classifier = { provider: "typesafe", id: "jev-latest", type: "classifier" };
const user = (content) => ({ role: "user", content, timestamp: 1 });
const choice = (phase, probability = 0.99) => ({
	stopReason: "stop", answers: { nextPhase: { type: "choice", choice: phase, probabilities: { [phase]: probability } } },
});

function setup(t, options = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-model-switcher-test-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	});
	if (!options.noConfig) writeFileSync(configPath(), JSON.stringify({
		interactive: "test/interactive", implementation: "test/implementation",
		classifier: options.classifier === undefined ? "typesafe/jev-latest" : options.classifier,
	}));
	const calls = [], notices = [];
	let definition, state, response = choice("planning");
	const available = new Map([primary, secondary, virtual].map((model) => [`${model.provider}/${model.id}`, model]));
	const ctx = {
		hasUI: true,
		// A router should use request.state, not inspect or write a second journal.
		sessionManager: new Proxy({}, { get() { throw new Error("Router accessed session history"); } }),
		ui: { notify: (message, level) => notices.push({ message, level }) },
		modelRegistry: {
			find: (provider, id) => available.get(`${provider}/${id}`),
			hasConfiguredAuth: () => true,
			findOfType: () => options.noClassifier ? undefined : classifier,
			classify: async (model, context, opts) => {
				calls.push({ model, context, opts });
				if (response instanceof Error) throw response;
				return typeof response === "function" ? response(opts) : response;
			},
		},
	};
	modelSwitcher(new Proxy({ registerVirtualModel: (value) => { definition = value; } }, {
		get(target, name) {
			assert.equal(name, "registerVirtualModel", `No tools, commands, hooks, model selection, or custom entries: ${String(name)}`);
			return target[name];
		},
	}));
	return {
		root, ctx, calls, notices, available, definition,
		answer(value) { response = value; },
		async route(overrides = {}) {
			const request = { model: virtual, reason: "user", thinkingLevel: "high", messages: [user("Discuss the design")], state, ...overrides };
			const result = await definition.route(request, ctx);
			if (request.reason !== "direct" && result.state !== undefined) state = result.state;
			return result;
		},
	};
}

test("registration only adds a virtual model and is inert until selected", (t) => {
	const h = setup(t, { noConfig: true });
	assert.equal(h.definition.provider, "model-switcher");
	assert.equal(h.definition.id, "auto");
	assert.equal(h.definition.name, "Model switcher");
	assert.equal(h.calls.length, 0);
	assert.equal(h.notices.length, 0);
	assert.equal(existsSync(configPath()), false);
});

test("classifier decisions alone route planning -> implementation -> review and retain the thinking level", async (t) => {
	const h = setup(t);
	for (const [phase, model] of [["planning", primary], ["implementation", secondary], ["review", primary]]) {
		h.answer(choice(phase));
		const result = await h.route({ thinkingLevel: "medium" });
		assert.equal(result.model, model);
		assert.equal(result.state.phase, phase);
		assert.equal(result.thinkingLevel, "medium");
	}
	assert.deepEqual(h.calls.map((call) => call.context.state.currentPhase), ["planning", "planning", "implementation"]);
});

test("uncertain, malformed, failed, and unavailable classifiers keep the Pi-provided state", async (t) => {
	const h = setup(t);
	h.answer(choice("implementation"));
	const initial = await h.route();
	for (const answer of [choice("implementation"), choice("review", 0.79), choice("review", NaN), choice("review", 1.1), choice("other"),
		{ stopReason: "error", answers: {} }, { stopReason: "stop", answers: {} }, { stopReason: "stop", answers: null }, new Error("provider down")]) {
		h.answer(answer);
		const result = await h.route();
		assert.equal(result.model, secondary);
		assert.equal(result.state, initial.state, "unchanged phase reuses state rather than adding redundant Pi entries");
	}
	h.ctx.modelRegistry.findOfType = () => undefined;
	assert.equal((await h.route()).model, secondary);
});

test("a valid threshold decision switches and an invalid saved phase starts in planning", async (t) => {
	const h = setup(t);
	h.answer(choice("implementation", 0.8));
	assert.equal((await h.route()).model, secondary);
	h.answer(choice("review", 0.79));
	const result = await h.route({ state: { phase: "unknown" } });
	assert.equal(result.model, primary);
	assert.deepEqual(result.state, { phase: "planning" });
});

test("disabled or missing classifiers start interactive and retain a previously saved phase", async (t) => {
	const h = setup(t, { classifier: null });
	assert.equal((await h.route()).model, primary);
	assert.equal((await h.route({ state: { phase: "implementation" } })).model, secondary);
	assert.equal(h.calls.length, 0);
	assert.equal(h.notices.length, 1);
	assert.match(h.notices[0].message, /Use \/model/);
});

test("classifier warnings are bounded and headless routing does not access UI", async (t) => {
	const h = setup(t, { noClassifier: true });
	assert.equal((await h.route()).model, primary);
	await h.route();
	assert.equal(h.notices.length, 1);
	h.ctx.hasUI = false;
	h.ctx.ui = new Proxy({}, { get() { throw new Error("UI accessed"); } });
	assert.equal((await h.route()).model, primary);
});

test("file edits and successful tools reach the next user classification, not a separate phase trigger", async (t) => {
	const h = setup(t);
	const messages = [user("Design it first; wait for approval")];
	for (const [toolName, text] of [["write", "Wrote pseudocode stubs in src/cache.ts"], ["bash", "Committed and opened a draft PR"]]) {
		messages.push({ role: "toolResult", toolName, content: [{ type: "text", text }], isError: false });
		const result = await h.route({ messages: [...messages, user("Revise the design; do not implement yet")] });
		assert.equal(result.model, primary);
		assert.equal(result.state.phase, "planning");
		assert.equal(h.calls.at(-1).context.state.recentMessages.at(-2).text, text);
	}
	assert.equal(h.calls.length, 2);
});

test("tool continuations keep the dispatched model and thinking level without config reads or classification", async (t) => {
	const h = setup(t, { noConfig: true });
	const state = { phase: "planning" };
	// Deliberately disagree with the saved phase: the dispatched model wins.
	for (const reason of ["continuation", "retry"]) {
		const result = await h.route({ reason, state, previous: { model: secondary, thinkingLevel: "low" } });
		assert.equal(result.model, secondary);
		assert.equal(result.thinkingLevel, "low");
		assert.equal(result.state, state);
	}
	const noState = await h.route({ reason: "continuation", state: undefined, previous: { model: primary } });
	assert.equal(noState.model, primary);
	assert.equal(noState.thinkingLevel, "high");
	assert.equal(noState.state, undefined);
	assert.equal(h.calls.length, 0);
	assert.equal(h.notices.length, 0);
});

test("continuations without a previous response use the saved phase or interactive default without classifying", async (t) => {
	const h = setup(t);
	h.answer(choice("review"));
	for (const [state, model] of [[undefined, primary], [{ phase: "implementation" }, secondary], [{ phase: "unknown" }, primary]]) {
		const result = await h.route({ reason: "continuation", state });
		assert.equal(result.model, model);
	}
	assert.equal(h.calls.length, 0);
	assert.equal(h.notices.length, 0);
});

test("direct calls and retries do not classify or change phase", async (t) => {
	const h = setup(t);
	const state = { phase: "implementation" };
	const direct = await h.route({ reason: "direct", state: undefined, previous: { model: secondary } });
	assert.equal(direct.model, secondary);
	assert.equal(direct.state, undefined);
	assert.equal((await h.route({ reason: "direct", state: undefined })).model, primary);
	const retry = await h.route({ reason: "retry", state, failed: { model: primary, thinkingLevel: "low" }, previous: { model: secondary, thinkingLevel: "medium" } });
	assert.equal(retry.model, primary);
	assert.equal(retry.thinkingLevel, "low");
	assert.equal(retry.state, state);
	const noFailedResponse = await h.route({ reason: "retry", state });
	assert.equal(noFailedResponse.model, secondary);
	assert.equal(noFailedResponse.state, state);
	assert.equal(h.calls.length, 0);
});

test("an aborted request is not converted into fallback work", async (t) => {
	const h = setup(t);
	const before = new AbortController();
	before.abort();
	await assert.rejects(h.route({ signal: before.signal }), { name: "AbortError" });
	assert.equal(h.calls.length, 0);
	const during = new AbortController();
	h.answer(() => { during.abort(); return { stopReason: "aborted", answers: {} }; });
	await assert.rejects(h.route({ signal: during.signal }), { name: "AbortError" });
	assert.equal(h.notices.length, 0, "cancellation is not a provider warning");
});

test("the 1.5-second classifier deadline retains phase, including when a provider returns a late decision", async (t) => {
	const h = setup(t);
	let deadline;
	const timeouts = [];
	t.mock.method(AbortSignal, "timeout", (ms) => {
		timeouts.push(ms);
		deadline = new AbortController();
		return deadline.signal;
	});
	for (const [state, model] of [[undefined, primary], [{ phase: "implementation" }, secondary]]) {
		for (const lateDecision of [false, true]) {
			const started = Promise.withResolvers();
			h.answer(async ({ signal }) => {
				const aborted = new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
				started.resolve(signal);
				await aborted;
				return lateDecision ? choice("review") : { stopReason: "aborted", answers: {} };
			});
			const parent = new AbortController();
			const pending = h.route({ state, signal: parent.signal });
			const signal = await started.promise;
			assert.equal(signal.aborted, false);
			deadline.abort(new DOMException("Classifier deadline exceeded", "TimeoutError"));
			const result = await pending;
			assert.equal(signal.aborted, true);
			assert.equal(parent.signal.aborted, false, "Local timeout does not cancel the user's request");
			assert.equal(result.model, model);
			if (state) assert.equal(result.state, state);
			else assert.deepEqual(result.state, { phase: "planning" });
		}
	}
	assert.deepEqual(timeouts, [1500, 1500, 1500, 1500]);
	assert.equal(h.notices.length, 1);
});

test("classifier projection is bounded, strips private blocks, and never mutates model context", () => {
	const latest = user("User approval stays available even after many tool calls");
	const messages = [
		{ role: "system", content: "SECRET_SYSTEM" }, latest,
		...Array.from({ length: 20 }, () => ({ role: "toolResult", toolName: "read", content: [{ type: "text", text: "x".repeat(20000) }], isError: false })),
		{ role: "assistant", content: [{ type: "thinking", thinking: "SECRET_THINKING" }, { type: "toolCall", name: "bash", arguments: { secret: "SECRET_ARGUMENTS" } }, { type: "image", data: "SECRET_IMAGE" }, { type: "text", text: "Inspect test output" }] },
	];
	const before = structuredClone(messages);
	const result = classifierContext({ messages, reason: "continuation" }, "implementation");
	assert.equal(result.state.latestUserMessage, latest.content);
	assert.equal(result.state.recentMessages.length, 8);
	assert.ok(JSON.stringify(result).length < 30000);
	assert.ok(!JSON.stringify(result).includes("SECRET_"));
	assert.deepEqual(messages, before);
});

test("selected model errors remain actionable; no silent cross-provider fallback", async (t) => {
	const h = setup(t);
	h.answer(choice("implementation"));
	h.available.delete("test/implementation");
	await assert.rejects(h.route(), /installed physical model/);
	h.available.set("test/implementation", virtual);
	await assert.rejects(h.route(), /installed physical model/);
	h.available.set("test/implementation", secondary);
	h.ctx.modelRegistry.hasConfiguredAuth = () => false;
	await assert.rejects(h.route(), /no configured credentials/);
});

test("configuration validates model references and never changes settings", async (t) => {
	const h = setup(t, { classifier: null });
	const before = readFileSync(configPath(), "utf8");
	await h.route();
	assert.equal(readFileSync(configPath(), "utf8"), before);
	assert.equal(configPath(), join(h.root, "model-switcher.json"));
	assert.equal(readConfig().classifier, null);
	assert.deepEqual(modelRef("openrouter/company/model"), ["openrouter", "company/model"]);
	for (const value of ["", "no-provider", "/id", "a/", "a/id x", null]) assert.throws(() => modelRef(value));
	for (const invalid of ["{broken", "[]", "null", '{"interactive":"test/interactive","implementation":"test/implementation","typo":true}']) {
		writeFileSync(configPath(), invalid);
		assert.throws(readConfig);
		assert.equal(readFileSync(configPath(), "utf8"), invalid);
	}
});

test("old config filename remains readable but new-file errors never fall back to old settings", (t) => {
	const h = setup(t, { noConfig: true });
	const legacyPath = join(h.root, "workflow.json");
	const legacy = { interactive: "test/interactive", implementation: "test/implementation", classifier: "other/custom" };
	writeFileSync(legacyPath, JSON.stringify(legacy));
	assert.deepEqual(readConfig(), legacy);
	assert.equal(existsSync(configPath()), false);
	writeFileSync(configPath(), JSON.stringify({ ...legacy, classifier: null }));
	assert.equal(readConfig().classifier, null);
	writeFileSync(configPath(), "{broken");
	assert.throws(readConfig, /model-switcher\.json/);
	rmSync(configPath());
	writeFileSync(legacyPath, "{broken");
	assert.throws(readConfig, /workflow\.json/);
	rmSync(legacyPath);
	assert.throws(readConfig, /Create .*model-switcher\.json/);
	writeFileSync(configPath(), JSON.stringify({ interactive: legacy.interactive, implementation: legacy.implementation }));
	assert.equal(readConfig().classifier, "typesafe/jev-latest");
});
