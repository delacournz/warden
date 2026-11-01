import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import type { RuntimeFiles } from "../e2e/e2e-runtime";
import { e2eBundle } from "./e2e-bundle";

/** The bundled runtime keeps only the runtime's own `bun:test`: `zod` is inlined, there is no `node_modules` to find it in. */
const RUNTIME_EXTERNALS = ["bun:test"] as const;

export class E2eRuntimePack {
	/** `packages/e2e/src/{index,preload}.ts` bundled for `version`, as a file map (the embedded runtime). */
	async bundleRuntime(input: { srcDir: string; version: string }): AsyncResult<RuntimeFiles> {
		const outDir = mkdtempSync(join(tmpdir(), "warden-e2e-runtime-"));
		try {
			const built = await e2eBundle.bundleE2e({ ...input, outDir, externals: RUNTIME_EXTERNALS });
			if (!built.success) return built;
			const files: Record<string, string> = {};
			for (const name of readdirSync(outDir)) files[name] = readFileSync(join(outDir, name), "utf8");
			return resultFactory.ok(files);
		} catch (cause) {
			return resultFactory.err(`@delacour/warden-e2e runtime bundle failed: ${String(cause)}`);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}

	/** Write the runtime blob `bun build --compile` embeds (JSON: file name → text). */
	async writeRuntimeBlob(input: { srcDir: string; version: string; outFile: string }): AsyncResult<void> {
		const bundled = await this.bundleRuntime(input);
		if (!bundled.success) return bundled;
		writeFileSync(input.outFile, JSON.stringify(bundled.data));
		return resultFactory.ok(undefined);
	}
}

export const e2eRuntimePack = new E2eRuntimePack();
