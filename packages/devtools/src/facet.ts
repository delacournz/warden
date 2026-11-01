import { join } from "node:path";
import { resultFactory } from "@delacour/warden-types/result";
import { type ConsoleCapture, ConsoleRecorder } from "./console";
import {
	type ConsoleLine,
	type DevtoolsFacet,
	type DevtoolsResult,
	devtoolsErrors,
	type Fetch,
	type NetworkEntry,
	type Sleep,
	type TreeOptions,
} from "./devtools.types";
import type { SelectedTarget } from "./inspector";
import { type LogBoxMute, LogBoxMuter } from "./logbox";
import { type NetworkCapture, networkAttacher } from "./network";
import { type DevtoolsDevice, type DevtoolsSession, devtoolsConnector } from "./session";
import { treeFetcher } from "./tree";

export type OpenDevtoolsFacetOptions = {
	/** the spec env: `metroUrl` is `WARDEN_METRO_URL`; absent = a release build, so `devtools_unavailable` */
	env: { metroUrl?: string };
	device: DevtoolsDevice;
	fetch: Fetch;
	WebSocket?: typeof WebSocket;
	log?: (line: string) => void;
	sleep?: Sleep;
	timeoutMs?: number;
	/** keep request/response text in network entries (default false) */
	includeBodies?: boolean;
	pollMs?: number;
	consoleRing?: number;
	networkRing?: number;
	/** called with each console line / network entry as it is recorded (the collector's files) */
	consoleSink?: (line: ConsoleLine) => void;
	networkSink?: (entry: NetworkEntry) => void;
	/** keep React Native's LogBox (toasts and the error inspector) off in the app, across reloads (default false) */
	muteLogBox?: boolean;
};

/** The facet over one attached session: its console ring, network capture and optional LogBox mute. */
class AttachedDevtoolsFacet implements DevtoolsFacet {
	constructor(
		private readonly session: DevtoolsSession,
		private readonly consoleCapture: ConsoleCapture,
		private readonly networkCapture: NetworkCapture,
		private readonly logbox: LogBoxMute | undefined,
		private readonly sleep: Sleep | undefined
	) {}

	readonly console: DevtoolsFacet["console"] = {
		lines: () => this.consoleCapture.lines(),
		clear: () => this.consoleCapture.clear(),
		mark: (label) => this.consoleCapture.mark(label),
	};

	readonly network: DevtoolsFacet["network"] = {
		entries: (query) => this.networkCapture.entries(query),
		clear: () => this.networkCapture.clear(),
	};

	get target(): SelectedTarget {
		return this.session.target;
	}

	readonly on: DevtoolsSession["on"] = (event, handler) => this.session.on(event, handler);

	evaluate(expression: string, options?: { await?: boolean; timeoutMs?: number }) {
		return this.session.evaluate(expression, options);
	}

	reloadJs() {
		return this.session.reloadJs();
	}

	tree(options?: TreeOptions) {
		return treeFetcher.fetch(this.session, options, { sleep: this.sleep });
	}

	async attachArtifacts(dir: string): Promise<DevtoolsResult<{ console: string; network: string }>> {
		const paths = { console: join(dir, "console.jsonl"), network: join(dir, "network.jsonl") };
		try {
			await this.consoleCapture.writeJsonl(paths.console);
			await this.networkCapture.writeJsonl(paths.network);
		} catch (error) {
			return devtoolsErrors.err("io_failed", `could not write devtools artifacts to ${dir}: ${String(error)}`);
		}
		return resultFactory.ok(paths);
	}

	close(): void {
		this.logbox?.stop();
		this.networkCapture.stop();
		this.session.close();
	}
}

/** Opens {@link DevtoolsFacet}s. Use the shared {@link devtoolsFacetOpener} singleton. */
export class DevtoolsFacetOpener {
	/**
	 * Attach to the running dev client and start capturing its console and `fetch` traffic. This is what
	 * `device.devtools` and the failure capture use. Console capture starts before the socket opens so the
	 * runtime's replay of buffered messages is seen (and de-duplicated on later reconnects).
	 */
	async open(o: OpenDevtoolsFacetOptions): Promise<DevtoolsResult<DevtoolsFacet>> {
		const metroUrl = o.env.metroUrl;
		if (!metroUrl) {
			return devtoolsErrors.err(
				"devtools_unavailable",
				"no Metro URL (WARDEN_METRO_URL): release builds have no devtools"
			);
		}
		const consoleCapture = new ConsoleRecorder({ ring: o.consoleRing, sink: o.consoleSink });
		const connected = await devtoolsConnector.connect({
			metroUrl,
			device: o.device,
			fetch: o.fetch,
			WebSocket: o.WebSocket,
			log: o.log,
			sleep: o.sleep,
			timeoutMs: o.timeoutMs,
			taps: [consoleCapture.handle],
		});
		if (!connected.success) return connected;
		const session = connected.data;

		const attached = await networkAttacher.attach(session, {
			ring: o.networkRing,
			metroUrl,
			includeBodies: o.includeBodies,
			pollMs: o.pollMs,
			sleep: o.sleep,
			sink: o.networkSink,
		});
		if (!attached.success) {
			session.close();
			return attached;
		}
		const logbox = o.muteLogBox ? new LogBoxMuter(session, { log: o.log }) : undefined;
		return resultFactory.ok(new AttachedDevtoolsFacet(session, consoleCapture, attached.data, logbox, o.sleep));
	}
}

export const devtoolsFacetOpener = new DevtoolsFacetOpener();
