import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ModelSwitcherConfig {
	interactive: string;
	implementation: string;
	classifier: string | null;
}

export const DEFAULT_CLASSIFIER = "typesafe/jev-latest";
export const configPath = () => join(getAgentDir(), "model-switcher.json");

export function modelRef(value: unknown): [string, string] {
	if (typeof value !== "string" || !/^[^\s/]+\/\S+$/.test(value)) {
		throw new Error("Use an exact provider/model ID, for example isara/claude-opus-5-5.");
	}
	const slash = value.indexOf("/");
	return [value.slice(0, slash), value.slice(slash + 1)];
}

function loadConfig(): ModelSwitcherConfig | undefined {
	// Read the old filename only when the new one is absent. Never overwrite it
	// during startup or hide errors in an existing new configuration.
	for (const file of [configPath(), join(getAgentDir(), "workflow.json")]) {
		let value: Record<string, unknown>;
		try {
			value = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw new Error(`Cannot read ${file}: ${String(error)}`);
		}
		if (!value || typeof value !== "object" || Array.isArray(value)
			|| Object.keys(value).some((key) => !["interactive", "implementation", "classifier"].includes(key))) {
			throw new Error(`Invalid model-switcher configuration in ${file}. Expected interactive, implementation, and optional classifier.`);
		}
		modelRef(value.interactive);
		modelRef(value.implementation);
		const classifier = value.classifier === undefined ? DEFAULT_CLASSIFIER : value.classifier;
		if (classifier !== null) modelRef(classifier);
		return { interactive: value.interactive as string, implementation: value.implementation as string, classifier: classifier as string | null };
	}
}

export function readConfig(): ModelSwitcherConfig {
	const config = loadConfig();
	if (!config) throw new Error(`Create ${configPath()} with interactive, implementation, and classifier provider/model IDs.`);
	return config;
}

export function physicalModel(ctx: ExtensionContext, ref: string) {
	const model = ctx.modelRegistry.find(...modelRef(ref));
	if (!model || model.api === "pi-virtual") throw new Error(`Model switcher model ${ref} must be an installed physical model.`);
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`Model switcher model ${ref} has no configured credentials. Use /login for its provider.`);
	return model;
}
