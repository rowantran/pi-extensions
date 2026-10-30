import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSideSnapshot, SIDE_BOUNDARY_TEXT, SIDE_BOUNDARY_TYPE } from "../side.ts";

test("side snapshot ends the settled history with a boundary that forks keep as the leaf", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-side-snapshot-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const main = SessionManager.create(root, join(root, "sessions"));
	main.appendMessage({ role: "user", content: "Refactor the parser", timestamp: 1 });
	const settled = main.appendMessage({ role: "assistant", content: [{ type: "text", text: "Started" }], timestamp: 2 });
	main.appendMessage({ role: "user", content: "Keep going with step 2", timestamp: 3 });
	const mainFile = main.getSessionFile();
	const before = readFileSync(mainFile, "utf8");

	const snapshot = createSideSnapshot(mainFile, settled);

	assert.ok(snapshot && snapshot !== mainFile);
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
