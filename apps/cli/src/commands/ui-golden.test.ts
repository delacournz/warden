import { afterEach, describe, expect, test } from "bun:test";
import { driverFixtures } from "@delacour/warden-driver/testing/driver";
import { uiJsonSchema } from "@delacour/warden-sdk/contracts/ui";
import { uiResultLookup } from "@delacour/warden-sdk/contracts/ui-result";
import { cleanupHarnesses, type Harness, harness, LOGIN, UDID } from "./ui.testing";

afterEach(cleanupHarnesses);
afterEach(() => {
	const problems = schemaProblems.splice(0);
	expect(problems).toEqual([]);
});

/**
 * WSDK-6b golden JSON: every `warden ui` subcommand's `--json` envelope (and exit code) over the fake driver, captured
 * before the commands became SDK ops. The snapshots in `__snapshots__/ui-golden.test.ts.snap` must not change when the
 * logic moves; only `durationMs` (the fake clock) and the temp home are normalised.
 */

const FORM = driverFixtures.snapshotOf([
	driverFixtures.el("window", {
		children: [
			driverFixtures.el("text", { label: "Welcome", id: "welcome" }),
			driverFixtures.el("textfield", {
				label: "Email",
				id: "email",
				value: "a@b.co",
				frame: { x: 0, y: 100, width: 390, height: 44 },
			}),
			driverFixtures.el("button", {
				label: "Sign in",
				id: "sign-in-submit",
				hittable: true,
				frame: { x: 0, y: 150, width: 390, height: 44 },
			}),
			driverFixtures.el("button", {
				label: "Cancel",
				id: "cancel",
				enabled: false,
				frame: { x: 0, y: 200, width: 390, height: 44 },
			}),
			driverFixtures.el("list", { id: "list", frame: { x: 20, y: 300, width: 350, height: 400 } }),
		],
	}),
]);

type Case = {
	name: string;
	/** commands run first (their output is dropped) */
	pre?: string[][];
	argv: string[];
	options?: Parameters<typeof harness>[1];
};

type Captured = { exit: number; stdout: unknown[]; stderr: string[] };

function normalise(h: Harness, text: string): string {
	return text
		.split(h.c.cwd)
		.join("<HOME>")
		.replace(/\bl_[0-9a-f]{12}\b/g, "l_<id>");
}

function stripVolatile(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripVolatile);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, inner]) => [key, key === "durationMs" ? 0 : stripVolatile(inner)])
		);
	}
	return value;
}

/** Every golden success whose `result` has no per-command schema, or does not parse against it. */
const schemaProblems: string[] = [];

function checkResultSchema(doc: unknown): void {
	const envelope = uiJsonSchema.parse(doc);
	if (!envelope.ok) return;
	const schema = uiResultLookup.schemaFor(envelope.command);
	if (schema === undefined) {
		schemaProblems.push(`no result schema for "${envelope.command}"`);
		return;
	}
	const parsed = schema.safeParse(envelope.result);
	if (!parsed.success) schemaProblems.push(`"${envelope.command}" result: ${parsed.error.message}`);
}

async function capture(testCase: Case): Promise<Captured> {
	const h = harness([FORM], { realRecorder: false, ...testCase.options });
	for (const pre of testCase.pre ?? []) await h.run(...pre);
	const exit = await h.run(...testCase.argv, "--json");
	return {
		exit,
		stdout: h.c.stdout.map((line) => {
			try {
				const doc = JSON.parse(normalise(h, line));
				checkResultSchema(doc);
				return stripVolatile(doc);
			} catch {
				return normalise(h, line);
			}
		}),
		stderr: h.c.stderr.map((line) => normalise(h, line)),
	};
}

const SNAP = [["snapshot"]];

