import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { getPackageDir, RpcClient } from "@earendil-works/pi-coding-agent";
import background from "../background.ts";

for (const provider of ["isara", "openai", "custom-provider"]) {
	test(`${provider} background agents use normal Pi discovery`, async (t) => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-background-test-"));
		const tools = new Map();
		const handlers = new Map();
		let options;
		let thinkingLevel;
		let prompt;

		// Capture the RPC launch configuration without spawning a process or
		// requiring credentials or a machine-specific provider installation.
		t.mock.method(RpcClient.prototype, "start", async function () {
			options = this.options;
		});
		t.mock.method(RpcClient.prototype, "setThinkingLevel", async (level) => {
			thinkingLevel = level;
		});
		t.mock.method(RpcClient.prototype, "prompt", async (message) => {
			prompt = message;
		});
		t.mock.method(RpcClient.prototype, "waitForIdle", () => new Promise(() => {}));
		t.mock.method(RpcClient.prototype, "stop", async () => {});
		background({
			registerTool(tool) { tools.set(tool.name, tool); },
			registerCommand() {},
			registerMessageRenderer() {},
			on(event, handler) { handlers.set(event, handler); },
		});
		t.after(async () => {
			await handlers.get("session_shutdown")();
			rmSync(cwd, { recursive: true, force: true });
		});

		const task = "Report the working directory without changing files.";
		const result = await tools.get("background_start").execute("test-start", {
			kind: "agent",
			cwd,
			task,
		}, undefined, undefined, {
			cwd: tmpdir(),
			model: { provider, id: "test-model" },
			thinkingLevel: "high",
			ui: { setStatus() {}, setWidget() {} },
		});

		assert.deepEqual(options, {
			cliPath: resolve(getPackageDir(), "dist", "cli.js"),
			cwd,
			provider,
			model: "test-model",
			args: ["--no-session"],
		});
		assert.equal(thinkingLevel, "high");
		assert.ok(prompt.endsWith(`Task: ${task}`));
		assert.equal(result.details.kind, "agent");
		assert.equal(result.details.state, "running");
	});
}

test("a real child discovers a provider package, skill, and prompt without network access", { timeout: 20_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-background-discovery-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	const providerDir = join(agentDir, "extensions", "arbitrary-provider-package");
	const skillDir = join(agentDir, "skills", "discovery-skill");
	const promptsDir = join(agentDir, "prompts");
	for (const path of [cwd, providerDir, skillDir, promptsDir]) mkdirSync(path, { recursive: true });
	writeFileSync(join(providerDir, "package.json"), JSON.stringify({ pi: { extensions: ["./provider.ts"] } }));
	writeFileSync(join(providerDir, "provider.ts"), `
export default function (pi) {
	pi.registerProvider("discovery-provider", {
		baseUrl: "http://127.0.0.1:1",
		apiKey: "unused-test-key",
		api: "openai-completions",
		models: [{
			id: "discovery-model", name: "Discovery model", reasoning: false,
			input: ["text"], contextWindow: 8192, maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}],
	});
	pi.registerCommand("discovery-command", { description: "Discovery test", handler() {} });
}
`);
	writeFileSync(join(skillDir, "SKILL.md"), "---\nname: discovery-skill\ndescription: Discovery test skill\n---\nTest skill.\n");
	writeFileSync(join(promptsDir, "discovery-prompt.md"), "Test prompt.\n");

	const previousEnv = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	const tools = new Map();
	const handlers = new Map();
	background({
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand() {},
		registerMessageRenderer() {},
		on(event, handler) { handlers.set(event, handler); },
	});
	t.after(async () => {
		try {
			await handlers.get("session_shutdown")();
		} finally {
			for (const [key, value] of Object.entries(previousEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});

	// Launch a real RPC child, but inspect its discovered resources instead of
	// sending a task to a model. No provider request or credentials are needed.
	let inspected = false;
	t.mock.method(RpcClient.prototype, "prompt", async function () {
		const state = await this.getState();
		assert.equal(state.model.provider, "discovery-provider");
		assert.equal(state.model.id, "discovery-model");
		assert.equal(state.sessionFile, undefined);
		const names = (await this.getCommands()).map((command) => command.name);
		for (const name of ["discovery-command", "skill:discovery-skill", "discovery-prompt"]) {
			assert.ok(names.includes(name), `child should discover ${name}`);
		}
		inspected = true;
	});
	t.mock.method(RpcClient.prototype, "waitForIdle", () => new Promise(() => {}));
	await tools.get("background_start").execute("discovery-start", {
		kind: "agent", task: "Inspect discovery.",
	}, undefined, undefined, {
		cwd,
		model: { provider: "discovery-provider", id: "discovery-model" },
		thinkingLevel: "off",
		ui: { setStatus() {}, setWidget() {} },
	});
	assert.equal(inspected, true);
});
