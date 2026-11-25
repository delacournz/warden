import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "@delacour/warden-core/exec";
import { getGrant, getHost, listHosts, putHost } from "@delacour/warden-core/hosts/registry";
import { fakeExec, type TestContext, testContext } from "../testing";
import { currentBuild } from "../update/build-info";
import { createHostCommand } from "./host";

const ctxs: TestContext[] = [];
afterEach(() => {
	for (const ctx of ctxs.splice(0)) ctx.cleanup();
});

const VERSION = currentBuild().version;

function context(argv: string[], exec = fakeExec([])): TestContext {
	const ctx = testContext(argv, { exec });
	ctxs.push(ctx);
	return ctx;
}

const run = (ctx: TestContext) => createHostCommand().run(ctx);

describe("warden host add", () => {
	test("records the host after first contact, trusting (and pinning) the first host key", async () => {
		const calls: string[][] = [];
		const ctx = context(
			["add", "mac", "--ssh", "me@mac.tail:2222", "--json"],
			fakeExec([["ssh", { stdout: `{"channel":"release","version":"${VERSION}"}\n` }]], calls)
		);
		expect(await run(ctx)).toBe(0);
		expect(calls[0]?.join(" ")).toContain("StrictHostKeyChecking=accept-new");
		expect(calls[0]?.slice(-3)).toEqual(["warden", "version", "--json"]);
		expect(getHost(ctx.db, "mac")).toMatchObject({
			ssh: { user: "me", hostname: "mac.tail", port: 2222 },
			version: VERSION,
		});
		expect(JSON.parse(ctx.stdout.join(""))).toMatchObject({ warden: VERSION });
	});

	test("--host-key pins that key up front and never trusts a new one", async () => {
		const calls: string[][] = [];
		const ctx = context(
			["add", "mac", "--ssh", "me@mac:22", "--host-key", "ssh-ed25519 AAAAhost"],
			fakeExec([["ssh", { stdout: `{"version":"${VERSION}"}` }]], calls)
		);
		expect(await run(ctx)).toBe(0);
		expect(calls[0]?.join(" ")).toContain("StrictHostKeyChecking=yes");
		expect(readFileSync(join(ctx.env.WARDEN_HOME ?? "", "hosts", "mac.known_hosts"), "utf8")).toBe(
			"[mac]:22 ssh-ed25519 AAAAhost\n"
		);
	});

	test("a host with no warden yet is still added, pointing at setup", async () => {
		const ctx = context(
			["add", "mac", "--ssh", "me@mac"],
			fakeExec([["ssh", { exitCode: 127, stderr: "sh: warden: command not found" }]])
		);
		expect(await run(ctx)).toBe(0);
		expect(getHost(ctx.db, "mac")?.version).toBeUndefined();
		expect(ctx.stderr.join("\n")).toContain("warden host setup mac");
	});

	test("an unreachable host is not added and exits 12 HOST_UNREACHABLE", async () => {
		const ctx = context(
			["add", "mac", "--ssh", "me@mac", "--json"],
			fakeExec([["ssh", { exitCode: 255, stderr: "ssh: connect to host mac port 22: Connection refused" }]])
		);
		expect(await run(ctx)).toBe(12);
		expect(listHosts(ctx.db)).toEqual([]);
	});

	test("a refused key exits 13 HOST_AUTH", async () => {
		const ctx = context(
			["add", "mac", "--ssh", "me@mac"],
			fakeExec([["ssh", { exitCode: 255, stderr: "me@mac: Permission denied (publickey)." }]])
		);
		expect(await run(ctx)).toBe(13);
	});

	test("bad names and targets are usage errors", async () => {
		expect(await run(context(["add", "-bad", "--ssh", "me@mac"]))).toBe(1);
		expect(await run(context(["add", "mac", "--ssh", "-oProxyCommand=x"]))).toBe(1);
		expect(await run(context(["add", "mac"]))).toBe(1);
	});
});

describe("warden host ls / rm", () => {
	test("ls lists, rm forgets the host and its pinned key", async () => {
		const ctx = context(["ls", "--json"]);
		putHost(ctx.db, { name: "mac", ssh: { hostname: "mac" }, addedAt: 1 });
		const pin = join(ctx.env.WARDEN_HOME ?? "", "hosts", "mac.known_hosts");
		writeFileSync(join(ctx.env.WARDEN_HOME ?? "", "hosts.tmp"), "");
		expect(await run(ctx)).toBe(0);
		expect(JSON.parse(ctx.stdout.join("")).hosts.map((h: { name: string }) => h.name)).toEqual(["mac"]);
		ctx.argv = ["rm", "mac"];
		expect(await run(ctx)).toBe(0);
		expect(getHost(ctx.db, "mac")).toBeUndefined();
		expect(existsSync(pin)).toBe(false);
		ctx.argv = ["rm", "mac"];
		expect(await run(ctx)).toBe(15);
	});
});

