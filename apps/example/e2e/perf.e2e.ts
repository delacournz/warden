import { expect, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { SPEC_OPTIONS, signedIn } from "./helpers/steps";

test.use(SPEC_OPTIONS);

/**
 * `device.perf`: profile the todos spec and hold the report to budgets. The suite's budgets come from
 * `perf.budgets` in `warden.config.ts`; the `budgets` passed to `stop` replace them per key for this spec. The
 * `react` capture needs the dev client (`example-dev`), so it is only asked for when Metro is up; a capture that did
 * not run has no number and cannot breach. The report lands in the attempt's `perf/` dir.
 */
test("adding todos stays inside the perf budgets", async ({ app, device, screen }) => {
	await signedIn(app, screen);

	await device.perf.start({ metrics: true, frames: true, react: device.devtools !== undefined });
	await device.perf.mark("add todo");
	await screen.getByTestId(ids.todos.input).fill("Profile me");
	await screen.getByTestId(ids.todos.add).tap();
	await expect(screen.getByTestId(ids.todos.title("todo-1"))).toHaveText("Profile me");

	await device.perf.mark("filter");
	await screen.getByTestId(ids.todos.filter("active")).tap();
	await expect(screen.getByTestId(ids.todos.row("welcome"))).toBeVisible();

	const report = await device.perf.stop({ budgets: { jankPct: 10 } });
	expect(report.sessionId).not.toBe("");
});
