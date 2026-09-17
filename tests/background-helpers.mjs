import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import background from "../background.ts";

export function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-background-test-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	const cleanup = [];
	t.after(async () => {
		for (const close of cleanup.reverse()) await close();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	const parent = SessionManager.create(cwd);
	writeFileSync(parent.getSessionFile(), JSON.stringify(parent.getHeader()) + "\n");
	return { root, cwd, agentDir, parentFile: parent.getSessionFile(), cleanup };
}

export function harness(t, f, model = { provider: "discovery-provider", id: "discovery-model" }) {
	const parent = SessionManager.open(f.parentFile);
	const tools = new Map();
	const handlers = new Map();
	const notices = [];
	const waiting = [];
	const ctx = {
		cwd: f.cwd, model, thinkingLevel: "high", sessionManager: parent,
		ui: { setStatus() {}, setWidget() {}, notify() {} },
	};
	background({
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand() {},
		registerMessageRenderer() {},
		on(event, handler) { handlers.set(event, handler); },
		appendEntry(type, data) { parent.appendCustomEntry(type, data); },
		sendMessage(message, options) {
			assert.equal(options.triggerTurn, true);
			if (message.details?.event !== "completion") return;
			const resolve = waiting.shift();
			if (resolve) resolve(message); else notices.push(message);
		},
	});
	let closed = false;
	const h = {
		parent, ctx,
		async open() { await handlers.get("session_start")({}, ctx); },
		call(name, params) { return tools.get(name).execute("test-call", params, undefined, undefined, ctx); },
		nextNotice() {
			if (notices.length) return Promise.resolve(notices.shift());
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("No background completion notice within 20 seconds")), 20_000);
				waiting.push((notice) => { clearTimeout(timer); resolve(notice); });
			});
		},
		async close() {
			if (closed) return;
			closed = true;
			await handlers.get("session_shutdown")();
		},
	};
	f.cleanup.push(() => h.close());
	return h;
}

export function installProvider(f) {
	const providerDir = join(f.agentDir, "extensions", "arbitrary-provider-package");
	const skillDir = join(f.agentDir, "skills", "discovery-skill");
	const promptsDir = join(f.agentDir, "prompts");
	for (const dir of [providerDir, skillDir, promptsDir]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(providerDir, "package.json"), JSON.stringify({ pi: { extensions: ["./provider.ts"] } }));
	writeFileSync(join(providerDir, "provider.ts"), `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi) {
	pi.registerProvider("discovery-provider", {
		baseUrl: "http://127.0.0.1:1", apiKey: "unused-test-key", api: "openai-completions",
		models: [{ id: "discovery-model", name: "Discovery model", reasoning: true,
			input: ["text"], contextWindow: 32768, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			const users = context.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => c.text).join("\\n"));
			const output = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "pending", timestamp: Date.now() };
			queueMicrotask(() => {
				stream.push({ type: "start", partial: output });
				if (users.at(-1) === "WAIT_FOREVER" || (users.at(-1)?.startsWith("Begin the delegated task") && users[0]?.includes("WAIT_FOREVER"))) {
					options.signal.addEventListener("abort", () => {
						output.stopReason = "aborted";
						stream.push({ type: "error", reason: "aborted", error: output }); stream.end();
					}, { once: true });
					return;
				}
				const text = JSON.stringify({ users, provider: model.provider, model: model.id, reasoning: options.reasoning });
				output.content = [{ type: "text", text }];
				stream.push({ type: "text_start", contentIndex: 0, partial: output });
				stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
				stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
				output.stopReason = "stop";
				stream.push({ type: "done", reason: "stop", message: output }); stream.end();
			});
			return stream;
		},
	});
	pi.registerCommand("discovery-command", { description: "Discovery test", handler() {} });
}
`);
	writeFileSync(join(skillDir, "SKILL.md"), "---\nname: discovery-skill\ndescription: Discovery test skill\n---\nTest skill.\n");
	writeFileSync(join(promptsDir, "discovery-prompt.md"), "Test prompt.\n");
}
