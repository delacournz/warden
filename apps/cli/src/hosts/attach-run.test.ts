import { afterEach, describe, expect, test } from "bun:test";
import { fakeExec, type TestContext, testContext } from "../testing";
import { attachOptions } from "./attach-run";

const ctxs: TestContext[] = [];
afterEach(() => {
	for (const ctx of ctxs.splice(0)) ctx.cleanup();
});

const base = { grant: "ssh-ed25519 AAA warden:m:u", as: "ci", listen: "127.0.0.1" };

function context(): TestContext {
	const ctx = testContext([], { exec: fakeExec([["tailscale ip -4", { stdout: "100.64.0.9\nfd7a::1\n" }]]) });
	ctxs.push(ctx);
	return ctx;
}

describe("attachOptions", () => {
	test("plain, advertised, tailnet and dialled-out requests", async () => {
		const ctx = context();
		expect(await attachOptions(ctx, base)).toEqual({
			success: true,
			data: { grant: base.grant, name: "ci", listen: "127.0.0.1" },
		});
		expect(await attachOptions(ctx, { ...base, advertise: "100.64.0.9", port: "2222" })).toMatchObject({
			data: { advertise: "100.64.0.9", port: 2222 },
		});
		expect(await attachOptions(ctx, { ...base, tailscale: true })).toMatchObject({ data: { listen: "100.64.0.9" } });
		expect(await attachOptions(ctx, { ...base, jump: "ci@bastion", jumpPort: "2201" })).toMatchObject({
			data: { jump: { target: "ci@bastion", remotePort: 2201 } },
		});
	});

	test("what's wrong with the flags, first", async () => {
		const ctx = context();
		const why = async (flags: Parameters<typeof attachOptions>[1]) => {
			const r = await attachOptions(ctx, flags);
			return r.success ? "" : r.error;
		};
		expect(await why({ as: "ci", listen: "127.0.0.1" })).toContain("--grant");
		expect(await why({ ...base, tailscale: true, jump: "b", jumpPort: "1" })).toContain("pick one");
		expect(await why({ ...base, jump: "b" })).toContain("--jump-port");
		expect(await why({ ...base, jumpPort: "1" })).toContain("need --jump");
		expect(await why({ ...base, port: "99999" })).toContain("not a port");
	});
});
