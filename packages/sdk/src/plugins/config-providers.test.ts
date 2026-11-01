import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { processExec } from "@delacour/warden-runtime/exec";
import { GitFactsCache } from "@delacour/warden-runtime/git-facts";
import { storeLocator } from "@delacour/warden-store/store";
import { fakeFarm } from "../../examples/fake-provider";
import { createWardenClient } from "../client";
import { isWardenError } from "../errors";
import type { WardenClientOptions } from "../sdk.types";
import { configStopAt, loadConfigProviders } from "./config-providers";
import { runProviderConformance } from "./provider-conformance";

const ENV = {
	WARDEN_CAPACITY: "off",
	WARDEN_ARRANGE: "0",
	WARDEN_BACKGROUND: "0",
	WARDEN_SESSION_ID: "sdk-config-providers-test",
	HOME: "/nonexistent",
};
const EXAMPLE = resolve(import.meta.dir, "../../examples/fake-provider.ts");

let dir = "";
let home = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-sdk-cfgprov-"));
	home = join(dir, "home");
	mkdirSync(home);
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function options(extra: Partial<WardenClientOptions> = {}): WardenClientOptions {
	return { home, host: { env: { ...ENV, WARDEN_HOME: home }, cwd: dir }, ...extra };
}

function writeConfig(providers: string[]): void {
	writeFileSync(join(dir, "warden.config.ts"), `export default { providers: ${JSON.stringify(providers)} };\n`);
}

async function failureOf(run: () => Promise<unknown>): Promise<{ code: string }> {
	try {
		await run();
	} catch (error) {
		if (isWardenError(error)) return error;
		throw error;
	}
	throw new Error("expected a WardenError");
}

runProviderConformance("example fake-provider", () => fakeFarm());

describe("providers in warden.config.ts", () => {
	test("a client with no in-code providers claims through the config's plugin", async () => {
		writeConfig([EXAMPLE]);
		await using warden = createWardenClient(options());
		const [lease] = await warden.leases.claim({ platform: "android", provider: "fake-farm" });
		expect(lease?.provider).toBe("fake-farm");
	});

	test("a relative specifier resolves against the config file", async () => {
		writeFileSync(join(dir, "farm.ts"), `export { default } from ${JSON.stringify(EXAMPLE)};\n`);
		writeConfig(["./farm.ts"]);
		await using warden = createWardenClient(options());
		const rows = await warden.devices.list({ platform: "android" });
		expect(rows.filter((d) => d.provider === "fake-farm")).toHaveLength(2);
	});

	test("a second client from the same config opens a session on the first one's lease", async () => {
		writeConfig([EXAMPLE]);
		await using first = createWardenClient(options());
		const [lease] = await first.leases.claim({ platform: "android", provider: "fake-farm" });
		if (!lease) throw new Error("no lease");
		await using second = createWardenClient(options());
		await using session = await second.sessions.open({ lease });
		const snap = await session.capture.snapshot({ interactiveOnly: true });
		expect(snap.elements.some((e) => e.identifier === "start")).toBe(true);
	});

	test("the lease row stores the provider; a bundled claim leaves it null", async () => {
		writeConfig([EXAMPLE]);
		await using warden = createWardenClient(options());
		const [lease] = await warden.leases.claim({ platform: "android", provider: "fake-farm" });
		const peek = storeLocator.open(join(home, "warden.db"));
		try {
			expect(peek.getLease(lease?.id ?? "")?.provider).toBe("fake-farm");
		} finally {
			peek.close();
		}
	});

	test("a config module taking a reserved name is duplicate_provider", async () => {
		writeFileSync(
			join(dir, "bad.ts"),
			`export default { apiVersion: 1, name: "ios", platform: "ios", setup: () => { throw new Error("no"); } };\n`
		);
		writeConfig(["./bad.ts"]);
		await using warden = createWardenClient(options());
		const failed = await failureOf(() => warden.devices.list());
		expect(failed.code).toBe("duplicate_provider");
	});

	test("one name in code and in the config is duplicate_provider", async () => {
		writeConfig([EXAMPLE]);
		await using warden = createWardenClient(options({ providers: [fakeFarm()] }));
		const failed = await failureOf(() => warden.devices.list());
		expect(failed.code).toBe("duplicate_provider");
	});

	test("an unloadable module is config_invalid", async () => {
		writeConfig(["./missing.ts"]);
		await using warden = createWardenClient(options());
		const failed = await failureOf(() => warden.devices.list());
		expect(failed.code).toBe("config_invalid");
	});

	test("no config and no plugins: the config is never required for a bundled claim", async () => {
		await using warden = createWardenClient(options({ providers: [fakeFarm()] }));
		const [lease] = await warden.leases.claim({ platform: "android", provider: "fake-farm" });
		expect(lease?.provider).toBe("fake-farm");
	});
});

describe("config search bounds", () => {
	test("stops at the repo toplevel: a config above the repo is not read", async () => {
		const repo = join(dir, "repo");
		const nested = join(realpathSync(dir), "repo", "apps", "mobile");
		mkdirSync(nested, { recursive: true });
		Bun.spawnSync(["git", "init", "-q", repo]);
		writeConfig([EXAMPLE]);
		const stopAt = await configStopAt(processExec.run, nested, new GitFactsCache(), { HOME: "/nonexistent" });
		expect(realpathSync(stopAt)).toBe(realpathSync(repo));
		expect(await loadConfigProviders(nested, ENV, stopAt)).toEqual([]);
	});

	test("without a repo it stops at the home directory when cwd is under it, else at cwd", async () => {
		const project = join(home, "work", "app");
		mkdirSync(project, { recursive: true });
		const env = { HOME: home };
		expect(await configStopAt(processExec.run, project, new GitFactsCache(), env)).toBe(resolve(home));
		expect(await configStopAt(processExec.run, project, new GitFactsCache(), { HOME: "/nonexistent" })).toBe(
			resolve(project)
		);
	});

	test("a config at the stop directory itself is still found", async () => {
		writeConfig([EXAMPLE]);
		const plugins = await loadConfigProviders(dir, ENV, dir);
		expect(plugins.map((p) => p.name)).toEqual(["fake-farm"]);
	});
});
