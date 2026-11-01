import type { ConsoleLine, DevtoolsFacet, DevtoolsResult } from "@delacour/warden-devtools/devtools.types";
import { E2eError } from "@delacour/warden-driver/e2e-error";

/** Where the facet comes from: the session attaches it on the first `devtools()` and keeps it. */
export type DevtoolsSource = {
	devtools(): Promise<DevtoolsResult<DevtoolsFacet>>;
	peekDevtools(): DevtoolsFacet | undefined;
};

/**
 * `device.devtools`: the app's JS runtime over Metro. Every call attaches on first use (the session shares one
 * connection), so the members that are synchronous on a bare facet (`console`) are async here. `connect()` hands out
 * the whole facet (`target`, `on`, `attachArtifacts`).
 */
export type DeviceDevtools = {
	evaluate: DevtoolsFacet["evaluate"];
	reloadJs: DevtoolsFacet["reloadJs"];
	/** the app's React components with rects, `devtools_unavailable` when the app has no DevTools hook */
	tree: DevtoolsFacet["tree"];
	network: DevtoolsFacet["network"];
	console: {
		lines(): Promise<ConsoleLine[]>;
		clear(): Promise<void>;
		mark(label: string): Promise<void>;
	};
	/** the attached facet; throws `SESSION` when the app cannot be reached */
	connect(): Promise<DevtoolsFacet>;
};

/** The `device.devtools` object over a {@link DevtoolsSource}. */
export class DeviceDevtoolsFacade implements DeviceDevtools {
	constructor(private readonly source: DevtoolsSource) {}

	readonly connect = async (): Promise<DevtoolsFacet> => {
		const attached = await this.source.devtools();
		if (attached.success) return attached.data;
		throw new E2eError("SESSION", `devtools unavailable: ${attached.error.message}`);
	};

	readonly network: DeviceDevtools["network"] = {
		entries: async (query) => (await this.connect()).network.entries(query),
		clear: async () => {
			await (await this.connect()).network.clear();
		},
	};

	readonly console: DeviceDevtools["console"] = {
		lines: async () => (await this.connect()).console.lines(),
		clear: async () => {
			(await this.connect()).console.clear();
		},
		mark: async (label) => {
			(await this.connect()).console.mark(label);
		},
	};

	readonly evaluate: DevtoolsFacet["evaluate"] = async (expression, options) => {
		const attached = await this.source.devtools();
		if (!attached.success) return { success: false, error: attached.error };
		return attached.data.evaluate(expression, options);
	};

	readonly reloadJs: DevtoolsFacet["reloadJs"] = async () => {
		const attached = await this.source.devtools();
		return attached.success ? attached.data.reloadJs() : attached;
	};

	readonly tree: DevtoolsFacet["tree"] = async (options) => {
		const attached = await this.source.devtools();
		return attached.success ? attached.data.tree(options) : attached;
	};
}
