#!/usr/bin/env bun
/**
 * The agent's Bash gate, run as a `PreToolUse` hook in the sandbox (`bun bash-gate.ts <bin>`). Claude Code's own
 * `Bash(<bin> *)` rule denies any compound command with a segment it does not cover, so `U=<udid>; <bin> … --udid
 * $U` fails under `--permission-mode dontAsk` and the agent gives up. This gate allows a command when every
 * segment is the tool's CLI, a variable assignment, a shell keyword, or a read-only utility, and denies anything
 * else (another device tool, an interpreter, `xargs`, backticks) with a reason the agent can act on.
 */

export type Gate = { allow: true } | { allow: false; reason: string };

/** Commands that cannot drive a device: text processing, waiting, navigation, output. */
const READ_ONLY = new Set([
	"[",
	"[[",
	"awk",
	"base64",
	"basename",
	"cat",
	"cd",
	"column",
	"cut",
	"date",
	"dirname",
	"echo",
	"egrep",
	"expr",
	"export",
	"false",
	"fgrep",
	"grep",
	"head",
	"jq",
	"ls",
	"nl",
	"printf",
	"pwd",
	"read",
	"rg",
	"sed",
	"seq",
	"sleep",
	"sort",
	"tail",
	"tee",
	"test",
	"tr",
	"true",
	"uniq",
	"wc",
]);

