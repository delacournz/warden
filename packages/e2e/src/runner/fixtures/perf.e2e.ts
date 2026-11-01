import "./preload";
import { test } from "../../index";
import { fixtureLog } from "./fake-setup";

test("runs under a perf session", async ({ device }) => {
	fixtureLog.write(`active ${device.perf.active}`);
});

test("stops it itself", async ({ device }) => {
	await device.perf.stop();
	fixtureLog.write(`active ${device.perf.active}`);
});
