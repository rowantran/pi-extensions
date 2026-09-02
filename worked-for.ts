import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENTRY_TYPE = "worked-for";
const LEGACY_WORKED_FOR_CONTENT = "workedFor";
const NO_TOP_SPACER_PATCH = Symbol.for("worked-for.no-top-spacer");

type WorkedForData = {
	elapsedSeconds: number;
};

type CustomEntryInstance = {
	entry: { customType: string };
	render(width: number): string[];
};

type CustomEntryPrototype = {
	render(width: number): string[];
};

function formatDuration(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function isLegacyWorkedForContent(content: unknown): boolean {
	return (
		typeof content === "object" &&
		content !== null &&
		(content as Record<string, unknown>)[LEGACY_WORKED_FOR_CONTENT] === true
	);
}

async function removeWorkedForTopSpacer(): Promise<void> {
	// Pi currently inserts a Spacer(1) before every custom transcript entry and
	// does not expose a spacing option. Patch only this entry type's rendered
	// output, leaving every other custom entry unchanged.
	//
	// The CLI is bundled at dist/bundle/cli.js, while the component remains in
	// dist/modes/... . Resolve the package entry first instead of assuming that
	// the component is relative to process.argv[1].
	const componentPath = await resolveCustomEntryComponentPath();
	const module = (await import(pathToFileURL(componentPath).href)) as {
		CustomEntryComponent: { prototype: object };
	};
	const prototype = module.CustomEntryComponent.prototype as CustomEntryPrototype;
	const patchState = prototype as unknown as Record<PropertyKey, unknown>;
	if (patchState[NO_TOP_SPACER_PATCH]) return;

	const originalRender = prototype.render;
	prototype.render = function (this: CustomEntryInstance, width: number): string[] {
		const lines = originalRender.call(this, width);
		if (this.entry.customType === ENTRY_TYPE && lines[0] === "") {
			return lines.slice(1);
		}
		return lines;
	};
	patchState[NO_TOP_SPACER_PATCH] = true;
}

async function resolveCustomEntryComponentPath(): Promise<string> {
	const relativeComponentPath = "modes/interactive/components/custom-entry.js";
	const candidates: string[] = [];

	try {
		const packageEntry = await import.meta.resolve("@earendil-works/pi-coding-agent");
		if (packageEntry.startsWith("file:")) {
			candidates.push(join(dirname(fileURLToPath(packageEntry)), relativeComponentPath));
		}
	} catch {
		// Fall back to the CLI location for older runtimes or package layouts.
	}

	if (process.argv[1]) {
		const cliPath = realpathSync(process.argv[1]);
		const cliDirectory = dirname(cliPath);
		candidates.push(
			join(cliDirectory, relativeComponentPath),
			join(cliDirectory, "..", relativeComponentPath),
		);
	}

	const componentPath = candidates.find((candidate) => existsSync(candidate));
	if (componentPath) return componentPath;

	throw new Error(
		`Could not locate Pi's custom-entry component. Tried: ${candidates.join(", ")}`,
	);
}

export default async function workedFor(pi: ExtensionAPI): Promise<void> {
	await removeWorkedForTopSpacer();

	let startedAt: number | undefined;

	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as WorkedForData;
		return new Text(
			theme.fg("dim", `Worked for ${formatDuration(data.elapsedSeconds)}`),
			1,
			0,
		);
	});

	let ticker: ReturnType<typeof setInterval> | undefined;

	const stopTicker = () => {
		if (ticker === undefined) return;
		clearInterval(ticker);
		ticker = undefined;
	};

	pi.on("agent_start", (_event, ctx) => {
		startedAt ??= performance.now();
		if (!ctx.hasUI || ticker !== undefined) return;

		const updateWorkingMessage = () => {
			if (startedAt === undefined) return;
			const elapsedSeconds = Math.max(
				0,
				Math.floor((performance.now() - startedAt) / 1000),
			);
			ctx.ui.setWorkingMessage(
				ctx.ui.theme.fg(
					"dim",
					`Working... (${formatDuration(elapsedSeconds)})`,
				),
			);
		};

		updateWorkingMessage();
		ticker = setInterval(updateWorkingMessage, 1000);
	});

	pi.on("agent_settled", (_event, ctx) => {
		stopTicker();
		if (ctx.hasUI) ctx.ui.setWorkingMessage();
		if (startedAt === undefined) return;

		const elapsedSeconds = Math.max(
			0,
			Math.round((performance.now() - startedAt) / 1000),
		);
		startedAt = undefined;
		pi.appendEntry(ENTRY_TYPE, { elapsedSeconds } satisfies WorkedForData);
	});

	pi.on("session_shutdown", () => {
		stopTicker();
	});

	// Hide and filter timing content created by the previous implementation.
	pi.registerMarkdownTransformer((markdown, context) => {
		if (
			context.messageType === "assistant" &&
			/^_Worked for (?:(?:\d+h )?\d+m )?\d+s_$/.test(markdown)
		) {
			return "";
		}
		return markdown;
	});
	pi.on("context", (event) => ({
		messages: event.messages.map((message) => {
			if (message.role !== "assistant") return message;
			return {
				...message,
				content: message.content.filter(
					(content) => !isLegacyWorkedForContent(content),
				),
			};
		}),
	}));
}
