import { E2eError, test } from "../../index";
import { fake, fixtureLog } from "./fake-setup";

let runs = 0;

test("the app vanished when the accessibility service was restarted", async () => {
	runs += 1;
	fixtureLog(`body run ${runs}`);
	if (runs === 1) {
		// the helper found both readers silent mid-test, restarted backboardd and is still finishing up
		fake.axWedge = { restarts: 1, maxRestarts: 1, recovering: true };
		throw new E2eError("ASSERTION", 'expected "Welcome" to be visible');
	}
});

test("a later failure after the same restart is not run again", async () => {
	runs += 1;
	fixtureLog(`body run ${runs}`);
	throw new E2eError("ASSERTION", 'expected "Welcome" to be visible');
});
