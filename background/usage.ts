import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { AGENT_REFERENCE_ENTRY } from "./sessions.ts";

export interface AgentUsage {
	tokens: number;
	cost: number;
}

export interface BackgroundUsage extends AgentUsage {
	agents: number;
	unavailable: number;
}

/** Accounting follows all saved references, even after untracking or tree navigation. */
export function agentSessionFiles(entries: readonly SessionEntry[]): Set<string> {
	const paths = new Set<string>();
	for (const entry of entries) {
		let data: { sessionFile?: unknown; kind?: unknown } | undefined;
		if (entry.type === "custom" && entry.customType === AGENT_REFERENCE_ENTRY) {
			data = entry.data as typeof data;
		} else if (entry.type === "custom_message" && entry.customType === "background") {
			data = entry.details as typeof data;
			if (data?.kind !== "agent") continue;
		}
		if (typeof data?.sessionFile === "string" && data.sessionFile) paths.add(data.sessionFile);
	}
	return paths;
}

function sessionUsage(entries: readonly SessionEntry[]): { usage: AgentUsage; incomplete: boolean } {
	const totals = { tokens: 0, cost: 0 };
	let incomplete = false;
	for (const entry of entries) {
		let usage: Usage | undefined;
		if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
			usage = entry.usage;
		} else if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
			usage = entry.message.usage;
		}
		if (!usage) {
			if (entry.type === "usage" || (entry.type === "message" && entry.message.role === "assistant")) incomplete = true;
			continue;
		}
		if ([usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost?.total]
			.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
			incomplete = true;
			continue;
		}
		// Match Pi's totals: reasoning is already included in output, and cached
		// tokens are counted separately from input. Ignore notice snapshots.
		totals.tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		totals.cost += usage.cost.total;
	}
	return { usage: totals, incomplete };
}

interface CachedSession {
	fingerprint: string;
	usage: AgentUsage;
	incomplete: boolean;
	children: Set<string>;
}

/** Read-only snapshots: never open/migrate a live child's session with SessionManager. */
export class BackgroundUsageReader {
	private cache = new Map<string, CachedSession>();

	async read(paths: Iterable<string>, parentFile?: string): Promise<BackgroundUsage> {
		const totals: BackgroundUsage = { tokens: 0, cost: 0, agents: 0, unavailable: 0 };
		const visited = new Set<string>();
		if (parentFile) visited.add(await realpath(parentFile).catch(() => resolve(parentFile)));
		const pending = [...paths];
		for (let index = 0; index < pending.length; index++) {
			const path = await realpath(pending[index]).catch(() => resolve(pending[index]));
			if (visited.has(path)) continue;
			visited.add(path);
			totals.agents++;
			try {
				const snapshot = await this.snapshot(path);
				totals.tokens += snapshot.usage.tokens;
				totals.cost += snapshot.usage.cost;
				if (snapshot.incomplete) totals.unavailable++;
				pending.push(...snapshot.children);
			} catch {
				// Do not claim a missing/unreadable history costs nothing.
				totals.unavailable++;
			}
		}
		return totals;
	}

	private async snapshot(path: string): Promise<CachedSession> {
		const info = await stat(path);
		if (!info.isFile()) throw new Error("Not a regular session file");
		const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
		const cached = this.cache.get(path);
		if (cached?.fingerprint === fingerprint) return cached;
		// The public parser ignores a torn final JSONL line; the next changed
		// snapshot picks it up once the writer finishes. It does not repair files.
		const fileEntries = parseSessionEntries(await readFile(path, "utf8"));
		const header = fileEntries[0];
		if (header?.type !== "session" || typeof header.id !== "string") throw new Error("Invalid session header");
		const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
		const snapshot = { fingerprint, ...sessionUsage(entries), children: agentSessionFiles(entries) };
		this.cache.set(path, snapshot);
		return snapshot;
	}
}

/** Compact footer text, using the same dollar precision as Rowan's parent cost segment. */
export function backgroundStatusText(usage: BackgroundUsage): string | undefined {
	if (!usage.agents) return undefined;
	return `subagents: $${usage.cost.toFixed(3)}`;
}

export function backgroundUsageText(usage: BackgroundUsage): string {
	const partial = usage.unavailable ? ` (incomplete: ${usage.unavailable} unavailable)` : "";
	return `${usage.agents} ${usage.agents === 1 ? "agent" : "agents"} · ${usage.tokens.toLocaleString()} tokens · $${usage.cost.toFixed(4)}${partial}`;
}
