import { afterAll, describe, expect, test } from "bun:test";
import type { CommandUnknownOpts } from "@commander-js/extra-typings";
import { buildProgram } from "./command";
import { COMMANDS } from "./commands/registry";
import { wardenTools } from "./mcp/tools";
import { RULE_MD, SKILL_FILES, SKILL_PATHS } from "./skill";
import { SKILL_OMITTED_COMMANDS, SKILL_OMITTED_OPTIONS } from "./skill-coverage.data";
import { testContext } from "./testing";

/** The skill as shipped (embedded copies), file by file. */
const FILES: ReadonlyArray<{ path: string; text: string }> = [
	...SKILL_PATHS.map((path) => ({ path, text: SKILL_FILES[path] })),
	{ path: "rules/warden.md", text: RULE_MD },
];

/** Inline `code` spans and fenced lines (shell comments dropped): where the skill names commands. */
function codeSpans(text: string): string[] {
	const fenced = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].flatMap((m) =>
		(m[1] ?? "").split("\n").map((line) => line.replace(/(^|\s)#\s.*$/, ""))
	);
	const inline = [...text.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");
	return [...fenced, ...inline];
}

const SPANS = FILES.map((f) => ({ ...f, spans: codeSpans(f.text) }));
const CORPUS = FILES.map((f) => f.text).join("\n");

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
const words = (path: string) => path.split(" ");

/** Visible subcommands (no hidden workers, no commander's `help`). */
const visible = (cmd: CommandUnknownOpts) =>
	cmd
		.createHelp()
		.visibleCommands(cmd)
		.filter((sub) => sub.name() !== "help");

type Node = { path: string; cmd: CommandUnknownOpts };

function walk(cmd: CommandUnknownOpts, prefix: string[]): Node[] {
	return visible(cmd).flatMap((sub) => {
		const path = [...prefix, sub.name()];
		return [{ path: path.join(" "), cmd: sub }, ...walk(sub, path)];
	});
}

const ctx = testContext([]);
afterAll(() => ctx.cleanup());
const program = buildProgram(await Promise.all(COMMANDS.map((entry) => entry.load())), [], ctx);
const NODES = walk(program, []);
const PATHS = new Set(NODES.map((n) => n.path));

/**
 * `warden a b c` is documented when a code span holds its last two words in a row (`warden claim`, `gesture swipe`,
 * `heap diff`), or when a file that names `warden a b` has a code span starting with `c` (ui.md's verb table).
 */
function documented(path: string): boolean {
	const w = words(path);
	const pair = w.length === 1 ? `warden ${w[0]}` : w.slice(-2).join(" ");
	const pairRe = new RegExp(`(^|[^\\w-])${escapeRe(pair)}(?![\\w-])`);
	if (SPANS.some((f) => f.spans.some((s) => pairRe.test(s)))) return true;
	if (w.length === 1) return false;
	const parent = `warden ${w.slice(0, -1).join(" ")}`;
	const leafRe = new RegExp(`^${escapeRe(w.at(-1) ?? "")}(?![\\w-])`);
	return SPANS.some((f) => f.text.includes(parent) && f.spans.some((s) => leafRe.test(s.trim())));
}

/** Long options a user can pass (`--help` / `--json` are everywhere and say nothing). */
function options(cmd: CommandUnknownOpts): string[] {
	return cmd
		.createHelp()
		.visibleOptions(cmd)
		.flatMap((o) => (o.long && o.long !== "--help" && o.long !== "--json" ? [o.long] : []));
}

const HINT =
	"document it in skills/warden (SKILL.md quick reference or the matching references/*.md), or list it in apps/cli/src/skill-coverage.data.ts with why agents never need it — see .claude/rules/skill-sync.md";

describe("the warden skill covers the CLI", () => {
	test("every visible command and subcommand is in the skill or deliberately omitted", () => {
		const missing = [...PATHS].filter((p) => !documented(p) && !(p in SKILL_OMITTED_COMMANDS));
		expect(missing, `undocumented: ${HINT}`).toEqual([]);
	});

	test("every visible option is in the skill or deliberately omitted", () => {
		const missing = NODES.flatMap((n) =>
			options(n.cmd)
				.filter((o) => !new RegExp(`${escapeRe(o)}(?![\\w-])`).test(CORPUS))
				.map((o) => `${n.path} ${o}`)
		).filter((key) => !(key in SKILL_OMITTED_OPTIONS));
		expect(missing, `undocumented: ${HINT}`).toEqual([]);
	});

	test("every `warden mcp` tool is named in the skill", () => {
		const missing = wardenTools()
			.map((t) => t.name)
			.filter((name) => {
				const family = name.replace(/_[a-z]+$/, "_*");
				return !CORPUS.includes(name) && !CORPUS.includes(family);
			});
		expect(missing).toEqual([]);
	});

	test("omissions name commands and options that still exist (drop them when the CLI does)", () => {
		const optionKeys = new Set(NODES.flatMap((n) => options(n.cmd).map((o) => `${n.path} ${o}`)));
		expect(Object.keys(SKILL_OMITTED_COMMANDS).filter((p) => !PATHS.has(p))).toEqual([]);
		expect(Object.keys(SKILL_OMITTED_OPTIONS).filter((k) => !optionKeys.has(k))).toEqual([]);
	});

	test("omissions stay omitted: a documented command or option comes off the list", () => {
		expect(Object.keys(SKILL_OMITTED_COMMANDS).filter(documented)).toEqual([]);
		expect(
			Object.keys(SKILL_OMITTED_OPTIONS).filter((k) =>
				new RegExp(`${escapeRe(k.split(" ").at(-1) ?? "")}(?![\\w-])`).test(CORPUS)
			)
		).toEqual([]);
	});

	test("every `warden <command>` the skill names exists (renamed or removed commands fail here)", () => {
		const names = new Set(COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
		const unknown = SPANS.flatMap((f) =>
			f.spans.flatMap((s) =>
				[...s.matchAll(/(?:^|[\s(;|&])warden ([a-z][\w-]*)/g)]
					.map((m) => m[1] ?? "")
					.filter((name) => !names.has(name))
					.map((name) => `${f.path}: warden ${name}`)
			)
		);
		expect(unknown).toEqual([]);
	});

	test("`warden <command> <sub>` names a real subcommand when the command takes no arguments of its own", () => {
		const unknown = SPANS.flatMap((f) =>
			f.spans.flatMap((s) =>
				[...s.matchAll(/(?:^|[\s(;|&])warden ([a-z][\w-]*) ([a-z][\w-]*)/g)].flatMap((m) => {
					const cmd = program.commands.find((c) => c.name() === m[1] || c.aliases().includes(m[1] ?? ""));
					if (!cmd || cmd.commands.length === 0 || cmd.registeredArguments.length > 0) return [];
					const sub = cmd.commands.some((c) => c.name() === m[2] || c.aliases().includes(m[2] ?? ""));
					return sub ? [] : [`${f.path}: warden ${m[1]} ${m[2]}`];
				})
			)
		);
		expect(unknown).toEqual([]);
	});
});
