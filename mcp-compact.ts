import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import mcpAdapter from "pi-mcp-adapter";
import { withCompactToolRendering } from "./compact-tools.ts";

/**
 * Load the MCP adapter through the generic compact-tool decorator.
 * The package's own extension entry is disabled in settings.json to avoid
 * registering its tools a second time with the adapter's renderer.
 */
export default function mcpCompact(pi: ExtensionAPI): void {
	mcpAdapter(withCompactToolRendering(pi));
}
