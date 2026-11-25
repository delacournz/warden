import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bunExec } from "@delacour/warden-core/exec";
import { getHost } from "@delacour/warden-core/hosts/registry";
import { createHostCommand } from "../commands/host";
import { type TestContext, testContext } from "../testing";
import { type Attached, attachAddLine, dialArgv, loginUser, sshdConfig, startAttach } from "./attach";
import { ensureLaptopKey } from "./setup";
import { sshdSkipReason } from "./sshd.testing";

const CLI = join(import.meta.dir, "..", "cli.ts");

const ctxs: TestContext[] = [];
const attached: Attached[] = [];
afterEach(async () => {
	for (const a of attached.splice(0)) await a.stop();
	for (const ctx of ctxs.splice(0)) ctx.cleanup();
});

describe("sshdConfig", () => {
	test("a user-level sshd: keys only, no root, no agent, TCP forwarding for dev --host", () => {
		const text = sshdConfig({ listen: "127.0.0.1", port: 2222, dir: "/a" });
		for (const line of [
			"ListenAddress 127.0.0.1",
			"Port 2222",
			"HostKey /a/ssh_host_ed25519_key",
			"AuthorizedKeysFile /a/authorized_keys",
			"PasswordAuthentication no",
			"KbdInteractiveAuthentication no",
			"PermitRootLogin no",
			"AllowAgentForwarding no",
			"AllowTcpForwarding yes",
			"X11Forwarding no",
		]) {
			expect(text).toContain(line);
		}
	});
});

describe("dialArgv", () => {
	test("dials out to the bastion and forwards its loopback port to this sshd", () => {
		expect(dialArgv({ target: "ci@bastion.example", remotePort: 2201, identity: "/k" }, 2222)).toEqual([
			"ssh",
			"-N",
			"-T",
			"-o",
			"BatchMode=yes",
			"-o",
			"ExitOnForwardFailure=yes",
			"-o",
			"ServerAliveInterval=15",
			"-o",
			"ServerAliveCountMax=3",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-i",
			"/k",
			"-o",
			"IdentitiesOnly=yes",
			"-R",
			"2201:127.0.0.1:2222",
			"ci@bastion.example",
		]);
	});
});

describe("attachAddLine", () => {
	test("the laptop's host add: through the bastion when dialled out, the host key pinned", () => {
		expect(
			attachAddLine({ name: "ci", user: "runner", hostname: "100.64.0.9", port: 2222, hostKey: "ssh-ed25519 AAA" })
		).toBe("warden host add ci --ssh runner@100.64.0.9:2222 --host-key 'ssh-ed25519 AAA' --granted");
		expect(
			attachAddLine({
				name: "ci",
				user: "runner",
				hostname: "127.0.0.1",
				port: 2201,
				hostKey: "ssh-ed25519 AAA",
				jump: "ci@bastion.example",
			})
		).toBe(
			"warden host add ci --ssh runner@127.0.0.1:2201 --jump ci@bastion.example --host-key 'ssh-ed25519 AAA' --granted"
		);
	});
});

describe.skipIf(sshdSkipReason(process.env) !== undefined)("host attach over a real sshd", () => {
	test("attach on the runner, then host add --granted + doctor on the laptop", async () => {
		const runner = testContext([], { exec: bunExec });
		const laptop = testContext([], { exec: bunExec });
		ctxs.push(runner, laptop);
		laptop.env.USER = "tester";
		const key = await ensureLaptopKey(laptop);
		if (!key.success) throw new Error(key.error);
		const r = await startAttach(runner, {
			grant: key.data.publicKey,
			name: "ci",
			listen: "127.0.0.1",
			warden: [process.execPath, CLI],
		});
		if (!r.success) throw new Error(r.error);
		attached.push(r.data);
		const wrapper = readFileSync(join(runner.env.WARDEN_HOME ?? "", "attach", "warden"), "utf8");
		expect(wrapper).toContain(`WARDEN_HOME=${runner.env.WARDEN_HOME} `);

		const words = r.data.add.split(" ");
		const flag = (name: string) => words[words.indexOf(name) + 1] ?? "";
		const hostKey = r.data.hostKey;
		laptop.argv = ["add", "ci", "--ssh", flag("--ssh"), "--host-key", hostKey, "--granted", "--json"];
		const added = await createHostCommand().run(laptop);
		if (added !== 0) throw new Error(laptop.stderr.join("\n"));
		expect(getHost(laptop.db, "ci")?.identity).toBe(key.data.path);
		laptop.stdout.length = 0;
		laptop.argv = ["doctor", "ci", "--json"];
		await createHostCommand().run(laptop);
		expect(JSON.parse(laptop.stdout.join("")).checks).toContainEqual(
			expect.objectContaining({ name: "warden", ok: true })
		);
	}, 60_000);
});

describe("loginUser", () => {
	test("the OS's answer (`id -un`), never a guess from an env that may lack USER", async () => {
		const ctx = testContext([], { exec: async () => ({ exitCode: 0, stdout: "runner\n", stderr: "" }) });
		ctxs.push(ctx);
		ctx.env.USER = "someone-else";
		expect(await loginUser(ctx)).toEqual({ success: true, data: "runner" });
		const broken = testContext([], { exec: async () => ({ exitCode: 1, stdout: "", stderr: "no" }) });
		ctxs.push(broken);
		const r = await loginUser(broken);
		expect(r.success).toBe(false);
	});
});
