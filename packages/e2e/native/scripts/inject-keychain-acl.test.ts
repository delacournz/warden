import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInjectChannel } from "../../src/driver/ios/inject";
import { INJECT_DYLIB, main } from "./inject";

/**
 * The Keychain ACL shim (`#pragma mark - keychain acl` in WardenInject.m) on the macOS build. A Mac cannot hold an
 * access-controlled item without entitlements (`SecItemAdd` answers -34018) and must never show a real
 * LocalAuthentication dialog under `bun test`, so the harness replaces the Keychain and the policy evaluation through
 * the test-only hooks the macOS build exports (`-DWARDEN_INJECT_TEST_HOOKS`); the interposed `SecItemCopyMatching`,
 * the ACL parse and the `evaluatePolicy` swizzle are the real ones.
 */

let dir: string;
let built = false;
beforeAll(async () => {
	if (process.platform !== "darwin") return;
	dir = mkdtempSync(join(tmpdir(), "warden-inject-kacl-build-"));
	built = (await main(["--macos", dir])) === 0;
}, 120_000);
afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

/** An access control the harness builds with `SecAccessControlCreateWithFlags` (`kacl-run` `acl`). */
type Acl =
	| "currentSet"
	| "any"
	| "passcode"
	| "presence"
	| "currentSet-or-passcode"
	| "any-or-passcode"
	| "currentSet-and-passcode"
	| "appPassword"
	| "keyUsage"
	| "none";

type Parsed = { known: boolean; biometry: "none" | "any" | "currentSet"; passcode: boolean; presence: boolean };

type Run = {
	/** what the fake Keychain holds for the query; `null` = a plain item with no access control */
	items: (Acl | null)[];
	returnData?: boolean;
	returnAttributes?: boolean;
	matchLimit?: "one" | "all";
	authUI?: "allow" | "fail" | "skip";
	/** pass an LAContext; `evaluate` = the app evaluates that policy on it first (through the swizzle) */
	context?: { interactionNotAllowed?: boolean; evaluate?: 1 | 2 };
	prompt?: string;
	/** the fake evaluator's answer: 0 = success, else the LAError code */
	evalCode?: number;
	/** the fake canEvaluatePolicy: policy -> 0 or the LAError code */
	canEval?: { "1"?: number; "2"?: number };
	/** call SecItemCopyMatching off the main thread */
	background?: boolean;
};

type Ran = {
	event: "kacl";
	status: number;
	data: string | null;
	evals: { policy: number; reason: string; context: "app" | "shim" }[];
	probes: { keys: string[]; limit: string; returnAttributes: boolean }[];
	reads: { keys: string[] }[];
	hooks: boolean;
};

type Rig = {
	send(cmd: string): void;
	next<T>(): Promise<T>;
	run(args: Run): Promise<Ran>;
	stop(): Promise<void>;
};

function startRig(env: Record<string, string>): Rig {
	const proc = Bun.spawn([join(dir, "harness")], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, DYLD_INSERT_LIBRARIES: join(dir, INJECT_DYLIB), ...env },
	});
	const decoder = new TextDecoder();
	let buffer = "";
	const reader = proc.stdout.getReader();
	const next = async <T>(): Promise<T> => {
		for (;;) {
			const nl = buffer.indexOf("\n");
			if (nl >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				return JSON.parse(line) as T;
			}
			const chunk = await reader.read();
			if (chunk.done) throw new Error("harness exited");
			buffer += decoder.decode(chunk.value);
		}
	};
	const send = (cmd: string) => proc.stdin.write(`${cmd}\n`);
	return {
		send,
		next,
		async run(args) {
			send(`kacl-run ${JSON.stringify(args)}`);
			return next<Ran>();
		},
		async stop() {
			send("quit");
			await proc.exited;
		},
	};
}

const ON = { WARDEN_KEYCHAIN_ACL: "1" };
const BIO = 1;
const OWNER = 2;

const run = process.platform === "darwin" ? describe : describe.skip;

