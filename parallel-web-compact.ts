import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import parallelWebExtension from "../npm/node_modules/@parallel-web/pi-extension/dist/index.js";
import { withCompactToolRendering } from "./compact-tools.ts";

/**
 * Load Parallel's extension through the generic compact-tool decorator.
 * The package's own extension entry is disabled in settings.json to avoid
 * registering its tools a second time without the decorator.
 */
export default function parallelWebCompact(pi: ExtensionAPI): void {
	parallelWebExtension(withCompactToolRendering(pi));
}
