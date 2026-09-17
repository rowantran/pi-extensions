// Hold the writer lock in the child, before Pi opens the session. This also
// protects the file while a crashed parent's RPC child is shutting down on EOF.
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";

const sessionIndex = process.argv.indexOf("--session");
const sessionFile = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : undefined;
const cliPath = process.env.PI_BACKGROUND_CLI_PATH;
if (!sessionFile || !cliPath) throw new Error("Background runner requires --session and PI_BACKGROUND_CLI_PATH.");
const ownerFile = `${sessionFile}.owner.json`;

try {
	let owner;
	try {
		owner = JSON.parse(readFileSync(ownerFile, "utf8"));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (owner) {
		let alive = true;
		if (owner.hostname === hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
			try { process.kill(owner.pid, 0); } catch (error) { alive = error.code !== "ESRCH"; }
		}
		if (alive) throw new Error(`Session is owned by a live process (${owner.hostname}:${owner.pid}).`);
	}
	const token = randomUUID();
	let compromised = false;
	const release = lockfile.lockSync(sessionFile, {
		stale: 10_000,
		update: 2_000,
		onCompromised(error) {
			compromised = true;
			console.error(`Background session lock lost: ${error.message}`);
			process.exit(1);
		},
	});
	process.once("exit", () => {
		if (compromised) return;
		try {
			if (JSON.parse(readFileSync(ownerFile, "utf8")).token === token) unlinkSync(ownerFile);
		} catch { /* Best-effort ownership cleanup. */ }
		try { release(); } catch { /* The lock may already have been released by signal-exit. */ }
	});
	writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, hostname: hostname(), token }), { mode: 0o600 });

	// A kill during append can leave an incomplete final JSONL record. Repair
	// only that tail under the lock; never append onto a torn record.
	const contents = readFileSync(sessionFile);
	if (contents.length && contents.at(-1) !== 10) {
		const lastNewline = contents.lastIndexOf(10);
		let completeRecord = false;
		try {
			JSON.parse(contents.subarray(lastNewline + 1).toString("utf8"));
			completeRecord = true;
		} catch { /* Only an invalid final record can be truncated. */ }
		if (completeRecord) appendFileSync(sessionFile, "\n");
		else {
			if (lastNewline < 0) throw new Error("Session header is incomplete; refusing to overwrite it.");
			truncateSync(sessionFile, lastNewline + 1);
		}
	}
} catch (error) {
	console.error(`Cannot open background session ${sessionFile}: ${error.message} ` +
		"If its previous process just crashed, wait at least 10 seconds for the writer lock to expire and retry.");
	process.exit(1);
}

// Run the same installed Pi CLI, with normal provider/resource discovery.
await import(pathToFileURL(resolve(cliPath)).href);
