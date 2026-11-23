/**
 * Words for a shell that re-parses its command line: the device's `sh` behind `adb shell a b c` (adb joins its
 * arguments with spaces and the device parses the line again), or a host `sh -c` string. Every value that is not a
 * literal goes through `shellQuote`, so it arrives as exactly one word.
 */

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX single-quote a word (`'` becomes `'\''`). Safe words stay bare. */
export function shellQuote(word: string): string {
	if (word === "") return "''";
	if (SAFE_WORD.test(word)) return word;
	return `'${word.replace(/'/g, "'\\''")}'`;
}

/** One shell command line from an argv. */
export function shellCommand(argv: readonly string[]): string {
	return argv.map(shellQuote).join(" ");
}

/**
 * Host argv for `adb … shell <words>`: `prefix` is the adb command up to (not including) `shell`, `words` the device
 * command, one element per word, unquoted. Not for a whole script passed as a single element: that is already a
 * shell line and goes after `"shell"` as it is.
 */
export function adbShellArgv(prefix: readonly string[], words: readonly string[]): string[] {
	return [...prefix, "shell", ...words.map(shellQuote)];
}
