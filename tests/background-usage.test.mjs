import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentSessionFiles, BackgroundUsageReader, backgroundStatusText } from "../background/usage.ts";
import { AGENT_FORGET_ENTRY, AGENT_REFERENCE_ENTRY } from "../background/sessions.ts";

const usage = {
	input: 7, output: 5, cacheRead: 11, cacheWrite: 13, totalTokens: 36, reasoning: 3,
	cost: { input: 0.05, output: 0.1, cacheRead: 0.05, cacheWrite: 0.05, total: 0.25 },
};
const reference = path => ({ type: "custom", customType: AGENT_REFERENCE_ENTRY, data: { id: path, sessionFile: path } });
const notice = path => ({ type: "custom_message", customType: "background", details: { kind: "agent", sessionFile: path, usage: { tokens: 9999, cost: 9999 } } });
const assistant = (reported = usage) => ({ type: "message", message: { role: "assistant", usage: reported, stopReason: "stop" } });

function files(t) {
	const dir = mkdtempSync(join(tmpdir(), "pi-background-usage-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return {
		dir,
		save(name, entries, header = {}) {
			const path = join(dir, `${name}.jsonl`);
			writeFileSync(path, [{ type: "session", version: 3, id: name, cwd: dir, ...header }, ...entries].map(JSON.stringify).join("\n") + "\n");
			return path;
		},
	};
}

test("saved accounting counts every billed entry, including compacted and alternate history, not notice snapshots", async t => {
	const f = files(t);
	const report = (input, output, cacheRead, cost) => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: 999, cost: { total: cost } });
	const path = f.save("child", [
		assistant(),
		{ ...assistant(), id: "alternate", parentId: null },
		{ type: "usage", kind: "future_kind", usage: report(0, 0, 40, 0.1) },
		{ type: "message", message: { role: "toolResult", usage: report(0, 4, 0, 0.05) } },
		{ type: "compaction", usage: report(10, 2, 0, 0.1) },
		{ type: "branch_summary", usage: report(20, 3, 0, 0.2) },
		{ type: "message", message: { role: "user", usage } },
		notice(""),
	]);
	const reader = new BackgroundUsageReader();
	const result = await reader.read([path]);
	assert.equal(result.tokens, 151);
	assert.equal(result.cost.toFixed(4), "0.9500");
	assert.equal(result.agents, 1);
	assert.equal(result.unavailable, 0);
	assert.deepEqual(await reader.read([path, path]), result, "Repeated reads and references are not incremental invoices");
});

