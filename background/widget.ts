/** Display-only background widget data and rendering; safe to import without the worker extension. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const BACKGROUND_WIDGET_ID = "background-running";
const MAX_WIDGET_ITEMS = 5;

type ActiveTask = { kind: "shell" | "agent"; name: string; startedAt: number };

/** Remove terminal commands and keep each input on one terminal line. */
function plainLine(text: string): string {
	return stripTerminalSequences(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
}

function elapsed(from: number, now: number): string {
	const delta = now - from;
	const seconds = Number.isFinite(delta) ? Math.max(0, Math.floor(delta / 1_000)) : 0;
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60 > 0 ? `${seconds % 60}s` : ""}`;
	return `${Math.floor(minutes / 60)}h${minutes % 60 > 0 ? `${minutes % 60}m` : ""}`;
}

/** Plain RPC payload: a heading, up to five active tasks, and an optional overflow count. */
export function backgroundWidgetLines(active: readonly ActiveTask[], now = Date.now()): string[] {
	if (active.length === 0) return [];
	const lines = [`Background: ${active.length} running`];
	for (const task of active.slice(0, MAX_WIDGET_ITEMS)) {
		const name = plainLine(task.name).replace(/\s+/g, " ").trim();
		lines.push(`  (${elapsed(task.startedAt, now)}) ${task.kind === "agent" ? "Agent:" : "Task:"} ${name}`);
	}
	if (active.length > MAX_WIDGET_ITEMS) lines.push(`  (+ ${active.length - MAX_WIDGET_ITEMS} more)`);
	return lines;
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

/** Render known RPC lines as the native box. Unknown content stays plain, sanitized, and width-bounded. */
export function renderBackgroundWidgetLines(lines: readonly string[], width: number, theme: Theme): string[] {
	if (lines.length === 0) return [];
	width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	const safeLines = lines.map(plainLine);
	const heading = /^Background: ([1-9]\d*) running$/.exec(safeLines[0]);
	const rows = safeLines.slice(1).map((line) => ({
		task: /^  \((\d+s|\d+m(?:\d+s)?|\d+h(?:\d+m)?)\) (Agent:|Task:) (.*)$/.exec(line),
		overflow: /^  \(\+ ([1-9]\d*) more\)$/.exec(line),
	}));
	if (!heading || rows.some((row) => !row.task && !row.overflow)) {
		return safeLines.map((line) => truncateToWidth(line, width));
	}

	const accent = (text: string) => theme.fg("accent", text);
	const rendered = [borderTop("Background", `${heading[1]} running`, width, accent)];
	for (const { task, overflow } of rows) {
		if (task) {
			const duration = theme.fg("dim", `(${task[1]})`);
			const label = theme.fg("muted", task[2]);
			rendered.push(borderLine(` ${duration} ${label} ${task[3]} `, width, accent));
		} else if (overflow) {
			rendered.push(borderLine(` ${theme.fg("dim", `(+ ${overflow[1]} more)`)} `, width, accent));
		}
	}
	rendered.push(borderBottom(width, accent));
	return rendered;
}
