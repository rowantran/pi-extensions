import { readFileSync } from "node:fs";
import { Type } from "typebox";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRouteRequest, SessionEntry } from "@earendil-works/pi-coding-agent";
import { configPath, modelRef, physicalModel, readConfig, writeModels } from "./model-switcher/config.ts";

export const PROVIDER = "model-switcher";
export const MODEL = "auto";
const LEGACY_PROVIDER = "workflow";
const SIGNAL = "model-switcher.phase";
const OVERRIDE = "model-switcher.override";
const PHASES = ["planning", "implementation", "review"] as const;
type Phase = typeof PHASES[number];
type Override = "auto" | "interactive" | "implementation";
export interface ModelSwitcherState { phase: Phase; signalId?: string }
const prompts = JSON.parse(readFileSync(new URL("./model-switcher/prompts.json", import.meta.url), "utf8"));

function phase(value: unknown): value is Phase {
	return PHASES.includes(value as Phase);
}

function latestUserId(branch: readonly SessionEntry[]): string | null {
	return branch.findLast((entry) => entry.type === "message" && entry.message.role === "user")?.id ?? null;
}

function controls(branch: readonly SessionEntry[]) {
	let signal: { id: string; phase: Phase; userId: unknown } | undefined;
	let override: Override = "auto";
	for (const entry of branch) {
		if (entry.type !== "custom") continue;
		const data = entry.data as Record<string, unknown> | undefined;
		if ((entry.customType === SIGNAL || entry.customType === `${LEGACY_PROVIDER}.phase`) && phase(data?.phase)) {
			signal = { id: entry.id, phase: data.phase, userId: data.userId };
		}
		if ((entry.customType === OVERRIDE || entry.customType === `${LEGACY_PROVIDER}.override`)
			&& ["auto", "interactive", "implementation"].includes(data?.mode as string)) {
			override = data!.mode as Override;
		}
	}
	return { signal, override };
}

function savedState(branch: readonly SessionEntry[]): ModelSwitcherState | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== "pi.virtual-model-state") continue;
		const data = entry.data as { provider?: string; modelId?: string; state?: ModelSwitcherState };
		if ((data?.provider === PROVIDER || data?.provider === LEGACY_PROVIDER)
			&& data.modelId === MODEL && phase(data.state?.phase)) return data.state;
	}
}

function textOf(message: Message, limit: number): string {
	const text = typeof message.content === "string" ? message.content : message.content.flatMap((block) => {
		if (block.type === "text") return [block.text];
		if (block.type === "toolCall") return [`[tool call: ${block.name}]`];
		return []; // Do not send hidden reasoning, images, signatures, or tool arguments to the classifier.
	}).join("\n");
	return text.length > limit ? `${text.slice(0, limit / 2)}\n[truncated]\n${text.slice(-limit / 2)}` : text;
}

