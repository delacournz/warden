import { test } from "../../index";
import { getSession } from "../../session";
import { fixtureLog as log } from "./fake-setup";

test.use({ launch: "none" });

test("soft failures fail the attempt after the body", async () => {
	getSession().softFailures.push(new Error("first soft"), new Error("second soft"));
	log("body finished");
});

test("one soft failure is reported as is", async () => {
	getSession().softFailures.push(new Error("only soft"));
});

test("the list starts empty for every attempt", async () => {
	log(`soft=${getSession().softFailures.length}`);
});
