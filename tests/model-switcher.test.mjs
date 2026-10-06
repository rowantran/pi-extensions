import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import modelSwitcher, { classifierContext } from "../model-switcher.ts";
import { configPath, modelRef, readConfig } from "../model-switcher/config.ts";

const primary = { provider: "test", id: "interactive", api: "openai-completions" };
const secondary = { provider: "test", id: "implementation", api: "openai-completions" };
const virtual = { provider: "model-switcher", id: "auto", api: "pi-virtual" };
const classifier = { provider: "typesafe", id: "jev-latest", type: "classifier" };
const user = (content) => ({ role: "user", content, timestamp: 1 });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 2 });
const choice = (phase, probability = 0.99) => ({
	stopReason: "stop", answers: { nextPhase: { type: "choice", choice: phase, probabilities: { [phase]: probability } } },
});

function setup(t, options = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-model-switcher-test-"));
	const old = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; rmSync(root, { recursive: true, force: true }); });
	if (!options.noConfig) writeFileSync(configPath(), JSON.stringify({ interactive: "test/interactive", implementation: "test/implementation", classifier: options.classifier === undefined ? "typesafe/jev-latest" : options.classifier }));
	const manager = SessionManager.inMemory(root);
	const commands = new Map(), tools = new Map(), events = new Map(), notices = [], selections = [], calls = [];
	let definition;
	let response = choice("planning");
	const available = new Map([primary, secondary, virtual].map((model) => [`${model.provider}/${model.id}`, model]));
	const ctx = {
		model: primary, hasUI: true, isIdle: () => true, sessionManager: manager,
		ui: { notify: (message, level) => notices.push({ message, level }), setStatus() {} },
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
	let thinking = "high";
	const api = {
		registerVirtualModel: (model) => { definition = model; },
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, command) => commands.set(name, command),
		on: (name, handler) => events.set(name, handler),
		appendEntry: (type, data) => manager.appendCustomEntry(type, data),
		setModel: async (model) => { ctx.model = model; selections.push(model); thinking = "low"; return true; },
		getThinkingLevel: () => thinking,
		setThinkingLevel: (level) => { thinking = level; },
	};
	modelSwitcher(api);
	function state() {
		return manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "pi.virtual-model-state").at(-1)?.data.state;
	}
	return {
		root, manager, ctx, notices, selections, calls, available, commands, tools, definition, events, api,
		answer(value) { response = value; },
		command(args) { return commands.get("model-switcher").handler(args, ctx); },
		phase(value, signal) { return tools.get("model_switcher_phase").execute("test", { phase: value }, signal, undefined, ctx); },
		async route(overrides = {}) {
			const request = { model: virtual, reason: "user", thinkingLevel: "high", messages: [user("Discuss the design")], state: state(), ...overrides };
			const result = await definition.route(request, ctx);
			if (result.state && result.state !== request.state && request.reason !== "direct") manager.appendCustomEntry("pi.virtual-model-state", { provider: "model-switcher", modelId: "auto", state: result.state });
			return result;
		},
	};
}

test("registration is inert: no config, model changes, classification, or context hooks", (t) => {
	const h = setup(t, { noConfig: true });
	assert.equal(h.definition.provider, "model-switcher");
	assert.equal(h.definition.id, "auto");
	assert.equal(h.definition.name, "Model switcher");
	assert.deepEqual([...h.commands.keys()], ["model-switcher"]);
	assert.deepEqual([...h.tools.keys()], ["model_switcher_phase"]);
	assert.equal(configPath(), join(h.root, "model-switcher.json"));
	assert.equal(h.selections.length, 0);
	assert.equal(h.calls.length, 0);
	assert.equal(h.manager.getBranch().length, 0);
	assert.deepEqual([...h.events.keys()], ["model_select"]);
});

test("explicit phase signals route planning -> implementation -> review before the next reply", async (t) => {
	const h = setup(t);
	for (const [phase, model] of [["planning", primary], ["implementation", secondary], ["review", primary]]) {
		await h.phase(phase);
		const result = await h.route({ reason: "continuation" });
		assert.equal(result.model, model);
		assert.equal(result.state.phase, phase);
		assert.equal(h.ctx.model, virtual);
	}
	assert.equal(h.calls.length, 0, "explicit phase transitions do not need a classifier call");
});

test("phase activation preserves thinking and does not reselect an already active virtual model", async (t) => {
	const h = setup(t);
	await h.phase("planning");
	assert.equal(h.api.getThinkingLevel(), "high", "first activation preserves the current thinking level");
	h.api.setThinkingLevel("xhigh");
	await h.phase("implementation");
	await h.command("interactive");
	assert.equal(h.selections.length, 1, "phase signals and overrides do not reselect model-switcher/auto");
	assert.equal(h.api.getThinkingLevel(), "xhigh");
});

