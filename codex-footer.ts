import type { ContextUsage, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

const AUTO_COMPACTION_RESERVE_TOKENS = 16_384;
const LINE_INDENT = "  ";
const SEPARATOR = " · ";

function formatTokens(count: number): string {
	if (count < 1_000) {
		return count.toString();
	}
	if (count < 10_000) {
		return `${(count / 1_000).toFixed(1)}k`;
	}
	if (count < 1_000_000) {
		return `${Math.round(count / 1_000)}k`;
	}
	if (count < 10_000_000) {
		return `${(count / 1_000_000).toFixed(1)}M`;
	}
	return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string): string {
	const home = resolve(homedir());
	const absoluteCwd = resolve(cwd);
	const relativeToHome = relative(home, absoluteCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." &&
			!relativeToHome.startsWith(`..${sep}`) &&
			!isAbsolute(relativeToHome));

	if (!isInsideHome) {
		return cwd;
	}
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function contextSegment(theme: Theme, usage: ContextUsage | undefined): string {
	if (!usage) {
		return theme.fg("thinkingHigh", "? left");
	}

	const threshold = Math.max(0, usage.contextWindow - AUTO_COMPACTION_RESERVE_TOKENS);
	const effectiveLimit = threshold > 0 ? threshold : usage.contextWindow;
	if (usage.tokens === null) {
		return theme.fg("thinkingHigh", "? left");
	}

	const percentLeft = Math.max(0, ((effectiveLimit - usage.tokens) / effectiveLimit) * 100);
	const label = `${percentLeft.toFixed(0)}% left`;
	if (percentLeft < 10) {
		return theme.fg("error", label);
	}
	if (percentLeft < 30) {
		return theme.fg("warning", label);
	}
	return theme.fg("thinkingHigh", label);
}

function packSegments(segments: string[], width: number, theme: Theme): string[] {
	if (width <= visibleWidth(LINE_INDENT)) {
		return [truncateToWidth(LINE_INDENT, width, "")];
	}

	const separator = theme.fg("dim", SEPARATOR);
	const lines: string[] = [];
	let line = LINE_INDENT;

	for (const segment of segments) {
		const prefix = line === LINE_INDENT ? "" : separator;
		const candidate = `${line}${prefix}${segment}`;
		if (visibleWidth(candidate) <= width) {
			line = candidate;
			continue;
		}

		if (line !== LINE_INDENT) {
			lines.push(line);
			line = LINE_INDENT;
		}

		const available = Math.max(0, width - visibleWidth(LINE_INDENT));
		line += truncateToWidth(segment, available, "…");
	}

	if (line !== LINE_INDENT || lines.length === 0) {
		lines.push(line);
	}
	return lines;
}

export default function codexFooter(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsubscribe,
				invalidate(): void {},
				render(width: number): string[] {
					let totalCost = 0;
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							totalCost += entry.message.usage.cost.total;
						} else if (
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.usage
						) {
							totalCost += entry.message.usage.cost.total;
						} else if (
							(entry.type === "branch_summary" || entry.type === "compaction") &&
							entry.usage
						) {
							totalCost += entry.usage.cost.total;
						}
					}

					const modelName = ctx.model?.id ?? "no-model";
					const providerPrefix =
						ctx.model && footerData.getAvailableProviderCount() > 1
							? `(${ctx.model.provider}) `
							: "";
					const thinking = ctx.model?.reasoning ? ` ${ctx.thinkingLevel ?? "off"}` : "";
					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow;
					const contextMax = contextWindow ? ` (${formatTokens(contextWindow)} ctx)` : "";
					const branch = footerData.getGitBranch();
					const workspace = branch ? `${formatCwd(ctx.cwd)} (${branch})` : formatCwd(ctx.cwd);
					const mainSegments = [
						theme.fg("warning", `${providerPrefix}${modelName}${thinking}${contextMax}`),
						contextSegment(theme, contextUsage),
						theme.fg("success", workspace),
					];

					const lines: string[] = [];
					const sessionName = sanitizeStatus(ctx.sessionManager.getSessionName() ?? "");
					if (sessionName) {
						lines.push(...packSegments([theme.bold(theme.fg("accent", sessionName))], width, theme));
					}
					lines.push(...packSegments(mainSegments, width, theme));

					const otherSegments: string[] = [];
					const usingSubscription =
						ctx.model !== undefined &&
						(ctx.model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(ctx.model));
					if (totalCost || usingSubscription) {
						const subscriptionLabel = usingSubscription ? " (sub)" : "";
						otherSegments.push(theme.fg("dim", `$${totalCost.toFixed(3)}${subscriptionLabel}`));
					}
					if (process.env.PI_EXPERIMENTAL === "1") {
						otherSegments.push(theme.bold(theme.fg("warning", "xp")));
					}

					const statuses = Array.from(footerData.getExtensionStatuses().entries())
						.sort(([left], [right]) => left.localeCompare(right))
						.map(([, text]) => sanitizeStatus(text))
						.filter(Boolean);
					otherSegments.push(...statuses);
					if (otherSegments.length > 0) {
						lines.push(...packSegments(otherSegments, width, theme));
					}
					return lines;
				},
			};
		});
	});
}
