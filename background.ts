/**
 * Unified background activities for shell commands and steerable Pi agents.
 *
 * Both kinds share lifecycle, status, output, cancellation, widget UI, bounded
 * retention, and automatic completion wake-up. Finished activities never
 * consume running capacity. Idle agent runtimes stop after a short grace period;
 * saved sessions remain resumable after runtime cleanup or parent restarts.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
	closeSync,
	fstatSync,
	mkdtempSync,
	openSync,
	readSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getPackageDir,
	RpcClient,
	truncateHead,
	truncateTail,
	type ExtensionAPI,
	type ExtensionContext,
	type JsonAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { stripTerminalSequences, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { withCompactToolRendering } from "./compact-tools.ts";
import {
	AGENT_FORGET_ENTRY,
	AGENT_REFERENCE_ENTRY,
	createSavedAgent,
	readSavedAgent,
	type SavedAgent,
} from "./background/sessions.ts";

const MAX_RUNNING_SHELLS = 8;
const MAX_RUNNING_AGENTS = 4;
const MAX_FINISHED_KEPT = 20;
const AGENT_RESUME_GRACE_MS = 5 * 60 * 1_000;
const AGENT_HEALTH_CHECK_MS = 5_000;
const AGENT_RUNNER = fileURLToPath(new URL("./background/runner.mjs", import.meta.url));
const MIN_CHECKIN_SECONDS = 30;
const NOTICE_SHELL_BYTES = 4_096;
const NOTICE_AGENT_BYTES = 12_000;
const OUTPUT_MAX_BYTES = 50_000;
const OUTPUT_DEFAULT_LINES = 100;
const OUTPUT_MAX_LINES = 2_000;
const STATUS_TEXT_LIMIT = 2_000;
const MAX_ACTIVITY_ITEMS = 12;
const MAX_WIDGET_ITEMS = 5;
const WIDGET_TICK_MS = 1_000;
const WIDGET_ID = "background-running";
const KILL_ESCALATION_MS = 5_000;
const NOTICE_RENDER_MAX_OUTPUT_LINES = 5;

const TERMINAL_STATES = new Set<ActivityState>(["completed", "failed", "stopped", "timed_out"]);

type ActivityKind = "shell" | "agent";
type ActivityState = "running" | "completed" | "failed" | "stopped" | "timed_out";

interface BaseActivity {
	id: string;
	kind: ActivityKind;
	name: string;
	cwd: string;
	state: ActivityState;
	startedAt: number;
	updatedAt: number;
	endedAt?: number;
	error?: string;
}

interface ShellActivity extends BaseActivity {
	kind: "shell";
	command: string;
	logPath: string;
	child: ChildProcess;
	exitCode: number | null;
	deliveredBytes: number;
	stopRequested: boolean;
	timedOut: boolean;
	checkinTimer?: NodeJS.Timeout;
	timeoutTimer?: NodeJS.Timeout;
	killTimer?: NodeJS.Timeout;
}

interface AgentUsage {
	tokens: number;
	cost: number;
}

interface AgentActivity extends BaseActivity {
	kind: "agent";
	task: string;
	sessionId: string;
	sessionFile: string;
	starting?: boolean;
	monitorTimer?: NodeJS.Timeout;
	reapPromise?: Promise<void>;
	client?: RpcClient;
	lastText: string;
	activity: string[];
	usage?: AgentUsage;
	runId: number;
	notifiedRunId: number;
	runError?: string;
	reapTimer?: NodeJS.Timeout;
}

type Activity = ShellActivity | AgentActivity;

function elapsed(from: number, to = Date.now()): string {
	const seconds = Math.max(0, Math.floor((to - from) / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60 > 0 ? `${seconds % 60}s` : ""}`;
	return `${Math.floor(minutes / 60)}h${minutes % 60 > 0 ? `${minutes % 60}m` : ""}`;
}

function age(timestamp: number): string {
	return `${elapsed(timestamp)} ago`;
}

// Bordered widget design adapted from hazat/pi-interactive-subagents.
// Copyright (c) 2026 HazAT; used under the repository's MIT License.
function borderLine(content: string, width: number, accent: (text: string) => string): string {
	if (width <= 0) return "";
	if (width === 1) return accent("│");

	const contentWidth = width - 2;
	const truncated = truncateToWidth(content, contentWidth);
	const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)));
	return `${accent("│")}${truncated}${padding}${accent("│")}`;
}

function borderTop(title: string, info: string, width: number, accent: (text: string) => string): string {
	if (width <= 0) return "";
	if (width === 1) return accent("╭");

	const innerWidth = width - 2;
	const titlePart = `─ ${title} `;
	const infoPart = ` ${info} ─`;
	const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(titlePart) - visibleWidth(infoPart)));
	const inner = truncateToWidth(`${titlePart}${fill}${infoPart}`, innerWidth, "");
	return accent(`╭${inner}${"─".repeat(Math.max(0, innerWidth - visibleWidth(inner)))}╮`);
}

function borderBottom(width: number, accent: (text: string) => string): string {
	if (width <= 0) return "";
	if (width === 1) return accent("╰");
	return accent(`╰${"─".repeat(width - 2)}╯`);
}

function deriveName(value: string): string {
	const flat = stripTerminalSequences(value)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length <= 40 ? flat : `${flat.slice(0, 37)}...`;
}

function resolveName(value: string | undefined, fallback: string): string {
	return deriveName(value ?? "") || deriveName(fallback) || "background activity";
}

function shorten(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} characters]`;
}

function readTail(path: string, fromByte: number, maxBytes: number): { text: string; size: number } {
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		const start = Math.max(fromByte, size - maxBytes, 0);
		const length = size - start;
		if (length <= 0) return { text: "", size };
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, start);
		let text = buffer.toString("utf8");
		if (start > fromByte) text = `[...earlier output omitted...]\n${text}`;
		return { text, size };
	} finally {
		closeSync(fd);
	}
}

function messageInfo(message: unknown): { text: string; error?: string } {
	if (!message || typeof message !== "object") return { text: "" };
	const record = message as { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown };
	if (record.role !== "assistant" || !Array.isArray(record.content)) return { text: "" };

	const text = record.content
		.filter(
			(part): part is { type: "text"; text: string } =>
				Boolean(
					part &&
						typeof part === "object" &&
						(part as { type?: unknown }).type === "text" &&
						typeof (part as { text?: unknown }).text === "string",
				),
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
	const error =
		record.stopReason === "error"
			? typeof record.errorMessage === "string"
				? record.errorMessage
				: "The agent ended with an error."
			: undefined;
	return { text, error };
}

function describeTool(name: string, args: unknown): string {
	const serialized = JSON.stringify(args);
	return `started ${name}${serialized && serialized !== "{}" ? ` ${shorten(serialized, 240)}` : ""}`;
}

function addAgentActivity(activity: AgentActivity, text: string): void {
	activity.activity.push(text);
	if (activity.activity.length > MAX_ACTIVITY_ITEMS) activity.activity.shift();
	activity.updatedAt = Date.now();
}

const StartParameters = Type.Object({
	kind: StringEnum(["shell", "agent"] as const, {
		description: "Activity kind: shell runs a command; agent delegates an autonomous task",
	}),
	command: Type.Optional(Type.String({ description: "Shell command (required for kind=shell)" })),
	task: Type.Optional(Type.String({ description: "Delegated task (required for kind=agent)" })),
	name: Type.Optional(Type.String({ description: "Short human-readable label" })),
	cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the session cwd" })),
	timeoutSeconds: Type.Optional(Type.Number({ description: "Kill a shell command after this many seconds" })),
	checkinSeconds: Type.Optional(
		Type.Number({
			description: `Deliver shell progress with new output every N seconds, minimum ${MIN_CHECKIN_SECONDS}`,
		}),
	),
});

const IdParameters = Type.Object({
	id: Type.String({ description: "Background activity ID or saved subagent session file" }),
});

const StatusParameters = Type.Object({
	id: Type.Optional(Type.String({ description: "Activity ID or saved subagent session file; omit to list retained activities" })),
});

const OutputParameters = Type.Object({
	id: Type.String({ description: "Background activity ID or saved subagent session file" }),
	lines: Type.Optional(Type.Number({ description: `Maximum shell log lines, default ${OUTPUT_DEFAULT_LINES}` })),
});

const SendParameters = Type.Object({
	id: Type.String({ description: "Background agent ID or saved subagent session file, including after a parent restart" }),
	message: Type.String({ description: "Instruction to steer a running agent or resume its saved conversation" }),
});

export default function background(pi: ExtensionAPI): void {
	pi = withCompactToolRendering(pi);
	const activities = new Map<string, Activity>();
	const agentReferences = new Map<string, string>();
	let nextShellId = 1;
	let logDir: string | undefined;
	let ui: ExtensionContext["ui"] | undefined;
	let widgetTimer: NodeJS.Timeout | undefined;
	let shuttingDown = false;

	function ensureLogDir(): string {
		logDir ??= mkdtempSync(join(tmpdir(), "pi-bg-"));
		return logDir;
	}

	function running(kind?: ActivityKind): Activity[] {
		return [...activities.values()].filter(
			(activity) => activity.state === "running" && (kind === undefined || activity.kind === kind),
		);
	}

	function updateWidget(): void {
		if (!ui) return;
		const active = running();
		ui.setStatus("background", undefined);
		if (active.length === 0) {
			ui.setWidget(WIDGET_ID, undefined);
			if (widgetTimer) {
				clearInterval(widgetTimer);
				widgetTimer = undefined;
			}
			return;
		}

		ui.setWidget(
			WIDGET_ID,
			(_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					const visible = active.slice(0, MAX_WIDGET_ITEMS);
					const overflow = active.length - visible.length;
					const accent = (text: string) => theme.fg("accent", text);
					const lines = [borderTop("Background", `${active.length} running`, width, accent)];

					for (const activity of visible) {
						const duration = theme.fg("dim", `(${elapsed(activity.startedAt)})`);
						const label = theme.fg("muted", activity.kind === "agent" ? "Agent:" : "Task:");
						lines.push(borderLine(` ${duration} ${label} ${activity.name} `, width, accent));
					}
					if (overflow > 0) {
						lines.push(borderLine(` ${theme.fg("dim", `(+ ${overflow} more)`)} `, width, accent));
					}
					lines.push(borderBottom(width, accent));
					return lines;
				},
			}),
			{ placement: "belowEditor" },
		);
		if (!widgetTimer) {
			widgetTimer = setInterval(updateWidget, WIDGET_TICK_MS);
			widgetTimer.unref();
		}
	}

	function rememberAgent(activity: AgentActivity): void {
		if (agentReferences.get(activity.id) === activity.sessionFile) return;
		agentReferences.set(activity.id, activity.sessionFile);
		pi.appendEntry(AGENT_REFERENCE_ENTRY, {
			id: activity.id, sessionId: activity.sessionId, sessionFile: activity.sessionFile,
		});
	}

	function restoreAgent(saved: SavedAgent): AgentActivity {
		const activity: AgentActivity = {
			...saved, kind: "agent", activity: [], runId: 0, notifiedRunId: 0, endedAt: saved.updatedAt,
		};
		activities.set(activity.id, activity);
		return activity;
	}

	function requireActivity(id: string | undefined, ctx?: ExtensionContext): Activity {
		if (!id) throw new Error("This operation requires an activity id.");
		const activity = activities.get(id);
		if (activity) return activity;
		const path = agentReferences.get(id) ?? (id.endsWith(".jsonl") ? resolve(ctx?.cwd ?? process.cwd(), id) : undefined);
		if (!path) throw new Error(`Unknown background activity: ${id}. Use background_status or supply its saved session file.`);
		const saved = readSavedAgent(path);
		const restored = activities.get(saved.id) ?? restoreAgent(saved);
		if (restored.kind === "agent") rememberAgent(restored);
		return restored;
	}

	function clearShellTimers(activity: ShellActivity): void {
		for (const timer of [activity.checkinTimer, activity.timeoutTimer, activity.killTimer]) {
			if (timer) clearTimeout(timer);
		}
		activity.checkinTimer = activity.timeoutTimer = activity.killTimer = undefined;
	}

	function killProcessGroup(activity: ShellActivity, signal: NodeJS.Signals): void {
		if (activity.child.pid === undefined) return;
		try {
			process.kill(-activity.child.pid, signal);
		} catch {
			try {
				activity.child.kill(signal);
			} catch {
				// The process has already exited.
			}
		}
	}

	function clearAgentMonitor(activity: AgentActivity): void {
		if (activity.monitorTimer) clearInterval(activity.monitorTimer);
		activity.monitorTimer = undefined;
	}

	async function reapAgentRuntime(activity: AgentActivity): Promise<void> {
		if (activity.reapTimer) {
			clearTimeout(activity.reapTimer);
			activity.reapTimer = undefined;
		}
		clearAgentMonitor(activity);
		if (activity.reapPromise) return activity.reapPromise;
		const client = activity.client;
		if (!client) return;
		activity.client = undefined;
		activity.reapPromise = client.stop().catch((error) => {
			activity.error ??= error instanceof Error ? error.message : String(error);
		}).finally(() => {
			activity.reapPromise = undefined;
			addAgentActivity(activity, "agent runtime released; saved session remains resumable");
		});
		await activity.reapPromise;
	}

	function scheduleAgentReap(activity: AgentActivity): void {
		if (!activity.client || activity.state === "running") return;
		if (activity.reapTimer) clearTimeout(activity.reapTimer);
		activity.reapTimer = setTimeout(() => void reapAgentRuntime(activity), AGENT_RESUME_GRACE_MS);
		activity.reapTimer.unref();
	}

	async function forgetActivity(activity: Activity): Promise<void> {
		if (activities.get(activity.id) !== activity) return;
		activities.delete(activity.id);
		if (activity.kind === "shell") {
			clearShellTimers(activity);
			try {
				unlinkSync(activity.logPath);
			} catch {
				// The log may already have been removed during shutdown.
			}
		} else {
			await reapAgentRuntime(activity);
		}
		updateWidget();
	}

	function pruneFinished(): void {
		const finished = [...activities.values()]
			.filter((activity) => TERMINAL_STATES.has(activity.state))
			.sort((a, b) => (a.endedAt ?? a.updatedAt) - (b.endedAt ?? b.updatedAt));
		while (finished.length > MAX_FINISHED_KEPT) {
			const oldest = finished.shift();
			if (oldest) void forgetActivity(oldest);
		}
	}

	function newShellOutput(activity: ShellActivity, maxBytes: number): string {
		try {
			const { text, size } = readTail(activity.logPath, activity.deliveredBytes, maxBytes);
			activity.deliveredBytes = size;
			return text;
		} catch {
			return "";
		}
	}

	function sendShellCheckin(activity: ShellActivity): void {
		if (activity.state !== "running" || shuttingDown) return;
		const output = newShellOutput(activity, NOTICE_SHELL_BYTES);
		const body = output.trim().length > 0 ? `New output:\n${output}` : "(no new output since last check-in)";
		pi.sendMessage(
			{
				customType: "background",
				content:
					`Background shell check-in: ${activity.id} (${activity.name}) is still running after ${elapsed(activity.startedAt)}.\n` +
					`${body}\nFull log: ${activity.logPath}`,
				display: true,
				details: { id: activity.id, kind: activity.kind, event: "checkin", state: activity.state },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	}

	function onShellExit(activity: ShellActivity, code: number | null, signal: NodeJS.Signals | null): void {
		if (activity.state !== "running") return;
		clearShellTimers(activity);
		activity.exitCode = code;
		activity.endedAt = activity.updatedAt = Date.now();
		activity.state = activity.timedOut
			? "timed_out"
			: activity.stopRequested
				? "stopped"
				: code === 0
					? "completed"
					: "failed";
		pruneFinished();
		updateWidget();

		// The stop tool already tells the model what happened.
		if (activity.state === "stopped" || shuttingDown) return;

		const output = newShellOutput(activity, NOTICE_SHELL_BYTES);
		const outcome =
			activity.state === "timed_out"
				? `timed out after ${elapsed(activity.startedAt, activity.endedAt)} and was killed`
				: `${activity.state} with exit code ${code ?? `signal ${signal ?? "unknown"}`} after ${elapsed(activity.startedAt, activity.endedAt)}`;
		const error = activity.error ? `\nError: ${activity.error}` : "";
		pi.sendMessage(
			{
				customType: "background",
				content:
					`Background shell ${activity.id} (${activity.name}) ${outcome}.${error}\n` +
					`${output.trim().length > 0 ? `Last output:\n${output}` : "(no output)"}\nFull log: ${activity.logPath}`,
				display: true,
				details: {
					id: activity.id,
					kind: activity.kind,
					event: "completion",
					state: activity.state,
					exitCode: code,
				},
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	}

	function observeAgent(activity: AgentActivity, event: JsonAgentSessionEvent | { type: "extension_error"; error: string }): void {
		switch (event.type) {
			case "agent_start":
				addAgentActivity(activity, "agent started a turn");
				break;
			case "agent_settled": {
				addAgentActivity(activity, "agent completed a run");
				const runId = activity.runId;
				void finalizeAgent(activity, runId);
				break;
			}
			case "tool_execution_start":
				addAgentActivity(activity, describeTool(event.toolName, event.args));
				break;
			case "tool_execution_end":
				addAgentActivity(activity, `finished ${event.toolName}${event.isError ? " with an error" : ""}`);
				break;
			case "message_end": {
				const info = messageInfo(event.message);
				if (info.text) {
					activity.lastText = info.text;
					addAgentActivity(activity, "assistant produced an update");
				}
				if (info.error) activity.runError = info.error;
				else if (info.text) activity.runError = undefined;
				break;
			}
			case "extension_error":
				addAgentActivity(activity, `extension error: ${event.error}`);
				break;
		}
	}

	async function finalizeAgent(activity: AgentActivity, runId: number): Promise<void> {
		if (
			shuttingDown || activities.get(activity.id) !== activity ||
			activity.runId !== runId ||
			activity.notifiedRunId >= runId ||
			activity.state !== "running"
		) {
			return;
		}
		activity.notifiedRunId = runId;
		clearAgentMonitor(activity);
		// Release running capacity as soon as the child settles. Result and usage
		// retrieval can take another RPC round trip and must not hold a slot.
		activity.state = activity.runError ? "failed" : "completed";
		activity.endedAt = activity.updatedAt = Date.now();
		updateWidget();

		const client = activity.client;
		if (client) {
			const [textResult, statsResult] = await Promise.allSettled([
				client.getLastAssistantText(),
				client.getSessionStats(),
			]);
			// A manually requested continuation can begin while these RPC requests
			// finish. Never let an older run overwrite the newer run's state.
			if (activities.get(activity.id) !== activity || activity.runId !== runId) return;
			if (textResult.status === "fulfilled" && textResult.value) activity.lastText = textResult.value;
			if (textResult.status === "rejected" && !activity.lastText) {
				activity.runError ??= textResult.reason instanceof Error ? textResult.reason.message : String(textResult.reason);
			}
			if (statsResult.status === "fulfilled") {
				activity.usage = { tokens: statsResult.value.tokens.total, cost: statsResult.value.cost };
			}
		} else {
			activity.runError ??= "The agent runtime exited before its result could be collected.";
		}

		activity.error = activity.runError;
		activity.state = activity.error ? "failed" : "completed";
		activity.endedAt = activity.updatedAt = Date.now();
		scheduleAgentReap(activity);
		pruneFinished();

		if (shuttingDown) return;
		const rawResult = activity.lastText || activity.error || "The agent produced no final text.";
		const result = truncateHead(rawResult, { maxBytes: NOTICE_AGENT_BYTES, maxLines: OUTPUT_MAX_LINES });
		const suffix = result.truncated ? "\n[Result truncated in this notice; use background_output for the retained result.]" : "";
		const usage = activity.usage
			? `\nUsage: ${activity.usage.tokens.toLocaleString()} tokens, $${activity.usage.cost.toFixed(4)}`
			: "";
		pi.sendMessage(
			{
				customType: "background",
				content:
					`Background agent ${activity.id} (${activity.name}) ${activity.state} after ${elapsed(activity.startedAt, activity.endedAt)}.\n` +
					`Result:\n${result.content || "(no output)"}${suffix}${usage}\n` +
					`Session: ${activity.sessionFile}\nResume with background_send using this ID or session file. ` +
					`No collection or cleanup call is required.`,
				display: true,
				details: {
					id: activity.id,
					kind: activity.kind,
					event: "completion",
					state: activity.state,
					sessionId: activity.sessionId,
					sessionFile: activity.sessionFile,
					usage: activity.usage,
				},
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	}

	function monitorAgentRun(activity: AgentActivity, runId: number): void {
		clearAgentMonitor(activity);
		if (activity.state !== "running") return;
		let checking = false;
		// Completion comes from agent_settled. Health checks detect crashed RPC
		// processes without imposing RpcClient.waitForIdle's 60-second run limit.
		activity.monitorTimer = setInterval(async () => {
			if (checking || activity.runId !== runId || activity.state !== "running") return;
			checking = true;
			try { await refreshAgent(activity); } finally { checking = false; }
		}, AGENT_HEALTH_CHECK_MS);
		activity.monitorTimer.unref();
	}

	async function refreshAgent(activity: AgentActivity): Promise<void> {
		if (activity.state !== "running" || activity.starting || !activity.client) return;
		const client = activity.client;
		const runId = activity.runId;
		try {
			// A non-streaming gap can occur before a queued run starts. Only the
			// settled event completes a run; get_state is a liveness check.
			await client.getState();
		} catch (error) {
			if (activity.client !== client || activity.runId !== runId || activity.state !== "running") return;
			activity.runError = error instanceof Error ? error.message : String(error);
			await finalizeAgent(activity, runId);
			if (activity.client === client && activity.runId === runId) await reapAgentRuntime(activity);
		}
	}

	async function startAgentRun(activity: AgentActivity, message: string): Promise<void> {
		if (activity.starting || activity.state === "running") throw new Error(`${activity.id} is already starting or running.`);
		if (running("agent").length >= MAX_RUNNING_AGENTS) {
			throw new Error(`At most ${MAX_RUNNING_AGENTS} background agents may run at once.`);
		}
		if (activity.reapTimer) clearTimeout(activity.reapTimer);
		activity.reapTimer = undefined;
		const runId = ++activity.runId;
		activity.state = "running";
		activity.starting = true;
		activity.endedAt = undefined;
		activity.error = activity.runError = undefined;
		activity.lastText = "";
		try {
			await activity.reapPromise;
			if (shuttingDown || activity.runId !== runId) throw new Error("Parent stopped during child startup.");
			if (activity.client) {
				try { await activity.client.getState(); } catch { await reapAgentRuntime(activity); }
			}
			if (!activity.client) {
				const client = new RpcClient({
					cliPath: AGENT_RUNNER,
					cwd: activity.cwd,
					env: { PI_BACKGROUND_CLI_PATH: resolve(getPackageDir(), "dist", "cli.js") },
					// Keep normal discovery. The saved session supplies its own model
					// and thinking level, not the resumed parent's current model.
					args: ["--session", activity.sessionFile, "--session-dir", dirname(activity.sessionFile)],
				});
				activity.client = client;
				client.onEvent((event) => {
					if (activity.client === client && !shuttingDown) observeAgent(activity, event);
				});
				await client.start();
				const state = await client.getState();
				if (state.sessionId !== activity.sessionId) throw new Error("Child opened a different session than requested.");
			}
			if (shuttingDown || activity.runId !== runId) throw new Error("Parent stopped during child startup.");
			await activity.client.prompt(message);
			activity.starting = false;
			addAgentActivity(activity, "instruction accepted");
			monitorAgentRun(activity, activity.runId);
		} catch (error) {
			activity.starting = false;
			activity.state = "failed";
			activity.error = error instanceof Error ? error.message : String(error);
			activity.endedAt = activity.updatedAt = Date.now();
			await reapAgentRuntime(activity);
			pruneFinished();
			throw new Error(`${activity.error}\nSaved session: ${activity.sessionFile}\nResume ${activity.id} with background_send.`);
		} finally {
			updateWidget();
		}
	}

	function activityLine(activity: Activity): string {
		const duration =
			activity.state === "running"
				? elapsed(activity.startedAt)
				: elapsed(activity.startedAt, activity.endedAt ?? activity.updatedAt);
		const resumable = activity.kind === "agent" && activity.state !== "running" ? ", resumable" : "";
		return `${activity.id} [${activity.kind}, ${activity.state}${resumable}, ${duration}] ${activity.name}`;
	}

	function detailedStatus(activity: Activity): string {
		const lines = [
			`Activity: ${activity.id}`,
			`Kind: ${activity.kind}`,
			`State: ${activity.state}`,
			`Name: ${activity.name}`,
			`Working directory: ${activity.cwd}`,
			`Started: ${age(activity.startedAt)}`,
		];
		if (activity.error) lines.push(`Error: ${activity.error}`);
		if (activity.kind === "shell") {
			lines.push(`Command: ${activity.command}`, `Log: ${activity.logPath}`);
			if (activity.state !== "running") lines.push(`Exit code: ${activity.exitCode ?? "unknown"}`);
			try {
				const tail = readTail(activity.logPath, 0, NOTICE_SHELL_BYTES).text;
				if (tail.trim()) lines.push("Recent output:", tail);
			} catch {
				// The retained log may have been removed externally.
			}
		} else {
			lines.push(`Task: ${activity.task}`, `Session ID: ${activity.sessionId}`, `Session file: ${activity.sessionFile}`);
			if (activity.activity.length > 0) lines.push("Recent activity:", ...activity.activity.map((item) => `- ${item}`));
			if (activity.lastText) lines.push("Latest assistant text:", shorten(activity.lastText, STATUS_TEXT_LIMIT));
			if (activity.usage) lines.push(`Usage: ${activity.usage.tokens.toLocaleString()} tokens, $${activity.usage.cost.toFixed(4)}`);
			if (activity.state !== "running") {
				lines.push(
					activity.client
						? "Resume: background_send (runtime is still loaded)"
						: "Resume: background_send reopens the saved session; a live writer will block reopening",
				);
			}
		}
		return lines.join("\n");
	}

	async function listStatus(id?: string, ctx?: ExtensionContext): Promise<string> {
		if (id) {
			const activity = requireActivity(id, ctx);
			if (activity.kind === "agent") await refreshAgent(activity);
			return detailedStatus(activity);
		}
		await Promise.all([...activities.values()].filter((a): a is AgentActivity => a.kind === "agent").map(refreshAgent));
		return activities.size === 0 ? "No background activities." : [...activities.values()].map(activityLine).join("\n");
	}

	pi.registerTool({
		name: "background_start",
		label: "Background Start",
		description:
			"Start a background shell command or durable Pi agent. Returns immediately with an agent ID and saved session file. Completion notices wake the parent; finished activities release running capacity. Agent sessions survive runtime cleanup and parent restarts.",
		promptSnippet: "Start long shell commands or delegated agents with automatic completion wake-up",
		promptGuidelines: [
			"Use background_start with kind=shell instead of bash for long-running commands such as test suites, builds, dev servers, and watchers.",
			"Use background_start with kind=agent for independent delegated work that benefits from an isolated context. Start calls return immediately, and completion messages include results automatically; do not poll background_status or background_output merely to wait.",
			"Finished background activities are retained and pruned automatically. Do not call background_forget as routine cleanup.",
			"Use background_send with the saved agent ID or session file to resume a child after a crash, runtime cleanup, or parent restart; check for completed side effects before repeating interrupted work.",
		],
		parameters: StartParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ui ??= ctx.ui;
			const cwd = resolve(ctx.cwd, params.cwd ?? ".");
			if (!statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);

			if (params.kind === "shell") {
				const command = params.command?.trim();
				if (!command) throw new Error("kind=shell requires a non-empty command.");
				if (params.task) throw new Error("kind=shell accepts command, not task.");
				if (running("shell").length >= MAX_RUNNING_SHELLS) {
					throw new Error(`At most ${MAX_RUNNING_SHELLS} background shell commands may run at once.`);
				}

				const id = `shell-${nextShellId++}`;
				const logPath = join(ensureLogDir(), `${id}.log`);
				const fd = openSync(logPath, "a");
				let child: ChildProcess;
				try {
					child = spawn("/bin/bash", ["-c", command], {
						cwd,
						detached: true,
						stdio: ["ignore", fd, fd],
						env: process.env,
					});
				} finally {
					closeSync(fd);
				}

				const activity: ShellActivity = {
					id,
					kind: "shell",
					name: resolveName(params.name, command),
					command,
					cwd,
					logPath,
					child,
					state: "running",
					exitCode: null,
					startedAt: Date.now(),
					updatedAt: Date.now(),
					deliveredBytes: 0,
					stopRequested: false,
					timedOut: false,
				};
				activities.set(id, activity);
				child.unref();
				child.on("error", (error) => {
					activity.error = error.message;
					onShellExit(activity, -1, null);
				});
				child.on("exit", (code, signal) => onShellExit(activity, code, signal));

				if (params.timeoutSeconds && params.timeoutSeconds > 0) {
					activity.timeoutTimer = setTimeout(() => {
						if (activity.state !== "running") return;
						activity.timedOut = true;
						killProcessGroup(activity, "SIGTERM");
						activity.killTimer = setTimeout(() => killProcessGroup(activity, "SIGKILL"), KILL_ESCALATION_MS);
						activity.killTimer.unref();
					}, params.timeoutSeconds * 1_000);
					activity.timeoutTimer.unref();
				}
				if (params.checkinSeconds && params.checkinSeconds > 0) {
					const interval = Math.max(params.checkinSeconds, MIN_CHECKIN_SECONDS) * 1_000;
					activity.checkinTimer = setInterval(() => sendShellCheckin(activity), interval);
					activity.checkinTimer.unref();
				}

				updateWidget();
				return {
					content: [
						{
							type: "text",
							text:
								`Started ${id} (${activity.name}), PID ${child.pid ?? "unknown"}.\nLog: ${logPath}\n` +
								"A completion notice will arrive automatically; continue other work or end the turn.",
						},
					],
					details: { id, kind: activity.kind, state: activity.state, name: activity.name, logPath, cwd },
				};
			}

			if (params.command) throw new Error("kind=agent accepts task, not command.");
			if (params.timeoutSeconds || params.checkinSeconds) {
				throw new Error("timeoutSeconds and checkinSeconds currently apply only to kind=shell.");
			}
			const task = params.task?.trim();
			if (!task) throw new Error("kind=agent requires a non-empty task.");
			if (!ctx.model) throw new Error("The parent session has no active model.");
			if (running("agent").length >= MAX_RUNNING_AGENTS) {
				throw new Error(`At most ${MAX_RUNNING_AGENTS} background agents may run at once.`);
			}

			const activity = restoreAgent(createSavedAgent(cwd, resolveName(params.name, task), task, ctx));
			const id = activity.id;
			// Record the durable reference before launching, so a parent crash
			// before the tool result is written does not lose the child session.
			rememberAgent(activity);
			await startAgentRun(activity, "Begin the delegated task in the saved conversation.");

			updateWidget();
			return {
				content: [
					{
						type: "text",
						text:
							`Started ${id} (${activity.name}).\nSession: ${activity.sessionFile}\n` +
							"Its completion notice will include the final result automatically. " +
							"After a restart, use background_send with this ID or session file to resume.",
					},
				],
				details: { id, kind: activity.kind, state: activity.state, name: activity.name, task, cwd,
					sessionId: activity.sessionId, sessionFile: activity.sessionFile },
			};
		},
		renderCall(args, theme) {
			const source = args.kind === "shell" ? args.command : args.task;
			const target = args.name?.trim() || deriveName(source ?? "");
			let text = `${theme.fg("toolTitle", theme.bold("background_start "))}${theme.fg("accent", args.kind)} ${theme.fg("muted", target)}`;
			const timing: string[] = [];
			if (args.timeoutSeconds && args.timeoutSeconds > 0) timing.push(`timeout=${args.timeoutSeconds}s`);
			if (args.checkinSeconds && args.checkinSeconds > 0) {
				timing.push(`checkin=${Math.max(args.checkinSeconds, MIN_CHECKIN_SECONDS)}s`);
			}
			if (timing.length > 0) text += theme.fg("dim", ` (${timing.join(", ")})`);
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "background_status",
		label: "Background Status",
		description: "Inspect one retained background activity or list all activities. Do not poll this tool merely to wait; completions arrive automatically.",
		parameters: StatusParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const text = await listStatus(params.id, ctx);
			return { content: [{ type: "text", text }], details: { id: params.id, count: activities.size } };
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("background_status"))}${args.id ? ` ${theme.fg("muted", args.id)}` : ""}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "background_output",
		label: "Background Output",
		description: "Read retained shell logs or an agent's latest/final result without removing the activity.",
		parameters: OutputParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const activity = requireActivity(params.id, ctx);
			if (activity.kind === "shell") {
				const maxLines = Math.min(Math.max(params.lines ?? OUTPUT_DEFAULT_LINES, 1), OUTPUT_MAX_LINES);
				const { text } = readTail(activity.logPath, 0, OUTPUT_MAX_BYTES);
				const result = truncateTail(text, { maxLines, maxBytes: OUTPUT_MAX_BYTES });
				const body = result.content.trim().length > 0 ? result.content : "(no output yet)";
				const suffix = result.truncated ? `\n[tail of ${activity.logPath}; full log on disk]` : "";
				return {
					content: [{ type: "text", text: `${body}${suffix}` }],
					details: { id: activity.id, kind: activity.kind, state: activity.state, logPath: activity.logPath },
				};
			}

			await refreshAgent(activity);
			const raw = activity.lastText || activity.error || (activity.state === "running" ? "(no agent output yet)" : "(no output)");
			const result = truncateHead(raw, { maxLines: OUTPUT_MAX_LINES, maxBytes: OUTPUT_MAX_BYTES });
			const suffix = result.truncated ? "\n[agent output truncated]" : "";
			return {
				content: [{ type: "text", text: `${result.content}${suffix}` }],
				details: { id: activity.id, kind: activity.kind, state: activity.state, usage: activity.usage,
					sessionId: activity.sessionId, sessionFile: activity.sessionFile },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("background_output "))}${theme.fg("muted", args.id)}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "background_send",
		label: "Background Send",
		description: "Steer a running background agent or resume its saved conversation, including after runtime cleanup, a crash, or a parent restart. Accepts an agent ID or saved session file.",
		parameters: SendParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const activity = requireActivity(params.id, ctx);
			if (activity.kind !== "agent") throw new Error(`${activity.id} is a shell activity and cannot receive messages.`);
			const message = params.message.trim();
			if (!message) throw new Error("background_send requires a non-empty message.");
			if (activity.starting) throw new Error(`${activity.id} is still starting. Retry after startup completes.`);
			await refreshAgent(activity);
			if (activity.starting) throw new Error(`${activity.id} is still starting. Retry after startup completes.`);
			if (activity.state === "running" && activity.client) {
				await activity.client.steer(message);
				addAgentActivity(activity, "steering instruction queued");
			} else {
				await startAgentRun(activity, message);
			}
			return {
				content: [{ type: "text", text: `${activity.id} accepted the instruction.\nSession: ${activity.sessionFile}` }],
				details: { id: activity.id, kind: activity.kind, state: activity.state,
					sessionId: activity.sessionId, sessionFile: activity.sessionFile },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("background_send "))}${theme.fg("muted", args.id)}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "background_stop",
		label: "Background Stop",
		description: "Cancel a running shell command or agent. Retained output remains available and is cleaned up automatically later.",
		parameters: IdParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const activity = requireActivity(params.id, ctx);
			if (activity.kind === "agent" && activity.starting) throw new Error(`${activity.id} is still starting. Retry after startup completes.`);
			if (activity.state !== "running") throw new Error(`${activity.id} is not running (state: ${activity.state}).`);

			if (activity.kind === "shell") {
				activity.stopRequested = true;
				killProcessGroup(activity, "SIGTERM");
				activity.killTimer = setTimeout(() => killProcessGroup(activity, "SIGKILL"), KILL_ESCALATION_MS);
				activity.killTimer.unref();
				return {
					content: [{ type: "text", text: `Sent SIGTERM to ${activity.id} (${activity.name}); retained logs remain available.` }],
					details: { id: activity.id, kind: activity.kind, state: "stopping" },
				};
			}

			clearAgentMonitor(activity);
			activity.state = "stopped";
			activity.runId++;
			activity.endedAt = activity.updatedAt = Date.now();
			updateWidget();
			try {
				await activity.client?.abort();
			} finally {
				addAgentActivity(activity, "agent run stopped");
				scheduleAgentReap(activity);
				pruneFinished();
			}
			return {
				content: [{ type: "text", text: `Stopped ${activity.id}; retained output remains available.` }],
				details: { id: activity.id, kind: activity.kind, state: activity.state },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("background_stop "))}${theme.fg("muted", args.id)}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "background_forget",
		label: "Background Forget",
		description: "Untrack a finished activity. Shell logs are removed, but durable agent sessions remain on disk and can be reopened by session file. Routine cleanup is automatic.",
		parameters: IdParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const activity = requireActivity(params.id, ctx);
			if (activity.state === "running") throw new Error(`${activity.id} is still running. Stop it before forgetting it.`);
			if (activity.kind === "agent") {
				agentReferences.delete(activity.id);
				pi.appendEntry(AGENT_FORGET_ENTRY, { id: activity.id });
			}
			await forgetActivity(activity);
			return {
				content: [{ type: "text", text: activity.kind === "agent"
					? `Untracked ${activity.id}. Saved session remains at ${activity.sessionFile}.`
					: `Forgot ${activity.id} and removed its retained resources.` }],
				details: { id: activity.id, kind: activity.kind, state: "forgotten" },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("background_forget "))}${theme.fg("muted", args.id)}`,
				0,
				0,
			);
		},
	});

	pi.registerMessageRenderer("background", (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		const [first = "", ...output] = content.split("\n");
		const visibleOutput = output.slice(0, NOTICE_RENDER_MAX_OUTPUT_LINES);
		const hiddenLines = output.length - visibleOutput.length;
		const lines = [
			`  ${theme.fg("accent", "● ")}${theme.fg("muted", first)}`,
			...visibleOutput.map((line) => `    ${theme.fg("dim", line || " ")}`),
		];
		if (hiddenLines > 0) {
			lines.push(`    ${theme.fg("dim", `(+ ${hiddenLines} ${hiddenLines === 1 ? "line" : "lines"})`)}`);
		}
		return new Text(lines.join("\n"), 0, 0);
	});

	pi.registerCommand("background", {
		description: "List retained background shell commands and agents",
		handler: async (_args, ctx) => {
			ui ??= ctx.ui;
			ctx.ui.notify(await listStatus(undefined, ctx), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.ui;
		shuttingDown = false;
		agentReferences.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			const data = entry.data as { id?: unknown; sessionFile?: unknown } | undefined;
			if (typeof data?.id !== "string") continue;
			if (entry.customType === AGENT_REFERENCE_ENTRY && typeof data.sessionFile === "string") {
				agentReferences.set(data.id, data.sessionFile);
			} else if (entry.customType === AGENT_FORGET_ENTRY) agentReferences.delete(data.id);
		}
		for (const [id, path] of [...agentReferences].slice(-MAX_FINISHED_KEPT)) {
			if (activities.has(id)) continue;
			try { restoreAgent(readSavedAgent(path)); } catch (error) {
				ctx.ui.notify(`Could not restore ${id}: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}
		updateWidget();
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		if (widgetTimer) {
			clearInterval(widgetTimer);
			widgetTimer = undefined;
		}
		ui?.setStatus("background", undefined);
		ui?.setWidget(WIDGET_ID, undefined);

		const stops: Promise<void>[] = [];
		for (const activity of activities.values()) {
			if (activity.kind === "shell") {
				clearShellTimers(activity);
				if (activity.state === "running") {
					activity.stopRequested = true;
					killProcessGroup(activity, "SIGKILL");
				}
			} else {
				activity.runId++;
				activity.state = "stopped";
				stops.push(reapAgentRuntime(activity));
			}
		}
		await Promise.allSettled(stops);
		activities.clear();
		if (logDir) {
			try {
				rmSync(logDir, { recursive: true, force: true });
			} catch {
				// Best-effort temporary log cleanup.
			}
			logDir = undefined;
		}
	});
}
