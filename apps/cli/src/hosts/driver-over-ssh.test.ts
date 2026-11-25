import { afterEach, describe, expect, test } from "bun:test";
import { stdioTransport } from "@delacour/warden-e2e/driver/ios/simd-transport";
import { connectRemoteDriver, type RemoteClient } from "@delacour/warden-e2e/driver/remote/remote-client";
import { type LoopbackSshd, sshdSkipReason, startLoopbackSshd } from "./sshd.testing";

const FIXTURE = Bun.resolveSync("@delacour/warden-e2e/driver/remote/remote-stdio.fixture", import.meta.dir);

const sshds: LoopbackSshd[] = [];
const clients: RemoteClient[] = [];
afterEach(async () => {
	for (const client of clients.splice(0)) await client.close();
	for (const sshd of sshds.splice(0)) await sshd.stop();
});

describe.skipIf(sshdSkipReason(process.env) !== undefined)("a remote driver over ssh", () => {
	test("connectRemoteDriver reaches a driver served on the far side's stdio", async () => {
		const sshd = await startLoopbackSshd({ forcedCommand: `${process.execPath} ${FIXTURE}` });
		sshds.push(sshd);
		const connected = await connectRemoteDriver({
			transport: stdioTransport({ cmd: sshd.sshArgv(["warden", "__driver-serve", "--lease", "L1"]) }),
			label: "ssh loop",
			readyTimeoutMs: 10_000,
		});
		if (!connected.success) throw new Error(connected.error.message);
		clients.push(connected.data);
		const remote = connected.data.driver();
		expect(remote.id).toBe("fixture-device");
		expect(await remote.tap({ x: 5, y: 5 })).toEqual({ success: true, data: undefined });
		const shot = await remote.snapshot();
		expect(shot.success && shot.data.flat.map((e) => e.label)).toEqual(["From the fixture"]);
	});

	test("an ssh that cannot authenticate fails the connect with the ssh error", async () => {
		const sshd = await startLoopbackSshd({ forcedCommand: "true" });
		sshds.push(sshd);
		const stranger = { path: `${sshd.dir}/nobody`, publicKey: "" };
		await Bun.write(stranger.path, "");
		const connected = await connectRemoteDriver({
			transport: stdioTransport({ cmd: sshd.sshArgv([], { identity: stranger }) }),
			label: "ssh loop",
			readyTimeoutMs: 10_000,
		});
		expect(connected.success).toBe(false);
		if (!connected.success) expect(connected.error.code).toBe("E_HELPER_CRASHED");
	});
});
