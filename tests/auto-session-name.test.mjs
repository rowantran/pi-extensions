import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import autoSessionName, { INSTRUCTIONS, configPath, excerpt, readConfig, normalizeTitle } from "../auto-session-name.ts";

const haiku = { provider: "isara", id: "claude-haiku", api: "anthropic-messages" };
const opus = { provider: "isara", id: "claude-opus", api: "anthropic-messages" };
const virtual = { provider: "model-switcher", id: "auto", api: "pi-virtual" };
const message = (role, content, extra = {}) => ({ type: "message", message: { role, content, ...extra } });
const user = (text) => message("user", text);
const reply = (text, model = opus) => message("assistant", [{ type: "thinking", thinking: "hidden" }, { type: "text", text }], { provider: model.provider, model: model.id });
const answer = (text, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason });

function setup(t, { config, branch = [user("Please fix the login redirect loop"), reply("Fixed the redirect.")], respond } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-auto-session-name-test-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	});
	if (config !== undefined) writeFileSync(configPath(), typeof config === "string" ? config : JSON.stringify(config));
	const handlers = new Map(), calls = [], notices = [];
	const state = { name: undefined, sessionId: "session-1", branch };
	const models = new Map([haiku, opus, virtual].map((model) => [`${model.provider}/${model.id}`, model]));
	autoSessionName({
		on: (event, handler) => handlers.set(event, handler),
		getSessionName: () => state.name,
		setSessionName: (name) => { state.name = name; },
	});
	const ctx = {
		hasUI: true,
		ui: { notify: (text, level) => notices.push({ text, level }) },
		sessionManager: { getBranch: () => state.branch, getSessionId: () => state.sessionId },
		modelRegistry: {
			find: (provider, id) => models.get(`${provider}/${id}`),
			complete: async (model, context, options) => {
				calls.push({ model, context, options });
				return respond ? respond({ model, context, options, state }) : answer("Fix Login Redirect Loop");
			},
		},
	};
	return { state, calls, notices, settle: () => handlers.get("agent_settled")({ type: "agent_settled" }, ctx), emit: (event, value) => handlers.get(event)(value, ctx) };
}

test("names an unnamed session with a title from the model of the latest reply", async (t) => {
	const { state, calls, notices, settle } = setup(t);
	await settle();
	assert.equal(state.name, "Fix Login Redirect Loop");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].model, opus);
	assert.equal(calls[0].context.systemPrompt, INSTRUCTIONS);
	assert.equal(calls[0].context.messages[0].content[0].text, "User: Please fix the login redirect loop\n\nAssistant: Fixed the redirect.");
	assert.equal(calls[0].options.cacheRetention, "none");
	await settle();
	assert.equal(calls.length, 1, "a named session is left alone");
	assert.deepEqual(notices, []);
});

test("uses the configured model, and can be turned off", async (t) => {
	const configured = setup(t, { config: { model: "isara/claude-haiku" } });
	await configured.settle();
	assert.equal(configured.calls[0].model, haiku);

	const off = setup(t, { config: { enabled: false } });
	await off.settle();
	assert.equal(off.calls.length, 0);
	assert.equal(off.state.name, undefined);
});

test("waits until the branch has both user and assistant text", async (t) => {
	const { state, calls, settle } = setup(t, { branch: [user("only a question")] });
	await settle();
	assert.equal(calls.length, 0);
	state.branch = [user("only a question"), reply("an answer")];
	await settle();
	assert.equal(state.name, "Fix Login Redirect Loop");
});

