import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import autoSessionName, { INSTRUCTIONS, STATE_TYPE, configPath, excerpt, readConfig, normalizeTitle, summaryText } from "../auto-session-name.ts";

const haiku = { provider: "isara", id: "claude-haiku", api: "anthropic-messages" };
const opus = { provider: "isara", id: "claude-opus", api: "anthropic-messages" };
const virtual = { provider: "model-switcher", id: "auto", api: "pi-virtual" };
let entryId = 0;
const entry = (value) => ({ id: `entry-${++entryId}`, parentId: null, timestamp: new Date().toISOString(), ...value });
const message = (role, content, extra = {}) => entry({ type: "message", message: { role, content, ...extra } });
const user = (text) => message("user", text);
const reply = (text, model = opus) => message("assistant", [{ type: "thinking", thinking: "hidden" }, { type: "text", text }], { provider: model.provider, model: model.id });
const answer = (text, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason });
const drain = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, { config, branch = [user("Please fix the login redirect loop"), reply("Fixed the redirect.")], respond, deferNameEvents = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-auto-session-name-test-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	});
	if (config !== undefined) writeFileSync(configPath(), typeof config === "string" ? config : JSON.stringify(config));
	const handlers = new Map(), calls = [], notices = [], nameEvents = [];
	const state = { name: undefined, sessionId: "session-1", branch: [...branch], entries: [...branch] };
	const append = (value) => {
		const added = entry({ ...value, parentId: state.branch.at(-1)?.id ?? null });
		state.branch.push(added);
		state.entries.push(added);
		return added;
	};
	const emit = (event, value = { type: event }) => handlers.get(event)(value, ctx);
	const rename = (name) => {
		state.name = name?.trim() || undefined;
		append({ type: "session_info", name });
		if (deferNameEvents) nameEvents.push({ type: "session_info_changed", name: state.name });
		else emit("session_info_changed", { type: "session_info_changed", name: state.name });
	};
	const pi = {
		on: (event, handler) => handlers.set(event, handler),
		getSessionName: () => state.name,
		setSessionName: rename,
		appendEntry: (customType, data) => append({ type: "custom", customType, data: structuredClone(data) }),
	};
	autoSessionName(pi);
	const models = new Map([haiku, opus, virtual].map((model) => [`${model.provider}/${model.id}`, model]));
	const ctx = {
		hasUI: true,
		ui: { notify: (text, level) => notices.push({ text, level }) },
		sessionManager: { getBranch: () => state.branch, getEntries: () => state.entries, getSessionId: () => state.sessionId },
		modelRegistry: {
			find: (provider, id) => models.get(`${provider}/${id}`),
			complete: async (model, context, options) => {
				calls.push({ model, context, options });
				return respond ? respond({ model, context, options, state }) : answer("Fix Login Redirect Loop");
			},
		},
	};
	const settle = async () => { emit("agent_settled"); await drain(); };
	return {
		state, calls, notices, settle, emit, rename, append,
		turn: async () => { append(user("Now add CSV export")); append(reply("Added the export.")); await settle(); },
		compact: async (summary, { reason = "manual", willRetry = false } = {}) => {
			const compactionEntry = append({ type: "compaction", summary, firstKeptEntryId: state.branch.findLast((e) => e.type === "message" && e.message.role === "user")?.id, tokensBefore: 10000 });
			emit("session_compact", { type: "session_compact", compactionEntry, reason, willRetry, fromExtension: true });
			await drain();
		},
		reload: () => { autoSessionName(pi); return emit("session_start", { type: "session_start", reason: "reload" }); },
		flushNameEvents: async () => { for (const event of nameEvents.splice(0)) await emit("session_info_changed", event); },
		saved: () => state.entries.findLast((e) => e.type === "custom" && e.customType === STATE_TYPE)?.data,
	};
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
	assert.equal(calls[0].options.maxTokens, undefined, "reasoning models must have room to produce a title");
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
	pending.rename("manual");
	assert.equal(pending.calls[0].options.signal.aborted, true);
	release();
	await run;
	assert.equal(pending.state.name, "manual");
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