describe("warden host doctor", () => {
	test("version skew exits 14 HOST_VERSION_SKEW", async () => {
		const ctx = context(["doctor", "mac", "--json"], fakeExec([["ssh", { stdout: '{"version":"0.0.1"}' }]]));
		putHost(ctx.db, { name: "mac", ssh: { hostname: "mac" }, addedAt: 1 });
		expect(await run(ctx)).toBe(14);
		expect(JSON.parse(ctx.stdout.join("")).checks[0]).toMatchObject({ name: "warden", ok: false });
	});

	test("an unknown host exits 15", async () => {
		expect(await run(context(["doctor", "nope"]))).toBe(15);
	});

	test("same version and no drift is ok", async () => {
		const calls: string[][] = [];
		const ctx = context(
			["doctor", "mac", "--json"],
			fakeExec([["ssh", { stdout: `{"version":"${VERSION}","findings":[]}` }]], calls)
		);
		putHost(ctx.db, { name: "mac", ssh: { hostname: "mac" }, addedAt: 1, wardenPath: "/u/me/.local/bin/warden" });
		expect(await run(ctx)).toBe(0);
		expect(calls.map((c) => c.slice(-3).join(" "))).toEqual([
			"/u/me/.local/bin/warden version --json",
			"doctor --leases --json",
		]);
	});

	/** ssh answers `version --json` with this version, and `doctor --leases --json` with `leases`. */
	function hostExec(leases: { exitCode: number; stdout: string }): Exec {
		return async (cmd) =>
			cmd.join(" ").includes("doctor --leases")
				? { stderr: "", ...leases }
				: { exitCode: 0, stdout: `{"version":"${VERSION}"}`, stderr: "" };
	}

	test("drift on the host's own store is a warning, not a failure: the link is fine", async () => {
		const findings = [
			{ kind: "device_missing", severity: "drift", fixable: true },
			{ kind: "device_missing", severity: "drift", fixable: true },
			{ kind: "stale_claim_key", severity: "info", fixable: true },
		];
		const ctx = context(
			["doctor", "mac", "--json"],
			hostExec({ exitCode: 1, stdout: JSON.stringify({ ok: false, findings }) })
		);
		putHost(ctx.db, { name: "mac", ssh: { hostname: "mac" }, addedAt: 1 });
		expect(await run(ctx)).toBe(0);
		const out = JSON.parse(ctx.stdout.join(""));
		expect(out.ok).toBe(true);
		expect(out.checks[1]).toMatchObject({ name: "leases", ok: true, warning: true });
		expect(out.checks[1].detail).toContain("2 device_missing, 1 stale_claim_key");
		expect(out.checks[1].detail).toContain("warden doctor --leases --fix");
	});

	test("drift prints a warn line in text mode", async () => {
		const findings = [{ kind: "device_missing", severity: "drift", fixable: true }];
		const ctx = context(["doctor", "mac"], hostExec({ exitCode: 1, stdout: JSON.stringify({ ok: false, findings }) }));
		putHost(ctx.db, { name: "mac", ssh: { hostname: "mac" }, addedAt: 1 });
		expect(await run(ctx)).toBe(0);
		expect(ctx.stdout.join("\n")).toContain("warn leases: 1 finding(s) on the host: 1 device_missing");
	});

	test("a host that refuses or breaks doctor --leases still fails", async () => {
		const ctx = context(
			["doctor", "mac", "--json"],
			hostExec({ exitCode: 2, stdout: JSON.stringify({ error: { code: "refused", message: "refused: doctor" } }) })
		);
		putHost(ctx.db, { name: "mac", ssh: { hostname: "mac" }, addedAt: 1 });
		expect(await run(ctx)).toBe(1);
		expect(JSON.parse(ctx.stdout.join("")).checks[1]).toMatchObject({
			name: "leases",
			ok: false,
			detail: "refused: doctor",
		});
	});
});

describe("warden host grant / revoke (on the host)", () => {
	const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAh3L5LzY7nqH3e7x5e0RgK4mTj9cH0zU0bAx5Xh7m1y warden:m1:chris";

	test("grant writes the forced-command line and the grant; revoke removes both", async () => {
		const ctx = context([]);
		const keys = join(ctx.cwd, "authorized_keys");
		writeFileSync(keys, "ssh-rsa AAAAother me@x\n");
		ctx.argv = ["grant", "--key", PUB, "--authorized-keys", keys, "--warden", "/u/me/.local/bin/warden", "--json"];
		expect(await run(ctx)).toBe(0);
		const out = JSON.parse(ctx.stdout.join(""));
		expect(out).toMatchObject({ machineId: "m1", user: "chris" });
		expect(getGrant(ctx.db, out.fingerprint)).toMatchObject({ machineId: "m1", user: "chris" });
		const text = readFileSync(keys, "utf8");
		expect(text).toContain("ssh-rsa AAAAother me@x\n");
		expect(text).toContain(
			`command="/u/me/.local/bin/warden __host-serve --key ${out.fingerprint}",restrict,port-forwarding`
		);
		ctx.argv = ["revoke", "--key", out.fingerprint, "--authorized-keys", keys];
		expect(await run(ctx)).toBe(0);
		expect(getGrant(ctx.db, out.fingerprint)).toBeUndefined();
		expect(readFileSync(keys, "utf8")).toBe("ssh-rsa AAAAother me@x\n");
	});

	test("a key without a warden comment needs --machine and --user", async () => {
		const ctx = context(["grant", "--key", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAh3 me@x"]);
		ctx.argv.push("--authorized-keys", join(ctx.cwd, "ak"));
		expect(await run(ctx)).toBe(1);
		expect(ctx.stderr.join("\n")).toContain("--machine");
	});
});
