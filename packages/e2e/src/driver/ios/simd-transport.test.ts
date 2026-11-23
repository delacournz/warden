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