const CASES: Case[] = [
	{ name: "status", argv: ["status"] },
	{ name: "close", argv: ["close"] },
	{ name: "close --app", argv: ["close", "--app", "com.example.app"] },
	{ name: "snapshot", argv: ["snapshot"] },
	{ name: "snapshot -i", argv: ["snapshot", "-i"] },
	{ name: "snapshot --depth 1", argv: ["snapshot", "--depth", "1"] },
	{ name: "snapshot --settle", argv: ["snapshot", "--settle"] },
	{ name: "snapshot --depth bad", argv: ["snapshot", "--depth", "x"] },
	{ name: "find id", argv: ["find", "id=email"] },
	{ name: "find role", argv: ["find", "role=button"] },
	{ name: "find none", argv: ["find", "id=nope"] },
	{ name: "find bad selector", argv: ["find", "colour=red"] },
	{ name: "open bundle", argv: ["open", "com.example.app"] },
	{ name: "open relaunch", argv: ["open", "com.example.app", "--relaunch"] },
	{ name: "open url", argv: ["open", "myapp://settings"] },
	{ name: "open metro", argv: ["open", "myapp://x", "--metro", "http://localhost:8081"] },
	{ name: "press ref", pre: SNAP, argv: ["press", "@e4"] },
	{ name: "press ref verify", pre: SNAP, argv: ["press", "@e4", "--verify"] },
	{ name: "press stale ref", pre: [...SNAP, ["snapshot"]], argv: ["press", "@e99"] },
	{ name: "press no snapshot", argv: ["press", "@e4"] },
	{ name: "press selector", argv: ["press", "id=sign-in-submit"] },
	{ name: "press settle", pre: SNAP, argv: ["press", "@e4", "--settle"] },
	{ name: "press missing", argv: ["press", "id=nope"] },
	{ name: "press point", argv: ["press", "120", "340"] },
	{ name: "tap selector", argv: ["tap", "id=sign-in-submit"] },
	{ name: "fill", argv: ["fill", "id=email", "new@x.co"] },
	{ name: "fill no-verify", argv: ["fill", "id=email", "x", "--no-verify"] },
	{ name: "fill secure", argv: ["fill", "id=email", "hunter2hunter2", "--secure"] },
	{ name: "fill usage", argv: ["fill", "id=email"] },
	{ name: "fill point", argv: ["fill", "50", "60", "abc"] },
	{ name: "type", argv: ["type", "hello", "--submit"] },
	{ name: "key", argv: ["key", "enter"] },
	{ name: "key unknown", argv: ["key", "f13"] },
	{ name: "scroll down", argv: ["scroll", "down"] },
	{ name: "scroll amount in", argv: ["scroll", "down", "0.25", "--in", "id=list"] },
	{ name: "scroll until missing", argv: ["scroll", "down", "--until", "id=far", "--max", "2"] },
	{ name: "scroll until present", argv: ["scroll", "down", "--until", "id=email"] },
	{ name: "scroll bad direction", argv: ["scroll", "sideways"] },
	{ name: "alert get", argv: ["alert", "get"] },
	{ name: "alert accept", argv: ["alert", "accept"] },
	{ name: "alert bad", argv: ["alert", "maybe"] },
	{ name: "home", argv: ["home"] },
	{ name: "back", argv: ["back"] },
	{ name: "screen rotate read", argv: ["screen", "rotate"] },
	{ name: "screen rotate set", argv: ["screen", "rotate", "landscape-left"] },
	{ name: "screen rotate bad", argv: ["screen", "rotate", "sideways"] },
	{ name: "screen appearance read", argv: ["screen", "appearance"] },
	{ name: "screen appearance set", argv: ["screen", "appearance", "dark"] },
	{ name: "screen appearance bad", argv: ["screen", "appearance", "blue"] },
	{ name: "screen screenshot default", argv: ["screen", "screenshot"] },
	{ name: "screen screenshot path", argv: ["screen", "screenshot", "out/shot.png"] },
	{ name: "gesture swipe dir", argv: ["gesture", "swipe", "up"] },
	{ name: "gesture swipe points", argv: ["gesture", "swipe", "10", "20", "30", "40"] },
	{ name: "gesture swipe from", argv: ["gesture", "swipe", "left", "--from", "id=list"] },
	{ name: "gesture swipe bad", argv: ["gesture", "swipe", "sideways"] },
	{ name: "gesture longpress", argv: ["gesture", "longpress", "id=email", "700"] },
	{ name: "gesture longpress point", argv: ["gesture", "longpress", "100", "200"] },
	{ name: "gesture pinch screen", argv: ["gesture", "pinch", "2"] },
	{ name: "gesture pinch target", argv: ["gesture", "pinch", "id=list", "0.5"] },
	{ name: "gesture pinch bad", argv: ["gesture", "pinch", "1"] },
	{ name: "gesture rotate", argv: ["gesture", "rotate", "45"] },
	{ name: "gesture rotate target", argv: ["gesture", "rotate", "id=list", "-45"] },
	{ name: "gesture rotate bad", argv: ["gesture", "rotate", "0"] },
	{ name: "gesture path one", argv: ["gesture", "path", "--path", "10,20 100,200 150,50"] },
	{ name: "gesture path two", argv: ["gesture", "path", "--path", "1,1 9,9", "--path", "5,5 8,8"] },
	{ name: "gesture path none", argv: ["gesture", "path"] },
	{ name: "wait visible", argv: ["wait", "id=email"] },
	{ name: "wait timeout", argv: ["wait", "id=continue", "--timeout", "250"] },
	{ name: "wait absent", argv: ["wait", "absent", "text=Loading"] },
	{ name: "wait absent present", argv: ["wait", "absent", "id=email", "--timeout", "250"] },
	{ name: "wait text", argv: ["wait", "text", "Welcome"] },
	{ name: "wait stable", argv: ["wait", "stable", "300"] },
	{ name: "wait bad", argv: ["wait", "colour=red"] },
	{ name: "is true", argv: ["is", "id=email", "visible"] },
	{ name: "is false", argv: ["is", "id=cancel", "enabled"] },
	{ name: "is missing", argv: ["is", "id=nope", "visible"] },
	{ name: "is bad state", argv: ["is", "id=email", "shiny"] },
	{ name: "get text", argv: ["get", "id=email", "value"] },
	{ name: "get frame", argv: ["get", "id=sign-in-submit", "frame"] },
	{ name: "get count", argv: ["get", "role=button", "count"] },
	{ name: "get missing", argv: ["get", "id=nope", "text"] },
	{ name: "get bad prop", argv: ["get", "id=email", "colour"] },
	{ name: "eval no metro", argv: ["eval", "1 + 1"] },
	{ name: "tree no metro", argv: ["tree"] },
	{ name: "logs no metro", argv: ["logs"] },
	{ name: "logs mark", argv: ["logs", "mark", "x"] },
	{ name: "network no metro", argv: ["network"] },
	{ name: "reload no metro", argv: ["reload"] },
	{
		name: "video start fake",
		argv: ["screen", "video", "start"],
		options: {
			video: { spawnDetached: () => ({ pid: 4242 }), kill: () => undefined, pidAlive: () => true },
		},
	},
	{ name: "video stop idle", argv: ["screen", "video", "stop"] },
	{ name: "video bad action", argv: ["screen", "video", "pause"] },
];

describe("warden ui golden --json", () => {
	for (const testCase of CASES) {
		test(testCase.name, async () => {
			expect(await capture(testCase)).toMatchSnapshot();
		});
	}

	test("a login-only tree still works for the legacy fixture", async () => {
		const h = harness([driverFixtures.snapshotOf(LOGIN)]);
		expect(await h.run("find", "id=email", "--json")).toBe(0);
		expect(UDID.length).toBeGreaterThan(0);
	});
});