test("updates only at user turns 4, 8, 16, 32, and 64", async (t) => {
	let generation = 0;
	const f = setup(t, { respond: () => answer(`Task title ${++generation}`) });
	await f.settle();
	assert.equal(f.saved().nextTurn, 4);
	for (let turns = 2; turns <= 70; turns++) {
		await f.turn();
		const expected = 1 + [4, 8, 16, 32, 64].filter((n) => n <= turns).length;
		assert.equal(f.calls.length, expected, `turn ${turns}`);
		assert.equal(f.state.name, `Task title ${expected}`);
		await f.settle();
		assert.equal(f.calls.length, expected, "repeated settle does not repeat a check");
	}
	assert.equal(f.saved().nextTurn, 128);
	assert.ok(f.calls.every((c) => c.context.systemPrompt === INSTRUCTIONS));
	assert.ok(f.calls.every((c) => !c.context.messages[0].content[0].text.includes("Task title")), "the prompt does not include or ask to preserve the current title");
});

test("counts user messages, not tool follow-ups or custom entries", async (t) => {
	const f = setup(t);
	await f.settle();
	for (let i = 0; i < 10; i++) {
		f.append(reply("Tool follow-up"));
		f.append(message("toolResult", "Read a file"));
		f.append({ type: "custom", customType: "other", data: {} });
		await f.settle();
	}
	assert.equal(f.calls.length, 1);
	await f.turn();
	await f.turn();
	assert.equal(f.calls.length, 1);
	await f.turn();
	assert.equal(f.calls.length, 2);
});

test("scheduled checks and automatic ownership survive reload", async (t) => {
	const f = setup(t);
	await f.settle();
	await f.turn();
	await f.turn();
	await f.reload();
	await f.settle();
	assert.equal(f.calls.length, 1, "resuming does not regenerate an existing title");
	await f.turn();
	assert.equal(f.calls.length, 2);
	assert.equal(f.saved().nextTurn, 8);
	await f.reload();
	await f.settle();
	assert.equal(f.calls.length, 2, "the same generated title still consumes the check");
	assert.equal(f.saved().paused, false);
});

test("a late first title skips missed checkpoints instead of catching up", async (t) => {
	const branch = Array.from({ length: 11 }, (_, i) => [user(`Request ${i}`), reply(`Reply ${i}`)]).flat();
	const f = setup(t, { branch });
	await f.settle();
	assert.equal(f.saved().nextTurn, 16);
	await f.turn();
	assert.equal(f.calls.length, 1);
});

test("compaction uses a bounded summary and does not reset the turn schedule", async (t) => {
	let title = "Fix login";
	const f = setup(t, { respond: () => answer(title) });
	await f.settle();
	title = "Add CSV export";
	await f.compact("Goal: Add CSV export. Progress: Export ready, testing remains.");
	assert.equal(f.state.name, title);
	assert.equal(f.calls.length, 2);
	assert.match(f.calls[1].context.messages[0].content[0].text, /^Goal: Add CSV export\. Progress: Export ready, testing remains\./);
	assert.equal(f.saved().nextTurn, 4);
	await f.settle();
	assert.equal(f.calls.length, 2, "compaction and settle produce one title request");
	await f.reload();
	await f.settle();
	assert.equal(f.calls.length, 2, "a compaction is not processed twice after reload");
	const big = "goals " + "x".repeat(20000) + " current progress";
	await f.compact(big);
	const text = f.calls.at(-1).context.messages[0].content[0].text;
	assert.ok(text.length < 9100);
	assert.ok(text.startsWith("goals ") && text.includes(" current progress"));
});

test("automatic compaction waits for retries and continuations to settle", async (t) => {
	const f = setup(t);
	await f.settle();
	await f.turn();
	await f.turn();
	f.append(user("Fourth request"));
	await f.compact("Compacted task summary", { reason: "overflow", willRetry: true });
	assert.equal(f.calls.length, 1);
	f.append(reply("Recovered and finished."));
	await f.settle();
	assert.equal(f.calls.length, 2, "compaction and turn 4 are combined into one check");
	assert.match(f.calls[1].context.messages[0].content[0].text, /^Compacted task summary/);
	assert.match(f.calls[1].context.messages[0].content[0].text, /Recovered and finished/);
	assert.equal(f.saved().nextTurn, 8);
	await f.compact("Threshold compaction", { reason: "threshold" });
	assert.equal(f.calls.length, 2);
	await f.settle();
	assert.equal(f.calls.length, 3);
});

