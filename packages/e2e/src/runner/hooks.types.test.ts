import { test as bunTest, expect } from "bun:test";
import { test } from "./test";

const extended = test.extend<{ account: string }>({
	account: async (_base, use) => {
		await use("acct-1");
	},
});

/** Never called: `bun run typecheck` fails when a `@ts-expect-error` below stops erroring or a typed line breaks. */
function typeChecks(): void {
	extended.beforeEach(({ account, platform }) => {
		const text: string = account;
		const target: "ios" | "android" = platform;
		void [text, target];
	});
	extended.afterEach(({ account }) => {
		const text: string = account;
		void text;
	});
	test.beforeEach(({ platform }) => {
		void platform;
	});
	test.afterEach((fixtures) => {
		// @ts-expect-error `account` only exists on tests made with `test.extend`
		void fixtures.account;
	});
	extended.beforeEach(({ account }) => {
		// @ts-expect-error `account` is a string
		const wrong: number = account;
		void wrong;
	});
}

bunTest("hooks on a test api are typed with that api's fixtures (checked by tsc)", () => {
	expect(typeof typeChecks).toBe("function");
});
