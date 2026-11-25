import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeRelay } from "../hosts/relay.testing";

const CLI = join(import.meta.dir, "..", "cli.ts");

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "whrelay-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function env(wardenHome: string, extra: Record<string, string>): Record<string, string | undefined> {
	return {
		PATH: process.env.PATH,
		HOME: wardenHome,
		WARDEN_HOME: wardenHome,
		WARDEN_BACKGROUND: "0",
		NO_COLOR: "1",
		...extra,
	};
}

async function warden(args: string[], e: Record<string, string | undefined>) {
	const proc = Bun.spawn([process.execPath, CLI, ...args], { env: e, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

async function online(url: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		const res = await fetch(`${url}/v1/hosts`, { headers: { Authorization: "Bearer user-token" } });
		const [h] = (await res.json()) as { status: string }[];
		if (h?.status === "online") return;
		await Bun.sleep(50);
	}
	throw new Error("uplink never came up");
}

describe("warden host uplink ↔ host add --cloud (fake warden-api relay)", () => {
	test("the laptop adds the relayed host, reads its warden and runs an allowed command there", async () => {
		const relay = startFakeRelay({
			hostToken: "host-token",
			userToken: "user-token",
			name: "ci",
			expiresAt: 4_102_444_800_000,
		});
		cleanups.push(() => relay.stop());
		const uplink = Bun.spawn([process.execPath, CLI, "host", "uplink"], {
			env: env(home(), { WARDEN_HOST_TOKEN: "host-token", WARDEN_API_URL: relay.url }),
			stdout: "ignore",
			stderr: "pipe",
			stdin: "ignore",
		});
		cleanups.push(async () => {
			uplink.kill("SIGTERM");
			await uplink.exited;
		});
		await online(relay.url);

		const laptop = env(home(), { WARDEN_TOKEN: "user-token", WARDEN_API_URL: relay.url });
		const added = await warden(["host", "add", "ci", "--cloud", "--json"], laptop);
		expect(added.stderr).toBe("");
		expect(added.code).toBe(0);
		const body = JSON.parse(added.stdout) as { host: Record<string, unknown>; warden: string | null };
		expect(body.host).toMatchObject({ relay: { apiUrl: relay.url, hostId: "h1" }, expiresAt: 4_102_444_800_000 });
		expect(typeof body.warden).toBe("string");

		const ls = await warden(["host", "run", "ci", "--", "ls", "--json"], laptop);
		expect(ls.code).toBe(0);
		expect(JSON.parse(ls.stdout)).toMatchObject({ leases: [] });
		expect(relay.dials.some((cmd) => cmd.includes("ls"))).toBe(true);

		const dev = await warden(["host", "rm", "ci", "--json"], laptop);
		expect(dev.code).toBe(0);
	}, 60_000);

	test("an offline host is still recorded, with what to run there", async () => {
		const relay = startFakeRelay({ hostToken: "host-token", userToken: "user-token", name: "ci" });
		cleanups.push(() => relay.stop());
		const r = await warden(
			["host", "add", "ci", "--cloud"],
			env(home(), { WARDEN_TOKEN: "user-token", WARDEN_API_URL: relay.url })
		);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("offline: run warden host uplink there");
	});

	test("--cloud with ssh flags is refused, naming them", async () => {
		const r = await warden(["host", "add", "ci", "--cloud", "--ssh", "a@b"], env(home(), {}));
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("drop --ssh");
	});
});
