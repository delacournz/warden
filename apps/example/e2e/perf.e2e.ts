import { expect, test } from "@delacour/warden-e2e";
import { ENV_NAMES } from "@delacour/warden-e2e/env";
import { ids } from "./helpers/ids";
import { SPEC_OPTIONS, signedIn } from "./helpers/steps";

test.use(SPEC_OPTIONS);

/**
 * `device.perf`: profile the todos spec and hold the report to budgets. The suite's budgets come from
 * `perf.budgets` in `warden.config.ts`; the `budgets` passed to `stop` replace them per key for this spec. The
 * `react` capture needs the dev client (`warden e2e example --dev`), so it is only asked for when Metro is up; a capture that did
 * not run has no number and cannot breach. The report lands in the attempt's `perf/` dir.
 */
test("adding todos stays inside the perf budgets", async ({ app, device, screen, platform }) => {
	await signedIn(app, screen);

	await device.perf.start({ metrics: true, frames: true, react: device.devtools !== undefined });
	await device.perf.mark("add todo");
	await screen.getByTestId(ids.todos.input).fill("Profile me");
	await screen.getByTestId(ids.todos.add).tap();
	await expect(screen.getByTestId(ids.todos.title("todo-1"))).toHaveText("Profile me");

	await device.perf.mark("filter");
	await screen.getByTestId(ids.todos.filter("active")).tap();
	await expect(screen.getByTestId(ids.todos.row("welcome"))).toBeVisible();

	/*
	 * Android emulators render frames in software, so jank reads 23-55% there whatever the app does (reduce motion made it
	 * worse): not a signal, so the jankPct budget is dropped for them and only them. iOS simulators and physical devices
	 * keep it, and every other budget (`maxCommitMs`, `p95CpuPct`, `peakMemoryMb`) stays on everywhere. The suite's
	 * `perf.budgets.jankPct` in `warden.config.ts` is the ceiling for a profiling run; this spec sets 10 for its own run.
	 */
	const softwareRendered = platform === "android" && process.env[ENV_NAMES.deviceKind] !== "physical";
	const report = await device.perf.stop({ budgets: { jankPct: softwareRendered ? undefined : 10 } });
	expect(report.sessionId).not.toBe("");
});
