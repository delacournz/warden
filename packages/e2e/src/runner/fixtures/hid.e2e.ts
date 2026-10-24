import { E2eError, test } from "../../index";
import { fixtureLog } from "./fake-setup";

let runs = 0;

test("tap after Device Hub quit", async () => {
	runs += 1;
	fixtureLog(`body run ${runs}`);
	if (runs === 1) {
		throw new E2eError(
			"ACTION_FAILED",
			"tap failed: E_HID: The dtuhidd connection (com.apple.coredevice.feature.remote.hid.digitizer) has been invalidated; events sent on it would be discarded"
		);
	}
});

test("a second loss is not recovered", async () => {
	runs += 1;
	fixtureLog(`body run ${runs}`);
	throw new E2eError("ACTION_FAILED", "tap failed: E_HID: The dtuhidd connection (x) has been invalidated");
});
