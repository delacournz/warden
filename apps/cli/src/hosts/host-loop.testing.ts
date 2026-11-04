import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec } from "@delacour/warden-core/exec";
import { type TestContext, testContext } from "../testing";
import { type LoopbackSshd, type SshClientKey, startLoopbackSshd } from "./sshd.testing";

const CLI = join(import.meta.dir, "..", "cli.ts");

/**
 * A laptop and a host on this Mac, joined by the loopback sshd (RMT-12): the host is this checkout's warden run from
 * source under its own `WARDEN_HOME` (a wrapper script `host setup --binary` installs), the laptop a `testContext`
 * with real `exec`. The setup key opens a plain shell (`eval "$SSH_ORIGINAL_COMMAND"`); `host setup` then grants the
 * laptop's own key in the sshd's `authorized_keys`. Nothing outside the temp dirs is touched.
 */
export type HostLoop = {
	sshd: LoopbackSshd;
	laptop: TestContext;
	hostHome: string;
	/** the wrapper `--binary` installs: this checkout's warden with the host's WARDEN_HOME */
	wrapper: string;
	installDir: string;
	setupKey: SshClientKey;
	/** `warden host add loop …` then `host setup loop …` argv for the laptop */
	addArgv: string[];
	setupArgv: string[];
	stop(): Promise<void>;
};

export async function startHostLoop(): Promise<HostLoop> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "whl-")));
	const hostHome = join(root, "host-home");
	const installDir = join(root, "bin");
	mkdirSync(hostHome, { recursive: true });
	const wrapper = join(root, "warden-wrapper");
	writeFileSync(
		wrapper,
		`#!/bin/sh\nexec env WARDEN_HOME='${hostHome}' HOME='${hostHome}' WARDEN_BACKGROUND=0 WARDEN_ARRANGE=0 '${process.execPath}' '${CLI}' "$@"\n`
	);
	chmodSync(wrapper, 0o755);
	const sshd = await startLoopbackSshd({ forcedCommand: "false" });
	const setupKey = await sshd.addClient({ forcedCommand: 'eval "$SSH_ORIGINAL_COMMAND"' });
	const laptop = testContext([], { exec: bunExec });
	laptop.env.USER = "tester";
	const user = process.env.USER ?? "";
	const target = `${user}@127.0.0.1:${sshd.port}`;
	return {
		sshd,
		laptop,
		hostHome,
		wrapper,
		installDir,
		setupKey,
		addArgv: ["add", "loop", "--ssh", target, "--identity", setupKey.path, "--json"],
		setupArgv: [
			"setup",
			"loop",
			"--binary",
			wrapper,
			"--install-dir",
			installDir,
			"--authorized-keys",
			join(sshd.dir, "authorized_keys"),
			"--no-helper",
			"--json",
		],
		async stop() {
			laptop.cleanup();
			await sshd.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
