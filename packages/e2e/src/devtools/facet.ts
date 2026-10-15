import { join } from "node:path";
import { ok } from "@delacour/warden-types/result";
import { createConsoleCapture } from "./console";
import {
	type ConsoleLine,
	type DevtoolsFacet,
	type DevtoolsResult,
	devtoolsErr,
	type Fetch,
	type NetworkEntry,
	type Sleep,
} from "./devtools.types";
import { attachNetwork } from "./network";
import { connectDevtools, type DevtoolsDevice } from "./session";

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
};

/**
 * Attach to the running dev client and start capturing its console and `fetch` traffic. This is what
 * `device.devtools` and the failure capture use. Console capture starts before the socket opens so the
 * runtime's replay of buffered messages is seen (and de-duplicated on later reconnects).
 */
export async function openDevtoolsFacet(o: OpenDevtoolsFacetOptions): Promise<DevtoolsResult<DevtoolsFacet>> {
	const metroUrl = o.env.metroUrl;
	if (!metroUrl) {
		return devtoolsErr("devtools_unavailable", "no Metro URL (WARDEN_METRO_URL): release builds have no devtools");
	}
	const consoleCapture = createConsoleCapture({ ring: o.consoleRing, sink: o.consoleSink });
	const connected = await connectDevtools({
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

	const attached = await attachNetwork(session, {
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
	const network = attached.data;

	return ok({
		evaluate: (expression, options) => session.evaluate(expression, options),
		reloadJs: () => session.reloadJs(),
		console: {
			lines: consoleCapture.lines,
			clear: consoleCapture.clear,
			mark: consoleCapture.mark,
		},
		network: { entries: network.entries, clear: network.clear },
		get target() {
			return session.target;
		},
		on: session.on,
		async attachArtifacts(dir) {
			const paths = { console: join(dir, "console.jsonl"), network: join(dir, "network.jsonl") };
			try {
				await consoleCapture.writeJsonl(paths.console);
				await network.writeJsonl(paths.network);
			} catch (error) {
				return devtoolsErr("io_failed", `could not write devtools artifacts to ${dir}: ${String(error)}`);
			}
			return ok(paths);
		},
		close() {
			network.stop();
			session.close();
		},
	});
}