test("a manual name or session switch during the request wins", async (t) => {
	const renamed = setup(t, { respond: ({ state }) => { state.name = "chosen by user"; return answer("generated"); } });
	await renamed.settle();
	assert.equal(renamed.state.name, "chosen by user");

	const switched = setup(t, { respond: ({ state }) => { state.sessionId = "session-2"; return answer("generated"); } });
	await switched.settle();
	assert.equal(switched.state.name, undefined);

	let release;
	const pending = setup(t, { respond: ({ options }) => new Promise((resolve) => { release = () => resolve(answer("generated", options.signal.aborted ? "aborted" : "stop")); }) });
	const run = pending.settle();
	await pending.settle(); // concurrent settle does not start a second request
	assert.equal(pending.calls.length, 1);
	pending.emit("session_info_changed", { type: "session_info_changed", name: "manual" });
	assert.equal(pending.calls[0].options.signal.aborted, true);
	release();
	await run;
	assert.equal(pending.state.name, undefined);
	assert.deepEqual(pending.notices, [], "an aborted request is not reported");
});

test("failures warn once and later runs retry", async (t) => {
	let fail = true;
	const { state, calls, notices, settle } = setup(t, { respond: () => fail ? answer("", "error") : answer("Add CSV export") });
	await settle();
	await settle();
	assert.equal(calls.length, 2);
	assert.equal(notices.length, 1);
	assert.match(notices[0].text, /^Automatic session naming failed/);
	fail = false;
	await settle();
	assert.equal(state.name, "Add CSV export");
});

test("a virtual latest-reply model or bad config is reported, not sent", async (t) => {
	const viaVirtual = setup(t, { branch: [user("hi"), reply("hello", virtual)] });
	await viaVirtual.settle();
	assert.equal(viaVirtual.calls.length, 0);
	assert.match(viaVirtual.notices[0].text, /must be a physical model/);

	const bad = setup(t, { config: "{not json" });
	await bad.settle();
	assert.equal(bad.calls.length, 0);
	assert.match(bad.notices[0].text, /Cannot read/);
});

test("config validation", (t) => {
	setup(t, { config: { model: "isara/claude-haiku", enabled: true } });
	assert.deepEqual(readConfig(), { enabled: true, model: "isara/claude-haiku" });
	for (const config of [{ model: "no-slash" }, { enabled: "no" }, { other: 1 }, []]) {
		writeFileSync(configPath(), JSON.stringify(config));
		assert.throws(readConfig, /Invalid/);
	}
});

test("excerpt keeps visible text, the first request, and recent messages", () => {
	const branch = [user("first request"), { type: "custom", data: {} }, ...Array.from({ length: 8 }, (_, i) => i % 2 ? reply(`reply ${i}`) : user(`ask ${i}`))];
	const text = excerpt(branch);
	assert.match(text, /^User: first request\n\n/);
	assert.ok(!text.includes("hidden"));
	assert.equal(text.split("\n\n").length, 6);
	assert.match(text, /Assistant: reply 7$/);
	assert.ok(excerpt([user("x".repeat(5000)), reply("y")]).length < 1600);
});

test("normalizeTitle preserves normal titles and removes surrounding quotes and extra whitespace", () => {
	assert.equal(normalizeTitle('\n "Fix Login Redirect!" \nignored'), "Fix Login Redirect!");
	assert.equal(normalizeTitle("‘Fix café login: OAuth + redirects’"), "Fix café login: OAuth + redirects");
	assert.equal(normalizeTitle("Repair\t  CSV\u0000 export"), "Repair CSV export");
	assert.equal(normalizeTitle("改善登录流程"), "改善登录流程");
	assert.equal(normalizeTitle("\n  \n"), undefined);
	assert.equal(normalizeTitle('""'), undefined);
});

test("normalizeTitle caps titles at 80 characters without splitting Unicode characters", () => {
	assert.equal(normalizeTitle("x".repeat(80)), "x".repeat(80));
	assert.equal(normalizeTitle("x".repeat(100)), "x".repeat(80));
	assert.equal(normalizeTitle("x".repeat(79) + " 🐛 more text"), "x".repeat(79));
	assert.equal(normalizeTitle("🐛".repeat(81)), "🐛".repeat(80));
});
