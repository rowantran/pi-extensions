import assert from "node:assert/strict";
import { test } from "node:test";

const { default: codexFooter, remoteHost } = await import("../codex-footer.ts");

const auto = { provider: "model-switcher", id: "auto", api: "pi-virtual", reasoning: true };
const opus = { provider: "isara", id: "claude-opus-5-5", api: "anthropic-messages", reasoning: true, contextWindow: 200_000 };
const astra = { provider: "isara", id: "gpt-6-astra", api: "openai-responses", reasoning: true, contextWindow: 400_000 };
const physical = new Map([opus, astra].map((model) => [`${model.provider}/${model.id}`, model]));

const theme = { fg: (_color, text) => text, bold: (text) => text, getColorMode: () => "truecolor" };
const response = (model, stopReason = "stop", thinkingLevel = "high") => ({
	type: "message",
	message: { role: "assistant", provider: model.provider, model: model.id, stopReason, thinkingLevel, usage: { cost: { total: 0 } } },
});
const selectAuto = { type: "model_change", provider: auto.provider, modelId: auto.id };

/** Render the first footer line for a selected model and session branch. */
function mainLine(selected, branch) {
	let handler;
	codexFooter({ on: (_event, fn) => { handler = fn; } });
	let factory;
	handler({}, {
		mode: "tui",
		cwd: "/tmp",
		model: selected,
		thinkingLevel: "high",
		getContextUsage: () => undefined,
		modelRegistry: { find: (provider, id) => physical.get(`${provider}/${id}`), isUsingOAuth: () => false },
		sessionManager: { getBranch: () => branch, getEntries: () => branch, getSessionName: () => undefined },
		ui: { setFooter: (fn) => { factory = fn; } },
	});
	const footerData = {
		onBranchChange: () => () => {},
		getAvailableProviderCount: () => 2,
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(),
	};
	const line = factory({ requestRender() {} }, theme, footerData).render(200)[0];
	return line.replace(/\x1b\[[0-9;]*m/g, "").trim().split(" · ");
}
const modelSegment = (selected, branch) => mainLine(selected, branch)[0];

/** Set environment variables for one callback, then restore them. */
function withEnv(values, fn) {
	const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("a pi-remote session shows the remote host before the workspace", () => {
	const segments = withEnv({ PI_REMOTE_SESSION: "1", PI_REMOTE_SESSION_HOST: "rowan-v2-dev" }, () => mainLine(opus, []));
	assert.deepEqual(segments.slice(-2), ["\uEB3A rowan-v2-dev", "/tmp"]);
});

test("a local session shows no remote host", () => {
	const segments = withEnv({ PI_REMOTE_SESSION: undefined, PI_REMOTE_SESSION_HOST: undefined }, () => mainLine(opus, []));
	assert.ok(!segments.some((segment) => segment.includes("\uEB3A")));
});

test("the remote host needs the session flag and a non-empty host name", () => {
	assert.equal(remoteHost({ PI_REMOTE_SESSION: "1", PI_REMOTE_SESSION_HOST: " devbox\n" }), "devbox");
	assert.equal(remoteHost({ PI_REMOTE_SESSION_HOST: "devbox" }), undefined);
	assert.equal(remoteHost({ PI_REMOTE_SESSION: "1", PI_REMOTE_SESSION_HOST: "" }), undefined);
});

test("a virtual model shows the badge and the physical model of the latest successful response", () => {
	const branch = [selectAuto, response(opus), response(astra), response(opus, "error")];
	assert.equal(modelSegment(auto, branch), "\uF074 (isara) gpt-6-astra high (400k ctx)");
});

test("a virtual model shows itself until it has routed a response", () => {
	assert.equal(modelSegment(auto, [response(opus), selectAuto]), "\uF074 (model-switcher) auto high");
});

test("a physical model shows no badge", () => {
	assert.equal(modelSegment(opus, [response(astra)]), "(isara) claude-opus-5-5 high (200k ctx)");
});
