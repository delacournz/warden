import { describe, expect, test } from "bun:test";
import {
	authorizedLine,
	keyComment,
	parseKeyComment,
	parsePublicKey,
	removeAuthorized,
	sshFingerprint,
	upsertAuthorized,
} from "./keys";

// ssh-keygen -lf of this key prints SHA256:qXQu2Pm0mNLK3+EFAN/Ijit7QhdXjOkR6AN/8l4Ma3k
const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAh3L5LzY7nqH3e7x5e0RgK4mTj9cH0zU0bAx5Xh7m1y warden:m1:chris";

describe("parsePublicKey", () => {
	test("type, blob and comment", () => {
		expect(parsePublicKey(PUB)).toEqual({
			success: true,
			data: {
				type: "ssh-ed25519",
				blob: "AAAAC3NzaC1lZDI1NTE5AAAAIAh3L5LzY7nqH3e7x5e0RgK4mTj9cH0zU0bAx5Xh7m1y",
				comment: "warden:m1:chris",
			},
		});
	});
	test("refuses options, private keys and junk", () => {
		for (const bad of [
			"",
			'command="x" ssh-ed25519 AAAA',
			"-----BEGIN OPENSSH PRIVATE KEY-----",
			"ssh-ed25519 not*base64",
		]) {
			expect(parsePublicKey(bad).success).toBe(false);
		}
	});
});

describe("sshFingerprint", () => {
	test("SHA256 of the key blob, base64 without padding (ssh-keygen -l)", async () => {
		const parsed = parsePublicKey(PUB);
		if (!parsed.success) throw new Error(parsed.error);
		const expected = await (async () => {
			const proc = Bun.spawn(["ssh-keygen", "-lf", "-"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
			proc.stdin.write(`${PUB}\n`);
			await proc.stdin.end();
			const out = await new Response(proc.stdout).text();
			return (await proc.exited) === 0 ? out.split(" ")[1] : undefined;
		})();
		const fp = sshFingerprint(parsed.data);
		expect(fp.startsWith("SHA256:")).toBe(true);
		if (expected !== undefined) expect(fp).toBe(expected);
	});
});

describe("key comments", () => {
	test("warden:<machineId>:<user> round trip", () => {
		expect(parseKeyComment(keyComment("m1", "chris"))).toEqual({ machineId: "m1", user: "chris" });
		expect(parseKeyComment("chris@laptop")).toBeUndefined();
		expect(parseKeyComment(undefined)).toBeUndefined();
	});
});

describe("authorized_keys", () => {
	const key = { type: "ssh-ed25519", blob: "AAAAkey1", comment: "warden:m1:chris" };
	const line = authorizedLine(["/Users/me/.local/bin/warden"], "SHA256:fp1", key);

	test("the line forces __host-serve with the fingerprint, restricts, and allows only port forwarding", () => {
		expect(line).toBe(
			'command="/Users/me/.local/bin/warden __host-serve --key SHA256:fp1",restrict,port-forwarding ssh-ed25519 AAAAkey1 warden:m1:chris'
		);
	});

	test("a from-source warden is quoted inside the command", () => {
		expect(authorizedLine(["/opt/bun", "/src/my repo/cli.ts"], "SHA256:x", key)).toContain(
			"command=\"/opt/bun '/src/my repo/cli.ts' __host-serve --key SHA256:x\""
		);
	});

	test("upsert replaces the same key's line and keeps everything else", () => {
		const before = "ssh-rsa AAAAother me@x\n";
		const once = upsertAuthorized(before, key, line);
		expect(once).toBe(`${before}${line}\n`);
		const again = upsertAuthorized(once, key, line.replace("fp1", "fp2"));
		expect(again).toBe(`${before}${line.replace("fp1", "fp2")}\n`);
	});

	test("remove drops only that key's lines", () => {
		const text = `ssh-rsa AAAAother me@x\n${line}\n`;
		expect(removeAuthorized(text, "AAAAkey1")).toEqual({ text: "ssh-rsa AAAAother me@x\n", removed: 1 });
		expect(removeAuthorized(text, "AAAAnone").removed).toBe(0);
	});
});
