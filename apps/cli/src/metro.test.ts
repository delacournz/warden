import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	devClientLaunchArgv,
	type MetroDeps,
	type MetroProc,
	metroArgv,
	metroOwner,
	metroUrl,
	prewarmMetro,
	startMetro,
} from "./metro";
import { fakeExec } from "./testing";

type Server = { port: number; stop: () => void };

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.stop();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-metro-")));
	dirs.push(dir);
	return dir;
}

/** A fake dev server on a free port. */
function serve(handler: (url: URL, req: Request) => Response): Server {
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => handler(new URL(req.url), req) });
	const s = { port: server.port ?? 0, stop: () => server.stop(true) };
	servers.push(s);
	return s;
}

/** Metro's `/status`, with the project-root header when `root` is given. */
function metroStatus(root?: string): (url: URL) => Response {
	return (url) =>
		url.pathname === "/status"
			? new Response("packager-status:running", {
					headers: root === undefined ? {} : { "X-React-Native-Project-Root": encodeURI(root) },
				})
			: new Response("not found", { status: 404 });
}

/** `lsof` answers for a listener on `port` whose cwd is `cwd`. */
function lsof(port: number, cwd: string | undefined, calls: string[][] = []) {
	return fakeExec(
		cwd === undefined
			? [["lsof", { exitCode: 1 }]]
			: [
					[`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { stdout: "4242\n" }],
					["lsof -a -p 4242 -d cwd -Fn", { stdout: `p4242\nfcwd\nn${cwd}\n` }],
				],
		calls
	);
}

const noExec = fakeExec([]);

describe("metroOwner (the verify matrix)", () => {
	test("header names this project root → ours", async () => {
		const root = tempDir();
		const s = serve(metroStatus(root));
		expect(await metroOwner(noExec, s.port, root)).toEqual({ kind: "ours" });
	});

	test("header names another checkout → foreign, with its root", async () => {
		const root = tempDir();
		const other = tempDir();
		const s = serve(metroStatus(other));
		expect(await metroOwner(noExec, s.port, root)).toEqual({ kind: "foreign", root: other });
	});

	test("a root with spaces survives the header's URI encoding", async () => {
		const root = join(tempDir(), "my app");
		const s = serve(metroStatus(root));
		expect(await metroOwner(noExec, s.port, root)).toEqual({ kind: "ours" });
	});

	test("no header: the listening pid's cwd decides", async () => {
		const root = tempDir();
		const other = tempDir();
		const s = serve(metroStatus());
		expect(await metroOwner(lsof(s.port, root), s.port, root)).toEqual({ kind: "ours" });
		expect(await metroOwner(lsof(s.port, other), s.port, root)).toEqual({ kind: "foreign", root: other });
	});

	test("no header and no listener cwd → unknown (never reported as ours)", async () => {
		const root = tempDir();
		const s = serve(metroStatus());
		expect(await metroOwner(lsof(s.port, undefined), s.port, root)).toEqual({ kind: "unknown" });
	});

	test("something that is not Metro answers → not-metro", async () => {
		const root = tempDir();
		const s = serve(() => new Response("<html>hello</html>"));
		expect(await metroOwner(noExec, s.port, root)).toEqual({ kind: "not-metro" });
	});

	test("nothing listening → down", async () => {
		const s = serve(metroStatus());
		s.stop();
		expect(await metroOwner(noExec, s.port, tempDir())).toEqual({ kind: "down" });
	});
});

type Harness = {
	deps: MetroDeps;
	spawned: Array<{ cmd: string[]; env: Record<string, string | undefined>; cwd: string }>;
	kills: string[];
	exit: (code: number) => void;
	clock: { now: number };
};

function harness(exec = noExec): Harness {
	let resolveExit: (code: number) => void = () => {};
	const clock = { now: 0 };
	const h: Harness = {
		spawned: [],
		kills: [],
		clock,
		exit: (code) => resolveExit(code),
		deps: {
			probe: (port, root) => metroOwner(exec, port, root),
			now: () => clock.now,
			sleep: async (ms) => {
				clock.now += ms;
			},
			spawn: (cmd, env, cwd): MetroProc => {
				h.spawned.push({ cmd, env, cwd });
				return {
					exited: new Promise<number>((resolve) => {
						resolveExit = resolve;
					}),
					kill: (signal) => {
						h.kills.push(signal);
						resolveExit(143);
					},
				};
			},
		},
	};
	return h;
}

describe("startMetro", () => {
	test("spawns expo on the port in the project root and is ready once /status names this root", async () => {
		const root = tempDir();
		const s = serve(metroStatus(root));
		const h = harness();
		const metro = await startMetro(h.deps, {
			projectRoot: root,
			port: s.port,
			env: { A: "1" },
			args: ["--clear"],
			readyTimeoutMs: 5_000,
		});
		if (!metro.success) throw new Error(metro.error);
		expect(h.spawned).toEqual([
			{ cmd: metroArgv(s.port, ["--clear"]), env: { A: "1", EXPO_NO_TELEMETRY: "1" }, cwd: root },
		]);
		expect(metro.data.url).toBe(metroUrl(s.port));
		await metro.data.stop();
		expect(h.kills).toEqual(["SIGTERM"]);
	});

	test("a foreign Metro on the port never reports ready: fails naming its root, our Metro is stopped", async () => {
		const root = tempDir();
		const other = tempDir();
		const s = serve(metroStatus(other));
		const h = harness();
		const metro = await startMetro(h.deps, { projectRoot: root, port: s.port, env: {}, readyTimeoutMs: 5_000 });
		expect(metro).toEqual({
			success: false,
			error: `port ${s.port} is served by ${other}, not this worktree (${root})`,
		});
		expect(h.kills).toEqual(["SIGTERM"]);
	});

	test("an unverifiable server times out instead of being trusted", async () => {
		const root = tempDir();
		const s = serve(metroStatus());
		const h = harness(lsof(s.port, undefined));
		const metro = await startMetro(h.deps, { projectRoot: root, port: s.port, env: {}, readyTimeoutMs: 2_000 });
		expect(metro.success).toBe(false);
		if (!metro.success) expect(metro.error).toContain("could not verify");
		expect(h.kills).toEqual(["SIGTERM"]);
	});

	test("Metro exiting before it is ready is reported with its exit code", async () => {
		const root = tempDir();
		const s = serve(metroStatus());
		s.stop();
		const h = harness();
		const sleep = h.deps.sleep;
		h.deps.sleep = async (ms) => {
			h.exit(1);
			await sleep(ms);
		};
		const metro = await startMetro(h.deps, { projectRoot: root, port: s.port, env: {}, readyTimeoutMs: 60_000 });
		expect(metro).toEqual({ success: false, error: "Metro exited (1) before it was ready" });
		expect(h.kills).toEqual([]);
	});

	test("never up → timeout, Metro stopped", async () => {
		const root = tempDir();
		const s = serve(metroStatus());
		s.stop();
		const h = harness();
		const metro = await startMetro(h.deps, { projectRoot: root, port: s.port, env: {}, readyTimeoutMs: 3_000 });
		expect(metro).toEqual({ success: false, error: `Metro did not answer on :${s.port} within 3s` });
		expect(h.kills).toEqual(["SIGTERM"]);
	});

	test("aborted while waiting → stops", async () => {
		const root = tempDir();
		const s = serve(metroStatus());
		s.stop();
		const h = harness();
		const metro = await startMetro(h.deps, {
			projectRoot: root,
			port: s.port,
			env: {},
			readyTimeoutMs: 60_000,
			aborted: () => h.clock.now >= 1_000,
		});
		expect(metro).toEqual({ success: false, error: "interrupted while waiting for Metro" });
	});

	test("stop escalates to SIGKILL when Metro ignores SIGTERM", async () => {
		const root = tempDir();
		const s = serve(metroStatus(root));
		const h = harness();
		const spawn = h.deps.spawn;
		h.deps.spawn = (cmd, env, cwd) => {
			const proc = spawn(cmd, env, cwd);
			return {
				exited: proc.exited,
				kill: (signal) => {
					h.kills.push(signal);
					if (signal === "SIGKILL") h.exit(137);
				},
			};
		};
		const metro = await startMetro(h.deps, { projectRoot: root, port: s.port, env: {}, readyTimeoutMs: 5_000 });
		if (!metro.success) throw new Error(metro.error);
		await metro.data.stop();
		expect(h.kills).toEqual(["SIGTERM", "SIGKILL"]);
	});
});

describe("prewarmMetro", () => {
	test("fetches the manifest for the platform, then its launch bundle", async () => {
		const seen: string[] = [];
		const s = serve((url, req) => {
			seen.push(`${url.pathname}${url.search} [${req.headers.get("expo-platform") ?? ""}]`);
			if (url.pathname === "/")
				return Response.json({ launchAsset: { url: `http://127.0.0.1:${s.port}/index.bundle?platform=ios` } });
			return new Response("bundle");
		});
		expect(await prewarmMetro(metroUrl(s.port), "ios")).toEqual({ success: true, data: { bundled: true } });
		expect(seen).toEqual(["/ [ios]", "/index.bundle?platform=ios []"]);
	});

	test("a bundle that fails to build is an error with Metro's message", async () => {
		const s = serve((url) =>
			url.pathname === "/"
				? Response.json({ launchAsset: { url: `http://127.0.0.1:${s.port}/index.bundle` } })
				: new Response("SyntaxError: app.tsx: Unexpected token", { status: 500 })
		);
		const res = await prewarmMetro(metroUrl(s.port), "ios");
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("SyntaxError: app.tsx: Unexpected token");
	});

	test("no readable manifest → skipped, not an error", async () => {
		const s = serve(() => new Response("nope", { status: 404 }));
		expect(await prewarmMetro(metroUrl(s.port), "ios")).toEqual({ success: true, data: { bundled: false } });
	});
});

describe("devClientLaunchArgv", () => {
	test("relaunches the app pointed at Metro, with the suite's launch args", () => {
		expect(devClientLaunchArgv("U1", "com.demo", "http://127.0.0.1:8090", ["-Flag", "YES"])).toEqual([
			"xcrun",
			"simctl",
			"launch",
			"--terminate-running-process",
			"U1",
			"com.demo",
			"--initialUrl",
			"http://127.0.0.1:8090",
			"-Flag",
			"YES",
		]);
	});
});
