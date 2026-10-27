import type { Broker, BrokerOptions } from "./broker";
import { logpointsExtension } from "./logpoints";
import { profilesExtension } from "./profiles";
import { symbolicateExtension } from "./symbolicate";

/** What an extension may read about the session it is installed into. */
export type BrokerExtensionContext = { metroUrl: string; logDir: string; log: (line: string) => void };

/** Adds methods (`registerMethod`), line processors or attach hooks to a started broker; returns its teardown. */
export type BrokerExtension = (broker: Broker, context: BrokerExtensionContext) => () => void;

/** Every extension `warden dev` installs, in order: symbolication (DBG-4), logpoints (DBG-5), profiles (DBG-6). */
export const BROKER_EXTENSIONS: readonly BrokerExtension[] = [
	symbolicateExtension,
	logpointsExtension,
	profilesExtension,
];

/**
 * Installs `extensions` into `broker`; `close()` on the result tears them down before the broker itself closes.
 */
export function withExtensions(
	broker: Broker,
	options: Pick<BrokerOptions, "metroUrl" | "logDir" | "log">,
	extensions: readonly BrokerExtension[] = BROKER_EXTENSIONS
): Broker {
	const context: BrokerExtensionContext = {
		metroUrl: options.metroUrl,
		logDir: options.logDir,
		log: options.log ?? (() => undefined),
	};
	const teardowns = extensions.map((install) => install(broker, context));
	return {
		...broker,
		close: async () => {
			for (const teardown of teardowns.reverse()) teardown();
			await broker.close();
		},
	};
}
