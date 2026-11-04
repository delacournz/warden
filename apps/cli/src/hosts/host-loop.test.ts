import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getHost } from "@delacour/warden-core/hosts/registry";
import { createHostCommand } from "../commands/host";
import { type HostLoop, startHostLoop } from "./host-loop.testing";
import { runOnHost } from "./remote";
import { spawnUpload } from "./setup";
import { sshdSkipReason } from "./sshd.testing";
import { treeHash, uploadToHost } from "./upload";

const loops: HostLoop[] = [];
afterEach(async () => {
	for (const loop of loops.splice(0)) await loop.stop();
});

async function host(loop: HostLoop, argv: string[]): Promise<{ code: number; json: unknown }> {
	loop.laptop.stdout.length = 0;
	loop.laptop.argv = argv;
	const code = await createHostCommand().run(loop.laptop);
	const text = loop.laptop.stdout.join("");
	return { code, json: text === "" ? undefined : JSON.parse(text) };
}

describe.skipIf(sshdSkipReason(process.env) !== undefined)("warden host over a loopback sshd", () => {
	test("add → setup → doctor; the granted key only runs allowed commands", async () => {
		const loop = await startHostLoop();
		loops.push(loop);

		const added = await host(loop, loop.addArgv);
		expect(added.code).toBe(0);
		expect(added.json).toMatchObject({ warden: null });

		const setup = await host(loop, loop.setupArgv);
		if (setup.code !== 0) throw new Error(loop.laptop.stderr.join("\n"));
		expect(setup.json).toMatchObject({ host: "loop", wardenPath: join(loop.installDir, "warden"), helper: "skipped" });
		const record = getHost(loop.laptop.db, "loop");
		expect(record?.identity).toBe(join(loop.laptop.env.WARDEN_HOME ?? "", "hosts", "id_ed25519"));
		expect(readFileSync(join(loop.sshd.dir, "authorized_keys"), "utf8")).toContain("__host-serve --key SHA256:");

		const doctor = await host(loop, ["doctor", "loop", "--json"]);
		expect(doctor.json).toMatchObject({ checks: [{ name: "warden", ok: true }, { name: "leases" }] });

		if (record === undefined) throw new Error("no record");
		const refused = await runOnHost(loop.laptop, record, [record.wardenPath ?? "warden", "gc", "--json"]);
		expect(refused.success && refused.data.exitCode).toBe(2);
		expect(refused.success && refused.data.stderr).toContain("not allowed");
		const shell = await runOnHost(loop.laptop, record, ["sh", "-c", "id"]);
		expect(shell.success && shell.data.exitCode).toBe(2);
	}, 60_000);

	test("a build is sent once through __host-recv, by content hash", async () => {
		const loop = await startHostLoop();
		loops.push(loop);
		expect((await host(loop, loop.addArgv)).code).toBe(0);
		const setup = await host(loop, loop.setupArgv);
		if (setup.code !== 0) throw new Error(loop.laptop.stderr.join("\n"));
		const app = join(loop.laptop.cwd, "Example.app");
		mkdirSync(app, { recursive: true });
		writeFileSync(join(app, "Example"), "binary");
		const hash = await treeHash(app);
		let sends = 0;
		const upload: typeof spawnUpload = async (argv, file) => {
			sends++;
			return spawnUpload(argv, file);
		};
		const first = await uploadToHost(loop.laptop, "loop", app, { upload });
		if (!first.success) throw new Error(first.error);
		expect(first.data).toEndWith(join("uploads", hash, "Example.app"));
		expect(existsSync(join(first.data, "Example"))).toBe(true);
		const again = await uploadToHost(loop.laptop, "loop", app, { upload });
		expect(again.success && again.data).toBe(first.data);
		expect(sends).toBe(1);
	}, 60_000);
});