test("returning to an older branch does not replay its compaction", async (t) => {
	const f = setup(t);
	await f.settle();
	await f.compact("First branch summary");
	const olderBranch = [...f.state.branch];
	await f.compact("Second branch summary");
	assert.equal(f.calls.length, 3);
	f.state.branch = olderBranch;
	f.emit("session_tree");
	await f.turn();
	assert.equal(f.calls.length, 3, "historical compactions are not new title triggers");
	await f.compact("New compaction on the older branch");
	assert.equal(f.calls.length, 4);
});

test("empty and provider-native placeholder summaries fall back to visible messages", async (t) => {
	const f = setup(t);
	await f.settle();
	for (const summary of ["", "OpenAI remote compaction applied for isara/gpt-5 via example.com. Pi keeps this textual summary for portability."]) {
		await f.compact(summary);
		assert.match(f.calls.at(-1).context.messages[0].content[0].text, /^User: Please fix/);
	}
	assert.equal(f.calls.length, 3);
	assert.equal(summaryText("   "), undefined);
});

test("manual naming permanently stops updates, even if cleared or restored", async (t) => {
	const f = setup(t);
	await f.settle();
	const autoTitle = f.state.name;
	f.rename("My own title");
	assert.equal(f.saved().paused, true);
	f.rename(autoTitle);
	await f.reload();
	for (let i = 0; i < 8; i++) await f.turn();
	await f.compact("Another task");
	assert.equal(f.calls.length, 1);
	assert.equal(f.state.name, autoTitle);
	f.rename("");
	await f.reload();
	await f.settle();
	assert.equal(f.state.name, undefined);
	assert.equal(f.calls.length, 1, "clearing a manual title does not resume auto-naming");
});

test("/name with the same text also transfers ownership to the user", async (t) => {
	const f = setup(t);
	await f.settle();
	f.rename(f.state.name);
	await f.reload();
	await f.compact("New task");
	assert.equal(f.calls.length, 1);
	assert.equal(f.saved().paused, true);
});

test("preexisting names without automatic ownership are not adopted", async (t) => {
	const f = setup(t);
	f.state.name = "Existing title";
	f.append({ type: "session_info", name: f.state.name });
	await f.reload();
	for (let i = 0; i < 4; i++) await f.turn();
	await f.compact("New task");
	assert.equal(f.calls.length, 0);
	assert.equal(f.state.name, "Existing title");
});

test("delayed metadata notifications do not treat automatic naming as manual", async (t) => {
	const f = setup(t, { deferNameEvents: true });
	await f.settle();
	await f.flushNameEvents();
	assert.equal(f.saved().paused, false);
	for (let i = 0; i < 3; i++) await f.turn();
	assert.equal(f.calls.length, 2);
	f.rename(f.state.name);
	await f.flushNameEvents();
	assert.equal(f.saved().paused, true);
});

test("manual names win during an update request, including identical names", async (t) => {
	let release;
	let updates = false;
	const f = setup(t, { respond: () => updates ? new Promise((resolve) => { release = resolve; }) : answer("Initial task") });
	await f.settle();
	updates = true;
	const pending = f.compact("New task");
	assert.equal(f.calls.length, 2);
	f.rename("Initial task");
	assert.equal(f.calls[1].options.signal.aborted, true);
	release(answer("Updated task"));
	await pending;
	assert.equal(f.state.name, "Initial task");
	assert.equal(f.saved().paused, true);
	assert.deepEqual(f.notices, []);
});

