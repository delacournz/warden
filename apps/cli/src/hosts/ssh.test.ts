import { describe, expect, test } from "bun:test";
import type { HostRecord } from "@delacour/warden-core/hosts/registry";
import { classifySshFailure, parseSshTarget, shellQuote, shellSplit, sshArgv } from "./ssh";

const host: HostRecord = {
	name: "mac",
	ssh: { user: "me", hostname: "mac.tail", port: 2222 },
	identity: "/k/id",
	addedAt: 0,
};

describe("parseSshTarget", () => {
	test("user@host:port, host, user@host", () => {
		expect(parseSshTarget("me@mac.tail:2222")).toEqual({
			success: true,
			data: { user: "me", hostname: "mac.tail", port: 2222 },
		});
		expect(parseSshTarget("mac")).toEqual({ success: true, data: { hostname: "mac" } });
		expect(parseSshTarget("me@10.0.0.2")).toEqual({ success: true, data: { user: "me", hostname: "10.0.0.2" } });
	});
	test("refuses an empty, option-looking or bad-port target", () => {
		for (const bad of ["", "-oProxyCommand=x", "me@", "a b", "me@mac:0", "me@mac:99999", "me@mac:x"]) {
			expect(parseSshTarget(bad).success).toBe(false);
		}
	});
});

describe("sshArgv", () => {
	test("strict pinned host key, batch mode, no agent / X11, no tty, keepalives, a control master", () => {
		const argv = sshArgv(host, ["warden", "version", "--json"], { home: "/w" });
		expect(argv.slice(0, 1)).toEqual(["ssh"]);
		const opts = argv.join(" ");
		expect(opts).toContain("-o StrictHostKeyChecking=yes");
		expect(opts).toContain("-o UserKnownHostsFile=/w/hosts/mac.known_hosts");
		expect(opts).toContain("-o BatchMode=yes");
		expect(opts).toContain("-o ForwardAgent=no");
		expect(opts).toContain("-o ForwardX11=no");
		expect(opts).toContain("-o IdentitiesOnly=yes");
		expect(opts).toContain("-i /k/id");
		expect(opts).toContain("-o ControlMaster=auto");
		expect(opts).toContain("-o ControlPersist=60s");
		expect(opts).toContain("-o ServerAliveInterval=15");
		expect(argv).toContain("-T");
		expect(argv.slice(argv.indexOf("-p"), argv.indexOf("--"))).toEqual(["-p", "2222", "me@mac.tail"]);
		expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["warden", "version", "--json"]);
	});

	test("one control master per key: setup's shell key never carries the granted key's calls", () => {
		const path = (argv: string[]) => argv.find((a) => a.startsWith("ControlPath="));
		const granted = path(sshArgv(host, [], { home: "/w" }));
		const setupKey = path(sshArgv({ ...host, identity: "/k/setup" }, [], { home: "/w" }));
		const { identity: _, ...bare } = host;
		const sshDefault = path(sshArgv(bare, [], { home: "/w" }));
		expect(granted).toMatch(/^ControlPath=\/w\/hosts\/cm\/[0-9a-f]{8}-%C$/);
		expect(new Set([granted, setupKey, sshDefault]).size).toBe(3);
		expect(path(sshArgv(host, [], { home: "/w" }))).toBe(granted);
	});

	test("first contact accepts and pins a new host key, never a changed one", () => {
		const opts = sshArgv(host, [], { home: "/w", trustNew: true }).join(" ");
		expect(opts).toContain("-o StrictHostKeyChecking=accept-new");
	});

	test("proxy command and jump host", () => {
		const argv = sshArgv({ ...host, proxyCommand: "cloudflared access ssh --hostname %h", jump: "me@bastion" }, [], {
			home: "/w",
		});
		expect(argv).toContain("ProxyCommand=cloudflared access ssh --hostname %h");
		expect(argv[argv.indexOf("-J") + 1]).toBe("me@bastion");
	});

	test("forwards are passed through; a long home skips the control master (socket path limit)", () => {
		const argv = sshArgv(host, [], { home: `/${"x".repeat(80)}`, forwards: ["-R", "8081:127.0.0.1:8081"] });
		expect(argv.join(" ")).not.toContain("ControlMaster");
		expect(argv[argv.indexOf("-R") + 1]).toBe("8081:127.0.0.1:8081");
	});

	test("no control master when asked (a long-lived stdio channel)", () => {
		expect(sshArgv(host, [], { home: "/w", control: false }).join(" ")).not.toContain("ControlMaster");
	});

	test("arguments are quoted for the remote shell", () => {
		const argv = sshArgv(host, ["warden", "claim", "ios", "--label", "my run's"], { home: "/w" });
		expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["warden", "claim", "ios", "--label", "'my run'\\''s'"]);
	});
});

describe("shellQuote / shellSplit", () => {
	test("round trip", () => {
		const words = ["warden", "claim", "--label", "a b", "it's", "", 'x"y', "$HOME"];
		expect(shellSplit(words.map(shellQuote).join(" "))).toEqual({ success: true, data: words });
	});
	test("plain words stay unquoted", () => {
		expect(shellQuote("--json")).toBe("--json");
		expect(shellQuote("ios")).toBe("ios");
	});
	test("an unterminated quote is refused", () => {
		expect(shellSplit("warden 'x").success).toBe(false);
	});
	test("double quotes and backslashes", () => {
		expect(shellSplit('a "b c" d\\ e')).toEqual({ success: true, data: ["a", "b c", "d e"] });
	});
});

describe("classifySshFailure", () => {
	test("exit 255 with an auth or host-key message is HOST_AUTH", () => {
		expect(classifySshFailure(255, "me@mac: Permission denied (publickey).")).toBe("HOST_AUTH");
		expect(classifySshFailure(255, "Host key verification failed.")).toBe("HOST_AUTH");
		expect(classifySshFailure(255, "@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @")).toBe("HOST_AUTH");
	});
	test("any other exit 255 is HOST_UNREACHABLE", () => {
		expect(classifySshFailure(255, "ssh: connect to host mac port 22: Connection refused")).toBe("HOST_UNREACHABLE");
		expect(classifySshFailure(255, "")).toBe("HOST_UNREACHABLE");
	});
	test("another exit is the remote command's own", () => {
		expect(classifySshFailure(1, "Permission denied")).toBeUndefined();
		expect(classifySshFailure(0, "")).toBeUndefined();
	});
});

describe("sshArgv on a relayed host", () => {
	test("dials through warden __relay-dial with the command as is, never ssh", () => {
		const host = {
			name: "mini",
			ssh: { hostname: "relay" },
			relay: { apiUrl: "https://api.warden.co.nz", hostId: "h1", account: "work", organization: "o1" },
			addedAt: 1,
		};
		expect(
			sshArgv(host, ["warden", "claim", "ios", "--label", "a b"], { home: "/h", dialer: ["/w"], forwards: ["-t"] })
		).toEqual([
			"/w",
			"__relay-dial",
			"--api",
			"https://api.warden.co.nz",
			"--host-id",
			"h1",
			"--account",
			"work",
			"--organization",
			"o1",
			"--",
			"warden",
			"claim",
			"ios",
			"--label",
			"a b",
		]);
	});
});
