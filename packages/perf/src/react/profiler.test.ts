import { describe, expect, test } from "bun:test";
import { reactProfileStatus, startReactProfile, stopReactProfile } from "./profiler";
import { fakeGlobal, fakeHook, fakeRenderer, runtimeCdp } from "./react.testing";

describe("start / stop over CDP", () => {
	test("start and stop are separate connections: the state lives in the runtime", async () => {
		const g = fakeGlobal(fakeHook([fakeRenderer()]));
		const started = await startReactProfile(runtimeCdp(g), { owner: "agent:a" });
		expect(started).toMatchObject({ success: true, data: { dev: true, bootstrapped: false } });
		const status = await reactProfileStatus(runtimeCdp(g));
		expect(status).toMatchObject({ success: true, data: { profiling: true, owner: { owner: "agent:a" } } });
		const stopped = await stopReactProfile(runtimeCdp(g), { owner: "agent:a", hostWallMs: 42 });
		if (!stopped.success) throw new Error(stopped.error.message);
		const file = stopped.data;
		expect(file.anchor.hostWallMs).toBe(42);
		expect(file.commits).toHaveLength(2);
		const [first, second] = file.commits;
		expect(first).toMatchObject({
			index: 0,
			durationMs: 40,
			passiveEffectMs: 2,
			updaters: ["FeedList"],
			root: "RootApp",
		});
		expect(first?.startMs).toBe(80);
		expect(first?.wallMs).toBe(file.anchor.startedWallMs + 80);
		expect(first?.fibers.find((f) => f.name === "FeedRow")?.causes).toEqual({
			firstMount: false,
			props: ["onPress", "style"],
			state: false,
			hooks: [],
			context: false,
		});
		expect(first?.fibers.find((f) => f.name === "ThemedText")?.causes?.context).toBe(true);
		expect(first?.fibers.find((f) => f.name === "FeedList")).toMatchObject({
			compiler: true,
			selfMs: 1.5,
			causes: { state: true, hooks: [0] },
		});
		expect(second?.fibers[0]?.causes).toBeNull();
		expect(file.warnings).toEqual([]);
	});

	test("typed failures survive the round trip", async () => {
		const release = await startReactProfile(runtimeCdp(fakeGlobal(fakeHook([fakeRenderer()]), { __DEV__: false })), {
			owner: "a",
		});
		expect(release).toMatchObject({ success: false, error: { code: "release_build" } });
		const g = fakeGlobal(fakeHook([fakeRenderer()]));
		await startReactProfile(runtimeCdp(g), { owner: "a" });
		const busy = await startReactProfile(runtimeCdp(g), { owner: "b" });
		expect(busy).toMatchObject({ success: false, error: { code: "session_active", owner: "a" } });
		const idle = await stopReactProfile(runtimeCdp(fakeGlobal(fakeHook([fakeRenderer()]))), { owner: "a" });
		expect(idle).toMatchObject({ success: false, error: { code: "not_profiling" } });
	});

	test("an evaluate that throws, or a non-string reply, is cdp_failed / invalid_data", async () => {
		const threw = runtimeCdp(fakeGlobal(fakeHook([])));
		const bad = { ...threw, send: async () => ({ success: true as const, data: { result: { value: 5 } } }) };
		expect(await startReactProfile(bad, { owner: "a" })).toMatchObject({
			success: false,
			error: { code: "invalid_data" },
		});
		const down = {
			...threw,
			send: async () => ({ success: false as const, error: { code: "x", message: "socket closed" } }),
		};
		expect(await startReactProfile(down, { owner: "a" })).toMatchObject({
			success: false,
			error: { code: "cdp_failed" },
		});
	});
});