/** Leading words that only introduce the real command. */
const PREFIX_KEYWORDS = new Set(["!", "do", "else", "elif", "if", "then", "until", "while", "time"]);
/** Segments that are pure syntax. */
const SYNTAX_ONLY = new Set(["done", "fi", "esac", "{", "}"]);
/** `for x in …` / `case … in`: the header names no command. */
const LOOP_HEADS = new Set(["for", "case", "in"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECT = /^\d*(>>?|<)(&\d+)?$|^\d*(>>?|<)\S+$|^&>/;

type Scan = { segments: string[][]; substitutions: string[]; backtick: boolean };

/** Paren depth change of one unquoted character. */
const depthDelta = (ch: string | undefined): number => (ch === "(" ? 1 : ch === ")" ? -1 : 0);

/** Index of the `)` closing a `$(` that starts at `open` (depth- and quote-aware); -1 when unbalanced. */
function closingParen(s: string, open: number): number {
	let depth = 0;
	let quote: string | undefined;
	for (let i = open; i < s.length; i++) {
		const ch = s[i];
		if (quote !== undefined) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') quote = ch;
		depth += depthDelta(ch);
		if (ch === ")" && depth === 0) return i;
	}
	return -1;
}

/** Mutable state of one `scan`: finished segments, the segment and word being built, the open quote. */
type ScanState = Scan & { words: string[]; word: string; inWord: boolean; quote?: string };

function endWord(st: ScanState): void {
	if (st.inWord) st.words.push(st.word);
	st.word = "";
	st.inWord = false;
}

function endSegment(st: ScanState): void {
	endWord(st);
	if (st.words.length > 0) st.segments.push(st.words);
	st.words = [];
}

function addChar(st: ScanState, ch: string): void {
	st.word += ch;
	st.inWord = true;
}

/** `$(…)` at `i`: records its body and returns the index of its `)`; marks the scan unsafe when unbalanced. */
function substitution(st: ScanState, command: string, i: number): number {
	const close = closingParen(command, i + 1);
	if (close === -1) {
		st.backtick = true;
		return command.length;
	}
	st.substitutions.push(command.slice(i + 2, close));
	addChar(st, "$SUB");
	return close;
}

/** A separator outside quotes: `;`, `|`, `&` (not a redirect's `2>&1` / `&>`), newline, `(`, `)`. */
function isSeparator(st: ScanState, command: string, i: number): boolean {
	const ch = command[i] ?? "";
	if (!/[;&|\n()]/.test(ch)) return false;
	return !(ch === "&" && (/[<>]$/.test(st.word) || command[i + 1] === ">"));
}

/** One character outside single quotes; returns the index to continue after. */
function step(st: ScanState, command: string, i: number): number {
	const ch = command[i] ?? "";
	if (ch === "\\") {
		addChar(st, command[i + 1] ?? "");
		return i + 1;
	}
	if (ch === "`") st.backtick = true;
	else if (ch === "$" && command[i + 1] === "(") return substitution(st, command, i);
	else if (st.quote === '"') {
		if (ch === '"') st.quote = undefined;
		else addChar(st, ch);
	} else if (ch === "'" || ch === '"') {
		st.quote = ch;
		st.inWord = true;
	} else if (isSeparator(st, command, i)) endSegment(st);
	else if (/\s/.test(ch)) endWord(st);
	else addChar(st, ch);
	return i;
}

/** Splits a command line into segments of words on `;`, `&&`, `||`, `|`, `&`, newlines and `(`/`)`, outside quotes. */
function scan(command: string): Scan {
	const st: ScanState = { segments: [], substitutions: [], backtick: false, words: [], word: "", inWord: false };
	for (let i = 0; i < command.length; i++) {
		const ch = command[i] ?? "";
		if (st.quote === "'") {
			if (ch === "'") st.quote = undefined;
			else addChar(st, ch);
		} else i = step(st, command, i);
	}
	endSegment(st);
	return { segments: st.segments, substitutions: st.substitutions, backtick: st.backtick };
}

/** Index of the first word after assignments, prefix keywords and redirections. */
function firstCommandIndex(words: readonly string[]): number {
	let i = 0;
	for (let w = words[i]; w !== undefined; w = words[i]) {
		if (ASSIGNMENT.test(w) || PREFIX_KEYWORDS.has(w)) i += 1;
		else if (REDIRECT.test(w)) i += /^\d*(>>?|<)$/.test(w) ? 2 : 1;
		else break;
	}
	return i;
}

/** The command a segment runs (basename); undefined for pure syntax or a bare assignment. */
function commandOf(words: readonly string[]): string | undefined {
	const first = words[firstCommandIndex(words)];
	if (first === undefined || SYNTAX_ONLY.has(first) || LOOP_HEADS.has(first)) return undefined;
	return first.slice(first.lastIndexOf("/") + 1);
}

/** Every segment (and every `$(…)` inside) must run `bin` or something that cannot drive a device. */
export function gateCommand(command: string, bin: string): Gate {
	const { segments, substitutions, backtick } = scan(command);
	const deny = (what: string): Gate => ({
		allow: false,
		reason: `The bench allows only \`${bin}\` and read-only shell utilities (${[...READ_ONLY].join(", ")}) in Bash; ${what} is not allowed. Use \`${bin}\` for everything that touches the device.`,
	});
	if (backtick) return deny("backtick or unbalanced command substitution");
	for (const words of segments) {
		const cmd = commandOf(words);
		if (cmd === undefined || cmd === bin || READ_ONLY.has(cmd)) continue;
		return deny(`\`${cmd}\``);
	}
	for (const inner of substitutions) {
		const gate = gateCommand(inner, bin);
		if (!gate.allow) return gate;
	}
	return { allow: true };
}

/** The decision for one hook input; undefined when it is not a Bash call (no opinion). */
export function decide(input: unknown, bin: string): Gate | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	if (Reflect.get(input, "tool_name") !== "Bash") return undefined;
	const toolInput: unknown = Reflect.get(input, "tool_input");
	const command = typeof toolInput === "object" && toolInput !== null ? Reflect.get(toolInput, "command") : undefined;
	return typeof command === "string" ? gateCommand(command, bin) : undefined;
}

/** What the hook prints: a `PreToolUse` permission decision. */
export function hookOutput(gate: Gate): string {
	return JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: gate.allow ? "allow" : "deny",
			permissionDecisionReason: gate.allow ? "bench: the tool's CLI and read-only shell utilities" : gate.reason,
		},
	});
}

if (import.meta.main) {
	const bin = process.argv[2] ?? "";
	let input: unknown;
	try {
		input = JSON.parse(await Bun.stdin.text());
	} catch {
		input = undefined;
	}
	const gate = bin === "" ? undefined : decide(input, bin);
	if (gate !== undefined) process.stdout.write(`${hookOutput(gate)}\n`);
}
