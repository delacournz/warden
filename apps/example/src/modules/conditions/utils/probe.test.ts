import { describe, expect, test } from "bun:test";
import { probe } from "./probe";

const deps = (fetchImpl: typeof fetch) => ({
	fetchImpl,
	timeoutMs: 50,
	retryDelayMs: 0,
	newKey: () => "key-1",
	now: (() => {
		let t = 0;
		return () => (t += 10);
	})(),
});

describe("probe", () => {
	test("succeeds on the first attempt", async () => {
		const result = await probe("https://x.test", deps((async () => new Response("ok")) as unknown as typeof fetch));
		expect(result).toMatchObject({ ok: true, status: 200, attempts: 1, error: null, key: "key-1" });
	});

	test("retries once with the same idempotency key", async () => {
		const keys: (string | null)[] = [];
		let calls = 0;
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			keys.push(new Headers(init?.headers).get("Idempotency-Key"));
			calls += 1;
			if (calls === 1) throw new TypeError("Network request failed");
			return new Response("ok");
		}) as unknown as typeof fetch;
		const result = await probe("https://x.test", deps(fetchImpl));
		expect(result).toMatchObject({ ok: true, attempts: 2 });
		expect(keys).toEqual(["key-1", "key-1"]);
	});

	test("gives up after the retry and reports the error", async () => {
		const fetchImpl = (async () => {
			throw new TypeError("Network request failed");
		}) as unknown as typeof fetch;
		const result = await probe("https://x.test", deps(fetchImpl));
		expect(result).toMatchObject({ ok: false, status: null, attempts: 2, error: "Network request failed" });
	});

	test("a 503 is retried and reported", async () => {
		const fetchImpl = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
		const result = await probe("https://x.test", deps(fetchImpl));
		expect(result).toMatchObject({ ok: false, status: 503, attempts: 2 });
	});
});
