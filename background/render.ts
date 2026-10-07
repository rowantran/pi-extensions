/** Display-only rendering for background custom messages; safe to import without the worker extension. */
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const NOTICE_RENDER_MAX_OUTPUT_LINES = 5;

/** Keep notices compact: the first line, up to five output lines, and a hidden-line count. */
export const renderBackgroundMessage: MessageRenderer = (message, _options, theme) => {
	const content = typeof message.content === "string" ? message.content : "";
	const [first = "", ...output] = content.split("\n");
	const visibleOutput = output.slice(0, NOTICE_RENDER_MAX_OUTPUT_LINES);
	const hiddenLines = output.length - visibleOutput.length;
	const lines = [
		`  ${theme.fg("accent", "● ")}${theme.fg("muted", first)}`,
		...visibleOutput.map((line) => `    ${theme.fg("dim", line || " ")}`),
	];
	if (hiddenLines > 0) {
		lines.push(`    ${theme.fg("dim", `(+ ${hiddenLines} ${hiddenLines === 1 ? "line" : "lines"})`)}`);
	}
	return new Text(lines.join("\n"), 0, 0);
};
