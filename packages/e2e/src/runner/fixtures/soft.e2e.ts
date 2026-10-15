import { E2eError } from "../../errors";
import { test } from "../../index";
import { getSession } from "../../session";
import { fixtureLog as log } from "./fake-setup";

test.use({ launch: "none" });

/** The running attempt's `expect.soft` collector (the runner creates it per attempt). */
function soft(): E2eError[] {
	const attempt = getSession().attempt;
	if (attempt === undefined) throw new Error("no attempt running");
	return attempt.softFailures;
}

test("soft failures fail the attempt after the body", async () => {
	soft().push(new E2eError("ASSERTION", "first soft"), new E2eError("ASSERTION", "second soft"));
	log("body finished");
});

test("one soft failure is reported as is", async () => {
	soft().push(new E2eError("ASSERTION", "only soft"));
});

test("the list starts empty for every attempt", async () => {
	log(`soft=${soft().length}`);
});
