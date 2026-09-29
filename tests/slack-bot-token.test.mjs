import assert from "node:assert/strict";
import { test } from "node:test";
import { getBotToken, TOKEN_SERVICE, tokenCommand } from "../slack-bot/token.ts";

test("macOS reads the token from the login Keychain", () => {
	const spec = tokenCommand("darwin", "rowan", "/Users/rowan");
	assert.equal(spec.command, "/usr/bin/security");
	assert.deepEqual(spec.args, [
		"find-generic-password",
		"-s",
		TOKEN_SERVICE,
		"-w",
		"/Users/rowan/Library/Keychains/login.keychain-db",
	]);
});

test("Linux reads the token from the Secret Service with secret-tool", () => {
	const spec = tokenCommand("linux", "ubuntu");
	assert.equal(spec.command, "secret-tool");
	assert.deepEqual(spec.args, ["lookup", "service", TOKEN_SERVICE, "account", "ubuntu"]);
});

test("unsupported platforms fail with a clear error", async () => {
	assert.throws(() => tokenCommand("win32", "rowan"), /unsupported platform win32/);
	await assert.rejects(getBotToken(undefined, "win32", "rowan"), /unsupported platform win32/);
});
