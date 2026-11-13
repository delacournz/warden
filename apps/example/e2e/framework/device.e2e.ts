import { existsSync } from "node:fs";
import { beforeAll, describe, E2eError, expect, run, test, WARDEN_E2E_VERSION } from "@delacour/warden-e2e";
import { ids } from "../helpers/ids";
import { launch, SPEC_OPTIONS } from "../helpers/steps";

test.use(SPEC_OPTIONS);

/**
 * Device, app and host APIs on one launch to the welcome screen: reads of the screen, appearance, the app lifecycle
 * and `run()`. The appearance test puts back what it changed; the lifecycle tests end with the app open again.
 */
describe.serial("framework: device, app and run", () => {
	beforeAll(async ({ app, screen }) => {
		await launch(app, screen);
	});

	test("device.snapshot is the AX tree as text, interactiveOnly keeps it to controls", async ({ device }) => {
		const full = await device.snapshot();
		const interactive = await device.snapshot({ interactiveOnly: true });
		expect(full).toContain(ids.welcome.next);
		expect(interactive).toContain(ids.welcome.next);
		expect(interactive.length).toBeLessThanOrEqual(full.length);
	});

	test("device.screenshot writes a PNG and returns its path", async ({ device }) => {
		const path = await device.screenshot("welcome");
		expect(path.endsWith(".png")).toBe(true);
		expect(existsSync(path)).toBe(true);
	});

	test("device.settle on a still screen ends quiet", async ({ device }) => {
		const detail = await device.settle({ quietMs: 250, timeout: 5_000 });
		expect(detail.quiet).toBe(true);
	});

	test("device.keyboardVisible is false with no field focused", async ({ device }) => {
		expect(await device.keyboardVisible()).toBe(false);
	});

	test("device.appearance switches to dark and back", async ({ device }) => {
		const before = await device.appearance();
		const other = before === "dark" ? "light" : "dark";
		expect(await device.appearance(other)).toBe(other);
		expect(await device.appearance()).toBe(other);
		await device.appearance(before);
		expect(await device.appearance()).toBe(before);
	});

	test("app.close stops the app, app.open({ wait: { until } }) brings it back to its first screen", async ({
		app,
		screen,
	}) => {
		expect(await app.isRunning()).toBe(true);
		await app.close();
		expect(await app.isRunning()).toBe(false);
		await app.open({ wait: { until: screen.getByTestId(ids.welcome.next) } });
		expect(await app.isRunning()).toBe(true);
		await expect(screen.getByTestId(ids.welcome.next)).toBeVisible();
	});

	test("run() returns stdout, parses JSON and feeds stdin", async () => {
		const echo = await run(["echo", "hello"]);
		expect(echo).toMatchObject({ ok: true, exitCode: 0, stdout: "hello\n" });
		expect((await run(`echo '{"a":1}'`)).json()).toEqual({ a: 1 });
		expect((await run(["cat"], { input: "piped" })).stdout).toBe("piped");
	});

	test("run() with check: false returns a failed exit; the default throws RUN_FAILED", async () => {
		const failed = await run("exit 3", { check: false });
		expect(failed).toMatchObject({ ok: false, exitCode: 3 });
		let caught: unknown;
		try {
			await run("exit 3");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(E2eError);
		expect((caught as E2eError).code).toBe("RUN_FAILED");
	});

	test("WARDEN_E2E_VERSION names the spec API version", () => {
		expect(WARDEN_E2E_VERSION).toMatch(/^\d+\.\d+\.\d+/);
	});
});