run("keychain acl: the description parser", () => {
	test("reads every access control the shim cares about from its description", async () => {
		expect(built).toBe(true);
		const h = startRig(ON);
		h.send("kacl-parse");
		const rows = await h.next<{ event: string; rows: Record<Acl, { desc: string; parsed: Parsed }> }>();
		const parsed = (acl: Acl) => rows.rows[acl].parsed;
		expect(parsed("currentSet")).toEqual({ known: true, biometry: "currentSet", passcode: false, presence: false });
		expect(parsed("any")).toEqual({ known: true, biometry: "any", passcode: false, presence: false });
		expect(parsed("passcode")).toEqual({ known: true, biometry: "none", passcode: true, presence: false });
		expect(parsed("presence")).toEqual({ known: true, biometry: "none", passcode: false, presence: true });
		expect(parsed("currentSet-or-passcode")).toEqual({
			known: true,
			biometry: "currentSet",
			passcode: true,
			presence: false,
		});
		expect(parsed("any-or-passcode")).toEqual({ known: true, biometry: "any", passcode: true, presence: false });
		// `.and` needs both factors at once, which no LAPolicy expresses: left untouched, not guessed
		expect(parsed("currentSet-and-passcode").known).toBe(false);
		for (const acl of ["appPassword", "keyUsage", "none"] as const) expect(parsed(acl).known).toBe(false);
		// the table in WardenInject.m is this text (iOS 27.2 simulator and macOS 26 give the same)
		expect(rows.rows["currentSet-or-passcode"].desc).toContain("od(pkofn(1)cup(true)cbio(pbioc()pbioh()))");
		await h.stop();
	});

	test("a stored item's description with filled-in hashes still parses; garbage does not", async () => {
		const h = startRig(ON);
		const parse = async (desc: string) => {
			h.send(`kacl-parse-text ${desc}`);
			return (await h.next<{ parsed: Parsed }>()).parsed;
		};
		expect(await parse("<SecAccessControlRef: akpu;od(cbio(pbioc(0a1b)pbioh(ffee)));odel(true);oe(true)>")).toEqual({
			known: true,
			biometry: "currentSet",
			passcode: false,
			presence: false,
		});
		expect(await parse("<SecAccessControlRef: akpu;od(pkofn(1)cbio(pbioc(01))cup(true));odel(true)>")).toEqual({
			known: true,
			biometry: "any",
			passcode: true,
			presence: false,
		});
		expect((await parse("<SecAccessControlRef: akpu;od(cbio(pbioc()")).known).toBe(false);
		expect((await parse("<SecAccessControlRef: akpu;od(cnew(true));odel(true)>")).known).toBe(false);
		expect((await parse("something else")).known).toBe(false);
		await h.stop();
	});
});

