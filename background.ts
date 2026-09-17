/**
 * Unified background activities for shell commands and steerable Pi agents.
 *
 * Both kinds share lifecycle, status, output, cancellation, widget UI, bounded
 * retention, and automatic completion wake-up. Finished activities never
 * consume running capacity. Agent runtimes remain resumable for a short grace
 * period, then stop automatically while their final result remains available.
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
import { join, resolve } from "node:path";
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

const MAX_RUNNING_SHELLS = 8;
const MAX_RUNNING_AGENTS = 4;
const MAX_FINISHED_KEPT = 20;
const AGENT_RESUME_GRACE_MS = 5 * 60 * 1_000;
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
	id: Type.String({ description: "Background activity id" }),
});

const StatusParameters = Type.Object({
	id: Type.Optional(Type.String({ description: "Activity id; omit to list all retained activities" })),
});

const OutputParameters = Type.Object({
	id: Type.String({ description: "Background activity id" }),
	lines: Type.Optional(Type.Number({ description: `Maximum shell log lines, default ${OUTPUT_DEFAULT_LINES}` })),
});

const SendParameters = Type.Object({
	id: Type.String({ description: "Background agent id" }),
	message: Type.String({ description: "Instruction to steer a running agent or continue a finished one" }),
});

export default function background(pi: ExtensionAPI): void {
	pi = withCompactToolRendering(pi);
	const activities = new Map<string, Activity>();
	let nextShellId = 1;
	let nextAgentId = 1;
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

	function requireActivity(id: string | undefined): Activity {
		if (!id) throw new Error("This operation requires an activity id.");
		const activity = activities.get(id);
		if (!activity) throw new Error(`Unknown background activity: ${id}. Use background_status to list activities.`);
		return activity;
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

	async function reapAgentRuntime(activity: AgentActivity): Promise<void> {
		if (activity.reapTimer) {
			clearTimeout(activity.reapTimer);
			activity.reapTimer = undefined;
		}
		const client = activity.client;
		if (!client) return;
		activity.client = undefined;
		try {
			await client.stop();
			addAgentActivity(activity, "agent runtime stopped after the resume grace period");
		} catch (error) {
			activity.error ??= error instanceof Error ? error.message : String(error);
		}
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

	function observeAgent(activity: AgentActivity, event: JsonAgentSessionEvent): void {
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
				break;
			}
			case "extension_error":
				addAgentActivity(activity, `extension error: ${event.error}`);
				break;
		}
	}

	async function finalizeAgent(activity: AgentActivity, runId: number): Promise<void> {
		if (
			activities.get(activity.id) !== activity ||
			activity.runId !== runId ||
			activity.notifiedRunId >= runId ||
			activity.state !== "running"
		) {
			return;
		}
		activity.notifiedRunId = runId;
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
					`The result is retained automatically; no collection or cleanup call is required.`,
				display: true,
				details: {
					id: activity.id,
					kind: activity.kind,
					event: "completion",
					state: activity.state,
					usage: activity.usage,
				},
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	}

	function monitorAgentRun(activity: AgentActivity, runId: number): void {
		const client = activity.client;
		if (!client) return;
		void client.waitForIdle().then(
			() => finalizeAgent(activity, runId),
			(error) => {
				if (activity.runId !== runId || activity.state !== "running") return;
				activity.runError = error instanceof Error ? error.message : String(error);
				void finalizeAgent(activity, runId);
			},
		);
	}

	async function refreshAgent(activity: AgentActivity): Promise<void> {
		if (activity.state !== "running" || !activity.client) return;
		try {
			// Completion is event-driven through agent_settled/waitForIdle. A brief
			// non-streaming gap can occur before a queued run starts, so get_state
			// must not promote a running activity to completed by itself.
			await activity.client.getState();
		} catch (error) {
			activity.runError = error instanceof Error ? error.message : String(error);
			await finalizeAgent(activity, activity.runId);
		}
	}

	function activityLine(activity: Activity): string {
		const duration =
			activity.state === "running"
				? elapsed(activity.startedAt)
				: elapsed(activity.startedAt, activity.endedAt ?? activity.updatedAt);
		const resumable = activity.kind === "agent" && activity.state !== "running" && activity.client ? ", resumable" : "";
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
			lines.push(`Task: ${activity.task}`);
			if (activity.activity.length > 0) lines.push("Recent activity:", ...activity.activity.map((item) => `- ${item}`));
			if (activity.lastText) lines.push("Latest assistant text:", shorten(activity.lastText, STATUS_TEXT_LIMIT));
			if (activity.usage) lines.push(`Usage: ${activity.usage.tokens.toLocaleString()} tokens, $${activity.usage.cost.toFixed(4)}`);
			if (activity.state !== "running") {
				lines.push(
					activity.client
						? "Resume: available temporarily with background_send"
						: "Resume: grace period expired; start a new agent",
				);
			}
		}
		return lines.join("\n");
	}

	async function listStatus(id?: string): Promise<string> {
		if (id) {
			const activity = requireActivity(id);
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
			"Start a background shell command or steerable Pi agent. Returns immediately. Completion and result notices arrive automatically and wake the parent; finished activities release running capacity and are pruned automatically.",
		promptSnippet: "Start long shell commands or delegated agents with automatic completion wake-up",
		promptGuidelines: [
			"Use background_start with kind=shell instead of bash for long-running commands such as test suites, builds, dev servers, and watchers.",
			"Use background_start with kind=agent for independent delegated work that benefits from an isolated context. Start calls return immediately, and completion messages include results automatically; do not poll background_status or background_output merely to wait.",
			"Finished background activities are retained and pruned automatically. Do not call background_forget as routine cleanup.",
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

			const id = `agent-${nextAgentId++}`;
			const client = new RpcClient({
				cliPath: resolve(getPackageDir(), "dist", "cli.js"),
				cwd,
				provider: ctx.model.provider,
				model: ctx.model.id,
				// Keep normal resource discovery, including custom providers. Only
				// disable persistence for the child's separate conversation.
				args: ["--no-session"],
			});
			const activity: AgentActivity = {
				id,
				kind: "agent",
				name: resolveName(params.name, task),
				task,
				cwd,
				client,
				state: "running",
				startedAt: Date.now(),
				updatedAt: Date.now(),
				lastText: "",
				activity: [],
				runId: 1,
				notifiedRunId: 0,
			};
			activities.set(id, activity);
			client.onEvent((event) => observeAgent(activity, event));

			try {
				await client.start();
				await client.setThinkingLevel(ctx.thinkingLevel);
				await client.prompt(
					`You are a background subagent. Complete this delegated task autonomously. ` +
						`Keep changes scoped and finish with a concise report containing relevant file paths.\n\nTask: ${task}`,
				);
				addAgentActivity(activity, "task accepted");
				monitorAgentRun(activity, activity.runId);
			} catch (error) {
				activities.delete(id);
				await client.stop();
				throw error;
			}

			updateWidget();
			return {
				content: [
					{
						type: "text",
						text:
							`Started ${id} (${activity.name}). ` +
							"Its completion notice will include the final result automatically; continue other work or end the turn.",
					},
				],
				details: { id, kind: activity.kind, state: activity.state, name: activity.name, task, cwd },
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
		async execute(_toolCallId, params) {
			const text = await listStatus(params.id);
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
		async execute(_toolCallId, params) {
			const activity = requireActivity(params.id);
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
				details: { id: activity.id, kind: activity.kind, state: activity.state, usage: activity.usage },
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
		description: "Send a course correction to a running background agent or continue a finished agent during its resume grace period.",
		parameters: SendParameters,
		async execute(_toolCallId, params) {
			const activity = requireActivity(params.id);
			if (activity.kind !== "agent") throw new Error(`${activity.id} is a shell activity and cannot receive messages.`);
			const message = params.message.trim();
			if (!message) throw new Error("background_send requires a non-empty message.");
			const client = activity.client;
			if (!client) throw new Error(`${activity.id}'s resume grace period expired. Start a new agent instead.`);

			if (activity.state === "running") {
				await client.steer(message);
				addAgentActivity(activity, "steering instruction queued");
			} else {
				if (activity.reapTimer) {
					clearTimeout(activity.reapTimer);
					activity.reapTimer = undefined;
				}
				activity.runId++;
				activity.state = "running";
				activity.endedAt = undefined;
				activity.error = undefined;
				activity.runError = undefined;
				activity.lastText = "";
				try {
					await client.prompt(message);
					addAgentActivity(activity, "continuation accepted");
					monitorAgentRun(activity, activity.runId);
				} catch (error) {
					activity.state = "failed";
					activity.error = error instanceof Error ? error.message : String(error);
					activity.endedAt = activity.updatedAt = Date.now();
					scheduleAgentReap(activity);
					pruneFinished();
					throw error;
				}
				updateWidget();
			}
			return {
				content: [{ type: "text", text: `${activity.id} accepted the instruction.` }],
				details: { id: activity.id, kind: activity.kind, state: activity.state },
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
		async execute(_toolCallId, params) {
			const activity = requireActivity(params.id);
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
		description: "Explicitly remove a finished activity and its retained output. Routine cleanup is automatic; use this only for immediate removal.",
		parameters: IdParameters,
		async execute(_toolCallId, params) {
			const activity = requireActivity(params.id);
			if (activity.state === "running") throw new Error(`${activity.id} is still running. Stop it before forgetting it.`);
			await forgetActivity(activity);
			return {
				content: [{ type: "text", text: `Forgot ${activity.id} and removed its retained resources.` }],
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
			ctx.ui.notify(await listStatus(), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.ui;
		shuttingDown = false;
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
			} else if (activity.client) {
				const client = activity.client;
				activity.client = undefined;
				if (activity.reapTimer) clearTimeout(activity.reapTimer);
				stops.push(client.stop());
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
