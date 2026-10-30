import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "@delacour/warden-core/exec";
import { collectRunnerSources } from "@delacour/warden-core/ios-runner/pack";
import type { RunnerSourceFiles } from "@delacour/warden-core/ios-runner/runner-build.types";
import { ensureSimRunnerBuild } from "@delacour/warden-core/ios-runner/sim-build";
import { wardenHome } from "@delacour/warden-core/store";
import { type AsyncResult, err, type Result } from "@delacour/warden-types/result";
import { xcuitestAudit } from "../../a11y/native/xcuitest";
import type { Logger } from "../driver.types";
import type { NativeAuditOptions, NativeAuditResult } from "../native-audit";
import { createSimRunner, type SimRunner, type SimRunnerDeps } from "./sim-runner";

/**
 * The iOS Simulator's XCUITest accessibility audit: the runner build (cached, unsigned), the runner process and the
 * `audit` op behind `AuditsNatively`. Without runner sources the audit is skipped with the reason.
 */

export type IosNativeAudit = {
	audit(options: NativeAuditOptions): Promise<NativeAuditResult>;
	close(): Promise<void>;
};

export type IosNativeAuditOptions = {
	udid: string;
	exec: Exec;
	/** the app the audit checks when the caller names none */
	bundleId: () => string | undefined;
	env?: Record<string, string | undefined>;
	wardenHome?: string;
	version?: string;
	log?: Logger;
	/** the runner's Xcode project as text files; default: this checkout's `packages/e2e/native` when running from source */
	runnerSources?: () => AsyncResult<RunnerSourceFiles>;
	/** test seams */
	ensureBuild?: SimRunnerDeps["ensureBuild"];
	spawn?: SimRunnerDeps["spawn"];
	connect?: SimRunnerDeps["connect"];
};

const AUDIT_TIMEOUT_MS = 60_000;

/** `packages/e2e/native` of the checkout this file runs from; absent in a bundled install (the CLI passes the embedded blob). */
export function checkoutRunnerSources(importDir: string = import.meta.dir): AsyncResult<RunnerSourceFiles> {
	const nativeDir = join(importDir, "..", "..", "..", "native");
	if (!existsSync(join(nativeDir, "ios-runner", "WardenRunner.xcodeproj"))) {
		return Promise.resolve(err("the iOS runner sources are not bundled with this install"));
	}
	return Promise.resolve(collectRunnerSources(nativeDir));
}

export function createIosNativeAudit(o: IosNativeAuditOptions): IosNativeAudit {
	const env = o.env ?? process.env;
	const loadSources = o.runnerSources ?? (() => checkoutRunnerSources());
	const ensureBuild: SimRunnerDeps["ensureBuild"] =
		o.ensureBuild ??
		(async (): Promise<Result<{ xctestrun: string }, string>> =>
			ensureSimRunnerBuild({
				env,
				exec: o.exec,
				version: o.version ?? "0.0.0",
				loadSources,
				...(o.wardenHome ? { home: o.wardenHome } : { home: wardenHome(env) }),
				...(o.log ? { log: o.log } : {}),
			}));
	let runner: SimRunner | undefined;
	const get = (): SimRunner => {
		runner ??= createSimRunner({
			udid: o.udid,
			ensureBuild,
			...(o.spawn ? { spawn: o.spawn } : {}),
			...(o.connect ? { connect: o.connect } : {}),
			...(o.log ? { log: o.log } : {}),
		});
		return runner;
	};
	return {
		async audit(options) {
			const bundleId = options.bundleId ?? o.bundleId();
			return xcuitestAudit(
				{
					audit: async (params) => {
						const res = await get().request("audit", params, { timeoutMs: AUDIT_TIMEOUT_MS });
						return res.success ? res : { success: false, error: { code: res.error.code, message: res.error.message } };
					},
				},
				bundleId === undefined ? {} : { bundleId }
			);
		},
		async close() {
			const current = runner;
			runner = undefined;
			await current?.close();
		},
	};
}
