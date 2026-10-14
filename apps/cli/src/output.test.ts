import { describe, expect, test } from "bun:test";
import { formatTable, heading, note, plural, reportError, success, warn } from "./output";
import { scriptedUi, type TestContext, testContext } from "./testing";

describe("formatTable", () => {
	test("pads columns", () => {
		expect(formatTable(["A", "BB"], [["xxx", "y"]])).toBe("A    BB\nxxx  y");
	});
});

describe("formatTable width", () => {
	test("shrinks the flex column to fit, keeping its end", () => {
		const text = formatTable(["ID", "PATH"], [["a", "/very/long/path/to/Some.app"]], undefined, {
			width: 16,
			flex: { column: 1, keep: "end" },
		});
		expect(text).toBe("ID  PATH\na   …to/Some.app");
	});

	test("keeps the start by default and never shrinks below the header", () => {
		const text = formatTable(["ID", "LABEL"], [["a", "abcdefghijklmnop"]], undefined, {
			width: 6,
			flex: { column: 1 },
		});
		expect(text).toBe("ID  LABEL\na   abcd…");
	});

	test("fits → untouched", () => {
		expect(formatTable(["A", "BB"], [["xxx", "y"]], undefined, { width: 80, flex: { column: 1 } })).toBe(
			"A    BB\nxxx  y"
		);
	});
});

describe("say", () => {
	const lines = (rich: boolean, fn: (ctx: TestContext) => void): { out: string[]; err: string[] } => {
		const ctx = testContext([], { ui: scriptedUi({ rich }) });
		try {
			fn(ctx);
			return { out: ctx.stdout, err: ctx.stderr };
		} finally {
			ctx.cleanup();
		}
	};

	test("piped: bare lines, no heading", () => {
		const { out, err } = lines(false, (ctx) => {
			heading(ctx, "ls", "2 leases");
			reportError(ctx, "claim", "nope");
			warn(ctx, "careful");
			success(ctx, "done");
			note(ctx, "fyi");
		});
		expect(out).toEqual([]);
		expect(err).toEqual(["warden claim: nope", "careful", "done", "fyi"]);
	});

	test("terminal: heading + glyphs, all on stderr", () => {
		const { out, err } = lines(true, (ctx) => {
			heading(ctx, "ls", "2 leases");
			heading(ctx, "gc");
			reportError(ctx, "claim", "nope");
			warn(ctx, "careful");
			success(ctx, "done");
			note(ctx, "fyi");
		});
		expect(out).toEqual([]);
		expect(err).toEqual(["warden ls  2 leases", "warden gc", "✗ warden claim: nope", "! careful", "✓ done", "· fyi"]);
	});

	test("plural", () => {
		expect(plural(1, "lease")).toBe("1 lease");
		expect(plural(0, "lease")).toBe("0 leases");
		expect(plural(2, "match", "matches")).toBe("2 matches");
	});
});
