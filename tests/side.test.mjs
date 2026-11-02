import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import sideExtension, {
	createSideSnapshot,
	PI_REMOTE_API_EVENT,
	SIDE_BOUNDARY_TEXT,
	SIDE_BOUNDARY_TYPE,
	SIDE_STATUS_KEY,
	SIDE_STATUS_TEXT,
	sideSessionDir,
} from "../side.ts";

test("side snapshot ends the settled history with a boundary that forks keep as the leaf", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-side-snapshot-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const main = SessionManager.create(root, join(root, "sessions"));
	main.appendMessage({ role: "user", content: "Refactor the parser", timestamp: 1 });
	const settled = main.appendMessage({ role: "assistant", content: [{ type: "text", text: "Started" }], timestamp: 2 });
	main.appendMessage({ role: "user", content: "Keep going with step 2", timestamp: 3 });
	const mainFile = main.getSessionFile();
	const before = readFileSync(mainFile, "utf8");

	const snapshot = createSideSnapshot(mainFile, settled, join(root, "side-sessions"));

	assert.ok(snapshot && snapshot.startsWith(join(root, "side-sessions")));
	assert.equal(readFileSync(mainFile, "utf8"), before, "the main session file is unchanged");
	const fork = SessionManager.forkFrom(snapshot, root, join(root, "side"));
	const boundary = fork.getLeafEntry();
	assert.equal(boundary.type, "custom_message");
	assert.equal(boundary.customType, SIDE_BOUNDARY_TYPE);
	assert.equal(boundary.content, SIDE_BOUNDARY_TEXT);
	assert.equal(boundary.display, true);
	assert.equal(boundary.parentId, settled, "the unsettled main prompt is not inherited");
	const messages = fork.buildSessionContext().messages;
	assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "custom"]);
	assert.match(SIDE_BOUNDARY_TEXT, /Do not continue, retry, or complete any task/);
});

test("side sessions are kept per workspace under side-sessions, as pi-remote lists them", () => {
	assert.equal(sideSessionDir("/home/me/work/project", "/agent"), "/agent/side-sessions/--home-me-work-project--");
});

/** Run /side in a Pi where `api` answers pi-remote's discovery event; return the notifications. */
async function runSideInPiRemote(t, api, args = "") {
	const root = mkdtempSync(join(tmpdir(), "pi-side-remote-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	});
	const main = SessionManager.create(root, join(root, "sessions"));
	main.appendMessage({ role: "user", content: "Refactor the parser", timestamp: 1 });
	main.appendMessage({ role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2 });
	let command;
	const pi = {
		on() {},
		registerCommand: (name, definition) => {
			if (name === "side") command = definition;
		},
		exec: async () => {
			throw new Error("isara is not needed in pi-remote");
		},
		events: {
			emit: (channel, data) => {
				if (channel === PI_REMOTE_API_EVENT && api) data.respond(api);
			},
		},
	};
	sideExtension(pi);
	const notes = [];
	await command.handler(args, {
		mode: "tui",
		cwd: root,
		isIdle: () => true,
		sessionManager: main,
		ui: { notify: (message, type) => notes.push({ message, type }) },
	});
	return { notes, sideDir: sideSessionDir(root, join(root, "agent")) };
}

test("in a pi-remote slot, /side starts a child slot from the snapshot and opens its pane", async (t) => {
	const calls = [];
	const api = {
		version: 1,
		slotId: "parent",
		slotNumber: 3,
		createChildSlot: async (options) => {
			calls.push(["create", options]);
			return { slotId: "child-id", slotNumber: 7 };
		},
		openSlot: async (options) => {
			calls.push(["open", options]);
		},
	};
	const { notes, sideDir } = await runSideInPiRemote(t, api, " Explain the parser ");
	assert.deepEqual(notes, [{ message: "Side conversation started in slot #7.", type: "info" }]);
	const [[, create], open] = calls;
	assert.equal(create.sessionDir, sideDir);
	assert.ok(create.sessionFile.startsWith(sideDir));
	assert.equal(create.prompt, "Explain the parser");
	assert.match(readFileSync(create.sessionFile, "utf8"), /side-boundary/);
	assert.deepEqual(open, ["open", { slotId: "child-id" }]);
});

test("in a pi-remote slot, /side reports a pane or slot that did not open", async (t) => {
	const failingPane = {
		version: 1,
		slotId: "parent",
		createChildSlot: async () => ({ slotId: "child-id", slotNumber: 7 }),
		openSlot: async () => {
			throw new Error("Ghostty is not running. The attach command is on the clipboard.");
		},
	};
	const pane = await runSideInPiRemote(t, failingPane);
	assert.equal(pane.notes.length, 1);
	assert.equal(pane.notes[0].type, "warning");
	assert.match(pane.notes[0].message, /slot #7, but its pane did not open: Ghostty is not running/);

	const failingSlot = { ...failingPane, createChildSlot: async () => { throw new Error("Daemon is shutting down"); } };
	const slot = await runSideInPiRemote(t, failingSlot);
	assert.deepEqual(slot.notes, [{ message: "Could not start the side conversation: Daemon is shutting down", type: "error" }]);
});

test("the footer marks a side conversation and clears the mark in other sessions", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-side-status-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const main = SessionManager.create(root, join(root, "sessions"));
	main.appendMessage({ role: "user", content: "Refactor the parser", timestamp: 1 });
	const settled = main.appendMessage({ role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2 });
	const side = SessionManager.open(createSideSnapshot(main.getSessionFile(), settled, join(root, "side-sessions")));

	const handlers = new Map();
	sideExtension({ on: (event, handler) => handlers.set(event, handler), registerCommand() {}, events: { emit() {} } });
	const statuses = new Map();
	const ctx = (sessionManager) => ({
		sessionManager,
		ui: {
			setStatus: (key, text) => (text === undefined ? statuses.delete(key) : statuses.set(key, text)),
		},
	});

	handlers.get("session_start")({}, ctx(side));
	assert.equal(statuses.get(SIDE_STATUS_KEY), SIDE_STATUS_TEXT);
	handlers.get("session_start")({}, ctx(main));
	assert.equal(statuses.has(SIDE_STATUS_KEY), false);
});