test("cancelled phase tools do not persist pending signals", async (t) => {
	const h = setup(t);
	const before = new AbortController();
	before.abort();
	await assert.rejects(h.phase("implementation", before.signal), { name: "AbortError" });
	assert.equal(h.selections.length, 0);
	const during = new AbortController();
	const original = h.api.setModel;
	h.api.setModel = async (model) => { const result = await original(model); during.abort(); return result; };
	await assert.rejects(h.phase("implementation", during.signal), { name: "AbortError" });
	assert.equal(h.manager.getBranch().length, 0);
});

test("a newer user turn invalidates an interrupted phase signal", async (t) => {
	const h = setup(t);
	h.manager.appendMessage(user("Approved, implement it"));
	await h.phase("implementation");
	// Simulate interruption after the tool, before the next routed request.
	h.manager.appendMessage(user("Stop; reopen the design instead"));
	h.answer(choice("planning"));
	const result = await h.route();
	assert.equal(result.model, primary);
	assert.equal(h.calls.length, 1, "new user input is reclassified rather than bypassed by a stale signal");
	assert.ok(result.state.signalId, "stale signal is consumed, not reapplied later");
	await h.command("status");
	assert.match(h.notices.at(-1).message, /phase: planning/);
});

test("Jev can detect both implementation and interactive review", async (t) => {
	const h = setup(t);
	h.answer(choice("implementation"));
	const implementation = await h.route({ messages: [user("The skeleton is approved. Implement it.")] });
	assert.equal(implementation.model, secondary);
	assert.equal(h.calls[0].context.state.currentPhase, "planning");
	h.answer(choice("review"));
	const review = await h.route({ reason: "continuation", messages: [assistant("Implementation is complete; discuss the results with the user.")] });
	assert.equal(review.model, primary);
	assert.equal(review.state.phase, "review");
	assert.equal(h.calls[1].context.state.currentPhase, "implementation");
});

test("in-place pseudocode edits, commits, and draft PR publication do not trigger implementation", async (t) => {
	const h = setup(t, { noClassifier: true });
	const messages = [user("Design it first; wait for approval of the skeleton commit")];
	for (const [toolName, text] of [
		["write", "Wrote pseudocode stubs in src/cache.ts"],
		["edit", "Updated the existing src/service.ts contract"],
		["bash", "Committed and pushed the skeleton as the first task commit"],
		["bash", "Opened draft PR https://example.invalid/pull/1"],
	]) {
		messages.push({ role: "toolResult", toolName, content: [{ type: "text", text }], isError: false });
		const result = await h.route({ reason: "continuation", messages });
		assert.equal(result.model, primary);
		assert.equal(result.state.phase, "planning");
	}
});

test("uncertain, malformed, failed, and unavailable classifiers preserve the phase", async (t) => {
	const h = setup(t);
	await h.phase("implementation");
	const initial = await h.route();
	for (const result of [choice("review", 0.79), choice("review", NaN), choice("review", 1.1), choice("other"), { stopReason: "error", answers: {} }, { stopReason: "stop", answers: {} }, new Error("provider down")]) {
		h.answer(result);
		const routed = await h.route();
		assert.equal(routed.model, secondary);
		assert.equal(routed.state, initial.state, "unchanged routing reuses state instead of appending entries");
	}
	h.ctx.modelRegistry.findOfType = () => undefined;
	assert.equal((await h.route()).model, secondary);
});

test("classifier warnings are bounded and safe in headless sessions", async (t) => {
	const h = setup(t, { noClassifier: true });
	await h.route(); await h.route();
	assert.equal(h.notices.length, 1);
	h.ctx.hasUI = false;
	h.ctx.ui = new Proxy({}, { get() { throw new Error("UI accessed"); } });
	await h.route();
});

test("classifier can be disabled without disabling phase signals", async (t) => {
	const h = setup(t, { classifier: null });
	assert.equal((await h.route()).model, primary);
	await h.phase("implementation");
	assert.equal((await h.route()).model, secondary);
	assert.equal((await h.route()).model, secondary);
	assert.equal(h.calls.length, 0);
});

test("manual routing overrides classifier and agent phase signals until auto", async (t) => {
	const h = setup(t);
	await h.command("interactive");
	await h.phase("implementation");
	assert.equal((await h.route()).model, primary);
	assert.equal(h.calls.length, 0);
	await h.command("implementation");
	await h.phase("review");
	assert.equal((await h.route()).model, secondary);
	assert.equal(h.calls.length, 0);
	h.answer(choice("review"));
	await h.command("auto");
	assert.equal((await h.route()).model, primary);
	assert.equal(h.calls.length, 1);
});

