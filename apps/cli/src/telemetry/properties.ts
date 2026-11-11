/**
 * The pure half of warden's telemetry: what one `command` event says, worked out from a commander command
 * and nothing else.
 *
 * Every function here is a filter. What may leave the machine is decided in this file, and the CLI
 * reference's Telemetry section and `/privacy` describe exactly what these return, so a new property is a
 * change here, in those two pages and in their tests together. Flag **values**, positional arguments, test
 * and suite names, bundle ids, udids, paths, URLs and error messages have no way through: a function that
 * returned them would have to be written, and reviewed, on purpose.
 */

export type Platform = "ios" | "android";

/** Every property a `command` event carries: the whole of it, since `tracker.ts` builds the event as this type. */
export type WardenCommandProperties = {
	command: string;
	flags: string[];
	json: boolean;
	platform?: Platform;
	suites?: number;
	errorKind?: string;
	exitCode?: number;
};

/**
 * The words `/privacy` uses for each property. A `Record` over `keyof WardenCommandProperties`, so adding a
 * property without saying what to call it is a type error, and the docs site's `privacy.test.ts` requires each
 * phrase to appear in the policy: a property cannot ship undisclosed.
 */
export const PROPERTY_DISCLOSURE: Record<keyof WardenCommandProperties, string> = {
	command: "its name",
	flags: "names, never the values, of the flags",
	json: "whether it ran with --json",
	platform: "whether it was for iOS or Android",
	suites: "how many e2e suites it was asked to run",
	errorKind: "class name of any error",
	exitCode: "its exit code",
};

type OptionLike = { long?: string; negate: boolean; attributeName(): string };

/** The part of a commander `Command` this file reads, so a test needs no program. */
export type CommandLike = {
	name(): string;
	parent: CommandLike | null;
	args: readonly string[];
	options: readonly OptionLike[];
	opts(): Record<string, unknown>;
	getOptionValueSource(key: string): string | undefined;
	getOptionValue(key: string): unknown;
};

/** `ui press` from the action command of `warden ui press @e3`: every name up to, and not including, the program. */
export function commandPathOf(command: CommandLike): string {
	const names: string[] = [];
	for (let node: CommandLike | null = command; node?.parent; node = node.parent) names.unshift(node.name());
	return names.join(" ");
}

/**
 * The long names of the flags typed on the command line (`--json`, `--no-verify`) and never their values.
 * A default and an environment variable are not "typed", so `getOptionValueSource` has to say `cli`.
 * `--x` and `--no-x` share an attribute and the value says which was typed.
 */
export function flagsSetOnCli(command: CommandLike): string[] {
	const flags = command.options.flatMap((option) => {
		if (!option.long) return [];
		const key = option.attributeName();
		if (command.getOptionValueSource(key) !== "cli") return [];
		const value = command.getOptionValue(key);
		return (option.negate ? value === false : value !== false) ? [option.long] : [];
	});
	return flags.sort();
}

const PLATFORM_POSITIONAL: ReadonlySet<string> = new Set([
	"claim",
	"run",
	"dev",
	"devices",
	"batch",
	"repack",
	"app fingerprint",
	"app ensure",
]);

function asPlatform(value: unknown): Platform | undefined {
	return value === "ios" || value === "android" ? value : undefined;
}

/** `ios` or `android` from `--platform` or, for the commands that take it positionally, the first argument. Anything else is dropped. */
export function platformOf(command: CommandLike): Platform | undefined {
	const flag = asPlatform(command.opts().platform);
	if (flag) return flag;
	return PLATFORM_POSITIONAL.has(commandPathOf(command)) ? asPlatform(command.args[0]) : undefined;
}

/** How many suites `e2e` / `affected` was asked for: a count, never the names. */
export function suitesOf(command: CommandLike): number | undefined {
	const path = commandPathOf(command);
	return path === "e2e" || path === "affected" ? command.args.length : undefined;
}

/** The error's class name and never its message, which names paths, udids and bundle ids. */
export function errorKindOf(error: unknown): string {
	if (!(error instanceof Error)) return "unknown";
	const name = error.constructor.name;
	return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error";
}
