import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyMetroLines, type MetroLogEntry, parseMetroLog, renderTerminalLines } from "./metro-log";
import { BUNDLE_MISSING_MODULE, BUNDLE_OK, BUNDLE_SYNTAX_ERROR, RUNTIME_LOGS } from "./metro-log.testing";

const kinds = (entries: MetroLogEntry[]) => entries.map((e) => e.kind);

describe("renderTerminalLines", () => {
	test("strips SGR and OSC 8 sequences", () => {
		const esc = String.fromCharCode(27);
		const link = `${esc}]8;;https://expo.dev${esc}\\docs${esc}]8;;${esc}\\`;
		expect(renderTerminalLines(`${esc}[31mred${esc}[39m ${link}\r\n`)).toEqual(["red docs"]);
	});

	test("a carriage return overwrites from column 0", () => {
		expect(renderTerminalLines("loading 10%\rloading 90%\r\ndone\r\n")).toEqual(["loading 90%", "done"]);
		expect(renderTerminalLines("abcdef\rXY\r\n")).toEqual(["XYcdef"]);
	});

	test("erase-line and cursor-up remove a spinner line", () => {
		const esc = String.fromCharCode(27);
		expect(renderTerminalLines(`spin\r\n${esc}[2K${esc}[1Anext\r\n`)).toEqual(["next"]);
		expect(renderTerminalLines(`a\r\nb${esc}[2K\rc\r\n`)).toEqual(["a", "c"]);
	});

	test("keeps an unterminated last line", () => {
		expect(renderTerminalLines("one\r\ntwo")).toEqual(["one", "two"]);
	});
});

describe("parseMetroLog", () => {
	test("successful bundle: progress collapses to its final state, then bundle_done", () => {
		const entries = parseMetroLog(BUNDLE_OK);
		expect(kinds(entries)).toEqual(["bundle_done", "bundle_done"]);
		expect(entries[0]).toMatchObject({
			kind: "bundle_done",
			platform: "ios",
			ms: 1432,
			modules: 13200,
			entry: "node_modules/expo-router/entry.js",
		});
		expect(entries[1]).toMatchObject({ kind: "bundle_done", ms: 38, modules: 1 });
	});

	test("progress lines kept on their own rows become one bundle_start", () => {
		const rows = [
			"iOS node_modules/expo-router/entry.js ▓▓░░░░░░░░░░░░░░  12.0% ( 360/3000)",
			"iOS node_modules/expo-router/entry.js ▓▓▓▓▓▓░░░░░░░░░░  40.0% (1200/3000)",
		];
		const entries = classifyMetroLines(rows);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ kind: "bundle_start", platform: "ios", progress: 0.4 });
	});

	test("syntax error folds the message and code frame into bundle_failed", () => {
		const entries = parseMetroLog(BUNDLE_SYNTAX_ERROR);
		expect(kinds(entries)).toEqual(["bundle_failed"]);
		const [failed] = entries;
		expect(failed).toMatchObject({
			kind: "bundle_failed",
			platform: "ios",
			file: "/work/example/src/app/index.tsx",
			line: 12,
			col: 20,
			message: 'Unexpected token, expected ","',
		});
		expect(failed && "codeFrame" in failed && failed.codeFrame).toEqual([
			"  10 |   return (",
			"  11 |     <View>",
			"> 12 |       <Text>hello</Text",
			"     |                     ^",
			"  13 |     </View>",
			"  14 |   );",
		]);
	});

	test("unresolved module: file from the message, line and column from the code frame, import stack folded in", () => {
		const entries = parseMetroLog(BUNDLE_MISSING_MODULE);
		expect(kinds(entries)).toEqual(["bundle_failed"]);
		const [failed] = entries;
		expect(failed).toMatchObject({
			kind: "bundle_failed",
			file: "src/app/index.tsx",
			line: 2,
			col: 22,
			message: 'Unable to resolve "./missing-screen" from "src/app/index.tsx"',
		});
		expect(failed?.text).toContain("Import stack:");
		expect(failed?.text).toContain("src/app/_layout.tsx");
	});

	test("a bundle after a failed one starts a new entry", () => {
		const entries = parseMetroLog(`${BUNDLE_SYNTAX_ERROR}${BUNDLE_OK}`);
		expect(kinds(entries)).toEqual(["bundle_failed", "bundle_done", "bundle_done"]);
	});

	test("warn, app error with stack, app log and info", () => {
		const entries = parseMetroLog(RUNTIME_LOGS);
		expect(kinds(entries)).toEqual(["warn", "error", "info", "info", "info"]);
		const error = entries[1];
		expect(error).toMatchObject({
			kind: "error",
			platform: "ios",
			message: "Warning: Cannot update a component while rendering a different component",
		});
		expect(error?.text).toContain("at RootLayout");
	});

	test("Metro-only output (community CLI): BUNDLE progress and unresolved module", () => {
		const entries = parseMetroLog(
			[
				"BUNDLE  ./index.js ▓▓▓▓▓▓▓▓░░░░░░░░ 50% (5/10)",
				"ERROR  Error: Unable to resolve module ./nope from /work/app/App.tsx: ./nope could not be found within the project or in these directories:",
				"  node_modules",
				"",
			].join("\n")
		);
		expect(kinds(entries)).toEqual(["bundle_start", "error"]);
		expect(entries[1]).toMatchObject({ kind: "error", file: "/work/app/App.tsx" });
	});

	test("stamps ts on every entry when given", () => {
		const entries = parseMetroLog(BUNDLE_OK, { ts: 1234 });
		expect(entries.every((e) => e.ts === 1234)).toBe(true);
		expect(parseMetroLog(BUNDLE_OK).every((e) => e.ts === undefined)).toBe(true);
	});

	test("the recorded expo start fixture parses without errors and without QR noise", () => {
		const bytes = readFileSync(join(import.meta.dir, "fixtures", "expo-start.bin"));
		const entries = parseMetroLog(new Uint8Array(bytes));
		expect(entries.length).toBeGreaterThan(3);
		expect(kinds(entries)).not.toContain("bundle_failed");
		expect(kinds(entries)).not.toContain("error");
		expect(entries.some((e) => e.text.includes("Starting Metro Bundler"))).toBe(true);
		expect(entries.some((e) => /^[▀▄█ ]+$/.test(e.text))).toBe(false);
		expect(entries.some((e) => e.kind === "hmr" && e.text.includes("Reloading apps"))).toBe(true);
	});
});