test("branch navigation restores phase signals and overrides from that branch only", async (t) => {
	const h = setup(t, { classifier: null });
	await h.phase("planning");
	await h.route();
	const planningLeaf = h.manager.getLeafId();
	await h.command("implementation");
	await h.phase("implementation");
	await h.route();
	h.manager.branch(planningLeaf);
	const result = await h.route();
	assert.equal(result.model, primary);
	assert.equal(result.state.phase, "planning");
});

test("renamed router reads legacy branch state and consumed signals without replaying them", async (t) => {
	const h = setup(t, { classifier: null });
	const userId = h.manager.appendMessage(user("Approved, implement it"));
	const signalId = h.manager.appendCustomEntry("workflow.phase", { phase: "planning", userId });
	const legacy = { phase: "implementation", signalId };
	h.manager.appendCustomEntry("pi.virtual-model-state", { provider: "workflow", modelId: "auto", state: legacy });
	const oldBranch = h.manager.getBranch().slice();
	await h.command("auto");
	const result = await h.route({ state: undefined });
	assert.equal(result.model, secondary);
	assert.deepEqual(result.state, legacy, "the last classified phase wins over the consumed planning signal");
	assert.equal(h.manager.getBranch().at(-1).data.provider, "model-switcher");
	assert.deepEqual(h.manager.getBranch().slice(0, oldBranch.length), oldBranch, "existing history stays unchanged");

	await h.phase("review");
	const review = await h.route();
	assert.equal(review.model, primary);
	assert.equal(review.state.phase, "review");
});

test("legacy pending signals and overrides yield to newer model-switcher controls on the same branch", async (t) => {
	const h = setup(t, { classifier: null });
	const userId = h.manager.appendMessage(user("Approved, implement it"));
	h.manager.appendCustomEntry("workflow.phase", { phase: "implementation", userId });
	h.manager.appendCustomEntry("workflow.override", { mode: "interactive" });
	const branch = h.manager.getLeafId();
	const pending = await h.route({ state: undefined });
	assert.equal(pending.state.phase, "implementation");
	assert.equal(pending.model, primary, "legacy override still wins over the signal");
	await h.command("auto");
	assert.equal((await h.route()).model, secondary);
	await h.phase("review");
	assert.equal((await h.route()).state.phase, "review");
	h.manager.branch(branch);
	assert.equal((await h.route({ state: undefined })).model, primary, "new overrides on another branch do not leak into the old branch");
});

test("compaction retains phase state and does not change routing policy", async (t) => {
	const h = setup(t, { classifier: null });
	const first = h.manager.appendMessage(user("Keep this constraint"));
	await h.phase("implementation");
	await h.route();
	h.manager.appendCompaction("A compact summary", first, 10000);
	assert.equal((await h.route()).model, secondary);
});

test("direct calls and retries do not classify or mutate phase", async (t) => {
	const h = setup(t);
	await h.phase("implementation");
	const initial = await h.route();
	const direct = await h.route({ reason: "direct", state: undefined, previous: { model: primary } });
	assert.equal(direct.model, primary);
	assert.equal(direct.state, undefined);
	assert.equal((await h.route({ reason: "direct", state: undefined })).model, primary);
	const retry = await h.route({ reason: "retry", failed: { model: secondary, thinkingLevel: "low" } });
	assert.equal(retry.model, secondary);
	assert.equal(retry.thinkingLevel, "low");
	assert.equal(retry.state, initial.state);
	assert.equal(h.calls.length, 0);
});

test("an aborted request is not converted into fallback work", async (t) => {
	const h = setup(t);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(h.route({ signal: controller.signal }), { name: "AbortError" });
	assert.equal(h.calls.length, 0);
	const during = new AbortController();
	h.answer(() => { during.abort(); return { stopReason: "aborted", answers: {} }; });
	await assert.rejects(h.route({ signal: during.signal }), { name: "AbortError" });
});

test("classifier gets a timeout signal and provider failure retains current phase", async (t) => {
	const h = setup(t);
	h.answer({ stopReason: "aborted", answers: {} });
	assert.equal((await h.route()).model, primary);
	assert.ok(h.calls[0].opts.signal instanceof AbortSignal);
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
	const json = JSON.stringify(result);
	assert.ok(json.length < 30000);
	assert.ok(!json.includes("SECRET_"));
	assert.deepEqual(messages, before);
});

test("configured model failures are actionable; no silent cross-provider fallback", async (t) => {
	const h = setup(t, { classifier: null });
	h.available.delete("test/implementation");
	await assert.rejects(h.phase("implementation"), /installed physical model/);
	assert.equal(h.manager.getBranch().length, 0);
	assert.equal(h.selections.length, 0);
	h.available.set("test/implementation", secondary);
	h.ctx.modelRegistry.hasConfiguredAuth = () => false;
	await assert.rejects(h.route(), /no configured credentials/);
});

