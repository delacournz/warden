import "./preload";
import { test } from "../../index";
import { fixtureLog as log } from "./fake-setup";

test("runs under a perf session", async ({ device }) => {
	log(`active ${device.perf.active}`);
});

test("stops it itself", async ({ device }) => {
	await device.perf.stop();
	log(`active ${device.perf.active}`);
});
