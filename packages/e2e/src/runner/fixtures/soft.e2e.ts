import { E2eError } from "@delacour/warden-driver/e2e-error";
import { test } from "../../index";
import { sessions } from "../../session";
import { fixtureLog } from "./fake-setup";

test.use({ launch: "none" });

class SoftProbe {
	/** The running attempt's `expect.soft` collector (the runner creates it per attempt). */
	soft(): E2eError[] {
		const attempt = sessions.get().attempt;
		if (attempt === undefined) throw new Error("no attempt running");
		return attempt.softFailures;
	}
}

const probe = new SoftProbe();

test("soft failures fail the attempt after the body", async () => {
	probe.soft().push(new E2eError("ASSERTION", "first soft"), new E2eError("ASSERTION", "second soft"));
	fixtureLog.write("body finished");
});

test("one soft failure is reported as is", async () => {
	probe.soft().push(new E2eError("ASSERTION", "only soft"));
});

test("the list starts empty for every attempt", async () => {
	fixtureLog.write(`soft=${probe.soft().length}`);
});
