import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { lazyRows, renderRows } from "../compact-tools.ts";

const { getThemeByName } = await import(new URL(
	"./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent"),
));

initTheme("dark", false);
const widths = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 16, 24, 40, 80, 120];
const red = (text) => `\x1b[31m${text}\x1b[0m`;
const link = (text, end = "\x1b\\") => `\x1b]8;;https://example.com/a?q=b${end}${text}\x1b]8;;${end}`;

function measured(getRows) {
	let layouts = 0;
	const component = lazyRows(getRows, (rows, width) => {
		layouts++;
		for (const row of rows) {
			assert.equal(typeof row.prefix, "string");
			assert.equal(typeof row.content, "string");
			assert.equal(typeof row.continuation, "string");
			assert.equal(typeof row.truncate, "boolean");
		}
		return renderRows(rows, width);
	});
	return { component, layouts: () => layouts };
}

const fixtures = [
	[],
	[{ prefix: "", content: "" }],
	[{ prefix: "┌─ ", content: "" }, { prefix: "└─ ", content: "", truncate: true }],
	[{ prefix: "│  ", content: "\n\n" }, { prefix: "", content: "\t a\r\nb\n" }],
	[{ prefix: "┌─ ", content: "one two three four five\nnext line\n", continuation: "│  " }],
	[{ prefix: "long prefix ", content: "words wrap or truncate", continuation: "" }],
	[{ prefix: "x", content: "long content", continuation: "long continuation " }],
	[{ prefix: red("┌─ "), content: red("styled words and\nmore words") }],
	[{ prefix: link("🔗 "), content: link("a hyperlink that wraps 👩🏽‍💻 over lines") }],
	[{ prefix: red("e\u0301界 "), content: red("combining e\u0301, wide 界, emoji 👩🏽‍💻 🇳🇿 and ✈️") }],
	[{ prefix: "🙂 ", content: "👨‍👩‍👧‍👦 🇺🇸 👍🏽 e\u0301 中文", continuation: red("│  ") }],
	[{ prefix: red("└─ "), content: link("ANSI and OSC8 truncation 界 👩🏽‍💻", "\x07"), truncate: true }],
	[{ prefix: "", content: red("👨‍👩‍👧‍👦 e\u0301") + link(" linked text"), truncate: true }],
];

for (const [index, fixture] of fixtures.entries()) {
	test(`cached rows exactly match uncached ANSI/Unicode layout, fixture ${index}`, () => {
		let builds = 0;
		const h = measured(() => {
			builds++;
			// Recreate both row objects and functions each frame: identity is not a cache key.
			return fixture.map((row) => ({
				...row,
				prefix: () => row.prefix,
				content: () => row.content,
				...(row.continuation === undefined ? {} : { continuation: () => row.continuation }),
			}));
		});
		let previousWidth;
		for (const width of [...widths, ...widths.toReversed()]) {
			const expected = renderRows(fixture, width);
			const before = h.layouts();
			const lines = h.component.render(width);
			assert.deepEqual(lines, expected, `width ${width}`);
			assert.strictEqual(h.component.render(width), lines, "unchanged frame reuses expensive layout");
			assert.equal(h.layouts(), before + (width === previousWidth ? 0 : 1));
			h.component.invalidate();
			assert.deepEqual(h.component.render(width), expected, "invalidation preserves exact output");
			assert.notStrictEqual(h.component.render(width), lines, "invalidation clears the layout cache");
			previousWidth = width;
		}
		assert.equal(builds, widths.length * 2 * 4, "row descriptions are rebuilt on every frame");
	});
}

test("all dynamic values run once per render, on hits, misses, resize, and invalidation", () => {
	let content = "live content that wraps into several lines";
	let builds = 0;
	const calls = { prefix: 0, content: 0, continuation: 0, tail: 0 };
	const order = [];
	const value = (name, text) => () => { calls[name]++; order.push(name); return text(); };
	const h = measured(() => {
		builds++;
		return [
			{
				prefix: value("prefix", () => red("┌─ ")),
				content: value("content", () => content),
				continuation: value("continuation", () => "│  "),
			},
			{ prefix: "└─ ", content: value("tail", () => "unchanged tail"), truncate: true },
		];
	});
	const frame = (width, expectedLayouts) => {
		order.length = 0;
		const expected = renderRows([
			{ prefix: red("┌─ "), content, continuation: "│  " },
			{ prefix: "└─ ", content: "unchanged tail", truncate: true },
		], width);
		assert.deepEqual(h.component.render(width), expected);
		assert.equal(h.layouts(), expectedLayouts);
		assert.deepEqual(calls, { prefix: builds, content: builds, continuation: builds, tail: builds });
		assert.deepEqual(order, ["prefix", "content", "continuation", "tail"]);
	};
	frame(24, 1);
	frame(24, 1);
	content = "updated timer: 2s";
	frame(24, 2);
	frame(24, 2);
	frame(1, 3);
	frame(0, 4);
	h.component.invalidate();
	frame(0, 5);
	frame(0, 5);
});

test("side-effecting dynamic values are not called twice on a layout miss", () => {
	let prefixCalls = 0, contentCalls = 0, continuationCalls = 0;
	const h = measured(() => [{
		prefix: () => `p${++prefixCalls} `,
		content: () => `tick ${++contentCalls}`,
		continuation: () => `c${++continuationCalls} `,
	}]);
	for (let frame = 1; frame <= 4; frame++) {
		assert.deepEqual(h.component.render(40), renderRows([
			{ prefix: `p${frame} `, content: `tick ${frame}`, continuation: `c${frame} ` },
		], 40));
		assert.equal(prefixCalls, frame);
		assert.equal(contentCalls, frame);
		assert.equal(continuationCalls, frame);
		assert.equal(h.layouts(), frame);
	}
});

