import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec } from "@delacour/warden-core/exec";
import { createInjectChannel, injectLaunchEnv } from "../../src/driver/ios/inject";
import { dylibArgv, harnessArgv, INJECT_DYLIB, IOS_MIN, main } from "./inject";

describe("build argv", () => {
	test("simulator dylib targets arm64 iphonesimulator with the deployment floor", () => {
		const argv = dylibArgv("ios-simulator", "/o/lib.dylib");
		expect(argv.slice(0, 5)).toEqual(["xcrun", "--sdk", "iphonesimulator", "clang", "-arch"]);
		expect(argv).toContain(`-mios-simulator-version-min=${IOS_MIN}`);
		expect(argv).toContain("-dynamiclib");
		expect(argv.slice(-2)).toEqual(["-o", "/o/lib.dylib"]);
		expect(argv.join(" ")).toContain("-framework Network -framework SystemConfiguration");
	});

	test("the host dylib and harness use the macOS SDK", () => {
		expect(dylibArgv("macos", "/o/x")).toContain("macosx");
		expect(harnessArgv("/o/h")).toContain("macosx");
	});
});

type Seen = {
	defaultProxy: Record<string, unknown> | null;
	ephemeralProxy: Record<string, unknown> | null;
	sessionProxy: Record<string, unknown> | null;
	clockMs: number;
	todMs: number;
	timeS: number;
	cfAbsS: number;
	reachFlags: number;
	monotonicOk: boolean | number;
};

let dir: string;
let built = false;
beforeAll(async () => {
	if (process.platform !== "darwin") return;
	dir = mkdtempSync(join(tmpdir(), "warden-inject-"));
	built = (await main(["--macos", dir])) === 0;
}, 120_000);
afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A harness process with the dylib inserted; `ask` sends `print` and parses the JSON line it answers. */
function startHarness(env: Record<string, string>) {
	const proc = Bun.spawn([join(dir, "harness")], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, DYLD_INSERT_LIBRARIES: join(dir, INJECT_DYLIB), ...env },
	});
	const lines = (async function* () {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of proc.stdout) {
			buffer += decoder.decode(chunk);
			let nl = buffer.indexOf("\n");
			while (nl >= 0) {
				yield buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");
			}
		}
	})();
	const send = (cmd: string) => proc.stdin.write(`${cmd}\n`);
	return {
		proc,
		send,
		async next<T>(): Promise<T> {
			const { value } = await lines.next();
			return JSON.parse(value as string) as T;
		},
		async ask(): Promise<Seen> {
			send("print");
			const { value } = await lines.next();
			return JSON.parse(value as string) as Seen;
		},
		async stop() {
			send("quit");
			await proc.exited;
		},
	};
}

const run = process.platform === "darwin" ? describe : describe.skip;

run("libwarden-inject (macOS build, real dyld insertion)", () => {
	test("routes NSURLSession configurations through the proxy and leaves the clock alone with no state", async () => {
		expect(built).toBe(true);
		const h = startHarness({ WARDEN_NET_PROXY: "127.0.0.1:19123" });
		const seen = await h.ask();
		for (const proxy of [seen.defaultProxy, seen.ephemeralProxy, seen.sessionProxy]) {
			expect(proxy).toMatchObject({
				HTTPEnable: 1,
				HTTPProxy: "127.0.0.1",
				HTTPPort: 19123,
				HTTPSEnable: 1,
				HTTPSProxy: "127.0.0.1",
				HTTPSPort: 19123,
			});
		}
		expect(Math.abs(seen.clockMs - Date.now())).toBeLessThan(2_000);
		await h.stop();
	});

	test("without WARDEN_NET_PROXY no configuration is touched", async () => {
		const h = startHarness({});
		const seen = await h.ask();
		expect(seen.defaultProxy).toBeNull();
		expect(seen.sessionProxy).toBeNull();
		await h.stop();
	});

	test("the state file shifts the wall clocks live, acks the seq, and never touches monotonic time", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "warden-inject-state-"));
		mkdirSync(stateDir, { recursive: true });
		const channel = createInjectChannel({
			statePath: join(stateDir, "state.json"),
			now: Date.now,
			sleep: (ms) => Bun.sleep(ms),
		});
		writeFileSync(join(stateDir, "seed"), "");
		const h = startHarness(
			injectLaunchEnv({ dylib: join(dir, INJECT_DYLIB), statePath: channel.statePath, debug: true })
		);
		const day = 86_400_000;
		const first = channel.write({ clockOffsetMs: 3 * day });
		expect(await channel.acked(first.seq, 5_000)).toBe(true);
		let seen = await h.ask();
		expect(Math.abs(seen.clockMs - (Date.now() + 3 * day))).toBeLessThan(2_000);
		expect(Math.abs(seen.todMs - (Date.now() + 3 * day))).toBeLessThan(2_000);
		expect(Math.abs(seen.timeS * 1000 - (Date.now() + 3 * day))).toBeLessThan(2_000);
		expect(Math.abs(seen.cfAbsS * 1000 - (Date.now() + 3 * day))).toBeLessThan(2_000);
		expect(seen.monotonicOk).toBeTruthy();

		const back = channel.write({ clockOffsetMs: -2 * day });
		expect(await channel.acked(back.seq, 5_000)).toBe(true);
		seen = await h.ask();
		expect(Math.abs(seen.clockMs - (Date.now() - 2 * day))).toBeLessThan(2_000);

		const reset = channel.write({});
		expect(await channel.acked(reset.seq, 5_000)).toBe(true);
		seen = await h.ask();
		expect(Math.abs(seen.clockMs - Date.now())).toBeLessThan(2_000);
		await h.stop();
		rmSync(stateDir, { recursive: true, force: true });
	}, 30_000);

	test("offline makes reachability report no flags and fires the registered path monitor", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "warden-inject-state-"));
		const channel = createInjectChannel({
			statePath: join(stateDir, "state.json"),
			now: Date.now,
			sleep: (ms) => Bun.sleep(ms),
		});
		const h = startHarness(injectLaunchEnv({ dylib: join(dir, INJECT_DYLIB), statePath: channel.statePath }));
		const online = await h.ask();
		h.send("monitor");
		const initial = await h.next<{ event: string; status: number }>();
		expect(initial.event).toBe("path");
		const offline = channel.write({ offline: true });
		expect(await channel.acked(offline.seq, 5_000)).toBe(true);
		const fired = await h.next<{ event: string; status: number }>();
		expect(fired).toEqual({ event: "path", status: 2 });
		const seen = await h.ask();
		expect(seen.reachFlags).toBe(0);
		expect(online.reachFlags).not.toBe(0xdead);
		const back = channel.write({ offline: false });
		expect(await channel.acked(back.seq, 5_000)).toBe(true);
		const restored = await h.next<{ event: string; status: number }>();
		expect(restored.status).toBe(initial.status);
		await h.stop();
		rmSync(stateDir, { recursive: true, force: true });
	}, 30_000);
});

test("bunExec is the exec the build uses", () => {
	expect(typeof bunExec).toBe("function");
});
