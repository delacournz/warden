import { E2eError, test } from "../../index";
import { fixtureLog } from "./fake-setup";

let runs = 0;

test("tap after the runner host died", async () => {
	runs += 1;
	fixtureLog(`body run ${runs}`);
	if (runs === 1) {
		throw new E2eError("ACTION_FAILED", "tap failed: E_HELPER_CRASHED: warden-runner socket closed");
	}
});

test("a second loss is not recovered", async () => {
	runs += 1;
	fixtureLog(`body run ${runs}`);
	throw new E2eError("ACTION_FAILED", "tap failed: E_HELPER_CRASHED: warden-runner socket closed");
});
