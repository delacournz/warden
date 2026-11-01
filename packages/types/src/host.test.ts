import { describe, expect, test } from "bun:test";
import type { WardenHost, WardenLogEvent } from "./host";

describe("WardenHost", () => {
	test("a minimal host and every log event kind type-check", async () => {
		const events: WardenLogEvent[] = [];
		const host: WardenHost = {
			env: {},
			cwd: "/w",
			home: "/h",
			now: () => 1,
			sleep: async () => {},
			pidAlive: () => true,
			exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			log: (e) => events.push(e),
		};
		host.log?.({ kind: "progress", phase: "boot", message: "booting" });
		host.log?.({ kind: "warn", message: "w" });
		host.log?.({ kind: "debug", message: "d" });
		host.log?.({ kind: "lease", action: "claimed", leaseId: "l1" });
		expect(events.map((e) => e.kind)).toEqual(["progress", "warn", "debug", "lease"]);
		expect((await host.exec(["x"])).exitCode).toBe(0);
	});
});
