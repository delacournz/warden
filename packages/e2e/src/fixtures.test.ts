import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@delacour/warden-types/result";
import { devtoolsErr } from "./devtools/devtools.types";
import { stubFacet } from "./devtools/facet.testing";
import type { E2eEnv } from "./env";
import { screenHostFor } from "./fixtures";
import type { DevtoolsOpener } from "./session";
import { createSession } from "./session";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function hostFor(metroUrl: string | undefined, devtools: DevtoolsOpener) {
	const out = mkdtempSync(join(tmpdir(), "wdn-fixtures-"));
	dirs.push(out);
	const env: E2eEnv = {
		udid: "U",
		platform: "ios",
		bundleId: "com.example.app",
		launchArgs: [],
		out,
		timeoutMs: 1000,
		actionTimeoutMs: 1000,
		assertionTimeoutMs: 1000,
		headless: false,
		logTimestamps: false,
		...(metroUrl === undefined ? {} : { metroUrl }),
	};
	const session = createSession({ env, exitHook: false, devtools });
	const ctx = {
		session,
		signal: new AbortController().signal,
		launch: "none" as const,
		actionTimeoutMs: 1000,
		assertionTimeoutMs: 1000,
	};
	return screenHostFor(ctx);
}

describe("screenHostFor devtools", () => {
	test("none without a Metro URL, so getByTestId never looks in React", () => {
		const host = hostFor(undefined, async () => ok(stubFacet().facet));
		expect(host.devtools?.()).toBeUndefined();
	});

	test("with a Metro URL the React tree is read through the session's facet, attached on first use", async () => {
		const stub = stubFacet();
		let opens = 0;
		const host = hostFor("http://127.0.0.1:8081", async () => {
			opens += 1;
			return ok(stub.facet);
		});
		const devtools = host.devtools?.();
		expect(devtools).toBeDefined();
		expect(opens).toBe(0);
		const tree = await devtools?.tree({ pixelRatio: 2 });
		expect(tree?.success).toBe(true);
		expect(stub.treeCalls).toEqual([{ pixelRatio: 2 }]);
		await devtools?.tree();
		expect(opens).toBe(1);
	});

	test("an app that cannot be reached answers with the failure", async () => {
		const host = hostFor("http://127.0.0.1:8081", async () => devtoolsErr("devtools_unavailable", "Metro is down"));
		const tree = await host.devtools?.()?.tree();
		expect(tree && !tree.success && tree.error.message).toBe("Metro is down");
	});
});