test("saved response costs remain authoritative across virtual routes and changing service-tier prices", async t => {
	const f = files(t);
	const response = (cost, responseModel) => ({ type: "message", message: {
		role: "assistant", provider: "physical-provider", model: "physical-model", responseModel,
		usage: { ...usage, cacheWrite1h: 4, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
	} });
	const path = f.save("routed", [
		{ type: "model_change", provider: "router", modelId: "auto" },
		response(0.25, "physical-standard"),
		response(1.5, "physical-premium"),
		response(0.125, "physical-discounted"),
	]);
	// Same token counts can have different saved costs. Neither a router's
	// zero-priced alias nor today's rates should reprice historical responses.
	assert.deepEqual(await new BackgroundUsageReader().read([path]), { agents: 1, tokens: 108, cost: 1.875, unavailable: 0 });
});

test("references survive forget; only explicit background references discover children, not fork headers", async t => {
	const f = files(t);
	const child = f.save("child", [assistant()]);
	const parent = f.save("parent", [reference(child)]);
	f.save("fork", [assistant(), assistant()], { parentSession: parent });
	const entries = [reference(child), notice(child), { type: "custom", customType: AGENT_FORGET_ENTRY, data: { id: child } },
		{ type: "custom_message", customType: "background", details: { kind: "shell", sessionFile: "not-a-child" } },
		{ type: "custom", customType: "unrelated", data: { sessionFile: "not-a-child" } }];
	assert.deepEqual([...agentSessionFiles(entries)], [child]);
	assert.deepEqual(await new BackgroundUsageReader().read(agentSessionFiles(entries), parent), {
		agents: 1, tokens: 36, cost: 0.25, unavailable: 0,
	});
});

test("nested children, shared references, symlink aliases, and cycles count each session once and exclude the parent", async t => {
	const f = files(t);
	const parent = f.save("parent", [assistant()]);
	const grandchild = f.save("grandchild", [assistant(), reference(parent)]);
	const first = f.save("first", [assistant(), reference(grandchild)]);
	const second = f.save("second", [assistant(), notice(grandchild), reference(first)]);
	appendFileSync(grandchild, JSON.stringify(reference(second)) + "\n");
	const alias = join(f.dir, "alias.jsonl");
	symlinkSync(first, alias);
	assert.deepEqual(await new BackgroundUsageReader().read([first, second, grandchild, alias, parent], parent), {
		agents: 3, tokens: 108, cost: 0.75, unavailable: 0,
	});
});

test("resumed and live histories refresh without mutating torn tails or counting prior runs again", async t => {
	const f = files(t);
	const path = f.save("child", [assistant()]);
	const reader = new BackgroundUsageReader();
	assert.equal((await reader.read([path])).tokens, 36);
	const serialized = JSON.stringify(assistant());
	const split = Math.floor(serialized.length / 2);
	appendFileSync(path, serialized.slice(0, split));
	const torn = readFileSync(path, "utf8");
	assert.deepEqual(await reader.read([path]), { agents: 1, tokens: 36, cost: 0.25, unavailable: 0 });
	assert.equal(readFileSync(path, "utf8"), torn, "A reader must not repair a live writer's tail");
	appendFileSync(path, serialized.slice(split) + "\n");
	assert.deepEqual(await reader.read([path]), { agents: 1, tokens: 72, cost: 0.5, unavailable: 0 });
	assert.deepEqual(await reader.read([path]), { agents: 1, tokens: 72, cost: 0.5, unavailable: 0 });
});

test("missing or invalid sessions mark a partial total and can recover on later reads", async t => {
	const f = files(t);
	const available = f.save("available", [assistant()]);
	const missing = join(f.dir, "missing.jsonl");
	const invalid = join(f.dir, "invalid.jsonl");
	writeFileSync(invalid, "not a session\n");
	const reader = new BackgroundUsageReader();
	assert.deepEqual(await reader.read([available, missing, missing, invalid]), { agents: 3, tokens: 36, cost: 0.25, unavailable: 2 });
	f.save("missing", [assistant()]);
	f.save("invalid", [assistant()]);
	assert.deepEqual(await reader.read([available, missing, invalid]), { agents: 3, tokens: 108, cost: 0.75, unavailable: 0 });
	assert.deepEqual(await reader.read([f.dir]), { agents: 1, tokens: 0, cost: 0, unavailable: 1 }, "Only regular files may be read");
});

test("malformed usage marks a partial total without NaN or losing valid recorded spend", async t => {
	const f = files(t);
	const path = f.save("child", [
		assistant(),
		assistant({ output: 3, cost: { total: 0 } }),
		assistant({ ...usage, cost: undefined }),
		assistant({ ...usage, cacheRead: "20" }),
		assistant({ ...usage, output: -1 }),
		assistant({ ...usage, input: Infinity }),
		{ type: "message", message: { role: "assistant" } },
		{ type: "usage", kind: "missing_usage" },
		{ type: "message", message: { role: "toolResult" } },
	]);
	assert.deepEqual(await new BackgroundUsageReader().read([path]), { agents: 1, tokens: 36, cost: 0.25, unavailable: 1 });
});

test("rewritten histories replace cached spend and newly appended references discover grandchildren", async t => {
	const f = files(t);
	const child = f.save("child", [assistant(), assistant()]);
	const grandchild = f.save("grandchild", [assistant()]);
	const reader = new BackgroundUsageReader();
	assert.equal((await reader.read([child])).tokens, 72);
	f.save("child", [assistant()]); // Truncate/rewrite in place.
	assert.equal((await reader.read([child])).tokens, 36);
	appendFileSync(child, JSON.stringify(reference(grandchild)) + "\n");
	assert.deepEqual(await reader.read([child]), { agents: 2, tokens: 72, cost: 0.5, unavailable: 0 });
	const replacement = f.save("replacement", [assistant(), assistant(), assistant()]);
	renameSync(replacement, child); // Different inode, with no nested reference.
	assert.deepEqual(await reader.read([child]), { agents: 1, tokens: 108, cost: 0.75, unavailable: 0 });
});

test("footer status is a compact subagent cost without history markers", () => {
	assert.equal(backgroundStatusText({ agents: 0, tokens: 0, cost: 0, unavailable: 0 }), undefined);
	assert.equal(backgroundStatusText({ agents: 2, tokens: 12_345, cost: 0.3604, unavailable: 0 }), "subagents: $0.360");
	assert.equal(backgroundStatusText({ agents: 1, tokens: 0, cost: 0, unavailable: 0 }), "subagents: $0.000");
	assert.equal(backgroundStatusText({ agents: 3, tokens: 99, cost: 1.2344, unavailable: 1 }), "subagents: $1.234");
});
