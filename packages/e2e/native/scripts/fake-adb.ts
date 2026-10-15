#!/usr/bin/env bun
/**
 * Fake `adb` for session tests: `fake-adb.ts -s <serial> shell` reads sentinel-wrapped command
 * lines from stdin, `(<cmd>) 2>&1 </dev/null; echo "__WDN_<id>_$?__"`, and answers like a device shell.
 * Never spawns a real adb. Scripted commands (the text inside the parentheses):
 *
 *   echo <text>        print text + newline, exit 0
 *   raw <text>         print text with no trailing newline, exit 0
 *   fail <n>           exit code n
 *   sleep <ms>         wait, then exit 0 (a never-finishing command is `sleep 600000`)
 *   exit [n]           the whole adb process dies with code n (no sentinel)
 *   crash-after <text> print text, then the process dies with code 1
 *   split <text>       print text, then write the sentinel in two chunks 25 ms apart
 *   pid                print this process id
 *   decoy              print a sentinel-shaped line for a different id, then exit 0
 *   big <n>            print n 'x' characters + newline
 *   args               print the argv this fake was started with
 *
 * Canned output: with FAKE_ADB_RULES=<json file> of `{ "rules": [{ "match": "<prefix>", "stdout"?: "<text>",
 * "stdoutFile"?: "<path, raw bytes>", "code"?: n }] }` the first rule whose `match` is a prefix of the shell
 * command wins over the scripted commands above. One-shot host mode, `fake-adb.ts -s <serial> <args…>` with
 * anything but `shell` (e.g. `exec-out uiautomator dump /dev/tty`, `exec-out screencap -p`, `install -r x.apk`),
 * answers from the same rules matched against `<args…>`; `exec-out screencap -p` defaults to a tiny PNG header.
 *
 * Env: FAKE_ADB_DIE_ON_START=1 exits immediately (a device that is gone).
 */
import { readFileSync } from "node:fs";

if (process.env.FAKE_ADB_DIE_ON_START === "1") process.exit(1);

type Rule = { match: string; stdout?: string; stdoutFile?: string; code?: number };
const rulesPath = process.env.FAKE_ADB_RULES;
const rules: Rule[] = rulesPath ? (JSON.parse(readFileSync(rulesPath, "utf8")) as { rules: Rule[] }).rules : [];
const ruleFor = (text: string): Rule | undefined => rules.find((r) => text.startsWith(r.match));
const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const WRAPPED = /^\((.*)\) 2>&1 <\/dev\/null; echo "(__WDN_.+_)\$\?__"$/;
const enc = new TextEncoder();
const write = (text: string): void => {
	process.stdout.write(enc.encode(text));
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Outcome = { code: number; die?: number; split?: boolean };

function ruleBytes(rule: Rule): Uint8Array {
	if (rule.stdoutFile) return new Uint8Array(readFileSync(rule.stdoutFile));
	return enc.encode(rule.stdout ?? "");
}

/** One-shot host invocation (`exec-out …`, `install …`): answer from the rules and exit. */
function hostMode(args: string[]): never {
	const text = args.join(" ");
	const rule = ruleFor(text);
	if (rule) {
		process.stdout.write(ruleBytes(rule));
		process.exit(rule.code ?? 0);
	}
	if (text === "exec-out screencap -p") process.stdout.write(PNG_HEADER);
	process.exit(0);
}

const argvRest = process.argv.slice(2);
const afterSerial = argvRest[0] === "-s" ? argvRest.slice(2) : argvRest;
if (afterSerial[0] !== undefined && afterSerial[0] !== "shell") hostMode(afterSerial);

async function execute(cmd: string): Promise<Outcome> {
	const canned = ruleFor(cmd);
	if (canned) {
		process.stdout.write(ruleBytes(canned));
		return { code: canned.code ?? 0 };
	}
	const space = cmd.indexOf(" ");
	const verb = space < 0 ? cmd : cmd.slice(0, space);
	const rest = space < 0 ? "" : cmd.slice(space + 1);
	switch (verb) {
		case "echo":
			write(`${rest}\n`);
			return { code: 0 };
		case "raw":
			write(rest);
			return { code: 0 };
		case "fail":
			return { code: Number(rest) };
		case "sleep":
			await sleep(Number(rest));
			return { code: 0 };
		case "exit":
			return { code: 0, die: rest === "" ? 0 : Number(rest) };
		case "crash-after":
			write(`${rest}\n`);
			return { code: 0, die: 1 };
		case "split":
			write(`${rest}\n`);
			return { code: 0, split: true };
		case "pid":
			write(`${process.pid}\n`);
			return { code: 0 };
		case "decoy":
			write("__WDN_other_0__\n");
			return { code: 0 };
		case "big":
			write(`${"x".repeat(Number(rest))}\n`);
			return { code: 0 };
		case "args":
			write(`${process.argv.slice(2).join(" ")}\n`);
			return { code: 0 };
		default:
			write(`/system/bin/sh: ${verb}: inaccessible or not found\n`);
			return { code: 127 };
	}
}

let buffer = "";
let chain: Promise<void> = Promise.resolve();

async function handle(line: string): Promise<void> {
	const match = WRAPPED.exec(line);
	if (!match) {
		write(`fake-adb: unrecognised line: ${line}\n`);
		return;
	}
	const outcome = await execute(match[1] ?? "");
	if (outcome.die !== undefined) process.exit(outcome.die);
	const prefix = match[2] ?? "";
	if (outcome.split) {
		write(prefix.slice(0, Math.ceil(prefix.length / 2)));
		await sleep(25);
		write(`${prefix.slice(Math.ceil(prefix.length / 2))}${outcome.code}__\n`);
		return;
	}
	write(`${prefix}${outcome.code}__\n`);
}

for await (const chunk of Bun.stdin.stream()) {
	buffer += new TextDecoder().decode(chunk);
	let newline = buffer.indexOf("\n");
	while (newline >= 0) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		chain = chain.then(() => handle(line));
		newline = buffer.indexOf("\n");
	}
}
await chain;

export {};
