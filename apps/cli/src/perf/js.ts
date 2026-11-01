import { readFileSync } from "node:fs";
import type { Command as Commander } from "@commander-js/extra-typings";
import { type Hotspots, hotspotsAnalyzer } from "@delacour/warden-perf/js/hotspots";
import { type JsParams, type JsPlan, perfJsOps } from "@delacour/warden-sdk/ops/perf/js";
import {
	defaultJsDeps,
	type JsDeps,
	type JsProfileResult,
	type JsSession,
} from "@delacour/warden-sdk/ops/perf/js-capture";
import { type JsOut, jsOutPaths } from "@delacour/warden-sdk/ops/perf/js-out";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { type UiError, type UiSuccess, uiOutput } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { perfAppCli } from "./app";
import { perfBrokerResumeCli } from "./broker-resume";
import type { PerfTarget } from "./device";
import { perfOptionsCli } from "./options";
import { type PerfDeps, type PerfOptionValues, perfRunCli } from "./run";

export type PerfJsOptions = PerfOptionValues & JsParams & { metro?: string };

type Connected = { session: JsSession; metro: string; app: string };

export class PerfJsCli {
	/** App, Metro and the Hermes socket for a device; the caller closes `session`. */
	async connectJs(
		ctx: CommandContext,
		deps: PerfDeps,
		js: JsDeps,
		target: PerfTarget,
		opts: { app?: string; metro?: string },
		timeoutMs: number
	): Promise<Result<Connected, UiError>> {
		const app = await perfAppCli.resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
		if (!app.success) return app;
		const connected = await perfJsOps.connectJsApp(ctx, deps, js, target, app.data.id, opts.metro, timeoutMs);
		if (!connected.success) return connected;
		return resultFactory.ok({
			...connected.data,
			session: perfBrokerResumeCli.resumeBrokerOnClose(ctx, target.udid, connected.data.session),
		});
	}

	/**
	 * The profile taken on the dev session's broker socket (`profile.start` / `profile.stop`) when `warden dev` serves
	 * the device: no second Hermes socket, so a single-debugger Metro never evicts the broker. `undefined` = no broker,
	 * use the direct path. Artifacts stay in the session's `profiles/` dir, not the perf session's `js/`.
	 */
	private async brokeredProfile(
		ctx: CommandContext,
		target: PerfTarget,
		opts: PerfJsOptions,
		plan: JsPlan,
		out: JsOut,
		sleep: JsDeps["sleep"]
	): Promise<Result<UiSuccess, UiError> | undefined> {
		const { udid } = target;
		const { devBrokerProfileClient: client } = await import("../dev-broker/profile-client");
		if (!client.brokerSocketFor(ctx.env, { udid }).success) return undefined;
		const started = await client.startProfile(ctx.env, {
			udid,
			kind: "cpu",
			samplingIntervalUs: plan.samplingIntervalUs,
		});
		if (!started.success) {
			return {
				success: false,
				error: uiOutput.uiError(
					"failed",
					started.error.message,
					started.error.hint ? { hint: started.error.hint } : {}
				),
			};
		}
		await sleep(plan.durationMs);
		const stopped = await client.stopProfile(ctx.env, { udid, kind: "cpu" });
		if (!stopped.success) {
			return {
				success: false,
				error: uiOutput.uiError(
					"failed",
					stopped.error.message,
					stopped.error.hint ? { hint: stopped.error.hint } : {}
				),
			};
		}
		const summary = stopped.data.summary;
		if (summary.kind !== "cpu")
			return { success: false, error: uiOutput.uiError("failed", "broker returned a non-CPU profile") };
		try {
			const hotspots: Hotspots = JSON.parse(readFileSync(summary.hotspotsPath, "utf8"));
			const result: JsProfileResult = {
				cpuPath: stopped.data.path,
				hotspotsPath: summary.hotspotsPath,
				hotspots,
				findings: hotspotsAnalyzer.hotspotFindings(hotspots),
				section: hotspotsAnalyzer.hotspotsSection(hotspots),
			};
			const app = await perfAppCli.resolveApp(ctx, { platform: target.platform, id: udid }, opts.app);
			return resultFactory.ok(
				perfJsOps.jsSuccess(ctx, target, app.success ? app.data.id : "app", out, result, plan.durationMs)
			);
		} catch (error) {
			return {
				success: false,
				error: uiOutput.uiError("failed", `cannot read ${summary.hotspotsPath}: ${String(error)}`),
			};
		}
	}

	private capturingError(out: JsOut, udid: string): UiError {
		return uiOutput.uiError("session_active", `session ${out.sessionId} already holds the JS profiler on ${udid}`, {
			hint: "its profile lands in js/cpu.cpuprofile when it stops (warden perf stop)",
		});
	}

	/**
	 * `warden perf js [--duration 10s] [--sampling-interval 100]`: a Hermes JS CPU profile of the running dev client,
	 * source-mapped to `file:line` hotspots. Observe-only. Writes `js/cpu.cpuprofile` and `js/hotspots.json` into the
	 * running session, else a one-shot dir under `$WARDEN_HOME/perf`. The profile is held by this process's socket for
	 * the whole capture; a JS reload during it loses the profile.
	 */
	perfJs(ctx: CommandContext, deps: PerfDeps, opts: PerfJsOptions, js: JsDeps = defaultJsDeps): Promise<number> {
		return perfRunCli.runPerf(ctx, deps, "js", "observe", opts, async (target, env) => {
			const planned = perfJsOps.planJs(opts);
			if (!planned.success) return planned;
			const out = jsOutPaths.jsOutFor(ctx, deps.session, target.udid, "js");
			if (out.jsCapturing) return { success: false, error: this.capturingError(out, target.udid) };
			const brokered = await this.brokeredProfile(ctx, target, opts, planned.data, out, js.sleep);
			if (brokered !== undefined) return brokered;
			const app = await perfAppCli.resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
			if (!app.success) return app;
			const resuming: JsDeps = {
				...js,
				open: async (options) => {
					const opened = await js.open(options);
					return opened.success
						? resultFactory.ok(perfBrokerResumeCli.resumeBrokerOnClose(ctx, target.udid, opened.data))
						: opened;
				},
			};
			return perfJsOps.jsWork(ctx, deps, resuming, target, app.data.id, planned.data, opts.metro, env.timeoutMs);
		});
	}

	/** Wire `js` onto `warden perf`. */
	readonly registerJs = (cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps): void => {
		perfOptionsCli
			.withPerfOptions(
				cmd
					.command("js")
					.description(
						"Hermes JS CPU profile of the dev client, source-mapped to file:line hotspots (js/cpu.cpuprofile)"
					)
					.option("--duration <time>", "how long to sample (default 10s, max 5m)")
					.option("--sampling-interval <us>", "sampling period in microseconds (default 100)")
					.option("--metro <url>", "Metro to attach through (default: the one serving the device)")
			)
			.action(async (opts) => {
				done(await this.perfJs(ctx, deps, opts));
			});
	};
}

export const perfJsCli = new PerfJsCli();
