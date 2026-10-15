import { isContextOverflow } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isBackgroundWaitEnding } from "./background/wait.ts";

export default function (pi: ExtensionAPI) {
	let run: { sessionId: string; leafId: string | null; signal?: AbortSignal; outcome?: "error" | "cancelled" } | undefined;
	const reset = () => { run = undefined; };
	pi.on("session_start", reset);
	pi.on("session_tree", reset);
	pi.on("session_shutdown", reset);

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// Retries and queued continuations share a logical run until agent_settled.
		run ??= { sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId() };
		run.signal = ctx.signal;
		run.outcome = undefined;
	});

	pi.on("session_compact_failed", (event) => {
		if (run && (event.aborted || event.reason === "overflow")) run.outcome = event.aborted ? "cancelled" : "error";
	});

	pi.on("agent_settled", (event, ctx) => {
		const current = run;
		reset();
		if (!current || ctx.mode !== "tui" || current.sessionId !== ctx.sessionManager.getSessionId()) return;
		if (current.signal?.aborted || current.outcome === "cancelled" || ("aborted" in event && event.aborted === true)) return;

		const branch = ctx.sessionManager.getBranch();
		const checkpoint = current.leafId === null ? -1 : branch.findIndex((entry) => entry.id === current.leafId);
		// A removed checkpoint cannot prove that an old wait belongs to this run.
		const tail = current.leafId !== null && checkpoint < 0 ? [] : branch.slice(checkpoint + 1);
		const omitted = new Map<string, boolean>();
		for (const entry of tail) if (entry.type === "context_edit") omitted.set(entry.targetId, entry.replacement === null);
		// Ignore Pi's omitted failures, but keep delivered input and successful calls
		// even if compaction or an extension later removes them from model context.
		const messages = tail.flatMap((entry) => entry.type === "message"
			&& !(omitted.get(entry.id) && entry.message.role === "assistant"
				&& (entry.message.stopReason === "error" || entry.message.stopReason === "length")) ? [entry.message] : []);
		const last = messages.findLast((message) => message.role === "assistant");
		if (last?.stopReason === "aborted") return;
		let failed = current.outcome === "error" || ("error" in event && event.error === true);
		const lastRaw = tail.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!failed && lastRaw?.type === "message" && lastRaw.message.role === "assistant" && omitted.get(lastRaw.id)
			&& (lastRaw.message.stopReason === "error" || lastRaw.message.stopReason === "length")) {
			// With no later reply, an omitted retry ended in cancellation. Overflow
			// without a completed compaction can instead be an unreported failure.
			const overflow = lastRaw.message.stopReason === "length" || isContextOverflow(lastRaw.message);
			const compacted = tail.slice(tail.indexOf(lastRaw) + 1).some((entry) => entry.type === "compaction");
			if (!overflow || compacted) return;
			failed = true;
		}
		if (failed || last?.stopReason === "error" || !isBackgroundWaitEnding(messages)) {
			process.stdout.write("\x07");
		}
	});
}