run("keychain acl: reads", () => {
	test("off without WARDEN_KEYCHAIN_ACL: the fake Keychain and evaluator are never consulted", async () => {
		const h = startRig({});
		const r = await h.run({ items: ["currentSet-or-passcode"], returnData: true });
		expect(r.hooks).toBe(true);
		expect(r.probes).toEqual([]);
		expect(r.reads).toEqual([]);
		expect(r.evals).toEqual([]);
		// the real macOS Keychain has no such item
		expect(r.status).toBe(-25300);
		await h.stop();
	});

	test("a plain item and an attributes-only read pass straight through with no prompt", async () => {
		const h = startRig(ON);
		const plain = await h.run({ items: [null], returnData: true });
		expect(plain.status).toBe(0);
		expect(plain.data).toBe("secret");
		expect(plain.evals).toEqual([]);
		expect(plain.reads).toHaveLength(1);
		const attrs = await h.run({ items: ["currentSet"], returnAttributes: true });
		expect(attrs.status).toBe(0);
		expect(attrs.probes).toEqual([]);
		expect(attrs.evals).toEqual([]);
		await h.stop();
	});

	test("the probe asks for attributes only, without the context, the prompt or the data", async () => {
		const h = startRig(ON);
		const r = await h.run({
			items: ["currentSet-or-passcode"],
			returnData: true,
			context: {},
			prompt: "Unlock",
			authUI: "allow",
		});
		expect(r.probes).toHaveLength(1);
		const probe = r.probes[0];
		expect(probe?.returnAttributes).toBe(true);
		expect(probe?.limit).toBe("one");
		for (const key of ["r_Data", "u_AuthCtx", "u_OpPrompt", "u_AuthUI", "r_Ref", "r_PersistentRef"]) {
			expect(probe?.keys).not.toContain(key);
		}
		expect(r.reads[0]?.keys).toContain("u_AuthCtx");
		await h.stop();
	});

	test("a gated read prompts with the item's policy and returns the data on a match", async () => {
		const h = startRig(ON);
		const gate = await h.run({ items: ["currentSet-or-passcode"], returnData: true, prompt: "Unlock the vault" });
		expect(gate.evals).toEqual([{ policy: OWNER, reason: "Unlock the vault", context: "shim" }]);
		expect(gate.status).toBe(0);
		expect(gate.data).toBe("secret");
		const bio = await h.run({ items: ["currentSet"], returnData: true });
		expect(bio.evals.map((e) => e.policy)).toEqual([BIO]);
		expect(bio.status).toBe(0);
		const presence = await h.run({ items: ["presence"], returnData: true });
		expect(presence.evals.map((e) => e.policy)).toEqual([OWNER]);
		const passcode = await h.run({ items: ["passcode"], returnData: true });
		expect(passcode.evals.map((e) => e.policy)).toEqual([OWNER]);
		await h.stop();
	});

	test("an unknown access control (and) is left untouched: no prompt", async () => {
		const h = startRig(ON);
		const r = await h.run({ items: ["currentSet-and-passcode"], returnData: true });
		expect(r.evals).toEqual([]);
		expect(r.status).toBe(0);
		await h.stop();
	});

	test("cancel, system cancel and app cancel are errSecUserCanceled; any other failure errSecAuthFailed", async () => {
		const h = startRig(ON);
		for (const code of [-2, -4, -9]) {
			const r = await h.run({ items: ["currentSet-or-passcode"], returnData: true, evalCode: code });
			expect(r.status).toBe(-128);
			expect(r.data).toBeNull();
			expect(r.reads).toEqual([]);
		}
		for (const code of [-1, -3, -8, -1020]) {
			const r = await h.run({ items: ["currentSet-or-passcode"], returnData: true, evalCode: code });
			expect(r.status).toBe(-25293);
		}
		await h.stop();
	});

	test("interactionNotAllowed and kSecUseAuthenticationUIFail are errSecInteractionNotAllowed, no prompt", async () => {
		const h = startRig(ON);
		const noUi = await h.run({
			items: ["currentSet-or-passcode"],
			returnData: true,
			context: { interactionNotAllowed: true },
		});
		expect(noUi.status).toBe(-25308);
		expect(noUi.evals).toEqual([]);
		const fail = await h.run({ items: ["currentSet"], returnData: true, authUI: "fail" });
		expect(fail.status).toBe(-25308);
		expect(fail.evals).toEqual([]);
		const skip = await h.run({ items: ["currentSet"], returnData: true, authUI: "skip" });
		expect(skip.status).toBe(-25300);
		expect(skip.evals).toEqual([]);
		await h.stop();
	});

	test("a bio-only item with unusable biometry is errSecItemNotFound; a passcode path still prompts", async () => {
		const h = startRig(ON);
		for (const code of [-5, -6, -7]) {
			const r = await h.run({ items: ["currentSet"], returnData: true, canEval: { "1": code } });
			expect(r.status).toBe(-25300);
			expect(r.evals).toEqual([]);
		}
		const any = await h.run({ items: ["any"], returnData: true, canEval: { "1": -7 } });
		expect(any.status).toBe(-25300);
		const gate = await h.run({ items: ["currentSet-or-passcode"], returnData: true, canEval: { "1": -7 } });
		expect(gate.evals.map((e) => e.policy)).toEqual([OWNER]);
		expect(gate.status).toBe(0);
		await h.stop();
	});

	test("a context the app already evaluated reads with no second prompt, also with interactionNotAllowed", async () => {
		const h = startRig(ON);
		const owner = await h.run({
			items: ["currentSet-or-passcode"],
			returnData: true,
			context: { evaluate: OWNER, interactionNotAllowed: true },
		});
		expect(owner.evals).toEqual([{ policy: OWNER, reason: "app", context: "app" }]);
		expect(owner.status).toBe(0);
		expect(owner.data).toBe("secret");
		const bio = await h.run({ items: ["currentSet"], returnData: true, context: { evaluate: BIO } });
		expect(bio.evals.map((e) => e.context)).toEqual(["app"]);
		expect(bio.status).toBe(0);
		// a passcode-capable evaluation does not cover a biometry-only item
		const weaker = await h.run({ items: ["currentSet"], returnData: true, context: { evaluate: OWNER } });
		expect(weaker.evals.map((e) => e.context)).toEqual(["app", "shim"]);
		// a failed evaluation is not remembered
		const failed = await h.run({
			items: ["currentSet-or-passcode"],
			returnData: true,
			context: { evaluate: OWNER, interactionNotAllowed: true },
			evalCode: -2,
		});
		expect(failed.status).toBe(-25308);
		await h.stop();
	});

	test("kSecMatchLimitAll gates once when any match is access-controlled", async () => {
		const h = startRig(ON);
		const r = await h.run({
			items: [null, "currentSet-or-passcode", "currentSet"],
			returnData: true,
			matchLimit: "all",
		});
		expect(r.probes).toHaveLength(1);
		expect(r.probes[0]?.limit).toBe("all");
		expect(r.evals).toHaveLength(1);
		expect(r.status).toBe(0);
		const plain = await h.run({ items: [null, null], returnData: true, matchLimit: "all" });
		expect(plain.evals).toEqual([]);
		await h.stop();
	});

	test("a read off the main thread prompts and answers the same way", async () => {
		const h = startRig(ON);
		const r = await h.run({ items: ["currentSet-or-passcode"], returnData: true, background: true, evalCode: -2 });
		expect(r.status).toBe(-128);
		expect(r.evals).toHaveLength(1);
		await h.stop();
	});

	test("the state file switches the gate live; a state without the key leaves it as launched", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "warden-inject-kacl-live-"));
		const channel = createInjectChannel({
			statePath: join(stateDir, "state.json"),
			now: Date.now,
			sleep: (ms) => Bun.sleep(ms),
		});
		const itemsPath = join(stateDir, "keychain-acl-items.json");
		const h = startRig({ ...ON, WARDEN_INJECT_STATE: channel.statePath });
		const set = async (enabled?: boolean) => {
			const state = channel.write(enabled === undefined ? {} : { keychainAcl: { enabled, generation: 0, itemsPath } });
			expect(await channel.acked(state.seq, 5_000)).toBe(true);
		};
		await set(false);
		const off = await h.run({ items: ["currentSet-or-passcode"], returnData: true });
		expect(off.evals).toEqual([]);
		expect(off.probes).toEqual([]);
		await set(true);
		expect((await h.run({ items: ["currentSet-or-passcode"], returnData: true })).evals).toHaveLength(1);
		await set(undefined);
		expect((await h.run({ items: ["currentSet-or-passcode"], returnData: true })).evals).toHaveLength(1);
		await h.stop();
		rmSync(stateDir, { recursive: true, force: true });
	});

	test("the ack says keychainAcl when launched with WARDEN_KEYCHAIN_ACL=1", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "warden-inject-kacl-state-"));
		const channel = createInjectChannel({
			statePath: join(stateDir, "state.json"),
			now: Date.now,
			sleep: (ms) => Bun.sleep(ms),
		});
		const ackOf = async (env: Record<string, string>) => {
			const h = startRig({ ...env, WARDEN_INJECT_STATE: channel.statePath });
			const state = channel.write({});
			expect(await channel.acked(state.seq, 5_000)).toBe(true);
			const ack = JSON.parse(readFileSync(`${channel.statePath}.ack`, "utf8")) as { keychainAcl?: boolean };
			await h.stop();
			return ack;
		};
		expect((await ackOf(ON)).keychainAcl).toBe(true);
		expect((await ackOf({})).keychainAcl).toBe(false);
		rmSync(stateDir, { recursive: true, force: true });
	});
});
