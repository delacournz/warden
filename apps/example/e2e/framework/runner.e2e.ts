import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	E2eError,
	expect,
	type Screen,
	test,
} from "@delacour/warden-e2e";
import { ENV_NAMES } from "@delacour/warden-e2e/env";
import { ids } from "../helpers/ids";
import { launch, SPEC_OPTIONS } from "../helpers/steps";

test.use(SPEC_OPTIONS);

/**
 * The runner's own API: hook order, nested scopes, `test.extend`, skips, `test.use` scoping and what `describe.serial`
 * keeps between tests. Tests that need no screen never launch the app (`launch: "none"`), so most of this costs no
 * device time. Tests in one file run in order, so a later test reads what an earlier one recorded.
 */
const events: string[] = [];

describe("hook order", () => {
	beforeAll(() => {
		events.push("outer beforeAll");
	});
	beforeEach(() => {
		events.push("outer beforeEach");
	});
	afterEach(() => {
		events.push("outer afterEach");
	});
	afterAll(() => {
		events.push("outer afterAll");
	});

	test("first", () => {
		events.push("first");
		expect(events).toEqual(["outer beforeAll", "outer beforeEach", "first"]);
	});

	describe("nested", () => {
		beforeEach(() => {
			events.push("inner beforeEach");
		});
		afterEach(() => {
			events.push("inner afterEach");
		});

		test("second", () => {
			events.push("second");
			expect(events.slice(3)).toEqual(["outer afterEach", "outer beforeEach", "inner beforeEach", "second"]);
		});
	});
});

test("hooks ran outermost first before a test and innermost first after it, afterAll last", () => {
	expect(events.slice(7)).toEqual(["inner afterEach", "outer afterEach", "outer afterAll"]);
});

const teardowns: string[] = [];
const withNote = test.extend<{ note: string }>({
	note: async (_base, use) => {
		teardowns.push("set up");
		await use("from the fixture");
		teardowns.push("torn down");
	},
});

withNote("test.extend hands the test its fixture", ({ note }) => {
	expect(note).toBe("from the fixture");
	expect(teardowns).toEqual(["set up"]);
});

test("an extend fixture is torn down after its test", () => {
	expect(teardowns).toEqual(["set up", "torn down"]);
});

const ran = { skip: false, skipIf: false, otherPlatform: false };
const otherPlatform = process.env[ENV_NAMES.platform] === "android" ? "ios" : "android";

test.skip("test.skip never runs its body", () => {
	ran.skip = true;
});
test.skipIf(true)("test.skipIf(true) never runs its body", () => {
	ran.skipIf = true;
});
test("a test for the other platform never runs its body", { platforms: [otherPlatform] }, () => {
	ran.otherPlatform = true;
});

test("skipped bodies did not run", () => {
	expect(ran).toEqual({ skip: false, skipIf: false, otherPlatform: false });
});

describe("test.use scoping", () => {
	test.use({ actionTimeout: 700 });

	test("an actionTimeout set on the describe bounds that scope's actions", async ({ screen }) => {
		const started = Date.now();
		await expect(screen.getByTestId("no-such-test-id").tap()).rejects.toBeInstanceOf(E2eError);
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});

let kept: Screen | undefined;

/** What one chain keeps between its tests: the app and its state, never a fixture from a hook. */
describe.serial("describe.serial state", () => {
	beforeAll(async ({ app, screen }) => {
		await launch(app, screen);
		kept = screen;
	});

	test("the first test moves the onboarding on a step", async ({ screen }) => {
		await screen.getByTestId(ids.welcome.next).tap({ until: screen.getByTestId(ids.welcome.title) });
		await expect(screen.getByTestId(ids.welcome.title)).toHaveText("Plan");
	});

	test("the next test starts on the step the first one left, no relaunch in between", async ({ app, screen }) => {
		await expect(screen.getByTestId(ids.welcome.title)).toHaveText("Plan");
		expect(await app.isRunning()).toBe(true);
	});

	test("a fixture kept from beforeAll fails SESSION inside a test", async () => {
		const stale = kept;
		if (stale === undefined) throw new Error("beforeAll kept no screen");
		await expect(stale.getByTestId(ids.welcome.title).text()).rejects.toMatchObject({ code: "SESSION" });
	});
});
