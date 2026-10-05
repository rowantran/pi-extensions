import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface WorkflowConfig {
	interactive: string;
	implementation: string;
	classifier: string | null;
}

export const DEFAULT_CLASSIFIER = "typesafe/jev-latest";
export const configPath = () => join(getAgentDir(), "workflow.json");

export function modelRef(value: unknown): [string, string] {
	if (typeof value !== "string" || !/^[^\s/]+\/\S+$/.test(value)) {
		throw new Error("Use an exact provider/model ID, for example isara/claude-opus-5-5.");
	}
	const slash = value.indexOf("/");
	return [value.slice(0, slash), value.slice(slash + 1)];
}

export function readConfig(): WorkflowConfig {
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(readFileSync(configPath(), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error("Configure routing first: /workflow models <interactive-provider/model> <implementation-provider/model>");
		}
		throw new Error(`Cannot read ${configPath()}: ${String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)
		|| Object.keys(value).some((key) => !["interactive", "implementation", "classifier"].includes(key))) {
		throw new Error(`Invalid workflow configuration in ${configPath()}. Expected interactive, implementation, and optional classifier.`);
	}
	modelRef(value.interactive);
	modelRef(value.implementation);
	const classifier = value.classifier === undefined ? DEFAULT_CLASSIFIER : value.classifier;
	if (classifier !== null) modelRef(classifier);
	return { interactive: value.interactive as string, implementation: value.implementation as string, classifier: classifier as string | null };
}

export function physicalModel(ctx: ExtensionContext, ref: string) {
	const model = ctx.modelRegistry.find(...modelRef(ref));
	if (!model || model.api === "pi-virtual") throw new Error(`Workflow model ${ref} must be an installed physical model.`);
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`Workflow model ${ref} has no configured credentials. Use /login for its provider.`);
	return model;
}

export function writeModels(ctx: ExtensionContext, interactive: string, implementation: string): WorkflowConfig {
	physicalModel(ctx, interactive);
	physicalModel(ctx, implementation);
	let classifier: string | null = DEFAULT_CLASSIFIER;
	try {
		readFileSync(configPath());
		classifier = readConfig().classifier;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const config = { interactive, implementation, classifier };
	const file = configPath();
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
	return config;
}