test("models command validates refs, rejects virtual models, and stores config outside the package", async (t) => {
	const h = setup(t, { noConfig: true });
	await h.command("models test/interactive test/implementation");
	assert.deepEqual(readConfig(), { interactive: "test/interactive", implementation: "test/implementation", classifier: "typesafe/jev-latest" });
	assert.equal(h.selections.length, 0, "configuration does not change the selected/default model");
	const original = readFileSync(configPath(), "utf8");
	await h.command("models model-switcher/auto test/implementation");
	assert.equal(h.notices.at(-1).level, "error");
	assert.equal(readFileSync(configPath(), "utf8"), original);
	assert.deepEqual(modelRef("openrouter/company/model"), ["openrouter", "company/model"]);
	for (const value of ["", "no-provider", "/id", "a/", "a/id x", null]) assert.throws(() => modelRef(value));
});

test("configuration validation rejects unknown keys and preserves an explicitly disabled classifier", async (t) => {
	const h = setup(t, { classifier: null });
	await h.command("models test/interactive test/implementation");
	assert.equal(readConfig().classifier, null);
	writeFileSync(configPath(), '{"interactive":"test/interactive","implementation":"test/implementation","typo":true}');
	assert.throws(readConfig, /Invalid model-switcher configuration/);
	await h.command("models test/interactive test/implementation");
	assert.equal(h.notices.at(-1).level, "error", "do not silently overwrite malformed configuration");
});

test("legacy settings remain readable; saving the model pair uses the new file and preserves the classifier", async (t) => {
	const h = setup(t, { noConfig: true });
	const oldPath = join(h.root, "workflow.json");
	for (const classifier of [null, "other/custom-classifier"]) {
		rmSync(configPath(), { force: true });
		const legacy = { interactive: "test/interactive", implementation: "test/implementation", classifier };
		const original = JSON.stringify(legacy);
		writeFileSync(oldPath, original);
		assert.deepEqual(readConfig(), legacy);
		assert.equal(existsSync(configPath()), false, "reading must not mutate settings");
		await h.command("models test/implementation test/interactive");
		assert.equal(h.notices.at(-1).level, "info");
		assert.deepEqual(readConfig(), { interactive: "test/implementation", implementation: "test/interactive", classifier });
		assert.equal(readFileSync(oldPath, "utf8"), original, "keep the old file untouched");
		assert.equal(statSync(configPath()).mode & 0o777, 0o600);
	}
});

test("new configuration takes precedence and invalid settings never silently fall back or get overwritten", async (t) => {
	const h = setup(t, { classifier: null });
	const oldPath = join(h.root, "workflow.json");
	writeFileSync(oldPath, JSON.stringify({ interactive: "old/planner", implementation: "old/builder", classifier: "other/classifier" }));
	assert.equal(readConfig().classifier, null);
	for (const invalid of ["{broken", '{"interactive":"test/interactive","implementation":"test/implementation","typo":true}']) {
		writeFileSync(configPath(), invalid);
		assert.throws(readConfig);
		await h.command("models test/interactive test/implementation");
		assert.equal(h.notices.at(-1).level, "error");
		assert.equal(readFileSync(configPath(), "utf8"), invalid);
	}
	rmSync(configPath());
	writeFileSync(oldPath, "{broken");
	assert.throws(readConfig, /workflow\.json/);
	await h.command("models test/interactive test/implementation");
	assert.equal(h.notices.at(-1).level, "error");
	assert.equal(existsSync(configPath()), false);
	rmSync(oldPath);
	assert.throws(readConfig, /Configure routing first: \/model-switcher models/);
});

test("off selects the interactive physical model and preserves the session", async (t) => {
	const h = setup(t);
	h.manager.appendMessage(user("Do not lose my planning discussion"));
	await h.phase("implementation");
	const branch = h.manager.getBranch();
	await h.command("off");
	assert.equal(h.ctx.model, primary);
	assert.deepEqual(h.manager.getBranch(), branch);
	assert.equal(h.notices.at(-1).level, "info");
});

test("commands refuse changes while busy and report status without classifying", async (t) => {
	const h = setup(t);
	h.ctx.isIdle = () => false;
	await h.command("implementation");
	assert.equal(h.selections.length, 0);
	assert.equal(h.notices.at(-1).level, "warning");
	h.ctx.isIdle = () => true;
	await h.phase("review");
	await h.command("");
	assert.match(h.notices.at(-1).message, /phase: review/);
	assert.equal(h.calls.length, 0);
	await h.command("nonsense");
	assert.equal(h.notices.at(-1).level, "error");
});
