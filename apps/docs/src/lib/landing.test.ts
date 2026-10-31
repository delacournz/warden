import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { plainText } from "@/components/rich-text";
import { type Claim, type Clip, type Faq, LANDING } from "./landing.data";

/**
 * The landing is a list of claims about the CLI, and the CLI moves without reading it. These tests hold the copy to
 * the code: each command and flag it names is in the warden skill (which `skill-coverage.test.ts` holds to the real
 * CLI), each number to the constant it quotes, each source and link to a file that exists.
 */

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const DOCS = join(REPO, "apps", "docs");

const EVERYTHING = plainText(JSON.stringify(LANDING));

/**
 * The text the copy sets as code, where a `warden <word>` is a command and not prose ("warden hands each one…"):
 * backtick spans, sample lines, command chips, the first prompt and the feature points (which name commands bare).
 */
const CODE = [
	...[...JSON.stringify(LANDING).matchAll(/`([^`]+)`/g)].map((m) => m[1] as string),
	...[...JSON.stringify(LANDING).matchAll(/"command":"([^"]+)"/g)].map((m) => m[1] as string),
	...LANDING.ON_THE_DEVICE.features.flatMap((f) => [...f.points, f.title, f.sample?.code ?? ""]),
	LANDING.FIRST_PROMPT.prompt,
].join("\n");

function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? filesUnder(path) : [path];
	});
}

const SKILL = filesUnder(join(REPO, "skills", "warden"))
	.map((file) => readFileSync(file, "utf-8"))
	.join("\n");

const read = (path: string) => readFileSync(join(REPO, path), "utf-8");

const CLAIMS: readonly Claim[] = [
	...LANDING.WHAT_YOU_GET.cards,
	...LANDING.SAFE_BY_DEFAULT.cards,
	...LANDING.USE_CASES.cards,
];
const CLIPS: readonly Clip[] = LANDING.DEVICE_CONTROL.clips;
const FAQS: readonly Faq[] = LANDING.FAQ.items;

/** Every `warden <command>` the copy names, command word only (`warden ui press` → `ui`). */
function commands(text: string): string[] {
	return [...new Set([...text.matchAll(/\bwarden ([a-z][a-z0-9-]*)/g)].map((m) => m[1] as string))];
}

/** Every long flag the copy names. npm's own flags are short, so every `--flag` here is warden's. */
function flags(text: string): string[] {
	return [...new Set([...text.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map((m) => m[0]))];
}

describe("the landing's claims", () => {
	test("the code scan sees the commands and flags (a scan that finds nothing passes everything)", () => {
		expect(commands(CODE)).toEqual(expect.arrayContaining(["claim", "ui", "e2e", "dev", "golden", "affected"]));
		expect(flags(CODE)).toEqual(expect.arrayContaining(["--physical", "--adopt", "--json", "--bad"]));
	});

	test("every warden command it names is in the warden skill", () => {
		const missing = commands(CODE).filter((command) => !SKILL.includes(`warden ${command}`));
		expect(missing).toEqual([]);
	});

	test("every flag it names is in the warden skill", () => {
		const missing = flags(CODE).filter((flag) => !SKILL.includes(flag));
		expect(missing).toEqual([]);
	});

	test("every claim's proof is a file in the repo", () => {
		const sources = [...CLAIMS, ...CLIPS, ...FAQS].flatMap((item) => (item.proof ? [item.proof.source] : []));
		expect(sources.filter((source) => !existsSync(join(REPO, source)))).toEqual([]);
	});

	test("every Read more goes to a docs page that exists", () => {
		const hrefs = [
			...CLAIMS.map((c) => c.href),
			...CLIPS.map((c) => c.href),
			...LANDING.ON_THE_DEVICE.features.map((f) => f.link.to),
		];
		const page = (href: string) =>
			[`${href}.mdx`, `${href}/index.mdx`].some((file) => existsSync(join(DOCS, "content", "docs", file)));
		expect(hrefs.filter((href) => !page(href))).toEqual([]);
	});

	test("every clip has its video and poster", () => {
		const missing = CLIPS.flatMap((clip) => [`${clip.src}.mp4`, `${clip.src}.jpg`]).filter(
			(file) => !existsSync(join(DOCS, "public", file))
		);
		expect(missing).toEqual([]);
	});

	test("clip ids are unique (they key the tabs)", () => {
		const ids = CLIPS.map((clip) => clip.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

/** A number the copy quotes, the file that sets it and how it is written there. */
const NUMBERS: readonly { copy: string; source: string; code: RegExp }[] = [
	{ copy: "30 min", source: "packages/core/src/config.defaults.ts", code: /DEFAULT_TTL_MS = 30 \* 60_000/ },
	{
		copy: "5 min for a bare agent",
		source: "packages/core/src/config.defaults.ts",
		code: /BARE_CLAIM_AGENT_TTL_MS = 5 \* 60_000/,
	},
	{
		copy: "heartbeat every 30 s",
		source: "packages/core/src/config.defaults.ts",
		code: /HEARTBEAT_INTERVAL_MS = 30_000/,
	},
	{ copy: "within about 90 s", source: "packages/core/src/liveness.ts", code: /LOST_HEARTBEATS = 3\b/ },
	{ copy: "leased for 20 min", source: "packages/core/src/config.defaults.ts", code: /DEFAULT_IDLE_MS = 20 \* 60_000/ },
	{ copy: "--wait 30m", source: "apps/cli/src/claim-flags.ts", code: /DEFAULT_WAIT = "30m"/ },
	{
		copy: "3.7 s clone plus 11.9 s boot",
		source: "packages/core/src/golden/golden.ts",
		code: /146–239 s vs clone 3\.7 s \+ boot 11\.9 s/,
	},
	{ copy: "set aside for 24 h", source: "packages/core/src/claim.ts", code: /QUARANTINE_TTL_MS = 24 \* 60 \* 60_000/ },
	{ copy: "binds loopback", source: "packages/core/src/netproxy/proxy.ts", code: /const LOOPBACK = "127\.0\.0\.1"/ },
];

describe("the numbers it quotes", () => {
	for (const { copy, source, code } of NUMBERS) {
		test(`"${copy}" is in the copy and matches ${source}`, () => {
			expect(EVERYTHING).toContain(copy);
			expect(read(source)).toMatch(code);
		});
	}
});

describe("what it never says", () => {
	test("names no other tool the copy was modelled on", () => {
		expect(EVERYTHING).not.toMatch(/simlock|callstack|agent-device/i);
	});

	test("never says warden listens on the network or sandboxes agents", () => {
		expect(EVERYTHING).not.toMatch(/HTTP API|web console|gateway|sandboxes your/i);
	});
});
