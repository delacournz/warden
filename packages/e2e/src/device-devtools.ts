import type { ConsoleLine, DevtoolsFacet, DevtoolsResult } from "./devtools/devtools.types";
import { E2eError } from "./errors";

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

export function createDeviceDevtools(source: DevtoolsSource): DeviceDevtools {
	const connect = async (): Promise<DevtoolsFacet> => {
		const attached = await source.devtools();
		if (attached.success) return attached.data;
		throw new E2eError("SESSION", `devtools unavailable: ${attached.error.message}`);
	};

	/** The facet, or the failure as a result for the members that return one. */
	const attach = (): Promise<DevtoolsResult<DevtoolsFacet>> => source.devtools();

	return {
		async evaluate(expression, options) {
			const attached = await attach();
			if (!attached.success) return { success: false, error: attached.error };
			return attached.data.evaluate(expression, options);
		},
		async reloadJs() {
			const attached = await attach();
			return attached.success ? attached.data.reloadJs() : attached;
		},
		async tree(options) {
			const attached = await attach();
			return attached.success ? attached.data.tree(options) : attached;
		},
		network: {
			async entries(query) {
				return (await connect()).network.entries(query);
			},
			async clear() {
				await (await connect()).network.clear();
			},
		},
		console: {
			async lines() {
				return (await connect()).console.lines();
			},
			async clear() {
				(await connect()).console.clear();
			},
			async mark(label) {
				(await connect()).console.mark(label);
			},
		},
		connect,
	};
}
