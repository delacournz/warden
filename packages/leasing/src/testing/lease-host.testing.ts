import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAndroidProvider } from "@delacour/warden-providers/android";
import { createIosProvider } from "@delacour/warden-providers/ios";
import type { Exec } from "@delacour/warden-runtime/exec";
import { createGitFactsCache } from "@delacour/warden-runtime/git-facts";
import { liveness } from "@delacour/warden-store/liveness";
import { type Store, storeLocator } from "@delacour/warden-store/store";
import type { WardenLogEvent } from "@delacour/warden-types/host";
import type { HostFacts } from "../host";
import type { LeaseHost } from "../lease-host";

/** The host every test lease host budgets from (12 cpu units): capacity never binds by accident, on any CI runner. */
export const TEST_HOST_FACTS: HostFacts = { totalMem: 64 * 1024 ** 3, perfCores: 20, effCores: 4, os: "darwin" };

export type TestLeaseHost = LeaseHost & {
	/** every `host.log` event, in order */
	events: WardenLogEvent[];
	/** devices `stopHelper` was called for */
	stopped: string[];
	dir: string;
	db: Store;
	cleanup: () => void;
};

/** A temp-store lease host with captured log events and plain (golden-free) providers. Call `cleanup()` in afterEach. */
export function testLeaseHost(overrides: Partial<LeaseHost> = {}): TestLeaseHost {
	const dir = mkdtempSync(join(tmpdir(), "warden-lease-host-"));
	const db = storeLocator.open(join(dir, "warden.db"));
	const events: WardenLogEvent[] = [];
	const stopped: string[] = [];
	const exec: Exec = async () => ({ exitCode: 0, stdout: "", stderr: "" });
	const host: TestLeaseHost = {
		env: { WARDEN_HOME: dir, HOME: dir, WARDEN_BACKGROUND: "0", WARDEN_ARRANGE: "0" },
		cwd: dir,
		home: dir,
		now: () => 1_000_000,
		exec,
		sleep: async () => {},
		pidAlive: liveness.processAlive,
		log: (event) => events.push(event),
		store: () => db,
		git: createGitFactsCache(),
		hostFacts: async () => TEST_HOST_FACTS,
		providerFor: (platform, owner) => {
			const deps = {
				exec: host.exec,
				store: db,
				env: host.env,
				now: host.now,
				owner,
				log: (line: string) => host.log?.({ kind: "progress", phase: "claim", message: line }),
			};
			return platform === "android" ? createAndroidProvider(deps) : createIosProvider(deps);
		},
		stopHelper: async (udid) => {
			stopped.push(udid);
		},
		...overrides,
		events,
		stopped,
		dir,
		db,
		cleanup: () => {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
	return host;
}