/** A bounded classifier input only; the implementation conversation is never transformed. */
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
	const warnings = new WeakMap<object, Set<string>>();
	function warn(ctx: ExtensionContext, message: string) {
		let shown = warnings.get(ctx.sessionManager);
		if (!shown) { shown = new Set(); warnings.set(ctx.sessionManager, shown); }
		if (shown.has(message)) return;
		shown.add(message);
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
	}
	function status(ctx: ExtensionContext, currentPhase: Phase, override: Override) {
		if (ctx.hasUI) ctx.ui.setStatus("model-switcher", `model switcher: ${currentPhase}${override === "auto" ? "" : ` (${override} override)`}`);
	}
	async function activate(ctx: ExtensionContext) {
		const config = readConfig();
		physicalModel(ctx, config.interactive);
		physicalModel(ctx, config.implementation);
		if (ctx.model?.provider === PROVIDER && ctx.model.id === MODEL) return;
		const model = ctx.modelRegistry.find(PROVIDER, MODEL);
		const thinkingLevel = pi.getThinkingLevel();
		if (!model || !await pi.setModel(model)) throw new Error("Could not select model-switcher/auto. Reload the extension and try again.");
		pi.setThinkingLevel(thinkingLevel);
	}

	pi.registerVirtualModel<ModelSwitcherState>({
		provider: PROVIDER, id: MODEL, name: "Model switcher",
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		async route(request, ctx) {
			request.signal?.throwIfAborted();
			const config = readConfig();
			// Compaction/other nested calls must not classify or change the routing phase.
			if (request.reason === "direct") {
				return { model: request.previous?.model ?? physicalModel(ctx, config.interactive), thinkingLevel: request.thinkingLevel };
			}
			// Retrying the same request must not make a second, different routing decision.
			if (request.reason === "retry" && request.failed) {
				return { model: request.failed.model, thinkingLevel: request.failed.thinkingLevel ?? request.thinkingLevel, state: request.state };
			}
			const branch = ctx.sessionManager.getBranch();
			const { signal, override } = controls(branch);
			// The renamed virtual model has no Pi-owned state on its first request.
			// Recover the old phase from this branch without rewriting session history.
			let state = request.state && phase(request.state.phase) ? request.state : savedState(branch) ?? { phase: "planning" as Phase };
			const pendingSignal = signal && signal.id !== state.signalId;
			const hasSignal = pendingSignal && signal.userId === latestUserId(branch);
			// An interrupted phase call must not override a newer user turn. Consume
			// stale signals without applying them, then let the classifier reconsider.
			if (pendingSignal) state = { phase: hasSignal ? signal.phase : state.phase, signalId: signal.id };

			if (!hasSignal && override === "auto" && config.classifier && request.reason !== "retry") {
				const classifier = ctx.modelRegistry.findOfType("classifier", ...modelRef(config.classifier));
				if (!classifier) {
					warn(ctx, `Model switcher classifier ${config.classifier} is unavailable. Phase signals and /model-switcher overrides still work.`);
				} else {
					try {
						const signal = AbortSignal.any([...(request.signal ? [request.signal] : []), AbortSignal.timeout(5000)]);
						const result = await ctx.modelRegistry.classify(classifier, classifierContext(request, state.phase), { signal });
						request.signal?.throwIfAborted();
						const answer = result.stopReason === "stop" ? result.answers.nextPhase : undefined;
						if (answer?.type === "choice" && phase(answer.choice)
							&& Number.isFinite(answer.probabilities[answer.choice]) && answer.probabilities[answer.choice] >= 0.8 && answer.probabilities[answer.choice] <= 1
							&& answer.choice !== state.phase) {
							state = { ...state, phase: answer.choice };
						} else if (result.stopReason !== "stop") {
							warn(ctx, "Model switcher classifier could not decide (credentials, timeout, or provider failure). Keeping the current phase; phase signals and /model-switcher overrides still work.");
						}
					} catch {
						request.signal?.throwIfAborted();
						warn(ctx, "Model switcher classifier failed. Keeping the current phase; phase signals and /model-switcher overrides still work.");
					}
				}
			}
			const implementation = override === "implementation" || (override === "auto" && state.phase === "implementation");
			const model = physicalModel(ctx, implementation ? config.implementation : config.interactive);
			status(ctx, state.phase, override);
			return { model, thinkingLevel: request.thinkingLevel, state };
		},
	});

	pi.registerTool({
		name: "model_switcher_phase", label: "Model switcher phase", description: prompts.toolDescription,
		parameters: Type.Object({ phase: Type.Union(PHASES.map((value) => Type.Literal(value))) }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const userId = latestUserId(ctx.sessionManager.getBranch());
			await activate(ctx);
			signal?.throwIfAborted();
			pi.appendEntry(SIGNAL, { phase: params.phase, userId });
			const { override } = controls(ctx.sessionManager.getBranch());
			status(ctx, params.phase, override);
			return { content: [{ type: "text", text: prompts.phaseMessages[params.phase] }], details: { phase: params.phase, override } };
		},
	});

	pi.registerCommand("model-switcher", {
		description: "Model routing: status | models <interactive> <implementation> | auto | interactive | implementation | off",
		async handler(args, ctx) {
			if (!ctx.isIdle()) { ctx.ui.notify("Wait for the current run to finish before changing model routing.", "warning"); return; }
			try {
				const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
				if (command === "models" && rest.length === 2) {
					const config = writeModels(ctx, rest[0], rest[1]);
					ctx.ui.notify(`Saved ${configPath()}\nInteractive: ${config.interactive}\nImplementation: ${config.implementation}`, "info");
				} else if (command === "off" && rest.length === 0) {
					if (!await pi.setModel(physicalModel(ctx, readConfig().interactive))) throw new Error("Could not select the interactive model.");
					ctx.ui.setStatus("model-switcher", undefined);
					ctx.ui.notify("Model switcher routing off. Continuing with the interactive model in the same conversation.", "info");
				} else if (["auto", "interactive", "implementation"].includes(command) && rest.length === 0) {
					await activate(ctx);
					pi.appendEntry(OVERRIDE, { mode: command });
					ctx.ui.notify(`Model switcher routing: ${command}. This changes model routing, not implementation approval.`, "info");
				} else if (command === "status" && rest.length === 0) {
					const branch = ctx.sessionManager.getBranch();
					const { signal, override } = controls(branch);
					const saved = savedState(branch);
					const currentPhase = signal && signal.id !== saved?.signalId && signal.userId === latestUserId(branch) ? signal.phase : saved?.phase ?? "planning";
					const config = readConfig();
					const active = ctx.model?.provider === PROVIDER && ctx.model.id === MODEL;
					ctx.ui.notify(`Model switcher ${active ? "selected" : "not selected"}; phase: ${currentPhase}; routing: ${override}\nInteractive: ${config.interactive}\nImplementation: ${config.implementation}\nClassifier: ${config.classifier ?? "disabled"}`, "info");
				} else throw new Error("Usage: /model-switcher [status | models <interactive-provider/model> <implementation-provider/model> | auto | interactive | implementation | off]");
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		},
	});

	pi.on("model_select", (_event, ctx) => {
		if (ctx.hasUI && (ctx.model?.provider !== PROVIDER || ctx.model.id !== MODEL)) ctx.ui.setStatus("model-switcher", undefined);
	});
}
