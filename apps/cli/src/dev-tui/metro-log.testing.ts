export class DevTuiMetroLogTesting {
	private sgr(code: string, text: string, reset = "0") {
		return `${ESC}[${code}m${text}${ESC}[${reset}m`;
	}

	bold(text: string) {
		return this.sgr("1", text, "22");
	}

	dim(text: string) {
		return this.sgr("2", text, "22");
	}

	green(text: string) {
		return this.sgr("32", text, "39");
	}

	red(text: string) {
		return this.sgr("31", text, "39");
	}

	inverseBold(color: string, text: string) {
		return `${ESC}[${color}m${ESC}[7m${ESC}[1m${text}${ESC}[22m${ESC}[27m${ESC}[39m`;
	}

	private progress(ratio: number, done: number, total: number) {
		const filled = Math.floor(ratio * 16);
		const bar = `${ESC}[32m${ESC}[42m${"▓".repeat(filled)}${ESC}[49m${ESC}[39m${ESC}[47m${ESC}[37m${"░".repeat(16 - filled)}${ESC}[39m${ESC}[49m`;
		return `${this.bold(`iOS ${this.dim("node_modules/expo-router/")}`)}${this.bold("entry.js")} ${bar}${this.bold(` ${(100 * ratio).toFixed(1).padStart(4)}% `)}${this.dim(`(${String(done).padStart(String(total).length)}/${total})`)}`;
	}

	progressLines(steps: Array<[number, number]>, total: number) {
		return steps.map(([ratio, done]) => `\r${ESC}[2K${this.progress(ratio, done, total)}`).join("");
	}
}

export const devTuiMetroLogTesting = new DevTuiMetroLogTesting();
/**
 * Metro / Expo CLI PTY output as `expo start` writes it (SGR colours, `\r\x1b[K` progress overwrites), built from the
 * message strings in `@expo/cli` 57 `MetroTerminalReporter` and `metro` 0.87 `TerminalReporter` / `reporting`.
 */

const ESC = String.fromCharCode(27);

/** `ERROR`, `WARN`, `INFO` badges as `reporting.logError` etc. print them (`"%s %s"`). */
export const ERROR_BADGE = devTuiMetroLogTesting.inverseBold("31", " ERROR ");
export const WARN_BADGE = devTuiMetroLogTesting.inverseBold("33", " WARN ");
export const INFO_BADGE = devTuiMetroLogTesting.inverseBold("36", " INFO ");

/** Progress overwritten in place, then the success line; two HMR rebuilds after. */
export const BUNDLE_OK = [
	devTuiMetroLogTesting.progressLines(
		[
			[0, 0],
			[0.366, 4790],
			[0.9, 11900],
		],
		13200
	),
	`\r${ESC}[2K${devTuiMetroLogTesting.green("iOS Bundled ")}${devTuiMetroLogTesting.dim("1432ms")}${ESC}[0m${devTuiMetroLogTesting.dim(" node_modules/expo-router/entry.js (13200 modules)")}\r\n`,
	`${devTuiMetroLogTesting.green("iOS Bundled ")}${devTuiMetroLogTesting.dim("38ms")}${ESC}[0m${devTuiMetroLogTesting.dim(" node_modules/expo-router/entry.js (1 module)")}\r\n`,
].join("");

const SYNTAX_FRAME = [
	"",
	"  10 |   return (",
	"  11 |     <View>",
	"> 12 |       <Text>hello</Text",
	"     |                     ^",
	"  13 |     </View>",
	"  14 |   );",
].join("\r\n");

/** A bundle that fails on a syntax error: `Bundling failed`, then the Babel message and code frame via `logError`. */
export const BUNDLE_SYNTAX_ERROR = [
	devTuiMetroLogTesting.progressLines(
		[
			[0, 0],
			[0.2, 600],
		],
		3000
	),
	`\r${ESC}[2K${devTuiMetroLogTesting.red("iOS Bundling failed ")}${devTuiMetroLogTesting.dim("842ms")}${ESC}[0m${devTuiMetroLogTesting.dim(" node_modules/expo-router/entry.js (1 module)")}\r\n`,
	`${ERROR_BADGE} SyntaxError: /work/example/src/app/index.tsx: Unexpected token, expected "," (12:20)\r\n${SYNTAX_FRAME}\r\n`,
	"\r\n",
].join("");

/** Expo's `Unable to resolve "x" from "y"`, the code frame lifted from Metro's message and the import stack. */
export const BUNDLE_MISSING_MODULE = [
	devTuiMetroLogTesting.progressLines([[0.1, 300]], 3000),
	`\r${ESC}[2K${devTuiMetroLogTesting.red("iOS Bundling failed ")}${devTuiMetroLogTesting.dim("311ms")}${ESC}[0m${devTuiMetroLogTesting.dim(" node_modules/expo-router/entry.js (2 modules)")}\r\n`,
	`Unable to resolve "./missing-screen" from "src/app/index.tsx"\r\n`,
	[
		"  1 | import { View } from 'react-native';",
		"> 2 | import Missing from './missing-screen';",
		"    |                      ^",
		"  3 |",
	].join("\r\n"),
	"\r\n\r\n",
	"Import stack:\r\n\r\n",
	` src/app/index.tsx\r\n | import "./missing-screen"\r\n\r\n`,
	` src/app/_layout.tsx\r\n | import "./index"\r\n\r\n`,
].join("");

/** A bundler warning, an app `console.error` forwarded to Metro with a stack, and a Fast Refresh note. */
export const RUNTIME_LOGS = [
	`${WARN_BADGE} the transform cache was reset.\r\n`,
	`${devTuiMetroLogTesting.bold("iOS ")}${devTuiMetroLogTesting.inverseBold("31", " ERROR ")} Warning: Cannot update a component while rendering a different component\r\n`,
	"    at Home (src/app/index.tsx:20:5)\r\n",
	"    at RootLayout (src/app/_layout.tsx:8:3)\r\n",
	`${devTuiMetroLogTesting.bold("iOS ")}${devTuiMetroLogTesting.inverseBold("37", " LOG ")} hello from the app\r\n`,
	`${INFO_BADGE} Fast Refresh enabled\r\n`,
	devTuiMetroLogTesting.dim("Waiting on http://localhost:8101\r\n"),
].join("");
