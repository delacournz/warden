import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type LoopbackSshd, sshdSkipReason, startLoopbackSshd } from "./sshd.testing";

const started: LoopbackSshd[] = [];

afterEach(async () => {
	for (const sshd of started.splice(0)) await sshd.stop();
});

async function run(cmd: readonly string[], stdin?: string) {
	const proc = Bun.spawn([...cmd], { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
	if (stdin !== undefined && proc.stdin) {
		proc.stdin.write(stdin);
		await proc.stdin.end();
	}
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

describe("sshdSkipReason", () => {
	test("WARDEN_SSH_IT=0 skips", () => {
		expect(sshdSkipReason({ WARDEN_SSH_IT: "0" }, () => true)).toBe("WARDEN_SSH_IT=0");
	});

	test("a missing sshd skips", () => {
		expect(sshdSkipReason({}, () => false)).toBe("/usr/sbin/sshd is missing");
	});

	test("otherwise it runs", () => {
		expect(sshdSkipReason({}, () => true)).toBeUndefined();
	});
});

const skip = sshdSkipReason(process.env);

describe.skipIf(skip !== undefined)("loopback sshd", () => {
	test("runs the forced command with the client's command in SSH_ORIGINAL_COMMAND", async () => {
		const sshd = await startLoopbackSshd({ forcedCommand: 'echo "orig=$SSH_ORIGINAL_COMMAND"' });
		started.push(sshd);
		const r = await run(sshd.sshArgv(["warden", "claim", "ios", "--json"]));
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("orig=warden claim ios --json");
	});

	test("pipes stdin and stdout both ways (the stdio a driver connection needs)", async () => {
		const sshd = await startLoopbackSshd({ forcedCommand: "cat" });
		started.push(sshd);
		const r = await run(sshd.sshArgv([]), '{"id":1}\n{"id":2}\n');
		expect(r.stdout).toBe('{"id":1}\n{"id":2}\n');
	});

	test("refuses a host key that does not match the pinned one", async () => {
		const sshd = await startLoopbackSshd({ forcedCommand: "true" });
		started.push(sshd);
		await Bun.write(
			sshd.knownHosts,
			`[127.0.0.1]:${sshd.port} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOBRQKa1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9\n`
		);
		const r = await run(sshd.sshArgv(["x"]));
		expect(r.exitCode).toBe(255);
	});

	test("a second key line can be authorized later; stop removes the pid file", async () => {
		const sshd = await startLoopbackSshd({ forcedCommand: "echo first" });
		started.push(sshd);
		const second = await sshd.addClient({ forcedCommand: "echo second" });
		const r = await run(sshd.sshArgv([], { identity: second }));
		expect(r.stdout.trim()).toBe("second");
		await sshd.stop();
		expect(existsSync(join(sshd.dir, "sshd.pid"))).toBe(false);
	});
});
