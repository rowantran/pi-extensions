import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { STATE_TYPE } from "../auto-session-name.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const provider = "auto-session-name-offline";
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const usage = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { ...cost, total: 0 } };
const drain = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-session-title-integration-"));
	const cwd = join(root, "work"), agentDir = join(root, "agent");
	for (const dir of [cwd, agentDir]) mkdirSync(dir, { recursive: true });
	const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	const authPath = join(agentDir, "auth.json");
	writeFileSync(authPath, "{}\n", { mode: 0o600 });
	writeFileSync(join(agentDir, "auto-session-name.json"), JSON.stringify({ model: `${provider}/title` }));
	const f = { titles: [], chats: [], sessions: [], errors: [], notices: [], holdTitles: false, pendingTitles: [], summary: "Goal: Add CSV export. Progress: Ready to test." };
	const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("Network access is forbidden in title integration tests"); });
	t.after(async () => {
		try {
			for (const session of f.sessions) { await session.abort(); session.dispose(); }
			assert.equal(fetch.mock.callCount(), 0);
			assert.deepEqual(f.errors, []);
			assert.deepEqual(f.notices, []);
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
			defaultProvider: provider, defaultModel: "chat", defaultThinkingLevel: "off",
			packages: [{ source: packageRoot, extensions: ["auto-session-name.ts"], skills: [], prompts: [], themes: [] }],
			compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 1 },
			retry: { enabled: false }, cacheWarming: "off",
		});
		const services = await createAgentSessionServices({
			cwd, agentDir, modelRuntime, settingsManager,
			resourceLoaderOptions: {
				noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
				extensionFactories: [(pi) => {
					pi.registerProvider(provider, {
						api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "unused-offline-key",
						models: ["chat", "title"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost })),
						streamSimple: (model, context, options) => {
							const stream = createAssistantMessageEventStream();
							const calls = model.id === "title" ? f.titles : f.chats;
							calls.push({ context: structuredClone(context), signal: options.signal });
							const text = model.id === "title" ? `Generated title ${calls.length}` : "Offline task finished.";
							const output = { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now() };
							let finished = false;
							const finish = () => {
								if (finished) return;
								finished = true;
								if (options.signal?.aborted) {
									stream.push({ type: "error", reason: "aborted", error: { ...output, stopReason: "aborted" } });
									stream.end();
									return;
								}
								stream.push({ type: "start", partial: output });
								stream.push({ type: "text_start", contentIndex: 0, partial: output });
								stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
								stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
								stream.push({ type: "done", reason: "stop", message: output });
								stream.end();
							};
							options.signal?.addEventListener("abort", finish, { once: true });
							if (model.id === "title" && f.holdTitles) f.pendingTitles.push(finish);
							else queueMicrotask(finish);
							return stream;
						},
					});
					pi.on("session_before_compact", (event) => ({ compaction: {
						summary: f.summary, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
					} }));
				}],
			},
		});
		assert.deepEqual(services.diagnostics, []);
		assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
		const { session, modelFallbackMessage } = await createAgentSessionFromServices({ services, sessionManager: manager, tools: [] });
		assert.equal(modelFallbackMessage, undefined);
		f.sessions.push(session);
		await session.bindExtensions({ mode: "rpc", uiContext: { notify: (text) => f.notices.push(text) }, onError: (error) => f.errors.push(error) });
		return session;
	};
	f.prompt = async (session, text) => { await session.prompt(text); await drain(); };
	f.compact = async (session) => { await session.compact(); await drain(); };
	f.releaseTitles = async () => { for (const finish of f.pendingTitles.splice(0)) finish(); await drain(); };
	f.saved = (session) => session.sessionManager.getEntries().findLast((e) => e.type === "custom" && e.customType === STATE_TYPE)?.data;
	return f;
}

test("real Pi runtime refreshes, compacts, resumes, and respects manual ownership", async (t) => {
	const f = await fixture(t);
	let session = await f.open();
	for (let turn = 1; turn <= 4; turn++) await f.prompt(session, `User request ${turn}`);
	assert.equal(f.titles.length, 2);
	assert.equal(session.sessionManager.getSessionName(), "Generated title 2");
	assert.equal(f.saved(session).paused, false, "automatic name events do not pause updates");
	assert.equal(f.saved(session).nextTurn, 8);
	assert.equal(f.saved(session).lastAutoNameId, session.sessionManager.getEntries().findLast((e) => e.type === "session_info").id);

	await f.compact(session);
	assert.equal(f.titles.length, 3);
	const content = f.titles[2].context.messages.find((message) => message.role === "user").content;
	const input = typeof content === "string" ? content : content.map((block) => block.text).join("");
	assert.ok(input.startsWith(f.summary));
	assert.equal(session.sessionManager.getSessionName(), "Generated title 3");
	const file = session.sessionManager.getSessionFile();
	session.dispose();
	session = await f.open(SessionManager.open(file));
	assert.equal(f.titles.length, 3, "resume does not name again");
	for (let turn = 5; turn <= 8; turn++) await f.prompt(session, `User request ${turn}`);
	assert.equal(f.titles.length, 4);
	assert.equal(session.sessionManager.getSessionName(), "Generated title 4");
	assert.equal(f.saved(session).nextTurn, 16);

	session.setSessionName("Generated title 4"); // /name with identical text is still manual.
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.saved(session).paused, true);
	session.dispose();
	session = await f.open(SessionManager.open(file));
	for (let turn = 9; turn <= 16; turn++) await f.prompt(session, `User request ${turn}`);
	await f.compact(session);
	assert.equal(f.titles.length, 4, "manual ownership survives a new runtime and compaction");
	assert.equal(session.sessionManager.getSessionName(), "Generated title 4");
	assert.equal(f.chats.length, 16);
	assert.ok(f.chats.every((c) => !JSON.stringify(c.context.messages).includes("lastAutoNameId")), "saved ownership data is not sent to the model");
});

test("title requests do not delay prompts or manual compaction", { timeout: 5000 }, async (t) => {
	const f = await fixture(t);
	const session = await f.open();
	f.holdTitles = true;
	await f.prompt(session, "First request");
	assert.equal(f.titles.length, 1, "naming starts after the run settles");
	assert.equal(session.sessionManager.getSessionName(), undefined, "the title request is still pending");
	await f.prompt(session, "A second request can run immediately");
	assert.equal(f.chats.length, 2);
	assert.equal(f.titles.length, 1, "only one title request runs at a time");
	await f.releaseTitles();
	assert.equal(session.sessionManager.getSessionName(), "Generated title 1");

	await f.compact(session);
	assert.equal(f.titles.length, 2);
	assert.equal(session.isCompacting, false, "compaction completes before naming returns");
	assert.equal(session.sessionManager.getSessionName(), "Generated title 1");
	await f.releaseTitles();
	assert.equal(session.sessionManager.getSessionName(), "Generated title 2");
});
