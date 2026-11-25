import { afterEach, describe, expect, test } from "bun:test";
import type { ExecResult } from "@delacour/warden-core/exec";
import { putHost } from "@delacour/warden-core/hosts/registry";
import { type TestContext, testContext } from "../testing";
import { claimCommand } from "./claim";
import { heartbeatCommand } from "./heartbeat";
import { lsCommand } from "./ls";
import { releaseCommand } from "./release";

const ctxs: TestContext[] = [];
afterEach(() => {
	for (const ctx of ctxs.splice(0)) ctx.cleanup();
});

const CLAIMED = JSON.stringify({
	leases: [{ leaseId: "R1", platform: "ios", udid: "U1", name: "warden-iphone-1", action: "boot" }],
});

function context(argv: string[], remotes: string[][] = []): TestContext {
	const ctx = testContext(argv, {
		exec: async (cmd: readonly string[]): Promise<ExecResult> => {
			const remote = cmd.slice(cmd.indexOf("--") + 2);
			remotes.push(remote);
			if (remote[0] === "claim") return { exitCode: 0, stdout: CLAIMED, stderr: "" };
			if (remote[0] === "heartbeat") return { exitCode: 0, stdout: '{"heartbeat":["R1"],"unknown":[]}', stderr: "" };
			return { exitCode: 0, stdout: '{"released":["R1"]}', stderr: "" };
		},
	});
	ctx.env.WARDEN_SESSION_ID = "s1";
	putHost(ctx.db, { name: "mac", ssh: { hostname: "mac.tail" }, addedAt: 1 });
	ctxs.push(ctx);
	return ctx;
}

const again = (ctx: TestContext, argv: string[]): TestContext => {
	ctx.argv = argv;
	ctx.stdout.length = 0;
	return ctx;
};

describe("warden claim --host", () => {
	test("claims on the host and prints the local lease with the host and the device", async () => {
		const remotes: string[][] = [];
		const ctx = context(["ios", "--host", "mac", "--profile", "iphone-17", "--json"], remotes);
		expect(await claimCommand.run(ctx)).toBe(0);
		expect(remotes[0]?.slice(0, 3)).toEqual(["claim", "ios", "--json"]);
		expect(remotes[0]).toContain("iphone-17");
		const out = JSON.parse(ctx.stdout.join(""));
		expect(out.leases[0]).toMatchObject({ host: "mac", remoteLeaseId: "R1", udid: "U1", platform: "ios" });
		expect(out.udids).toEqual(["U1"]);
		expect(ctx.db.listLeases()[0]?.resource.kind).toBe("host-device");
	});

	test("--host with --remote, --physical or --view is a usage error", async () => {
		for (const extra of [["--remote"], ["--physical"], ["--view"]]) {
			const ctx = context(["ios", "--host", "mac", ...extra]);
			expect(await claimCommand.run(ctx)).toBe(1);
			expect(ctx.stderr.join("\n")).toContain("--host");
		}
	});

	test("an unknown host exits 15 (HOST_UNKNOWN)", async () => {
		const ctx = context(["ios", "--host", "nope"]);
		expect(await claimCommand.run(ctx)).toBe(15);
	});

	test("heartbeat and release are forwarded to the host; ls shows the host", async () => {
		const remotes: string[][] = [];
		const ctx = context(["ios", "--host", "mac", "--json"], remotes);
		await claimCommand.run(ctx);
		const id = ctx.db.listLeases()[0]?.id ?? "";
		expect(await heartbeatCommand.run(again(ctx, [id, "--json"]))).toBe(0);
		expect(remotes.at(-1)).toEqual(["heartbeat", "R1", "--json"]);
		expect(await lsCommand.run(again(ctx, ["--json"]))).toBe(0);
		expect(JSON.parse(ctx.stdout.join("")).leases[0].resource.host).toBe("mac");
		expect(await lsCommand.run(again(ctx, ["--hosts", "--json"]))).toBe(0);
		expect(JSON.parse(ctx.stdout.join("")).leases).toHaveLength(1);
		expect(await releaseCommand.run(again(ctx, [id, "--shutdown", "--json"]))).toBe(0);
		expect(remotes.at(-1)).toEqual(["release", "R1", "--json", "--shutdown"]);
		expect(JSON.parse(ctx.stdout.join("")).hostReleased).toEqual(["R1"]);
		expect(ctx.db.listLeases()).toHaveLength(0);
	});
});
