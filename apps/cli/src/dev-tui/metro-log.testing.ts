/**
 * Metro / Expo CLI PTY output as `expo start` writes it (SGR colours, `\r\x1b[K` progress overwrites), built from the
 * message strings in `@expo/cli` 57 `MetroTerminalReporter` and `metro` 0.87 `TerminalReporter` / `reporting`.
 */

const ESC = String.fromCharCode(27);
const sgr = (code: string, text: string, reset = "0") => `${ESC}[${code}m${text}${ESC}[${reset}m`;
const bold = (text: string) => sgr("1", text, "22");
const dim = (text: string) => sgr("2", text, "22");
const green = (text: string) => sgr("32", text, "39");
const red = (text: string) => sgr("31", text, "39");
const inverseBold = (color: string, text: string) =>
	`${ESC}[${color}m${ESC}[7m${ESC}[1m${text}${ESC}[22m${ESC}[27m${ESC}[39m`;

/** `ERROR`, `WARN`, `INFO` badges as `reporting.logError` etc. print them (`"%s %s"`). */
export const ERROR_BADGE = inverseBold("31", " ERROR ");
export const WARN_BADGE = inverseBold("33", " WARN ");
export const INFO_BADGE = inverseBold("36", " INFO ");

const progress = (ratio: number, done: number, total: number) => {
	const filled = Math.floor(ratio * 16);
	const bar = `${ESC}[32m${ESC}[42m${"▓".repeat(filled)}${ESC}[49m${ESC}[39m${ESC}[47m${ESC}[37m${"░".repeat(16 - filled)}${ESC}[39m${ESC}[49m`;
	return `${bold(`iOS ${dim("node_modules/expo-router/")}`)}${bold("entry.js")} ${bar}${bold(` ${(100 * ratio).toFixed(1).padStart(4)}% `)}${dim(`(${String(done).padStart(String(total).length)}/${total})`)}`;
};

const progressLines = (steps: Array<[number, number]>, total: number) =>
	steps.map(([ratio, done]) => `\r${ESC}[2K${progress(ratio, done, total)}`).join("");

/** Progress overwritten in place, then the success line; two HMR rebuilds after. */
export const BUNDLE_OK = [
	progressLines(
		[
			[0, 0],
			[0.366, 4790],
			[0.9, 11900],
		],
		13200
	),
	`\r${ESC}[2K${green("iOS Bundled ")}${dim("1432ms")}${ESC}[0m${dim(" node_modules/expo-router/entry.js (13200 modules)")}\r\n`,
	`${green("iOS Bundled ")}${dim("38ms")}${ESC}[0m${dim(" node_modules/expo-router/entry.js (1 module)")}\r\n`,
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
	progressLines(
		[
			[0, 0],
			[0.2, 600],
		],
		3000
	),
	`\r${ESC}[2K${red("iOS Bundling failed ")}${dim("842ms")}${ESC}[0m${dim(" node_modules/expo-router/entry.js (1 module)")}\r\n`,
	`${ERROR_BADGE} SyntaxError: /work/example/src/app/index.tsx: Unexpected token, expected "," (12:20)\r\n${SYNTAX_FRAME}\r\n`,
	"\r\n",
].join("");

/** Expo's `Unable to resolve "x" from "y"`, the code frame lifted from Metro's message and the import stack. */
export const BUNDLE_MISSING_MODULE = [
	progressLines([[0.1, 300]], 3000),
	`\r${ESC}[2K${red("iOS Bundling failed ")}${dim("311ms")}${ESC}[0m${dim(" node_modules/expo-router/entry.js (2 modules)")}\r\n`,
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
	`${bold("iOS ")}${inverseBold("31", " ERROR ")} Warning: Cannot update a component while rendering a different component\r\n`,
	"    at Home (src/app/index.tsx:20:5)\r\n",
	"    at RootLayout (src/app/_layout.tsx:8:3)\r\n",
	`${bold("iOS ")}${inverseBold("37", " LOG ")} hello from the app\r\n`,
	`${INFO_BADGE} Fast Refresh enabled\r\n`,
	dim("Waiting on http://localhost:8101\r\n"),
].join("");
