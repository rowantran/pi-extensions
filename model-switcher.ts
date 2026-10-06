import { readFileSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { modelRef, physicalModel, readConfig } from "./model-switcher/config.ts";

export const PROVIDER = "model-switcher";
export const MODEL = "auto";
const PHASES = ["planning", "implementation", "review"] as const;
type Phase = typeof PHASES[number];
export interface ModelSwitcherState { phase: Phase }
const prompts = JSON.parse(readFileSync(new URL("./model-switcher/prompts.json", import.meta.url), "utf8"));

function phase(value: unknown): value is Phase {
	return PHASES.includes(value as Phase);
}

function textOf(message: Message, limit: number): string {
	const text = typeof message.content === "string" ? message.content : message.content.flatMap((block) => {
		if (block.type === "text") return [block.text];
		if (block.type === "toolCall") return [`[tool call: ${block.name}]`];
		return []; // Exclude hidden reasoning, images, signatures, and tool arguments.
	}).join("\n");
	return text.length > limit ? `${text.slice(0, limit / 2)}\n[truncated]\n${text.slice(-limit / 2)}` : text;
}

/** Bound the classifier input without changing the coding model's conversation. */
export function classifierContext(request: ModelRouteRequest<ModelSwitcherState>, currentPhase: Phase) {
	const messages = request.messages.filter((message) => message.role !== "system");
	const user = messages.findLast((message) => message.role === "user");
	return {
		state: {
			currentPhase,
			requestReason: request.reason,
			latestUserMessage: user ? textOf(user, 6000) : "",
			recentMessages: messages.slice(-8).map((message) => ({
				role: message.role,
				...(message.role === "toolResult" ? { toolName: message.toolName, isError: message.isError } : {}),
				text: textOf(message, message.role === "toolResult" ? 1000 : 3000),
			})),
		},
		questions: {
			nextPhase: { type: "choice" as const, instructions: prompts.classifierInstructions as string, criteria: prompts.criteria as Record<Phase, string> },
		},
	};
}

export default function modelSwitcher(pi: ExtensionAPI) {
	const warned = new WeakSet<object>();
	pi.registerVirtualModel<ModelSwitcherState>({
		provider: PROVIDER, id: MODEL, name: "Model switcher",
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		async route(request, ctx) {
			request.signal?.throwIfAborted();
			// Retrying a failed request must reuse its model, not reclassify it.
			if (request.reason === "retry" && request.failed) {
				return { model: request.failed.model, thinkingLevel: request.failed.thinkingLevel ?? request.thinkingLevel, state: request.state };
			}
			const config = readConfig();
			// Compaction and other direct calls do not have or change router state.
			if (request.reason === "direct") {
				return { model: request.previous?.model ?? physicalModel(ctx, config.interactive), thinkingLevel: request.thinkingLevel };
			}
			let state = request.state && phase(request.state.phase) ? request.state : { phase: "planning" as Phase };
			if (request.reason !== "retry") {
				try {
					const classifier = config.classifier && ctx.modelRegistry.findOfType("classifier", ...modelRef(config.classifier));
					if (!classifier) throw new Error("Classifier unavailable or disabled");
					const signal = AbortSignal.any([...(request.signal ? [request.signal] : []), AbortSignal.timeout(5000)]);
					const result = await ctx.modelRegistry.classify(classifier, classifierContext(request, state.phase), { signal });
					request.signal?.throwIfAborted();
					if (result.stopReason !== "stop") throw new Error("Classifier request failed");
					const answer = result.answers.nextPhase;
					if (answer?.type === "choice" && phase(answer.choice)
						&& Number.isFinite(answer.probabilities[answer.choice]) && answer.probabilities[answer.choice] >= 0.8 && answer.probabilities[answer.choice] <= 1
						&& answer.choice !== state.phase) {
						state = { phase: answer.choice };
					}
				} catch {
					request.signal?.throwIfAborted();
					if (ctx.hasUI && !warned.has(ctx.sessionManager)) {
						warned.add(ctx.sessionManager);
						ctx.ui.notify(`Model switcher classifier ${config.classifier ?? "(disabled)"} is unavailable or failed. Keeping the current phase. Use /model for manual selection.`, "warning");
					}
				}
			}
			const model = physicalModel(ctx, state.phase === "implementation" ? config.implementation : config.interactive);
			return { model, thinkingLevel: request.thinkingLevel, state };
		},
	});
}
