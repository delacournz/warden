/** Who answers on a port, relative to the caller's project (see `metroOwner` in `apps/cli/src/metro.ts`). */
export type MetroProbe = "ours" | "foreign" | "none";

export type MetroSource = "flag" | "env" | "state" | "lease";

export type FindMetroInput = {
	/** `--metro` */
	flag?: string;
	/** `WARDEN_METRO_URL` */
	env?: string;
	/** `metroUrl` of the device's `state.json` */
	stateMetroUrl?: string;
	/** ports the caller holds leases on, in order */
	portLeases: readonly number[];
	probe: (port: number) => Promise<MetroProbe>;
};

export type FoundMetro = { url: string; source: MetroSource };

/** Picks the Metro to inspect. Use the shared {@link metroFinder} singleton. */
export class MetroFinder {
	/**
	 * Which Metro to inspect: `--metro`, then `WARDEN_METRO_URL`, then the device state's URL, then the first
	 * leased port the probe says is ours. A `foreign` Metro (another checkout) is never picked.
	 */
	async find(input: FindMetroInput): Promise<FoundMetro | undefined> {
		const explicit: [MetroSource, string | undefined][] = [
			["flag", this.clean(input.flag)],
			["env", this.clean(input.env)],
			["state", this.clean(input.stateMetroUrl)],
		];
		for (const [source, url] of explicit) if (url) return { url, source };
		for (const port of input.portLeases) {
			if ((await input.probe(port)) === "ours") return { url: `http://127.0.0.1:${port}`, source: "lease" };
		}
		return undefined;
	}

	private clean(value: string | undefined): string | undefined {
		const trimmed = value?.trim().replace(/\/+$/, "");
		return trimmed ? trimmed : undefined;
	}
}

export const metroFinder = new MetroFinder();
