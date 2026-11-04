import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOST_OWNER_ENV } from "@delacour/warden-core/hosts/registry";
import { wardenHome } from "@delacour/warden-core/store";
import type { Owner } from "@delacour/warden-core/types";
import { type TestContext, testContext } from "../testing";
import { packPerfSession, perfSendRefusal, unpackInto } from "./evidence";

const ctxs: TestContext[] = [];
afterEach(() => {
	for (const ctx of ctxs.splice(0)) ctx.cleanup();
});

const ID = "20261104-101500-abc123";
const HOST_OWNER: Owner = { kind: "host", machineId: "m1", user: "me" };

function host(): TestContext {
	const ctx = testContext([]);
	ctx.env[HOST_OWNER_ENV] = JSON.stringify({ machineId: "m1", user: "me" });
	ctxs.push(ctx);
	const dir = join(wardenHome(ctx.env), "perf", ID);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "session.json"), JSON.stringify({ id: ID, device: { udid: "U1", platform: "ios" } }));
	writeFileSync(join(dir, "report.md"), "# report\n");
	return ctx;
}

describe("perfSendRefusal", () => {
	test("a session on a device the caller holds a lease on is sent; anything else is refused", () => {
		const ctx = host();
		expect(perfSendRefusal(ctx, ID)).toContain("no lease of yours on U1");
		ctx.db.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "U1", name: "iPhone" }, owner: HOST_OWNER, ttlMs: 90_000 },
			0
		);
		expect(perfSendRefusal(ctx, ID)).toBeUndefined();
		expect(perfSendRefusal(ctx, "../../etc")).toContain("not a perf session id");
		expect(perfSendRefusal(ctx, "20261104-101500-ffffff")).toContain("no perf session");
	});
});

describe("packPerfSession → unpackInto", () => {
	test("the session's directory arrives whole under the target", async () => {
		const ctx = host();
		const laptop = testContext([]);
		ctxs.push(laptop);
		const out = join(laptop.cwd, "evidence");
		const tar = packPerfSession(ctx, ID);
		const r = await unpackInto(out, tar);
		if (!r.success) throw new Error(r.error);
		expect(readFileSync(join(out, ID, "report.md"), "utf8")).toBe("# report\n");
		expect(existsSync(join(out, ID, "session.json"))).toBe(true);
	});
});