test("default continuation uses the resolved prefix's visible width, not its string length", () => {
	let prefix = red("👩🏽‍💻 e\u0301界 ");
	const content = "several words to wrap across continuation rows";
	const h = measured(() => [{ prefix: () => prefix, content }]);
	for (const next of [prefix, link("界 "), red("e\u0301 "), "", "\x1b[31m"]) {
		prefix = next;
		for (const width of widths) {
			const explicit = { prefix, content, continuation: " ".repeat(visibleWidth(prefix)) };
			assert.deepEqual(h.component.render(width), renderRows([explicit], width));
			assert.deepEqual(h.component.render(width), renderRows([{ prefix, content }], width));
		}
	}
});

test("cache compares resolved strings and flags, including row order/count and in-place mutations", () => {
	const rows = [
		{ prefix: "a ", content: "first long content", continuation: "  " },
		{ prefix: "b ", content: "second long content", continuation: "  ", truncate: true },
	];
	const h = measured(() => rows);
	let expectedLayouts = 0;
	const miss = () => {
		const before = h.layouts();
		assert.deepEqual(h.component.render(16), renderRows(rows, 16));
		assert.equal(h.layouts(), ++expectedLayouts);
		assert.equal(h.layouts(), before + 1);
		assert.deepEqual(h.component.render(16), renderRows(rows, 16));
		assert.equal(h.layouts(), expectedLayouts);
	};
	miss();
	rows[0].prefix = "c "; miss();
	rows[0].content = "changed content"; miss();
	rows[0].continuation = "│ "; miss();
	rows[0].truncate = true; miss();
	rows.reverse(); miss();
	rows.push({ prefix: "", content: "" }); miss();
	rows.pop(); miss();
	rows.splice(0); miss();
	rows.push({ prefix: "", content: "", truncate: false }); miss();
	// Omitted and false truncation, and an implicit and explicit empty continuation, are equivalent.
	delete rows[0].truncate;
	rows[0].continuation = "";
	assert.deepEqual(h.component.render(16), renderRows(rows, 16));
	assert.equal(h.layouts(), expectedLayouts);
});

test("field boundaries cannot collide through concatenation or delimiter characters", () => {
	for (const delimiter of ["", "|", "\0", "\n", "\x1b[0m"]) {
		let rows = [{ prefix: `a${delimiter}b`, content: "c", continuation: "", truncate: true }];
		const h = measured(() => rows);
		assert.deepEqual(h.component.render(12), renderRows(rows, 12));
		rows = [{ prefix: "a", content: `b${delimiter}c`, continuation: "", truncate: true }];
		assert.deepEqual(h.component.render(12), renderRows(rows, 12));
		assert.equal(h.layouts(), 2, `distinct fields must miss even for delimiter ${JSON.stringify(delimiter)}`);
		rows = [{ prefix: "a", content: "b", continuation: `${delimiter}c`, truncate: true }];
		assert.deepEqual(h.component.render(12), renderRows(rows, 12));
		assert.equal(h.layouts(), 3, "continuation changes matter even for truncated rows");
	}
});

test("theme, expansion, and live result changes rebuild descriptions without freezing settled output", () => {
	let theme = getThemeByName("dark");
	let expanded = false, status = "running", summary = "Running…", hiddenLines = 0;
	let builds = 0;
	const rows = () => [
		{ prefix: theme.fg(status === "running" ? "dim" : "success", "┌─ "), content: theme.bold("A long tool heading 👩🏽‍💻 界"), truncate: !expanded },
		{ prefix: theme.fg("dim", "└─ "), continuation: "   ", content: theme.fg("toolOutput", summary), truncate: !expanded },
		...(hiddenLines ? [{ prefix: "   ", content: theme.fg("muted", `(+ ${hiddenLines} lines)`), truncate: true }] : []),
	];
	const h = measured(() => { builds++; return rows(); });
	const frame = (width) => {
		const lines = h.component.render(width);
		assert.deepEqual(lines, renderRows(rows(), width));
		assert.strictEqual(h.component.render(width), lines);
	};
	for (const width of widths) {
		frame(width);
		summary = "Running… 2s"; frame(width);
		status = "success"; summary = "Completed a long result with combining e\u0301 and wide 界"; hiddenLines = 2; frame(width);
		// A settled result can still change; there is no status-based whole-output cache.
		summary = "Updated completed result"; hiddenLines = 3; frame(width);
		theme = getThemeByName("light"); h.component.invalidate(); frame(width);
		expanded = true; h.component.invalidate(); frame(width);
		expanded = false; hiddenLines = 0; status = "running"; summary = "Running…";
		theme = getThemeByName("dark"); h.component.invalidate();
	}
	assert.equal(builds, widths.length * 6 * 2);
	assert.equal(h.layouts(), widths.length * 6);
});

test("failed layout does not publish a partial cache entry", () => {
	let fail = false, content = "old", layouts = 0;
	const component = lazyRows(() => [{ prefix: "", content }], (rows, width) => {
		layouts++;
		if (fail) throw new Error("layout failed");
		return renderRows(rows, width);
	});
	const old = component.render(20);
	content = "new"; fail = true;
	assert.throws(() => component.render(20), /layout failed/);
	content = "old";
	assert.strictEqual(component.render(20), old, "last successful frame is still cached");
	content = "new"; fail = false;
	assert.deepEqual(component.render(20), renderRows([{ prefix: "", content }], 20));
	assert.equal(layouts, 3);
});
