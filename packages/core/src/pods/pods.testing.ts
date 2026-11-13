import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bunExec, type Exec, type ExecResult } from "../exec";
import { openStore, type Store } from "../store";
import type { Owner } from "../types";
import type { PodsDeps } from "./pods.types";

const done = (stdout = "", exitCode = 0): ExecResult => ({ exitCode, stdout, stderr: "" });

export type FakeToolchain = {
	exec: Exec;
	podInstalls: number;
	prebuilds: number;
	/** the fingerprint the fake `@expo/fingerprint` prints */
	fingerprint: string;
	podVersion: string;
	arch: string;
	/** make every `cp` fail */
	failCopy: boolean;
	/** pod missing */
	noPod: boolean;
	/** extra wait inside a fake pod install */
	installMs: number;
};

export function sha1(text: string): string {
	return createHash("sha1").update(text).digest("hex");
}

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

/** What a real `pod install` leaves behind. */
function writePodInstall(cwd: string, args: readonly string[]): void {
	const dir = join(cwd, args.find((a) => a.startsWith("--project-directory="))?.split("=")[1] ?? "ios");
	const spec = JSON.stringify({ name: "Local", source: { path: `${cwd}/node_modules/local` } });
	write(join(dir, "Pods", "Local Podspecs", "Local.podspec.json"), spec);
	write(
		join(dir, "Pods", "Pods.xcodeproj", "project.pbxproj"),
		`HEADER_SEARCH_PATHS = ${cwd}/node_modules/local/include;\n`
	);
	write(join(dir, "Pods", "Target Support Files", "x.xcconfig"), `FOO = ${cwd}/node_modules/x\n`);
	write(join(dir, "Pods", "Other", "plain.txt"), "no root here\n");
	write(join(dir, "build", "generated", "ios", "a.h"), "// generated\n");
	const lock = `PODS:\n  - Local (1.0)\nSPEC CHECKSUMS:\n  Local: ${sha1(spec)}\n`;
	write(join(dir, "Podfile.lock"), lock);
	write(join(dir, "Pods", "Manifest.lock"), lock);
	write(join(cwd, "node_modules", "local", "Products", "stub.txt"), "stub\n");
	write(join(cwd, "node_modules", ".cache", "ignored.txt"), "cache\n");
}

/**
 * Fake `pod` / `expo prebuild` / `xcodebuild` / fingerprint over real git, cp, find and grep. A fake `pod install` writes what the
 * real one does: Pods with the checkout root inside, both lockfiles (with the local podspec's sha1), and a stub under node_modules.
 */
export function fakeToolchain(): FakeToolchain {
	const tc: FakeToolchain = {
		podInstalls: 0,
		prebuilds: 0,
		fingerprint: "fp-1",
		podVersion: "1.16.2",
		arch: "arm64",
		failCopy: false,
		noPod: false,
		installMs: 0,
		exec: async () => done(),
	};
	tc.exec = async (cmd, opts) => {
		const [bin, ...rest] = cmd;
		const cwd = opts?.cwd ?? process.cwd();
		if (bin === "pod" && rest[0] === "--version") return tc.noPod ? done("", 127) : done(`${tc.podVersion}\n`);
		if (bin === "xcodebuild") return done("Xcode 27.0\nBuild version 27A1\n");
		if (bin === "uname") return done(`${tc.arch}\n`);
		if (cmd.some((c) => c.includes("fingerprint:generate"))) return done(JSON.stringify({ hash: tc.fingerprint }));
		if (bin === "bunx" && rest[0] === "expo") {
			tc.prebuilds++;
			if (rest.includes("--clean")) rmSync(join(cwd, "ios"), { recursive: true, force: true });
			write(join(cwd, "ios", "Podfile"), "target 'App' do\nend\n");
			write(join(cwd, "ios", "App.xcodeproj", "project.pbxproj"), `uuid ${Math.random()}\n`);
			return done();
		}
		if (bin === "pod" && rest[0] === "install") {
			tc.podInstalls++;
			if (tc.installMs > 0) await Bun.sleep(tc.installMs);
			writePodInstall(cwd, rest);
			opts?.onLine?.("Pod installation complete!");
			return done("Pod installation complete!\n");
		}
		if (bin === "cp" && tc.failCopy) return done("", 1);
		return bunExec(cmd, opts);
	};
	return tc;
}

/** A git repo (realpath) with a package.json; `ignoreIos` git-ignores `ios/` (CNG). */
export async function makeRepo(parent: string, name: string, opts: { ignoreIos: boolean }): Promise<string> {
	const root = join(parent, name);
	mkdirSync(root, { recursive: true });
	const real = realpathSync(root);
	write(join(real, "package.json"), '{"name":"app"}\n');
	if (opts.ignoreIos) write(join(real, ".gitignore"), "ios/\nnode_modules/\n");
	else write(join(real, ".gitignore"), "node_modules/\nios/Pods/\nios/build/\n");
	await bunExec(["git", "init", "-q"], { cwd: real });
	return real;
}

/** Commit a tracked bare-RN `ios/` into the repo. */
export async function commitIos(root: string): Promise<void> {
	write(join(root, "ios", "Podfile"), "target 'App' do\nend\n");
	write(join(root, "ios", "App", "Info.plist"), "<plist/>\n");
	write(join(root, "ios", "App.xcodeproj", "project.pbxproj"), "// pbx\n");
	await bunExec(["git", "add", "-A"], { cwd: root });
	await bunExec(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: root });
}

export type PodsHarness = {
	dir: string;
	home: string;
	store: Store;
	deps: PodsDeps;
	tc: FakeToolchain;
	logs: string[];
};

const owner: Owner = { kind: "agent", sessionId: "pods-test", cwd: "/" };

export function podsHarness(over: Partial<PodsDeps> = {}): PodsHarness {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-pods-")));
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	const store = openStore(join(home, "warden.db"));
	const tc = fakeToolchain();
	const logs: string[] = [];
	let clock = 1_000;
	const deps: PodsDeps = {
		store,
		exec: tc.exec,
		env: { WARDEN_HOME: home },
		now: () => (clock += 10),
		log: (l) => logs.push(l),
		pid: 4242,
		pidAlive: () => true,
		sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
		owner,
		lockPollMs: 5,
		lockWaitMs: 30_000,
		...over,
	};
	return { dir, home, store, deps, tc, logs };
}
