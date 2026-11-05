import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveChannel } from "../slack-bot.ts";

function mockSlack(t, responses) {
	const calls = [];
	t.mock.method(globalThis, "fetch", async (url, init) => {
		const method = String(url).split("/").pop();
		calls.push({ method, body: JSON.parse(init.body) });
		const body = responses[method];
		if (!body) return new Response("", { status: 429, headers: { "retry-after": "30" } });
		return Response.json(body);
	});
	return calls;
}

test("a user ID resolves to the bot's DM with that user", async (t) => {
	const calls = mockSlack(t, { "conversations.open": { ok: true, channel: { id: "D0BOTDM" } } });
	const channel = await resolveChannel("xoxb-test", "u0a5np31n3a");
	assert.equal(channel.id, "D0BOTDM");
	assert.deepEqual(calls, [{ method: "conversations.open", body: { users: "U0A5NP31N3A" } }]);
});

test("a channel name resolves from the bot's joined channels without listing the workspace", async (t) => {
	const calls = mockSlack(t, {
		"users.conversations": { ok: true, channels: [{ id: "C0MEEP", name: "proj-meep" }] },
	});
	const channel = await resolveChannel("xoxb-test", "#proj-meep");
	assert.deepEqual(channel, { id: "C0MEEP", display: "#proj-meep" });
	assert.deepEqual(calls.map((call) => call.method), ["users.conversations"]);
});

test("rate-limit errors include Slack's Retry-After delay", async (t) => {
	mockSlack(t, {});
	await assert.rejects(resolveChannel("xoxb-test", "#proj-meep"), /HTTP 429\. Retry after 30 seconds\./);
});
