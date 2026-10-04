import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import type { e2eFlowSchema, e2eSuiteSchema } from "../affected/affected.schema";
import type { batchPresetSchema } from "../batch/preset.schema";
import type { appOptionSchema } from "./app-option.schema";
import type { projectConfigSchema, wardenConfigSchema } from "./config";
import {
	defineConfig,
	type WardenAppOption,
	type WardenBatchPreset,
	type WardenConfig,
	type WardenE2eFlow,
	type WardenE2eSuite,
	type WardenProject,
} from "./define-config";

/** Compile-time check: the hand-written, documented types accept exactly what the zod schemas accept. */
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type Conformance = [
	Assert<Equals<WardenAppOption, z.input<typeof appOptionSchema>>>,
	Assert<Equals<WardenProject, z.input<typeof projectConfigSchema>>>,
	Assert<Equals<WardenBatchPreset, z.input<typeof batchPresetSchema>>>,
	Assert<Equals<WardenE2eFlow, z.input<typeof e2eFlowSchema>>>,
	Assert<Equals<WardenE2eSuite, z.input<typeof e2eSuiteSchema>>>,
	Assert<Equals<WardenConfig, z.input<typeof wardenConfigSchema>>>,
];

describe("defineConfig", () => {
	test("returns an object config unchanged", () => {
		const config = { projects: [{ name: "app", bundleId: { ios: "com.x.app" } }] };
		expect(defineConfig(config)).toBe(config);
	});

	test("returns a config function unchanged", () => {
		const fn = ({ env }: { env: Record<string, string | undefined> }) => ({
			projects: [{ name: "app", bundleId: { ios: env.BUNDLE_ID ?? "com.x.app" } }],
		});
		expect(defineConfig(fn)).toBe(fn);
	});
});