test("tree navigation and shutdown discard in-flight title updates", async (t) => {
	for (const event of ["session_before_tree", "session_tree", "session_before_switch", "session_before_fork", "session_shutdown"]) {
		let release;
		const f = setup(t, { respond: () => new Promise((resolve) => { release = resolve; }) });
		const run = f.settle();
		f.emit(event);
		assert.equal(f.calls[0].options.signal.aborted, true, event);
		release(answer("Stale result"));
		await run;
		assert.equal(f.state.name, undefined, event);
	}
});

test("failed updates keep the title and wait for the next scheduled check", async (t) => {
	let fail = false;
	const f = setup(t, { respond: () => fail ? answer("", "error") : answer("Good task title") });
	await f.settle();
	fail = true;
	for (let i = 0; i < 6; i++) await f.turn();
	assert.equal(f.calls.length, 2, "failure at turn 4 does not retry at turns 5, 6, or 7");
	assert.equal(f.state.name, "Good task title");
	assert.equal(f.notices.length, 1);
	await f.reload();
	await f.settle();
	assert.equal(f.calls.length, 2);
	fail = false;
	await f.turn();
	assert.equal(f.calls.length, 3, "turn 8 checks again");
	fail = true;
	await f.compact("New compaction summary");
	await f.settle();
	await f.reload();
	await f.settle();
	assert.equal(f.calls.length, 4, "a failed compaction check is not repeated");
});

test("updates follow recent work instead of always including the opening request", async (t) => {
	const f = setup(t, { branch: [user("Original database migration"), reply("Finished migration")] });
	await f.settle();
	for (let i = 0; i < 3; i++) await f.turn();
	const periodic = f.calls.at(-1).context.messages[0].content[0].text;
	assert.ok(!periodic.includes("Original database migration"));
	assert.match(periodic, /CSV export/);
	await f.compact("Goal: Export data");
	const compacted = f.calls.at(-1).context.messages[0].content[0].text;
	assert.ok(!compacted.includes("Original database migration"));
	assert.match(compacted, /Goal: Export data/);
	for (let i = 0; i < 4; i++) await f.turn();
	const later = f.calls.at(-1).context.messages[0].content[0].text;
	assert.ok(!later.includes("Original database migration"));
	assert.ok(!later.includes("Goal: Export data"), "later checkpoints do not reuse an older summary");
});

test("a fork that omits the old automatic name starts naming again", async (t) => {
	const marker = entry({ type: "custom", customType: STATE_TYPE, data: {
		version: 1, paused: false, nextTurn: 8, lastAutoTitle: "Title on another branch", lastAutoNameId: "missing-name-entry",
	} });
	const f = setup(t, { branch: [user("New fork task"), reply("Working on the fork"), marker] });
	await f.reload();
	await f.settle();
	assert.equal(f.calls.length, 1);
	assert.equal(f.saved().paused, false);
	assert.equal(f.saved().nextTurn, 4);
});

test("naming handlers return immediately while the request is pending", async (t) => {
	let release;
	const f = setup(t, { respond: () => new Promise((resolve) => { release = resolve; }) });
	assert.equal(f.emit("agent_settled"), undefined);
	await drain();
	assert.equal(f.calls.length, 1);
	assert.equal(f.state.name, undefined);
	assert.equal(f.emit("agent_settled"), undefined);
	assert.equal(f.calls.length, 1);
	release(answer("Completed task title"));
	await drain();
	assert.equal(f.state.name, "Completed task title");
});

test("answer-shaped titles are rejected before truncation", async (t) => {
	const long = "I can help you with the task that you described in your message today";
	assert.equal(normalizeTitle(long), undefined);
	assert.equal(normalizeTitle("word ".repeat(30)), undefined);
	assert.equal(normalizeTitle("one two three four five six seven eight nine ten eleven twelve"), "one two three four five six seven eight nine ten eleven twelve");
	let invalid = true;
	const f = setup(t, { respond: () => answer(invalid ? long : "Valid task title") });
	await f.settle();
	assert.equal(f.state.name, undefined);
	assert.equal(f.notices.length, 1);
	assert.match(f.notices[0].text, /did not return a usable title/);
	invalid = false;
	await f.settle();
	assert.equal(f.state.name, "Valid task title");
});
