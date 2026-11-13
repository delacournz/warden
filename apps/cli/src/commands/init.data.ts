import {
	DEFAULT_E2E_COUNT,
	DEFAULT_SPECS_DIR,
	DEV_MENU_OFF_ARGS,
} from "@delacour/warden-core/affected/affected.defaults";

/** `root`: the app dir relative to the config's root dir, when it is not that dir (an overlay config for a monorepo app). */
export type InitApp = { name: string; root?: string; bundleId: { ios?: string; android?: string } };

const str = (value: string) => JSON.stringify(value);

function bundleIds({ ios, android }: InitApp["bundleId"]): string {
	const ids = [ios ? `ios: ${str(ios)}` : undefined, android ? `android: ${str(android)}` : undefined];
	return `{ ${ids.filter((id) => id !== undefined).join(", ")} }`;
}

/**
 * The starter `warden.config.ts`: the project and the suite `warden e2e` otherwise assumes, spelled out to edit.
 * `{ e2e: false }` (what `warden dev` offers to write) keeps it to the project: the ids warden would otherwise
 * have to ask Expo for on every start.
 */
export function wardenConfigSource(
	app: InitApp,
	options: { e2e?: boolean; platform?: "ios" | "android" } = {}
): string {
	const platform = options.platform ?? "ios";
	const name = str(app.name);
	const root = app.root !== undefined && app.root !== "." ? `root: ${str(app.root)}, ` : "";
	const header = `/**
 * warden config.
 * - \`warden dev\`: the dev client on a leased simulator, on a Metro port of its own.
 * - \`warden e2e\`: the \`*.e2e.ts\` specs in ${DEFAULT_SPECS_DIR}/ (\`@delacour/warden-e2e\`) on the dev client, one
 *   \`bun test\` process per leased simulator (\`--count N\`).
 * For autocompletion: \`bun add -d @delacour/warden\` and wrap this in \`defineConfig\` from "@delacour/warden/config".
 */
`;
	if (options.e2e === false)
		return `${header}export default {
	projects: [{ name: ${name}, ${root}bundleId: ${bundleIds(app.bundleId)} }],
};
`;
	const metro =
		platform === "ios"
			? `
			// no Expo dev menu, onboarding sheet or floating button over the app
			metro: { launchArgs: [${DEV_MENU_OFF_ARGS.map(str).join(", ")}] },`
			: "";
	return `${header}export default {
	projects: [{ name: ${name}, ${root}bundleId: ${bundleIds(app.bundleId)} }],
	e2e: {
		[${name}]: {
			project: ${name},
			specsDir: ${str(DEFAULT_SPECS_DIR)},
			platform: ${str(platform)},
			isolate: "device",
			count: ${DEFAULT_E2E_COUNT},
			app: true,${metro}
		},
	},
};
`;
}

/** A first spec: the app opens. */
export const SMOKE_SPEC_SOURCE = `import { test } from "@delacour/warden-e2e";

// launch: "none" = the test opens the app itself (app.open below) instead of the runner opening it first
// systemAlerts: "dismiss" = a system prompt over the app (permissions, "Open in...?") is closed for you
test.use({ launch: "none", systemAlerts: "dismiss" });

test("the app opens", async ({ app }) => {
	await app.open({ wait: "quiet" });
	// next: assert on your first screen. Add \`expect\` to the import and \`screen\` to the fixtures, then:
	// await expect(screen.getByTestId("home")).toBeVisible({ timeout: 30_000 });
});
`;
