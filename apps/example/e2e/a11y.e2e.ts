import { type Device, expect, type Locator, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { pollUntil } from "./helpers/poll";
import { openA11y, SPEC_OPTIONS } from "./helpers/steps";

test.use(SPEC_OPTIONS);

/** The good screen, in the order a reader walks it. Phrases are warden's simulated speech, matched by prefix. */
const READING_ORDER = [
	"System settings",
	"Screen reader: off",
	"Reduce motion:",
	"Bold text: off",
	"Controls",
	"Sync over cellular",
	"Volume",
	"Starred item",
	"Save changes",
	"Quarterly report",
	"Last action: none",
	"Announcements",
	"Count: 0",
	"Increment",
	"Announce",
] as const;

/** The rules a `?bad=1` screen breaks, with the element each one is found on. */
const BAD_ISSUES = [
	["missing-name", "a11y-bad-unlabeled"],
	["target-size", "a11y-bad-tiny"],
	["role-in-name", "a11y-bad-role"],
] as const;

/**
 * Found from the Android hierarchy only: iOS's accessibility tree has no visible text under a merged control and no
 * container above a text, so `label-in-name` and `text-clipped` cannot see these there.
 */
const BAD_ISSUES_ANDROID = [["label-in-name", "a11y-bad-label"]] as const;

/** Polls the reading order until the pushed screen is settled: the screen underneath is gone and the last item is in. */
async function settledOrder(device: Pick<Device, "screenReader">): Promise<string[]> {
	let texts: string[] = [];
	for (let attempt = 0; attempt < 20; attempt++) {
		texts = (await device.screenReader.order()).map((a) => a.text);
		if (texts.some((t) => t.startsWith("Announce")) && !texts.some((t) => t.startsWith("Welcome"))) return texts;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return texts;
}

/** Reads a readout until it shows `text` (a setting reaches the app a moment after the OS changes). */
async function expectText(locator: Locator, text: string): Promise<void> {
	await expect(locator).toHaveText(text, { timeout: 15_000 });
}

test.afterEach(async ({ device }) => {
	await device.a11y(null).catch(() => undefined);
});

test("reading order matches the golden list", async ({ app, device, screen }) => {
	await openA11y(app, device, screen);
	const spoken = await settledOrder(device);
	const body = spoken.filter((t) => t !== "warden-example" && !t.startsWith("Back"));

	expect(body.length).toBe(READING_ORDER.length);
	READING_ORDER.forEach((prefix, index) => {
		expect(body[index]).toContain(prefix);
	});
	expect(spoken.some((t) => t.startsWith("Welcome"))).toBe(false);
});

test("controls expose name, role, hint and the simulated phrase", async ({ app, device, screen, platform }) => {
	await openA11y(app, device, screen);
	await settledOrder(device);

	await expect(screen.getByTestId(ids.a11y.switch)).toHaveAccessibleName("Sync over cellular");
	await expect(screen.getByTestId(ids.a11y.switch)).toHaveRole("switch");
	await expect(screen.getByTestId(ids.a11y.switch)).toAnnounce(/Sync over cellular, switch/);
	await expect(screen.getByTestId(ids.a11y.hinted)).toHaveAccessibleName("Save changes");
	await expect(screen.getByTestId(ids.a11y.hinted)).toHaveRole("button");
	await expect(screen.getByTestId(ids.a11y.hinted)).toAnnounce(/Save changes, button/);
	await expect(screen.getByTestId(ids.a11y.slider)).toHaveAccessibleName("Volume");
	await expect(screen.getByTestId(ids.a11y.image)).toHaveAccessibleName("Starred item");
	await expect(screen.getByTestId(ids.a11y.image)).toHaveRole("image");
	if (platform === "ios")
		await expect(screen.getByTestId(ids.a11y.hinted)).toHaveHint("Saves your changes to the cloud");
});

test("the good screen passes the audit", async ({ app, device, screen }) => {
	await openA11y(app, device, screen);
	await settledOrder(device);
	await expect(device).toPassA11yAudit();
});

test("the bad screen fails with the known rules", async ({ app, device, screen, platform }) => {
	await openA11y(app, device, screen, { bad: true });
	await screen.getByTestId("a11y-bad-label").scrollTo();
	await settledOrder(device);

	const result = await device.a11yAudit({ native: false, minSeverity: "warning" });
	const found = result.issues.filter((i) => i.identifier?.startsWith("a11y-bad")).map((i) => [i.rule, i.identifier]);
	const expectedIssues = platform === "android" ? [...BAD_ISSUES, ...BAD_ISSUES_ANDROID] : BAD_ISSUES;
	for (const expected of expectedIssues) expect(found).toContainEqual([...expected]);
	await expect(device).not.toPassA11yAudit({ native: false });
});

/**
 * The text size is set before the screen opens: Android recreates the activity when the font scale changes, which
 * sends the app back to its first screen, and `openA11y` launches fresh anyway. `text-clipped` finds text that
 * overflows a container the accessibility tree still shows; React Native clips on both platforms (iOS lists the text
 * and its box side by side, Android cuts a child's bounds to its parent's), so this asserts what holds: the text
 * grows, wraps, and the audit at that size finds nothing clipped.
 */
test("extra-large text grows and nothing is clipped", async ({ app, device, screen }) => {
	const readout = screen.getByTestId(ids.a11y.screenReader);
	await openA11y(app, device, screen);
	await settledOrder(device);
	const normal = (await readout.boundingBox()).height;

	await device.a11y({ textSize: "accessibility-extra-large" });
	await openA11y(app, device, screen);
	await settledOrder(device);
	const grown = await pollUntil(
		async () => (await readout.boundingBox()).height,
		(height) => height > normal,
		10_000
	);

	expect(grown).toBeGreaterThan(normal);
	const result = await device.a11yAudit({
		native: false,
		rules: ["text-clipped"],
		textSize: "accessibility-extra-large",
	});
	expect(result.issues).toEqual([]);
});

test("announce and live region", async ({ app, device, screen }) => {
	await openA11y(app, device, screen);
	await settledOrder(device);

	await screen.getByTestId(ids.a11y.announce).tap();
	await expect(device).toHaveAnnounced("Saved");

	const before = await device.announcements();
	await screen.getByTestId(ids.a11y.increment).tap();
	await expect(device).toHaveAnnounced("Count: 1", { since: before.cursor });
	await expect(screen.getByTestId(ids.a11y.counter)).toHaveText("Count: 1");
});

test("screen reader and reduce motion flow into the app", async ({ app, device, screen }) => {
	await openA11y(app, device, screen);
	await expect(screen.getByTestId(ids.a11y.screenReader)).toHaveText("Screen reader: off");

	await device.a11y({ screenReader: true });
	await expectText(screen.getByTestId(ids.a11y.screenReader), "Screen reader: on");

	await device.a11y({ reduceMotion: true });
	await expectText(screen.getByTestId(ids.a11y.reduceMotion), "Reduce motion: on");
});

test("TalkBack walks to the switch and toggles it", { platforms: ["android"], timeout: 240_000 }, async ({
	app,
	device,
	screen,
}) => {
	await openA11y(app, device, screen);
	await device.a11y({ screenReader: true });
	await expect(screen.getByTestId(ids.a11y.switch)).toBeChecked({ checked: false });

	const since = (await device.screenReader.spoken()).cursor;
	let reached = false;
	for (let step = 0; step < 30 && !reached; step++) {
		const focused = await device.screenReader.next();
		reached = focused?.text.includes("Sync over cellular") ?? false;
	}
	expect(reached).toBe(true);

	await device.screenReader.activate();
	await expect(screen.getByTestId(ids.a11y.switch)).toBeChecked();
	const { lines } = await device.screenReader.spoken({ since });
	expect(lines.map((l) => l.text).join(" | ")).toContain("Sync over cellular");
});
