import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodePrivateFs } from "@delacour/warden-core/private-fs";
import { socketTransport } from "./simd-transport";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("socketTransport", () => {
	test("a TCP target's first line is sent before anything else", async () => {
		const received: string[] = [];
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(_socket, chunk) {
					received.push(Buffer.from(chunk).toString("utf8"));
				},
			},
		});
		const handlers = { onLine: () => undefined, onClose: () => undefined, onDiagnostic: () => undefined };
		try {
			const transport = await socketTransport({
				tcp: { hostname: "127.0.0.1", port: listener.port },
				firstLine: '{"op":"auth","token":"t"}\n',
			})(handlers);
			if (!transport.success) throw new Error(transport.error.message);
			transport.data.send('{"id":"1","op":"health"}\n');
			const end = Date.now() + 3000;
			while (!received.join("").includes("health") && Date.now() < end) await Bun.sleep(5);
			expect(received.join("")).toBe('{"op":"auth","token":"t"}\n{"id":"1","op":"health"}\n');
			await transport.data.close();
		} finally {
			listener.stop(true);
		}
	});

	test("refuses a socket in a per-user temp directory another user owns, before connecting", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wst-"));
		dirs.push(dir);
		const tmp = join(dir, "warden-501");
		mkdirSync(tmp, { mode: 0o700 });
		const socketPath = join(tmp, "a.sock");
		const listener = Bun.listen({ unix: socketPath, socket: { data() {} } });
		const handlers = { onLine: () => undefined, onClose: () => undefined, onDiagnostic: () => undefined };
		try {
			const own = await socketTransport({ socketPath, socketScope: { tmp: () => tmp } })(handlers);
			expect(own.success).toBe(true);
			if (own.success) own.data.close();
			const other = { ...nodePrivateFs, uid: () => statSync(tmp).uid + 1 };
			const refused = await socketTransport({ socketPath, socketScope: { tmp: () => tmp, fs: other } })(handlers);
			expect(refused.success).toBe(false);
			if (!refused.success) expect(refused.error.message).toContain("is owned by uid");
		} finally {
			listener.stop(true);
		}
	});
});
