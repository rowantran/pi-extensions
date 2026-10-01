import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withCompactCodemodeRendering } from "./codemode/render.ts";

/**
 * Register Pi's codemode tool with the compact tree renderer.
 * Pi skips its replaceable built-in `codemode` extension when another extension registers the
 * tool. Disable the built-in (`"-builtin:codemode"` in settings.json `extensions`) to silence the
 * startup warning about the replacement.
 */
export default function codemodeCompact(pi: ExtensionAPI): void {
	createCodemodeExtension()(withCompactCodemodeRendering(pi));
}
