import { afterEach, describe, expect, test } from "bun:test";
import { cliTesting, type TestContext } from "../testing";
import type { DevReady } from "./dev-ui";
import { devUiPlain } from "./dev-ui.plain";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const READY: DevReady = {
	platform: "ios",
	deviceId: "U1",
	deviceName: undefined,
	port: 8082,
	metroUrl: "http://127.0.0.1:8082",
	leaseIds: ["L1"],
	app: undefined,
	projectName: "demo",
};

describe("plainDevUi", () => {
	test("Metro inherits the terminal; the ui's ctx is the caller's", () => {
		ctx = cliTesting.testContext(["dev"]);
		const ui = devUiPlain.plainDevUi(ctx);
		expect(ui.metro).toEqual({ kind: "inherit" });
		expect(ui.ctx).toBe(ctx);
	});

	test("task log is a ctx.err line; ok / fail print nothing", () => {
		ctx = cliTesting.testContext(["dev"]);
		const lines: string[] = [];
		ctx.err = (line) => void lines.push(line);
		const task = devUiPlain.plainDevUi(ctx).task("claim", "claiming");
		task.log("hello");
		task.ok("done");
		task.fail("nope");
		expect(lines).toEqual(["hello"]);
	});

	test("ready prints the holding note", () => {
		ctx = cliTesting.testContext(["dev"]);
		devUiPlain.plainDevUi(ctx).ready(READY);
		expect(
			ctx.stderr.some((e) => e.includes("warden dev: holding U1 + :8082 until Metro exits (WARDEN_UDID=U1)"))
		).toBe(true);
	});

	test("onQuit is a no-op and close resolves (twice)", async () => {
		ctx = cliTesting.testContext(["dev"]);
		const ui = devUiPlain.plainDevUi(ctx);
		ui.onQuit(() => {
			throw new Error("never called");
		});
		await ui.close();
		await ui.close();
	});
});
