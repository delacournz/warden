import { describe, expect, test } from "bun:test";
import { ok } from "@delacour/warden-types/result";
import type { Broker } from "./broker";
import { type BrokerExtension, withExtensions } from "./extensions";

function fakeBroker(events: string[]): Broker {
	return {
		socketPath: "/tmp/b.sock",
		state: () => ({ phase: "closed" }),
		resume: () => undefined,
		registerMethod: () => ok(() => undefined),
		addLineProcessor: () => () => undefined,
		onAttach: () => () => undefined,
		close: async () => {
			events.push("broker closed");
		},
	};
}

describe("withExtensions", () => {
	test("installs each extension with the session context and tears them down in reverse before the broker", async () => {
		const events: string[] = [];
		const ext =
			(name: string): BrokerExtension =>
			(_broker, context) => {
				events.push(`${name} installed ${context.metroUrl} ${context.logDir}`);
				return () => events.push(`${name} removed`);
			};
		const broker = withExtensions(fakeBroker(events), { metroUrl: "http://m", logDir: "/d" }, [ext("a"), ext("b")]);
		expect(broker.socketPath).toBe("/tmp/b.sock");
		await broker.close();
		expect(events).toEqual([
			"a installed http://m /d",
			"b installed http://m /d",
			"b removed",
			"a removed",
			"broker closed",
		]);
	});
});
